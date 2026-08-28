import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  parseHostToRuntimeMessage,
  parseRuntimeToHostMessage,
  type RuntimeBootstrap,
  type RuntimeCancel,
  type AgentPermissionsBootstrap,
  type ModelProviderBootstrap,
  type RuntimeReady,
  type RuntimeResponse,
  type RuntimeCapabilityRequest,
  agentAdmissionAuthoritySourceSchema,
  type AgentAdmissionAuthoritySource,
  type RuntimeToHostMessage
} from '@ariadne/protocol/host';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { readRuntimeBuildManifest } from './runtime-build-manifest';
import {
  runtimeCommandSchema,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type RuntimeResult,
  type RuntimeStatus
} from '@ariadne/protocol/public';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_RESTART_DELAYS_MS = [250, 1_000, 4_000] as const;
const DEFAULT_RESTART_STABILITY_MS = 30_000;

export interface RuntimeWorkspaceConfiguration {
  workspaceId: string;
  label: string;
  rootPath: string;
  access: 'read' | 'write';
}

export interface RuntimeSupervisorOptions {
  runtimeEntry: string;
  runtimeBuildManifestPath?: string;
  runtimeBuildFingerprint?: string;
  installRoot: string;
  dataRoot: string;
  modelRoots: string[];
  modelProviders: ModelProviderBootstrap[];
  routingStrategy: 'local-first' | 'cloud-first' | 'privacy-first' | 'quality-first';
  agentPermissions: AgentPermissionsBootstrap;
  agentAdmissionAuthoritySource: AgentAdmissionAuthoritySource;
  runtimePolicy: RuntimePolicySnapshot;
  workspaces: RuntimeWorkspaceConfiguration[];
  profile: string;
  appVersion: string;
  runtimeVersion: string;
  production: boolean;
  executablePath?: string;
  environment?: NodeJS.ProcessEnv;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  restartDelaysMs?: readonly number[];
  restartStabilityMs?: number;
  capabilityHandler?: (
    request: RuntimeCapabilityRequest
  ) => Promise<Record<string, unknown>>;
}

interface PendingRequest {
  commandId: string;
  resolve(result: RuntimeResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

interface StartupAttempt {
  promise: Promise<RuntimeReady>;
  resolve(ready: RuntimeReady): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ShutdownAttempt {
  child: ChildProcess;
  requestId: string;
  completed: boolean;
}

export class RuntimeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly correlationId: string = randomUUID(),
    readonly details?: readonly string[]
  ) {
    super(message);
    this.name = 'RuntimeRequestError';
  }
}

export interface RuntimeRequestOptions {
  commandId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class RuntimeSupervisor {
  private options: RuntimeSupervisorOptions;
  private child: ChildProcess | null = null;
  private runtimeInstanceId: string | null = null;
  private startup: StartupAttempt | null = null;
  private shutdownAttempt: ShutdownAttempt | null = null;
  private readySnapshot: RuntimeReady | null = null;
  private activeBuildFingerprint: string | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private restartTimer: NodeJS.Timeout | null = null;
  private restartStabilityTimer: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private lastEventCursor = 0;
  private eventDeliveryQueue: Promise<void> = Promise.resolve();
  private lastDiagnostic: string | null = null;
  private stopping = false;
  private disposed = false;
  private capabilities: RuntimeStatus['capabilities'] = [];
  private statusClock = 0;
  private currentStatus: RuntimeStatus = this.createStatus('stopped');
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: RuntimeEventEnvelope) => void>();
  private readonly statusListeners = new Set<(status: RuntimeStatus) => void>();

  constructor(options: RuntimeSupervisorOptions) {
    assertSupervisorOptions(options);
    this.options = options;
    this.clearRestartStabilityTimer();
  }

  getStatus(): RuntimeStatus {
    return structuredClone(this.currentStatus);
  }

  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (status: RuntimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  configure(options: RuntimeSupervisorOptions): void {
    if (this.child || this.startup || this.currentStatus.availability !== 'stopped') {
      throw new Error('Runtime 运行期间不能直接替换配置。');
    }
    assertSupervisorOptions(options);
    this.options = options;
    this.disposed = false;
    this.stopping = false;
    this.restartCount = 0;
    this.clearRestartStabilityTimer();
    this.lastEventCursor = 0;
    this.lastDiagnostic = null;
    this.readySnapshot = null;
    this.activeBuildFingerprint = null;
  }

  async restart(options: RuntimeSupervisorOptions): Promise<RuntimeReady> {
    assertSupervisorOptions(options);
    return this.runLifecycleOperation(async () => {
      return this.restartNow(options, 'restart');
    });
  }

  async start(): Promise<RuntimeReady> {
    return this.runLifecycleOperation(async () => {
      if (this.options.workspaces.length === 0) {
        throw new RuntimeRequestError('runtime_workspace_missing', '请先打开工作区。', false);
      }
      const buildFingerprint = this.resolveRuntimeBuildFingerprint();
      if (
        this.child
        && this.currentStatus.availability === 'ready'
        && this.readySnapshot?.runtimeBuildFingerprint !== buildFingerprint
      ) {
        return this.restartNow(this.options, 'upgrade', buildFingerprint);
      }
      return this.startNow(buildFingerprint);
    });
  }

  private async restartNow(
    options: RuntimeSupervisorOptions,
    reason: 'restart' | 'upgrade',
    buildFingerprint = resolveRuntimeBuildFingerprint(options)
  ): Promise<RuntimeReady> {
    await this.shutdownNow(reason, false);
    this.options = options;
    this.disposed = false;
    this.stopping = false;
    this.restartCount = 0;
    this.clearRestartStabilityTimer();
    this.lastEventCursor = 0;
    this.lastDiagnostic = null;
    this.readySnapshot = null;
    this.activeBuildFingerprint = null;
    return this.startNow(buildFingerprint);
  }

  private async startNow(
    buildFingerprint = this.resolveRuntimeBuildFingerprint()
  ): Promise<RuntimeReady> {
    if (this.disposed) throw new RuntimeRequestError('runtime_stopped', 'Runtime 已停止。', false);
    if (this.startup) return this.startup.promise;
    if (this.child && this.currentStatus.availability === 'ready') {
      return this.toReadySnapshot();
    }
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      throw new RuntimeRequestError(
        'runtime_previous_process_alive',
        'The previous Runtime process has not exited; replacement is blocked.',
        false
      );
    }

    this.stopping = false;
    this.activeBuildFingerprint = buildFingerprint;
    this.lastDiagnostic = null;
    this.readySnapshot = null;
    this.setStatus(this.restartCount > 0 ? 'restarting' : 'starting');
    mkdirSync(this.options.dataRoot, { recursive: true });
    const runtimeInstanceId = randomUUID();
    this.runtimeInstanceId = runtimeInstanceId;
    this.eventDeliveryQueue = Promise.resolve();

    let resolveStartup!: (ready: RuntimeReady) => void;
    let rejectStartup!: (error: Error) => void;
    const promise = new Promise<RuntimeReady>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    const timer = setTimeout(() => {
      const diagnostic = this.lastDiagnostic ? `（${this.lastDiagnostic}）` : '';
      this.failStartup(new RuntimeRequestError(
        'runtime_handshake_timeout',
        `Runtime 启动超时${diagnostic}。`,
        true
      ));
      const child = this.child;
      if (child) {
        this.setStatus('crashed', 'Runtime handshake timed out; waiting for the old process to exit.');
        child.kill();
      }
    }, this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.startup = { promise, resolve: resolveStartup, reject: rejectStartup, timer };

    try {
      const child = fork(this.options.runtimeEntry, [], {
        cwd: this.options.installRoot,
        execPath: this.options.executablePath,
        env: this.options.environment ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      this.child = child;
      child.stdout?.resume();
      child.stderr?.on('data', (chunk: Buffer | string) => this.captureDiagnostic(chunk));
      child.on('message', (raw) => this.handleMessage(child, raw));
      child.on('error', (error) => this.handleChildError(child, error));
      child.once('exit', (code, signal) => this.handleExit(child, code, signal));
      await this.send(child, this.createBootstrap(runtimeInstanceId, buildFingerprint));
    } catch (error) {
      const startupError = toError(error, 'Runtime 进程无法启动。');
      const child = this.child;
      if (child) this.handleChildFailure(child, startupError);
      else if (this.startup) {
        this.runtimeInstanceId = null;
        this.failStartup(startupError);
        this.setStatus('crashed', startupError.message);
        this.scheduleRestart();
      }
    }

    return promise;
  }

  async request(
    commandInput: RuntimeCommand,
    options: RuntimeRequestOptions = {}
  ): Promise<RuntimeResult> {
    const command = runtimeCommandSchema.parse(commandInput);
    const commandId = options.commandId ?? randomUUID();
    if (options.signal?.aborted) {
      throw new RuntimeRequestError(
        'runtime_request_cancelled',
        'Runtime 请求在发送前已取消。',
        false,
        commandId
      );
    }
    await this.start();
    if (options.signal?.aborted) {
      throw new RuntimeRequestError(
        'runtime_request_cancelled',
        'Runtime request was cancelled while the Runtime was starting.',
        false,
        commandId
      );
    }
    const child = this.child;
    const runtimeInstanceId = this.runtimeInstanceId;
    if (!child?.connected || !runtimeInstanceId || this.currentStatus.availability !== 'ready') {
      throw new RuntimeRequestError('runtime_unavailable', 'Runtime 当前不可用。', true);
    }

    const requestId = randomUUID();
    const timeoutMs = options.timeoutMs
      ?? this.options.requestTimeoutMs
      ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    return new Promise<RuntimeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancelPendingRequest(
          requestId,
          'deadline_exceeded',
          new RuntimeRequestError(
            'runtime_request_timeout',
            'Runtime request timed out; reuse the same commandId to reconcile the outcome safely.',
            false,
            commandId
          )
        );
      }, timeoutMs);
      const abort = (): void => {
        this.cancelPendingRequest(
          requestId,
          'caller_cancelled',
          new RuntimeRequestError(
            'runtime_request_cancelled',
            'Runtime 请求已由调用方取消。',
            false,
            commandId
          )
        );
      };
      const removeAbortListener = options.signal
        ? () => options.signal?.removeEventListener('abort', abort)
        : undefined;
      options.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(requestId, {
        commandId,
        resolve,
        reject,
        timer,
        ...(removeAbortListener ? { removeAbortListener } : {})
      });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      void this.send(child, {
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId,
        type: 'request',
        requestId,
        commandId,
        deadlineAt,
        command
      }).catch((error: unknown) => {
        clearTimeout(timer);
        const pending = this.pending.get(requestId);
        pending?.removeAbortListener?.();
        this.pending.delete(requestId);
        reject(new RuntimeRequestError(
          'runtime_request_send_failed',
          toError(error, 'Runtime 请求发送失败。').message,
          true,
          commandId
        ));
      });
    });
  }

  async stop(reason: 'app_quit' | 'restart' | 'upgrade' | 'user_request' = 'app_quit'): Promise<void> {
    await this.runLifecycleOperation(() => this.shutdownNow(reason, true));
  }

  private async shutdownNow(
    reason: 'app_quit' | 'restart' | 'upgrade' | 'user_request',
    dispose: boolean
  ): Promise<void> {
    this.disposed = dispose;
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearRestartStabilityTimer();
    this.rejectPendingUncertain('Runtime stopped before confirming the command outcome.');
    this.failStartup(new RuntimeRequestError('runtime_stopped', 'Runtime 已停止。', false));

    const child = this.child;
    const runtimeInstanceId = this.runtimeInstanceId;
    if (!child) {
      this.setStatus('stopped');
      return;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      this.releaseExitedChild(child);
      this.setStatus('stopped');
      return;
    }

    const timeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const deadlineAt = Date.now() + timeoutMs;
    const exitReserveMs = Math.min(2_000, Math.max(250, Math.floor(timeoutMs * 0.25)));
    const gracefulExitDeadline = deadlineAt - exitReserveMs;
    const requestId = randomUUID();
    this.shutdownAttempt = { child, requestId, completed: false };
    const exited = waitForExit(child);
    try {
      if (child.connected && runtimeInstanceId) {
        await this.send(child, {
          protocol: ARIADNE_RUNTIME_PROTOCOL,
          protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
          runtimeInstanceId,
          type: 'shutdown',
          requestId,
          reason,
          deadlineAt: new Date(deadlineAt).toISOString()
        });
      }
      const exitedGracefully = await waitForExitUntil(exited, gracefulExitDeadline);
      if (!exitedGracefully && child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      const exitedAfterKill = child.exitCode !== null
        || child.signalCode !== null
        || await waitForExitUntil(exited, deadlineAt);
      if (!exitedAfterKill) {
        this.setStatus(
          'crashed',
          'Runtime process did not exit after termination; replacement is blocked.'
        );
        throw new RuntimeRequestError(
          'runtime_process_exit_timeout',
          'Runtime process did not exit before the shutdown deadline.',
          false
        );
      }
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const exitedAfterKill = await waitForExitUntil(exited, deadlineAt);
        if (!exitedAfterKill) {
          this.setStatus(
            'crashed',
            'Runtime process did not exit after termination; replacement is blocked.'
          );
          throw new RuntimeRequestError(
            'runtime_process_exit_timeout',
            'Runtime process did not exit before the shutdown deadline.',
            false
          );
        }
      }
    } finally {
      if (this.shutdownAttempt?.child === child) this.shutdownAttempt = null;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.releaseExitedChild(child);
      this.setStatus('stopped');
    }
  }

  private createBootstrap(
    runtimeInstanceId: string,
    runtimeBuildFingerprint: string
  ): RuntimeBootstrap {
    return {
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'bootstrap',
      appVersion: this.options.appVersion,
      runtimeVersion: this.options.runtimeVersion,
      runtimeBuildFingerprint,
      installRoot: this.options.installRoot,
      dataRoot: this.options.dataRoot,
      modelRoots: [...this.options.modelRoots],
      modelProviders: this.options.modelProviders.map((provider) => ({ ...provider })),
      routingStrategy: this.options.routingStrategy,
      agentPermissions: structuredClone(this.options.agentPermissions),
      agentAdmissionAuthoritySource: structuredClone(
        this.options.agentAdmissionAuthoritySource
      ),
      runtimePolicy: structuredClone(this.options.runtimePolicy),
      profile: this.options.profile,
      workspaces: this.options.workspaces.map((workspace) => ({ ...workspace })),
      production: this.options.production
    };
  }

  private handleMessage(child: ChildProcess, raw: unknown): void {
    if (child !== this.child) return;
    let message: RuntimeToHostMessage;
    try {
      message = parseRuntimeToHostMessage(raw);
    } catch {
      this.handleProtocolViolation('Runtime 返回了无效协议消息。');
      return;
    }
    if (message.runtimeInstanceId !== this.runtimeInstanceId) {
      this.handleProtocolViolation('Runtime 实例标识不匹配。');
      return;
    }
    switch (message.type) {
      case 'ready':
        this.handleReady(message);
        return;
      case 'response':
        this.handleResponse(message);
        return;
      case 'cancel_acknowledged':
        return;
      case 'event':
        {
          const eventRuntimeInstanceId = message.runtimeInstanceId;
          const eventChild = child;
          this.eventDeliveryQueue = this.eventDeliveryQueue
            .then(async () => {
              if (
                eventChild !== this.child
                || eventRuntimeInstanceId !== this.runtimeInstanceId
              ) return;
              await this.deliverEvent(message.event, eventChild, eventRuntimeInstanceId);
            })
            .catch((error) => {
              if (
                eventChild !== this.child
                || eventRuntimeInstanceId !== this.runtimeInstanceId
              ) return;
              this.handleProtocolViolation(toError(error, 'Runtime event replay failed.').message);
            });
        }
        return;
      case 'capability_request':
        void this.handleCapabilityRequest(child, message);
        return;
      case 'shutdown_complete':
        if (
          this.shutdownAttempt?.child === child
          && this.shutdownAttempt.requestId === message.requestId
        ) {
          this.shutdownAttempt.completed = true;
        }
    }
  }

  private async handleCapabilityRequest(
    child: ChildProcess,
    message: RuntimeCapabilityRequest
  ): Promise<void> {
    const handler = this.options.capabilityHandler;
    try {
      if (!handler) throw new Error('host_capability_unavailable');
      const result = await handler(message);
      if (child !== this.child || message.runtimeInstanceId !== this.runtimeInstanceId) return;
      await this.send(child, {
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId: message.runtimeInstanceId,
        type: 'capability_response',
        requestId: message.requestId,
        outcome: { ok: true, result }
      });
    } catch (error) {
      if (child !== this.child || message.runtimeInstanceId !== this.runtimeInstanceId) return;
      const failure = toError(error, 'Host capability failed.');
      await this.send(child, {
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId: message.runtimeInstanceId,
        type: 'capability_response',
        requestId: message.requestId,
        outcome: {
          ok: false,
          error: {
            code: 'host_capability_failed',
            message: failure.message.slice(0, 1_024),
            retryable: false,
            correlationId: message.requestId
          }
        }
      }).catch(() => undefined);
    }
  }

  private handleReady(message: RuntimeReady): void {
    if (!this.startup || this.currentStatus.availability === 'ready') {
      this.handleProtocolViolation('Runtime 重复发送就绪消息。');
      return;
    }
    if (message.runtimeVersion !== this.options.runtimeVersion) {
      this.handleProtocolViolation(
        `Runtime 版本不匹配：期望 ${this.options.runtimeVersion}，实际 ${message.runtimeVersion}。`
      );
      return;
    }
    if (message.runtimeBuildFingerprint !== this.activeBuildFingerprint) {
      this.handleProtocolViolation(
        'Runtime 构建身份不匹配；拒绝连接旧构建。'
      );
      return;
    }
    clearTimeout(this.startup.timer);
    const startup = this.startup;
    this.startup = null;
    this.readySnapshot = structuredClone(message);
    this.capabilities = [...message.capabilities];
    this.setStatus('ready');
    this.scheduleRestartCountReset();
    startup.resolve(message);
  }

  private handleResponse(message: RuntimeResponse): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (pending.commandId !== message.commandId) {
      this.handleProtocolViolation('Runtime 响应的逻辑命令标识不匹配。');
      return;
    }
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    this.pending.delete(message.requestId);
    if (message.outcome.ok) pending.resolve(message.outcome.result);
    else pending.reject(new RuntimeRequestError(
      message.outcome.error.code,
      message.outcome.error.message,
      message.outcome.error.retryable,
      message.outcome.error.correlationId,
      message.outcome.error.details
    ));
  }

  private cancelPendingRequest(
    requestId: string,
    reason: RuntimeCancel['reason'],
    error: RuntimeRequestError
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    this.pending.delete(requestId);
    pending.reject(error);

    const child = this.child;
    const runtimeInstanceId = this.runtimeInstanceId;
    if (!child?.connected || !runtimeInstanceId) return;
    void this.send(child, {
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'cancel',
      cancelRequestId: randomUUID(),
      targetRequestId: requestId,
      commandId: pending.commandId,
      reason
    }).catch(() => undefined);
  }

  private handleChildError(child: ChildProcess, error: Error): void {
    if (child !== this.child) return;
    this.handleChildFailure(child, toError(error, 'Runtime 进程启动失败。'));
  }

  private handleChildFailure(child: ChildProcess, error: Error): void {
    if (child !== this.child) return;
    this.clearRestartStabilityTimer();
    this.readySnapshot = null;
    this.activeBuildFingerprint = null;
    this.failStartup(error);
    this.rejectPendingUncertain(error.message);
    if (child.pid === undefined) {
      this.releaseExitedChild(child);
      if (!this.stopping && !this.disposed) {
        this.setStatus('crashed', error.message);
        this.scheduleRestart();
      } else {
        this.setStatus('stopped');
      }
      return;
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    this.setStatus(
      this.stopping || this.disposed ? 'stopped' : 'crashed',
      this.stopping || this.disposed ? undefined : `${error.message} Waiting for process exit.`
    );
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return;
    this.clearRestartStabilityTimer();
    this.releaseExitedChild(child);
    const unexpected = !this.stopping && !this.disposed;
    const detail = unexpected
      ? `Runtime 意外退出（${code === null ? signal ?? 'unknown' : `code ${code}`}）${this.lastDiagnostic ? `：${this.lastDiagnostic}` : '。'}`
      : undefined;
    const error = new RuntimeRequestError('runtime_exited', detail ?? 'Runtime 已退出。', unexpected);
    this.failStartup(error);
    this.rejectPendingUncertain(error.message);
    if (unexpected) {
      console.error(`Runtime child exited unexpectedly${this.lastDiagnostic ? `: ${this.lastDiagnostic}` : '.'}`);
      this.setStatus('crashed', detail);
      this.scheduleRestart();
    } else {
      this.setStatus('stopped');
    }
  }

  private handleProtocolViolation(detail: string): void {
    this.failStartup(new RuntimeRequestError('runtime_protocol_violation', detail, true));
    this.rejectPendingUncertain(detail);
    const child = this.child;
    if (child) {
      this.setStatus('crashed', `${detail} Waiting for process exit.`);
      child.kill();
    }
  }

  private releaseExitedChild(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.runtimeInstanceId = null;
    this.readySnapshot = null;
    this.activeBuildFingerprint = null;
  }

  private captureDiagnostic(chunk: Buffer | string): void {
    const text = chunk.toString();
    for (const match of text.matchAll(/\[runtime\]\s+([a-z ]+):\s*([a-z0-9_]+)/gi)) {
      const category = match[1]?.trim().replace(/\s+/g, '_').toLocaleLowerCase();
      const code = match[2]?.toLocaleLowerCase();
      if (category && code && (category === 'initialization_failed' || !this.lastDiagnostic)) {
        this.lastDiagnostic = `${category}:${code}`.slice(0, 256);
      }
    }
  }

  private scheduleRestart(): void {
    if (this.disposed || this.stopping || this.restartTimer) return;
    const delays = this.options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    const delayMs = delays[this.restartCount];
    if (delayMs === undefined) {
      this.setStatus('disabled', 'Runtime 连续崩溃，已停止自动重启。');
      return;
    }
    this.restartCount += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch(() => {
        // Exit/error handlers publish the stable public status.
      });
    }, delayMs);
  }

  private scheduleRestartCountReset(): void {
    this.clearRestartStabilityTimer();
    if (this.restartCount === 0) return;
    this.restartStabilityTimer = setTimeout(() => {
      this.restartStabilityTimer = null;
      if (this.currentStatus.availability === 'ready') this.restartCount = 0;
    }, this.options.restartStabilityMs ?? DEFAULT_RESTART_STABILITY_MS);
    this.restartStabilityTimer.unref?.();
  }

  private clearRestartStabilityTimer(): void {
    if (this.restartStabilityTimer) clearTimeout(this.restartStabilityTimer);
    this.restartStabilityTimer = null;
  }

  private failStartup(error: Error): void {
    if (!this.startup) return;
    clearTimeout(this.startup.timer);
    const startup = this.startup;
    this.startup = null;
    startup.reject(error);
  }

  private rejectPendingUncertain(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(new RuntimeRequestError(
        'command_outcome_uncertain',
        'Runtime disconnected before the command outcome was confirmed; reconcile with the same commandId.',
        false,
        pending.commandId,
        [reason]
      ));
    }
    this.pending.clear();
  }

  private async send(child: ChildProcess, message: unknown): Promise<void> {
    if (child !== this.child || !child.connected) {
      throw new RuntimeRequestError('runtime_unavailable', 'Runtime IPC 已断开。', true);
    }
    const parsed = parseHostToRuntimeMessage(message);
    await new Promise<void>((resolve, reject) => {
      child.send(parsed, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private setStatus(availability: RuntimeStatus['availability'], detail?: string): void {
    this.currentStatus = this.createStatus(availability, detail);
    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(structuredClone(snapshot));
      } catch (error) {
        console.error('Runtime status observer failed.', error);
      }
    }
  }

  private async deliverEvent(
    event: RuntimeEventEnvelope,
    sourceChild: ChildProcess,
    sourceRuntimeInstanceId: string
  ): Promise<void> {
    const isCurrentEpoch = (): boolean => (
      sourceChild === this.child
      && sourceRuntimeInstanceId === this.runtimeInstanceId
    );
    if (!isCurrentEpoch()) return;
    if (event.cursor <= this.lastEventCursor) return;
    // Public Runtime events are coalescible Projection wake hints, not an
    // authoritative event stream. A cursor gap is recovered by Renderer
    // Projection synchronization and must never invoke the retired replay API.
    this.notifyEventListeners(event);
    this.lastEventCursor = event.cursor;
  }

  private notifyEventListeners(event: RuntimeEventEnvelope): void {
    for (const listener of this.eventListeners) {
      try {
        listener(structuredClone(event));
      } catch (error) {
        console.error('Runtime event observer failed.', error);
      }
    }
  }

  private createStatus(availability: RuntimeStatus['availability'], detail?: string): RuntimeStatus {
    this.statusClock = Math.max(Date.now(), this.statusClock + 1);
    return {
      availability,
      capabilities: [...this.capabilities],
      observedAt: new Date(this.statusClock).toISOString(),
      ...(availability === 'ready' ? {
        runtimeVersion: this.readySnapshot?.runtimeVersion,
        runtimeBuildFingerprint: this.readySnapshot?.runtimeBuildFingerprint,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION
      } : {}),
      ...(detail ? { detail } : {})
    };
  }

  private toReadySnapshot(): RuntimeReady {
    if (!this.runtimeInstanceId || !this.readySnapshot) {
      throw new Error('Runtime ready state is incomplete.');
    }
    return structuredClone(this.readySnapshot);
  }

  private runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private resolveRuntimeBuildFingerprint(): string {
    return resolveRuntimeBuildFingerprint(this.options);
  }
}

function resolveRuntimeBuildFingerprint(options: RuntimeSupervisorOptions): string {
  if (options.runtimeBuildManifestPath) {
    const manifest = readRuntimeBuildManifest(options.runtimeBuildManifestPath);
    if (manifest.runtimeVersion !== options.runtimeVersion) {
      throw new Error(
        `Runtime 构建清单版本不匹配：期望 ${options.runtimeVersion}，实际 ${manifest.runtimeVersion}。`
      );
    }
    return manifest.fingerprint;
  }
  if (options.runtimeBuildFingerprint) return options.runtimeBuildFingerprint;
  throw new Error('Runtime 构建身份未配置。');
}

function assertAbsolutePath(label: string, value: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
}

function assertSupervisorOptions(options: RuntimeSupervisorOptions): void {
  assertAbsolutePath('runtimeEntry', options.runtimeEntry);
  if (options.runtimeBuildManifestPath) {
    assertAbsolutePath('runtimeBuildManifestPath', options.runtimeBuildManifestPath);
  }
  if (!options.runtimeBuildManifestPath && !options.runtimeBuildFingerprint) {
    throw new Error('Runtime build identity is required.');
  }
  if (
    options.runtimeBuildFingerprint
    && !/^[a-f0-9]{64}$/.test(options.runtimeBuildFingerprint)
  ) {
    throw new Error('runtimeBuildFingerprint must be a SHA-256 value.');
  }
  assertAbsolutePath('installRoot', options.installRoot);
  assertAbsolutePath('dataRoot', options.dataRoot);
  for (const root of options.modelRoots) assertAbsolutePath('modelRoot', root);
  for (const workspace of options.workspaces) assertAbsolutePath('workspaceRoot', workspace.rootPath);
  agentAdmissionAuthoritySourceSchema.parse(options.agentAdmissionAuthoritySource);
  if (options.restartStabilityMs !== undefined && options.restartStabilityMs <= 0) {
    throw new Error('restartStabilityMs must be positive.');
  }
  const providerNames = new Set<string>();
  for (const provider of options.modelProviders) {
    if (providerNames.has(provider.name)) throw new Error(`Duplicate Runtime model provider: ${provider.name}`);
    providerNames.add(provider.name);
    const url = new URL(provider.baseUrl);
    if (url.protocol !== 'https:') throw new Error('Runtime model providers require HTTPS.');
  }
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function waitForExitUntil(exit: Promise<void>, deadlineAt: number): Promise<boolean> {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
