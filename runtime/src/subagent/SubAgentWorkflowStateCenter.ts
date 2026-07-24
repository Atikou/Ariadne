import { randomUUID } from "node:crypto";

import type { SubAgentBatchResult, SubAgentRunResult } from "./types.js";

export type SubAgentDispatchStatus = "accepted" | "running" | "completed" | "failed";

export type SubAgentWorkflowResult =
  | { mode: "single"; result: SubAgentRunResult }
  | { mode: "batch"; result: SubAgentBatchResult };

export interface SubAgentDispatchSnapshot {
  dispatchId: string;
  parentTaskId?: string;
  mode: "single" | "batch";
  taskCount: number;
  status: SubAgentDispatchStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface SubAgentDispatchEvent {
  previousStatus?: SubAgentDispatchStatus;
  current: SubAgentDispatchSnapshot;
}

interface DispatchRecord {
  snapshot: SubAgentDispatchSnapshot;
  result?: SubAgentWorkflowResult;
  failure?: unknown;
  waiters: Array<{
    resolve: (result: SubAgentWorkflowResult) => void;
    reject: (error: unknown) => void;
  }>;
}

/**
 * Application-scoped state center for delegated workflows.
 * It owns lifecycle state and completion events, but never executes child agents.
 */
export class SubAgentWorkflowStateCenter {
  private readonly records = new Map<string, DispatchRecord>();
  private readonly listeners = new Set<(event: SubAgentDispatchEvent) => void>();

  constructor(private readonly maxRetainedRecords = 200) {
    if (!Number.isInteger(maxRetainedRecords) || maxRetainedRecords < 1) {
      throw new Error("maxRetainedRecords must be a positive integer");
    }
  }

  accept(input: {
    parentTaskId?: string;
    mode: "single" | "batch";
    taskCount: number;
  }): SubAgentDispatchSnapshot {
    this.trimTerminalRecords();
    const snapshot: SubAgentDispatchSnapshot = {
      dispatchId: randomUUID(),
      parentTaskId: input.parentTaskId,
      mode: input.mode,
      taskCount: input.taskCount,
      status: "accepted",
      createdAt: new Date().toISOString(),
    };
    this.records.set(snapshot.dispatchId, { snapshot, waiters: [] });
    this.emit({ current: { ...snapshot } });
    return { ...snapshot };
  }

  markRunning(dispatchId: string): SubAgentDispatchSnapshot {
    return this.transition(dispatchId, "accepted", {
      status: "running",
      startedAt: new Date().toISOString(),
    });
  }

  complete(dispatchId: string, result: SubAgentWorkflowResult): SubAgentDispatchSnapshot {
    const record = this.requireRecord(dispatchId);
    record.result = result;
    const snapshot = this.transition(dispatchId, "running", {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    for (const waiter of record.waiters.splice(0)) waiter.resolve(result);
    return snapshot;
  }

  fail(dispatchId: string, error: unknown): SubAgentDispatchSnapshot {
    const record = this.requireRecord(dispatchId);
    record.failure = error;
    const snapshot = this.transition(dispatchId, "running", {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    for (const waiter of record.waiters.splice(0)) waiter.reject(error);
    return snapshot;
  }

  waitForCompletion(dispatchId: string): Promise<SubAgentWorkflowResult> {
    const record = this.requireRecord(dispatchId);
    if (record.result) return Promise.resolve(record.result);
    if (record.snapshot.status === "failed") return Promise.reject(record.failure);
    return new Promise((resolve, reject) => record.waiters.push({ resolve, reject }));
  }

  get(dispatchId: string): SubAgentDispatchSnapshot | undefined {
    const snapshot = this.records.get(dispatchId)?.snapshot;
    return snapshot ? { ...snapshot } : undefined;
  }

  list(): SubAgentDispatchSnapshot[] {
    return [...this.records.values()].map(({ snapshot }) => ({ ...snapshot }));
  }

  subscribe(listener: (event: SubAgentDispatchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private transition(
    dispatchId: string,
    expected: SubAgentDispatchStatus,
    patch: Partial<SubAgentDispatchSnapshot> & Pick<SubAgentDispatchSnapshot, "status">,
  ): SubAgentDispatchSnapshot {
    const record = this.requireRecord(dispatchId);
    if (record.snapshot.status !== expected) {
      throw new Error(
        `Invalid subagent dispatch transition: ${record.snapshot.status} -> ${patch.status}`,
      );
    }
    const previousStatus = record.snapshot.status;
    record.snapshot = { ...record.snapshot, ...patch };
    const current = { ...record.snapshot };
    this.emit({ previousStatus, current });
    return current;
  }

  private requireRecord(dispatchId: string): DispatchRecord {
    const record = this.records.get(dispatchId);
    if (!record) throw new Error(`Unknown subagent dispatch: ${dispatchId}`);
    return record;
  }

  private emit(event: SubAgentDispatchEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers cannot break workflow state transitions or completion delivery.
      }
    }
  }

  private trimTerminalRecords(): void {
    if (this.records.size < this.maxRetainedRecords) return;
    for (const [dispatchId, record] of this.records) {
      if (record.snapshot.status === "completed" || record.snapshot.status === "failed") {
        this.records.delete(dispatchId);
        if (this.records.size < this.maxRetainedRecords) return;
      }
    }
  }
}
