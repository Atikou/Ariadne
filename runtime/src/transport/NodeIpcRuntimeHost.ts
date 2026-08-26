import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap,
  type RuntimeCancel,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeShutdown,
  parseHostToRuntimeMessage,
  parseRuntimeToHostMessage
} from '@ariadne/protocol/host';
import type { RuntimeEventEnvelope } from '@ariadne/protocol/public';

import {
  RuntimeIngressInitializationError,
  type RuntimeIngress
} from '../ingress/RuntimeIngress.js';
import { createShutdownContext } from '../ingress/ShutdownContext.js';
import { IpcHostCapabilityClient } from './IpcHostCapabilityClient.js';

const BOOTSTRAP_TIMEOUT_MS = 15_000;
const MAX_IN_FLIGHT_REQUESTS = 32;

interface InFlightCommand {
  readonly requestId: string;
  readonly request: RuntimeRequest;
  readonly controller: AbortController;
  readonly operation: Promise<void>;
}

/** Node IPC framing adapter. All business state and persistence live in Ingress. */
export class NodeIpcRuntimeHost {
  private bootstrap?: RuntimeBootstrap;
  private initialized = false;
  private shuttingDown = false;
  private hostCapabilities?: IpcHostCapabilityClient;
  private readonly inFlight = new Map<string, InFlightCommand>();
  private bootstrapTimer?: NodeJS.Timeout;

  public constructor(private readonly ingress: RuntimeIngress) {}

  public start(): void {
    if (typeof process.send !== 'function' || !process.connected) {
      throw new Error('runtime_ipc_channel_required');
    }
    this.bootstrapTimer = setTimeout(() => {
      process.exitCode = 1;
      process.disconnect();
    }, BOOTSTRAP_TIMEOUT_MS);
    this.bootstrapTimer.unref?.();
    process.on('message', this.onMessage);
    process.once('disconnect', this.onDisconnect);
    process.once('SIGTERM', this.onSignal);
    process.once('SIGINT', this.onSignal);
  }

  private readonly onMessage = (raw: unknown): void => {
    let message;
    try {
      message = parseHostToRuntimeMessage(raw);
    } catch {
      void this.failClosed('invalid_protocol_message');
      return;
    }
    if (!this.bootstrap) {
      if (message.type !== 'bootstrap') {
        void this.failClosed('bootstrap_required');
        return;
      }
      void this.initialize(message);
      return;
    }
    if (message.runtimeInstanceId !== this.bootstrap.runtimeInstanceId) {
      void this.failClosed('runtime_instance_mismatch');
      return;
    }
    if (message.type === 'bootstrap') {
      void this.failClosed('duplicate_bootstrap');
      return;
    }
    if (message.type === 'request') {
      this.acceptRequest(message);
      return;
    }
    if (message.type === 'cancel') {
      this.cancelCommand(message);
      return;
    }
    if (message.type === 'capability_response') {
      this.hostCapabilities?.accept(message);
      return;
    }
    if (message.type === 'shutdown') {
      void this.shutdown(message);
      return;
    }
    void this.failClosed('unsupported_host_message');
  };

  private async initialize(bootstrap: RuntimeBootstrap): Promise<void> {
    clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = undefined;
    this.bootstrap = bootstrap;
    this.hostCapabilities = new IpcHostCapabilityClient(
      bootstrap.runtimeInstanceId,
      (message) => this.send(message)
    );
    try {
      const ready = await this.ingress.initialize({
        bootstrap,
        hostCapabilities: this.hostCapabilities,
        emitEvent: (event) => this.emitEvent(event)
      });
      this.initialized = true;
      this.send({
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId: bootstrap.runtimeInstanceId,
        type: 'ready',
        runtimeVersion: ready.runtimeVersion,
        runtimeBuildFingerprint: ready.runtimeBuildFingerprint,
        capabilities: ready.status.capabilities,
        storageSchemas: ready.storageSchemas,
        readyAt: new Date().toISOString()
      });
    } catch (error) {
      const diagnostic = error instanceof RuntimeIngressInitializationError
        ? `${error.phase}_${error.code}`
        : 'runtime_ingress_initialization_failed';
      process.stderr.write(`[runtime] initialization failed: ${diagnostic}\n`);
      this.hostCapabilities.close('runtime_initialization_failed');
      await this.failClosed('initialization_failed');
    }
  }

  private acceptRequest(request: RuntimeRequest): void {
    if (!this.initialized) {
      this.sendError(
        request,
        'runtime_initializing',
        'Runtime is still initializing.',
        true
      );
      return;
    }
    if (this.shuttingDown) {
      this.sendError(
        request,
        'runtime_shutting_down',
        'Runtime is shutting down.',
        false
      );
      return;
    }
    if ([...this.inFlight.entries()].some(([commandId, entry]) => (
      commandId !== request.commandId && entry.requestId === request.requestId
    ))) {
      this.sendError(
        request,
        'duplicate_request_id',
        'The requestId is already bound to another logical command.',
        false
      );
      return;
    }

    if (this.inFlight.has(request.commandId)) {
      this.executeKnownAttempt(request);
      return;
    }
    if (this.inFlight.size >= MAX_IN_FLIGHT_REQUESTS) {
      let knownCommand: boolean;
      try {
        knownCommand = this.ingress.getCommandStatus(request.commandId) !== null;
      } catch {
        void this.failClosed('runtime_ingress_status_failed');
        return;
      }
      if (!knownCommand) {
        this.sendError(
          request,
          'runtime_busy',
          'The Runtime request queue is full.',
          true
        );
        return;
      }
      this.executeKnownAttempt(request);
      return;
    }

    const controller = new AbortController();
    const operation = this.executeRequest(request, controller.signal).finally(() => {
      const current = this.inFlight.get(request.commandId);
      if (current?.operation === operation) {
        this.inFlight.delete(request.commandId);
      }
    });
    this.inFlight.set(request.commandId, {
      requestId: request.requestId,
      request,
      controller,
      operation
    });
  }

  private executeKnownAttempt(request: RuntimeRequest): void {
    const controller = new AbortController();
    void this.executeRequest(request, controller.signal);
  }

  private async executeRequest(
    request: RuntimeRequest,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const outcome = await this.ingress.execute({
        commandId: request.commandId,
        correlationId: request.commandId,
        command: request.command,
        deadlineAt: request.deadlineAt,
        signal
      });
      this.sendResponse(request, outcome);
    } catch {
      await this.failClosed('runtime_ingress_execute_failed');
    }
  }

  private cancelCommand(message: RuntimeCancel): void {
    const inFlight = this.inFlight.get(message.commandId);
    let status: 'accepted' | 'not_found' | 'already_settled' | 'attempt_mismatch';
    if (!inFlight) {
      try {
        status = this.ingress.getCommandStatus(message.commandId) === null
          ? 'not_found'
          : 'already_settled';
      } catch {
        void this.failClosed('runtime_ingress_status_failed');
        return;
      }
    } else if (inFlight.requestId !== message.targetRequestId) {
      status = 'attempt_mismatch';
    } else if (inFlight.controller.signal.aborted) {
      status = 'already_settled';
    } else {
      try {
        const outcome = this.ingress.interrupt(
          message.commandId,
          message.reason
        );
        if (outcome === null) {
          status = 'already_settled';
        } else {
          status = 'accepted';
          inFlight.controller.abort(new Error(message.reason));
        }
      } catch {
        void this.failClosed('runtime_ingress_interrupt_failed');
        return;
      }
    }
    const runtimeInstanceId = this.bootstrap?.runtimeInstanceId;
    if (!runtimeInstanceId) return;
    this.send({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'cancel_acknowledged',
      cancelRequestId: message.cancelRequestId,
      targetRequestId: message.targetRequestId,
      commandId: message.commandId,
      status
    });
  }

  private sendError(
    request: RuntimeRequest,
    code: string,
    message: string,
    retryable: boolean
  ): void {
    this.sendResponse(
      request,
      errorOutcome(request.commandId, code, message, retryable)
    );
  }

  private sendResponse(
    request: Pick<RuntimeRequest, 'requestId' | 'commandId'>,
    outcome: RuntimeResponse['outcome']
  ): void {
    const runtimeInstanceId = this.bootstrap?.runtimeInstanceId;
    if (!runtimeInstanceId) return;
    this.send({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'response',
      requestId: request.requestId,
      commandId: request.commandId,
      outcome
    });
  }

  private emitEvent(event: RuntimeEventEnvelope): void {
    const runtimeInstanceId = this.bootstrap?.runtimeInstanceId;
    if (!runtimeInstanceId) return;
    this.send({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'event',
      event
    });
  }

  private async shutdown(message: RuntimeShutdown): Promise<void> {
    if (this.shuttingDown || !this.bootstrap) return;
    this.shuttingDown = true;
    this.hostCapabilities?.close();
    const deadline = Date.parse(message.deadlineAt);
    if (!Number.isFinite(deadline)) {
      process.exitCode = 1;
      if (process.connected) process.disconnect();
      return;
    }
    if (deadline <= Date.now()) {
      // Main owns the absolute deadline and final kill. Never turn an
      // unconfirmed close into an acknowledged handoff.
      process.exitCode = 1;
      return;
    }
    try {
      await this.stopRuntime(deadline);
      if (Date.now() >= deadline) {
        throw new Error('runtime_shutdown_deadline_exceeded');
      }
      this.send({
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId: this.bootstrap.runtimeInstanceId,
        type: 'shutdown_complete',
        requestId: message.requestId,
        completedAt: new Date().toISOString()
      });
      if (process.connected) process.disconnect();
    } catch {
      // Keep the child connected and any uncertain owner fence alive until
      // Main enforces the deadline kill.
      process.exitCode = 1;
    }
  }

  private readonly onDisconnect = (): void => {
    void this.shutdownAfterParentLoss();
  };

  private readonly onSignal = (): void => {
    void this.shutdownAfterParentLoss();
  };

  private async shutdownAfterParentLoss(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.hostCapabilities?.close();
    try {
      await this.stopRuntime(Date.now() + 5_000);
    } finally {
      process.exit();
    }
  }

  private async failClosed(code: string): Promise<void> {
    process.stderr.write(`[runtime] protocol failure: ${code}\n`);
    process.exitCode = 1;
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.hostCapabilities?.close();
    try {
      await this.stopRuntime(Date.now() + 5_000);
    } catch {
      // An uncertain close deliberately remains connected and fenced for Main.
      return;
    }
    if (process.connected) process.disconnect();
  }

  private send(message: unknown): void {
    let parsed;
    try {
      parsed = parseRuntimeToHostMessage(message);
      if (typeof process.send !== 'function' || !process.connected) {
        void this.failClosed('ipc_channel_unavailable');
        return;
      }
      process.send(parsed, (error) => {
        if (error) void this.failClosed('ipc_send_failed');
      });
    } catch {
      void this.failClosed('ipc_send_failed');
    }
  }

  private async drainInFlight(deadline: number): Promise<boolean> {
    while (this.inFlight.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(10, remainingMs));
      });
    }
    return true;
  }

  private cancelInFlight(reason: RuntimeCancel['reason']): void {
    for (const [commandId, entry] of this.inFlight) {
      if (entry.controller.signal.aborted) continue;
      const outcome = this.ingress.interrupt(commandId, reason);
      if (outcome === null) continue;
      entry.controller.abort(new Error(reason));
    }
  }

  private async stopRuntime(deadline: number): Promise<void> {
    const context = createShutdownContext(deadline);
    const closeReserveMs = Math.min(
      2_000,
      Math.max(250, Math.floor((deadline - Date.now()) * 0.3))
    );
    const drainDeadline = deadline - closeReserveMs;
    this.cancelInFlight('runtime_shutdown');
    try {
      const drained = await this.drainInFlight(drainDeadline);
      if (!drained) {
        throw new Error('runtime_shutdown_inflight_deadline_exceeded');
      }
      context.throwIfExpired();
      await this.ingress.shutdown(context);
      context.throwIfExpired();
    } finally {
      context.dispose();
    }
  }
}

function errorOutcome(
  correlationId: string,
  code: string,
  message: string,
  retryable: boolean
): Extract<RuntimeResponse['outcome'], { ok: false }> {
  const normalizedCode = /^[a-z][a-z0-9_]{1,127}$/u.test(code)
    ? code
    : 'runtime_request_failed';
  return {
    ok: false,
    error: {
      code: normalizedCode,
      message: message.slice(0, 4_096),
      retryable,
      correlationId
    }
  };
}
