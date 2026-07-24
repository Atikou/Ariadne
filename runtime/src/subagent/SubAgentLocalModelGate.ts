import type { ModelLocation } from "../model/types.js";

interface WaitingCall {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** AppContext 私有的本地模型调用信号量；远程调用不经过此门控。 */
export class SubAgentLocalModelGate {
  private active = 0;
  private readonly waiters: WaitingCall[] = [];

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("localModelMaxConcurrent 必须是正整数");
    }
  }

  get stats(): { active: number; maxConcurrent: number; waiting: number } {
    return {
      active: this.active,
      maxConcurrent: this.maxConcurrent,
      waiting: this.waiters.length,
    };
  }

  async runIfLocal<T>(
    location: ModelLocation | undefined,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Only a known remote client may bypass local capacity. Unknown clients fail safe.
    if (location === "remote") return fn();
    const release = await this.acquire(signal);
    try {
      throwIfAborted(signal);
      return await fn();
    } finally {
      release();
    }
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return this.createRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiting: WaitingCall = { resolve, reject, signal };
      if (signal) {
        waiting.onAbort = () => {
          const index = this.waiters.indexOf(waiting);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiting.onAbort, { once: true });
      }
      this.waiters.push(waiting);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    for (;;) {
      const next = this.waiters.shift();
      if (!next) {
        this.active = Math.max(0, this.active - 1);
        return;
      }
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      if (next.signal?.aborted) {
        next.reject(abortReason(next.signal));
        continue;
      }
      // Slot ownership is handed off directly; active never dips below the real count.
      next.resolve(this.createRelease());
      return;
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("本地模型排队已取消");
}
