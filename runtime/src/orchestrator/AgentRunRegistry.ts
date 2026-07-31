export const RUN_CANCELLED_MESSAGE = "运行已取消";

interface ActiveRun {
  controller: AbortController;
  kind: "agent" | "chat";
  startedAt: string;
}

/** 跟踪运行中的 Agent / Chat 流式 Run，支持显式 cancel。 */
export class AgentRunRegistry {
  private readonly active = new Map<string, ActiveRun>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();

  register(runId: string, kind: ActiveRun["kind"] = "agent"): AbortController {
    if (this.active.has(runId)) {
      throw new Error(`run_execution_already_active:${runId}`);
    }
    const controller = new AbortController();
    this.active.set(runId, { controller, kind, startedAt: new Date().toISOString() });
    return controller;
  }

  unregister(runId: string): void {
    if (!this.active.delete(runId)) return;
    const waiters = this.idleWaiters.get(runId);
    if (!waiters) return;
    this.idleWaiters.delete(runId);
    for (const resolve of waiters) resolve();
  }

  async waitUntilIdle(runId: string): Promise<void> {
    while (this.active.has(runId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.idleWaiters.get(runId) ?? new Set<() => void>();
        waiters.add(resolve);
        this.idleWaiters.set(runId, waiters);
        if (!this.active.has(runId)) {
          waiters.delete(resolve);
          if (waiters.size === 0) this.idleWaiters.delete(runId);
          resolve();
        }
      });
    }
  }

  isRunning(runId: string): boolean {
    return this.active.has(runId);
  }

  listRunning(): Array<{ runId: string; kind: ActiveRun["kind"]; startedAt: string }> {
    return [...this.active.entries()].map(([runId, entry]) => ({
      runId,
      kind: entry.kind,
      startedAt: entry.startedAt,
    }));
  }

  cancel(runId: string): { runId: string; kind: ActiveRun["kind"]; status: "cancelling" } | undefined {
    const entry = this.active.get(runId);
    if (!entry) return undefined;
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(new Error(RUN_CANCELLED_MESSAGE));
    }
    return { runId, kind: entry.kind, status: "cancelling" };
  }
}

export function isRunCancelledError(err: unknown): boolean {
  const msg = String(err);
  if (msg.includes(RUN_CANCELLED_MESSAGE)) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}
