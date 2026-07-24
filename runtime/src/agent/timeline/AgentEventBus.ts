import type { AgentActivityEvent } from "./types.js";

export type ActivityEventListener = (event: AgentActivityEvent) => void;

/** 进程内 Activity 事件总线（按 runId 订阅；重放走磁盘 events.jsonl，不在内存保留历史）。 */
export class AgentEventBus {
  private readonly listeners = new Map<string, Set<ActivityEventListener>>();

  publish(event: AgentActivityEvent): void {
    const runId = this.runIdFromEvent(event);
    const subs = this.listeners.get(runId);
    if (subs) {
      for (const fn of subs) {
        fn(event);
      }
    }
  }

  subscribe(runId: string, listener: ActivityEventListener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  clearRun(runId: string): void {
    this.listeners.delete(runId);
  }

  private runIdFromEvent(event: AgentActivityEvent): string {
    if (event.type === "run_started") return event.run.id;
    if ("runId" in event) return event.runId;
    return "";
  }
}

/** 全局单例：跨请求共享实时订阅（单进程 dev 足够）。 */
export const defaultActivityEventBus = new AgentEventBus();
