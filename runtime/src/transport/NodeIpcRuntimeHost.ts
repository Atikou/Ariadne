import path from 'node:path';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap,
  type RuntimeRequest,
  type RuntimeShutdown,
  parseHostToRuntimeMessage,
  parseRuntimeToHostMessage
} from '@ariadne/protocol/host';
import type { RuntimeEventEnvelope } from '@ariadne/protocol/public';

import type { AppContext } from '../app/createAppContext.js';
import { COMPANION_DB_SCHEMA_VERSION } from '../companion/companionDbMigrations.js';
import { MEMORY_DB_SCHEMA_VERSION } from '../context/memoryDbMigrations.js';
import { TOOLS_DB_SCHEMA_VERSION } from '../storage/toolsDbMigrations.js';
import { RuntimeFacade, RuntimeFacadeError } from '../application/RuntimeFacade.js';
import { createRuntimeContext } from '../application/createRuntimeContext.js';
import { toPublicError } from '../util/publicError.js';
import { IpcHostCapabilityBroker } from '../host/HostCapabilityBroker.js';
import { readOwnRuntimeBuildManifest } from './runtimeBuildManifest.js';

export const ARIADNE_RUNTIME_VERSION = '0.1.0';
const BOOTSTRAP_TIMEOUT_MS = 15_000;
const MAX_IN_FLIGHT_REQUESTS = 32;

export class NodeIpcRuntimeHost {
  private app?: AppContext;
  private facade?: RuntimeFacade;
  private bootstrap?: RuntimeBootstrap;
  private shuttingDown = false;
  private hostCapabilities?: IpcHostCapabilityBroker;
  private readonly inFlight = new Map<string, Promise<void>>();
  private bootstrapTimer?: NodeJS.Timeout;

  start(): void {
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
    if (message.type === 'capability_response') {
      this.hostCapabilities?.accept(message);
      return;
    }
    void this.shutdown(message);
  };

  private async initialize(bootstrap: RuntimeBootstrap): Promise<void> {
    clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = undefined;
    let phase = 'bootstrap';
    try {
      const buildManifest = readOwnRuntimeBuildManifest();
      if (
        buildManifest.runtimeVersion !== ARIADNE_RUNTIME_VERSION
        || buildManifest.runtimeVersion !== bootstrap.runtimeVersion
        || buildManifest.fingerprint !== bootstrap.runtimeBuildFingerprint
      ) {
        throw new Error('runtime_build_identity_mismatch');
      }
      this.bootstrap = bootstrap;
      this.hostCapabilities = new IpcHostCapabilityBroker(
        bootstrap.runtimeInstanceId,
        (message) => this.send(message)
      );
      phase = 'context';
      this.app = createRuntimeContext(bootstrap, this.hostCapabilities);
      phase = 'facade';
      this.facade = new RuntimeFacade(
        this.app,
        (event) => this.emitEvent(event),
        ARIADNE_RUNTIME_VERSION,
        {
          activityDataRoot: bootstrap.dataRoot,
          conversationWorkspaceStateFile: path.join(bootstrap.dataRoot, 'conversation-workspaces.json'),
          workspaces: bootstrap.workspaces,
          ...(bootstrap.agentPermissions ? {
            proposalApproval: bootstrap.agentPermissions.proposalApproval,
            allowedPermissions: bootstrap.agentPermissions.allowedPermissions,
            agentPermissionPolicy: bootstrap.agentPermissions.permissionPolicy
          } : {})
        }
      );
      phase = 'start';
      await this.app.start();
      await this.facade.start();
      phase = 'ready';
      this.send({
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId: bootstrap.runtimeInstanceId,
        type: 'ready',
        runtimeVersion: ARIADNE_RUNTIME_VERSION,
        runtimeBuildFingerprint: buildManifest.fingerprint,
        capabilities: this.facade.status().capabilities,
        storageSchemas: {
          memory: MEMORY_DB_SCHEMA_VERSION,
          companion: COMPANION_DB_SCHEMA_VERSION,
          tools: TOOLS_DB_SCHEMA_VERSION
        },
        readyAt: new Date().toISOString()
      });
    } catch (error) {
      const publicError = toPublicError(error, 'Runtime 初始化失败');
      process.stderr.write(`[runtime] initialization failed: ${phase}_${publicError.code}\n`);
      await this.failClosed('initialization_failed');
    }
  }

  private acceptRequest(request: RuntimeRequest): void {
    const facade = this.facade;
    const runtimeInstanceId = this.bootstrap?.runtimeInstanceId;
    if (!facade || !runtimeInstanceId || this.shuttingDown) return;
    if (this.inFlight.has(request.requestId)) {
      this.sendError(request, 'duplicate_request_id', '请求 ID 已在处理中', false);
      return;
    }
    if (this.inFlight.size >= MAX_IN_FLIGHT_REQUESTS) {
      this.sendError(request, 'runtime_busy', 'Runtime 请求队列已满', true);
      return;
    }
    const operation = this.handleRequest(request, facade, runtimeInstanceId).finally(() => {
      if (this.inFlight.get(request.requestId) === operation) this.inFlight.delete(request.requestId);
    });
    this.inFlight.set(request.requestId, operation);
  }

  private async handleRequest(
    request: RuntimeRequest,
    facade: RuntimeFacade,
    runtimeInstanceId: string
  ): Promise<void> {
    try {
      const result = await facade.handle(request.command);
      this.send({
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId,
        type: 'response',
        requestId: request.requestId,
        outcome: { ok: true, result }
      });
    } catch (error) {
      if (error instanceof RuntimeFacadeError) {
        this.sendError(request, error.code, error.message, error.retryable);
      } else {
        const publicError = toPublicError(error, 'Runtime 请求失败');
        this.sendError(request, publicError.code.toLocaleLowerCase(), publicError.message, false);
      }
    }
  }

  private sendError(
    request: RuntimeRequest,
    code: string,
    message: string,
    retryable: boolean
  ): void {
    if (!this.bootstrap) return;
    const normalizedCode = /^[a-z][a-z0-9_]{1,127}$/.test(code)
      ? code
      : 'runtime_request_failed';
    this.send({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: this.bootstrap.runtimeInstanceId,
      type: 'response',
      requestId: request.requestId,
      outcome: {
        ok: false,
        error: { code: normalizedCode, message: message.slice(0, 4_096), retryable }
      }
    });
  }

  private emitEvent(event: RuntimeEventEnvelope): void {
    if (!this.bootstrap || this.shuttingDown) return;
    this.send({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: this.bootstrap.runtimeInstanceId,
      type: 'event',
      event
    });
  }

  private async shutdown(message: RuntimeShutdown): Promise<void> {
    if (this.shuttingDown || !this.bootstrap) return;
    this.shuttingDown = true;
    this.hostCapabilities?.close();
    const deadline = Date.now() + message.deadlineMs;
    try {
      await this.facade?.stop();
      await this.app?.prepareShutdown();
      await this.drainInFlight(deadline);
      await this.app?.shutdown();
      this.send({
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId: this.bootstrap.runtimeInstanceId,
        type: 'shutdown_complete',
        requestId: message.requestId,
        completedAt: new Date().toISOString()
      });
      process.disconnect();
    } catch {
      process.exitCode = 1;
      process.disconnect();
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
      await this.facade?.stop();
      await this.app?.prepareShutdown();
      await this.drainInFlight(Date.now() + 5_000);
      await this.app?.shutdown();
    } finally {
      process.exit();
    }
  }

  private async failClosed(code: string): Promise<void> {
    process.stderr.write(`[runtime] protocol failure: ${code}\n`);
    process.exitCode = 1;
    if (this.shuttingDown) {
      if (process.connected) process.disconnect();
      return;
    }
    this.shuttingDown = true;
    this.hostCapabilities?.close();
    if (this.app) {
      try {
        await this.facade?.stop();
        await this.app.prepareShutdown();
        await this.drainInFlight(Date.now() + 5_000);
        await this.app.shutdown();
      } catch {
        // Preserve the fail-closed exit code.
      }
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

  private async drainInFlight(deadline: number): Promise<void> {
    const operations = [...this.inFlight.values()];
    if (operations.length === 0) return;
    const remainingMs = Math.max(0, deadline - Date.now());
    let deadlineTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(operations).then(() => undefined),
        new Promise<void>((resolve) => {
          deadlineTimer = setTimeout(resolve, remainingMs);
        })
      ]);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
}
