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
  type AgentPermissionsBootstrap,
  type ModelProviderBootstrap,
  type RuntimeReady,
  type RuntimeResponse,
  type RuntimeToHostMessage
} from '@ariadne/protocol/host';
import {
  runtimeCommandSchema,
  type RuntimeCommand,
  type RuntimeEvent,
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
  installRoot: string;
  dataRoot: string;
  modelRoots: string[];
  modelProviders: ModelProviderBootstrap[];
  routingStrategy: 'local-first' | 'cloud-first' | 'privacy-first' | 'quality-first';
  agentPermissions: AgentPermissionsBootstrap;
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
}

interface PendingRequest {
  resolve(result: RuntimeResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
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
  resolve(): void;
}

export class RuntimeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'RuntimeRequestError';
  }
}

export class RuntimeSupervisor {
  private options: RuntimeSupervisorOptions;
  private child: ChildProcess | null = null;
  private runtimeInstanceId: string | null = null;
  private startup: StartupAttempt | null = null;
  private shutdownAttempt: ShutdownAttempt | null = null;
  private readySnapshot: RuntimeReady | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private restartTimer: NodeJS.Timeout | null = null;
  private restartStabilityTimer: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private lastSequence = 0;
  private lastDiagnostic: string | null = null;
  private stopping = false;
  private disposed = false;
  private capabilities: RuntimeStatus['capabilities'] = [];
  private currentStatus: RuntimeStatus = this.createStatus('stopped');
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: RuntimeEvent) => void>();
  private readonly statusListeners = new Set<(status: RuntimeStatus) => void>();

  constructor(options: RuntimeSupervisorOptions) {
    assertSupervisorOptions(options);
    this.options = options;
    this.clearRestartStabilityTimer();
  }

  getStatus(): RuntimeStatus {
    return structuredClone(this.currentStatus);
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
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
    this.lastSequence = 0;
    this.lastDiagnostic = null;
    this.readySnapshot = null;
  }

  async restart(options: RuntimeSupervisorOptions): Promise<RuntimeReady> {
    assertSupervisorOptions(options);
    return this.runLifecycleOperation(async () => {
      await this.shutdownNow('restart', false);
      this.options = options;
      this.disposed = false;
      this.stopping = false;
      this.restartCount = 0;
      this.clearRestartStabilityTimer();
      this.lastSequence = 0;
      this.lastDiagnostic = null;
      this.readySnapshot = null;
      return this.startNow();
    });
  }

  async start(): Promise<RuntimeReady> {
    return this.runLifecycleOperation(() => this.startNow());
  }

  private async startNow(): Promise<RuntimeReady> {
    if (this.disposed) throw new RuntimeRequestError('runtime_stopped', 'Runtime 已停止。', false);
    if (this.startup) return this.startup.promise;
    if (this.child && this.currentStatus.availability === 'ready') {
      return this.toReadySnapshot();
    }

    this.stopping = false;
    this.lastDiagnostic = null;
    this.readySnapshot = null;
    this.setStatus(this.restartCount > 0 ? 'restarting' : 'starting');
    mkdirSync(this.options.dataRoot, { recursive: true });
    const runtimeInstanceId = randomUUID();
    this.runtimeInstanceId = runtimeInstanceId;

    let resolveStartup!: (ready: RuntimeReady) => void;
    let rejectStartup!: (error: Error) => void;
    const promise = new Promise<RuntimeReady>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    const timer = setTimeout(() => {
      this.failStartup(new RuntimeRequestError('runtime_handshake_timeout', 'Runtime 启动超时。', true));
      this.child?.kill();
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
      await this.send(child, this.createBootstrap(runtimeInstanceId));
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

  async request(commandInput: RuntimeCommand): Promise<RuntimeResult> {
    const command = runtimeCommandSchema.parse(commandInput);
    await this.start();
    const child = this.child;
    const runtimeInstanceId = this.runtimeInstanceId;
    if (!child?.connected || !runtimeInstanceId || this.currentStatus.availability !== 'ready') {
      throw new RuntimeRequestError('runtime_unavailable', 'Runtime 当前不可用。', true);
    }

    const requestId = randomUUID();
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<RuntimeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RuntimeRequestError('runtime_request_timeout', 'Runtime 请求超时。', true));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      void this.send(child, {
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId,
        type: 'request',
        requestId,
        command
      }).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(toError(error, 'Runtime 请求发送失败。'));
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
    this.rejectPending(new RuntimeRequestError('runtime_stopped', 'Runtime 已停止。', false));
    this.failStartup(new RuntimeRequestError('runtime_stopped', 'Runtime 已停止。', false));

    const child = this.child;
    const runtimeInstanceId = this.runtimeInstanceId;
    if (!child || child.exitCode !== null || !child.connected || !runtimeInstanceId) {
      if (child === this.child) {
        this.child = null;
        this.runtimeInstanceId = null;
        this.readySnapshot = null;
      }
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      this.setStatus('stopped');
      return;
    }

    const requestId = randomUUID();
    const completed = new Promise<void>((resolve) => {
      this.shutdownAttempt = { child, requestId, resolve };
    });
    const exited = waitForExit(child);
    try {
      await this.send(child, {
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId,
        type: 'shutdown',
        requestId,
        reason,
        deadlineMs: this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
      });
      await Promise.race([
        completed,
        exited,
        delay(this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS)
      ]);
    } catch {
      // The child error listener owns the public failure state. Shutdown still
      // guarantees that the failed child is reaped before this operation ends.
    } finally {
      if (this.shutdownAttempt?.child === child) this.shutdownAttempt = null;
      if (this.child === child) {
        this.child = null;
        this.runtimeInstanceId = null;
        this.readySnapshot = null;
      }
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.race([exited, delay(2_000)]);
      this.setStatus('stopped');
    }
  }

  private createBootstrap(runtimeInstanceId: string): RuntimeBootstrap {
    return {
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'bootstrap',
      appVersion: this.options.appVersion,
      runtimeVersion: this.options.runtimeVersion,
      installRoot: this.options.installRoot,
      dataRoot: this.options.dataRoot,
      modelRoots: [...this.options.modelRoots],
      modelProviders: this.options.modelProviders.map((provider) => ({ ...provider })),
      routingStrategy: this.options.routingStrategy,
      agentPermissions: structuredClone(this.options.agentPermissions),
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
      case 'event':
        if (message.sequence <= this.lastSequence) {
          this.handleProtocolViolation('Runtime 事件序号未单调递增。');
          return;
        }
        this.lastSequence = message.sequence;
        this.notifyEventListeners(message.event);
        return;
      case 'shutdown_complete':
        if (
          this.shutdownAttempt?.child === child
          && this.shutdownAttempt.requestId === message.requestId
        ) {
          this.shutdownAttempt.resolve();
        }
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
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.outcome.ok) pending.resolve(message.outcome.result);
    else pending.reject(new RuntimeRequestError(
      message.outcome.error.code,
      message.outcome.error.message,
      message.outcome.error.retryable
    ));
  }

  private handleChildError(child: ChildProcess, error: Error): void {
    if (child !== this.child) return;
    this.handleChildFailure(child, toError(error, 'Runtime 进程启动失败。'));
  }

  private handleChildFailure(child: ChildProcess, error: Error): void {
    if (child !== this.child) return;
    this.clearRestartStabilityTimer();
    this.child = null;
    this.runtimeInstanceId = null;
    this.readySnapshot = null;
    this.lastSequence = 0;
    if (this.shutdownAttempt?.child === child) this.shutdownAttempt.resolve();
    this.failStartup(error);
    this.rejectPending(error);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (!this.stopping && !this.disposed) {
      this.setStatus('crashed', error.message);
      this.scheduleRestart();
    } else {
      this.setStatus('stopped');
    }
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return;
    this.clearRestartStabilityTimer();
    this.child = null;
    this.runtimeInstanceId = null;
    this.readySnapshot = null;
    this.lastSequence = 0;
    if (this.shutdownAttempt?.child === child) this.shutdownAttempt.resolve();
    const unexpected = !this.stopping && !this.disposed;
    const detail = unexpected
      ? `Runtime 意外退出（${code === null ? signal ?? 'unknown' : `code ${code}`}）${this.lastDiagnostic ? `：${this.lastDiagnostic}` : '。'}`
      : undefined;
    const error = new RuntimeRequestError('runtime_exited', detail ?? 'Runtime 已退出。', unexpected);
    this.failStartup(error);
    this.rejectPending(error);
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
    this.rejectPending(new RuntimeRequestError('runtime_protocol_violation', detail, true));
    this.child?.kill();
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

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
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
    const event: RuntimeEvent = { kind: 'runtime.status.changed', status: snapshot };
    this.notifyEventListeners(event);
  }

  private notifyEventListeners(event: RuntimeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(structuredClone(event));
      } catch (error) {
        console.error('Runtime event observer failed.', error);
      }
    }
  }

  private createStatus(availability: RuntimeStatus['availability'], detail?: string): RuntimeStatus {
    return {
      availability,
      capabilities: [...this.capabilities],
      observedAt: new Date().toISOString(),
      ...(availability === 'ready' ? {
        runtimeVersion: this.readySnapshot?.runtimeVersion,
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
}

function assertAbsolutePath(label: string, value: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
}

function assertSupervisorOptions(options: RuntimeSupervisorOptions): void {
  assertAbsolutePath('runtimeEntry', options.runtimeEntry);
  assertAbsolutePath('installRoot', options.installRoot);
  assertAbsolutePath('dataRoot', options.dataRoot);
  for (const root of options.modelRoots) assertAbsolutePath('modelRoot', root);
  if (options.workspaces.length === 0) throw new Error('At least one Runtime workspace is required.');
  for (const workspace of options.workspaces) assertAbsolutePath('workspaceRoot', workspace.rootPath);
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
