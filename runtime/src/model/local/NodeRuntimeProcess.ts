import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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

export class NodeRuntimeProcess {
  private child?: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;

  constructor(
    private readonly workerModuleUrl: URL,
    private readonly environment: NodeJS.ProcessEnv = {},
  ) {}

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
    if (this.disposed) throw new Error("本地模型运行时已关闭");
    const child = this.ensureChild();
    const id = randomUUID();
    const message: RuntimeRequestMessage = { id, command, payload };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requestCancellation(
          id,
          child,
          new ModelTimeoutError(`本地模型运行时总超时（${command}）`, "model_total_timeout"),
          options.cancelGraceMs,
        );
      }, options.timeoutMs ?? 10 * 60_000);
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
          this.requestCancellation(
            id,
            child,
            new ModelTimeoutError(`本地模型等待首个 token 超时（${command}）`, "model_first_token_timeout"),
            options.cancelGraceMs,
          );
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
      child.send?.(message, (error) => {
        if (!error) return;
        this.finishWithError(id, error);
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    try {
      await this.callBeforeDisposed(child, "dispose", 5_000);
    } catch {
      // A crashed worker is already isolated; termination below is the fallback.
    }
    child.kill();
    this.child = undefined;
  }

  isRunning(): boolean {
    return this.child?.connected === true;
  }

  private ensureChild(): ChildProcess {
    if (this.child?.connected) return this.child;
    const jsPath = fileURLToPath(this.workerModuleUrl);
    const tsPath = jsPath.replace(/\.js$/i, ".ts");
    const workerPath = existsSync(jsPath) ? jsPath : tsPath;
    const child = fork(workerPath, [], {
      execArgv: process.execArgv,
      env: { ...process.env, ...this.environment },
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) process.stderr.write(`[local-model-worker] ${text}\n`);
    });
    child.on("message", (raw) => this.handleMessage(raw));
    child.on("error", (error) => {
      if (this.child === child) this.rejectAll(error);
    });
    child.on("exit", (code, signal) => {
      const wasCurrent = this.child === child;
      if (wasCurrent) this.child = undefined;
      if (wasCurrent && !this.disposed) {
        this.rejectAll(new Error(`本地模型子进程异常退出（code=${String(code)}, signal=${String(signal)}）`));
      }
    });
    this.child = child;
    return child;
  }

  private handleMessage(raw: unknown): void {
    const message = raw as RuntimeEventMessage;
    if (!message || typeof message !== "object" || typeof message.id !== "string") return;
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
          if (!child) return;
          this.requestCancellation(
            message.id,
            child,
            new ModelTimeoutError("本地模型 token 流空闲超时", "model_token_idle_timeout"),
            pending.cancelGraceMs,
          );
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

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) this.finishWithError(id, pending.cancelError ?? error);
  }

  private terminateChild(child: ChildProcess, error: Error): void {
    if (this.child === child) this.child = undefined;
    child.kill();
    this.rejectAll(error);
  }

  private requestCancellation(id: string, child: ChildProcess, error: Error, graceMs = 1_000): void {
    const pending = this.pending.get(id);
    if (!pending || pending.cancelError) return;
    pending.cancelError = error;
    clearTimeout(pending.timer);
    if (pending.firstTokenTimer) clearTimeout(pending.firstTokenTimer);
    if (pending.tokenIdleTimer) clearTimeout(pending.tokenIdleTimer);
    child.send?.({ id, command: "cancel" } satisfies RuntimeRequestMessage);
    pending.cancelTimer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.terminateChild(child, error);
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

  private callBeforeDisposed(child: ChildProcess, command: RuntimeCommand, timeoutMs: number): Promise<void> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("关闭本地模型子进程超时"));
      }, timeoutMs);
      const pending: PendingRequest = { resolve: () => resolve(), reject, timer };
      this.pending.set(id, pending);
      child.send?.({ id, command } satisfies RuntimeRequestMessage);
    });
  }
}
