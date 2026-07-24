import type { RunStatus } from "../core/runTypes.js";

export type TerminalRunStatus = Extract<RunStatus, "completed" | "failed" | "cancelled">;

export interface RunTerminalEvent {
  runId: string;
  status: TerminalRunStatus;
  source: "agent_resume" | "permission_denied" | "startup_recovery" | "run_cancelled";
  at: string;
}

export type RunTerminalListener = (event: RunTerminalEvent) => Promise<void> | void;

/** In-process event mechanism; durable consumers recover from their own SQLite state center. */
export class RunTerminalEventBus {
  private readonly listeners = new Set<RunTerminalListener>();

  subscribe(listener: RunTerminalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(event: RunTerminalEvent): Promise<void> {
    await Promise.allSettled([...this.listeners].map((listener) => listener(event)));
  }
}
