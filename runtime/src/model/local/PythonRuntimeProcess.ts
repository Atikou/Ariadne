import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import type { RuntimeCommand, RuntimeEventMessage, RuntimeRequestMessage } from "./runtimeProtocol.js";
import { createModelAbortError, ModelTimeoutError } from "../modelCancellation.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onToken?: (delta: string) => void;
  timer: NodeJS.Timeout;
  firstTokenTimer?: NodeJS.Timeout;
  tokenIdleTimer?: NodeJS.Timeout;
  cancelTimer?: NodeJS.Timeout;
  cancelError?: Error;
  tokenIdleTimeoutMs?: number;
  cancelGraceMs?: number;
  removeAbort?: () => void;
}

export class PythonRuntimeProcess {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = "";
  private disposed = false;

  constructor(
    private readonly pythonPath: string,
    private readonly workerPath: string,
    private readonly environment: NodeJS.ProcessEnv = {},
  ) {}

  static canStart(pythonPath: string, workerPath: string): boolean {
    return existsSync(pythonPath) && existsSync(workerPath);
  }

  async call<T>(
    command: RuntimeCommand,
    payload?: unknown,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onToken?: (delta: string) => void;
      firstTokenTimeoutMs?: number;
      tokenIdleTimeoutMs?: number;
      cancelGraceMs?: number;
    } = {},
  ): Promise<T> {
    if (this.disposed) throw new Error("Transformers 运行时已关闭");
    const child = this.ensureChild();
    const id = randomUUID();
    const message: RuntimeRequestMessage = { id, command, payload };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requestCancellation(id, child, new ModelTimeoutError(`Transformers 运行时总超时（${command}）`), options.cancelGraceMs);
      }, options.timeoutMs ?? 15 * 60_000);
      timer.unref?.();
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        onToken: options.onToken,
        timer,
        tokenIdleTimeoutMs: options.tokenIdleTimeoutMs,
        cancelGraceMs: options.cancelGraceMs,
      };
      this.pending.set(id, pending);
      if (options.firstTokenTimeoutMs) {
        pending.firstTokenTimer = setTimeout(() => {
          this.requestCancellation(id, child, new ModelTimeoutError("Transformers 等待首个 token 超时", "model_first_token_timeout"), options.cancelGraceMs);
        }, options.firstTokenTimeoutMs);
        pending.firstTokenTimer.unref?.();
      }
      if (options.signal) {
        const abort = (): void => {
          this.requestCancellation(id, child, createModelAbortError(options.signal?.reason), options.cancelGraceMs);
        };
        if (options.signal.aborted) {
          this.finishWithError(id, createModelAbortError(options.signal.reason));
          return;
        }
        options.signal.addEventListener("abort", abort, { once: true });
        pending.removeAbort = () => options.signal?.removeEventListener("abort", abort);
      }
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.finishWithError(id, error);
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.child) await this.call("dispose", undefined, { timeoutMs: 5_000 });
    } catch {
      // Termination below is the isolation fallback.
    }
    this.disposed = true;
    this.terminate(new Error("Transformers 运行时已关闭"));
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(this.pythonPath, ["-u", this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ...this.environment,
        PYTHONUNBUFFERED: "1",
        TOKENIZERS_PARALLELISM: "false",
      },
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) process.stderr.write(`[transformers-worker] ${text}\n`);
    });
    child.on("error", (error) => {
      if (this.child === child) this.terminate(error);
    });
    child.on("exit", (code, signal) => {
      const wasCurrent = this.child === child;
      if (wasCurrent) this.child = undefined;
      if (wasCurrent && !this.disposed) {
        this.terminate(new Error(`Transformers 子进程异常退出（code=${String(code)}, signal=${String(signal)}）`));
      }
    });
    this.child = child;
    return child;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handleMessage(JSON.parse(line) as RuntimeEventMessage);
      } catch (error) {
        this.terminate(new Error(`Transformers worker 返回了无效 JSON：${String(error)}`));
      }
    }
  }

  private handleMessage(message: RuntimeEventMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "token") {
      if (pending.cancelError) return;
      if (pending.firstTokenTimer) {
        clearTimeout(pending.firstTokenTimer);
        pending.firstTokenTimer = undefined;
      }
      if (pending.tokenIdleTimer) clearTimeout(pending.tokenIdleTimer);
      if (pending.tokenIdleTimeoutMs) {
        pending.tokenIdleTimer = setTimeout(() => {
          const child = this.child;
          if (child) this.requestCancellation(message.id, child, new ModelTimeoutError("Transformers token 流空闲超时", "model_token_idle_timeout"), pending.cancelGraceMs);
        }, pending.tokenIdleTimeoutMs);
        pending.tokenIdleTimer.unref?.();
      }
      pending.onToken?.(message.delta);
      return;
    }
    this.pending.delete(message.id);
    this.clearPending(pending);
    if (pending.cancelError) pending.reject(pending.cancelError);
    else if (message.type === "cancelled") pending.reject(createModelAbortError());
    else if (message.type === "error") pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  private finishWithError(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.clearPending(pending);
    pending.reject(error);
  }

  private terminate(error: Error): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    for (const id of [...this.pending.keys()]) this.finishWithError(id, error);
  }

  isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  private requestCancellation(
    id: string,
    child: ChildProcessWithoutNullStreams,
    error: Error,
    graceMs = 1_000,
  ): void {
    const pending = this.pending.get(id);
    if (!pending || pending.cancelError) return;
    pending.cancelError = error;
    clearTimeout(pending.timer);
    if (pending.firstTokenTimer) clearTimeout(pending.firstTokenTimer);
    if (pending.tokenIdleTimer) clearTimeout(pending.tokenIdleTimer);
    child.stdin.write(`${JSON.stringify({ id, command: "cancel" } satisfies RuntimeRequestMessage)}\n`);
    pending.cancelTimer = setTimeout(() => {
      if (this.pending.has(id)) this.terminate(error);
    }, Math.max(50, graceMs));
    pending.cancelTimer.unref?.();
  }

  private clearPending(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.firstTokenTimer) clearTimeout(pending.firstTokenTimer);
    if (pending.tokenIdleTimer) clearTimeout(pending.tokenIdleTimer);
    if (pending.cancelTimer) clearTimeout(pending.cancelTimer);
    pending.removeAbort?.();
  }
}
