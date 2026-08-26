import type {
  SubAgentBatchOptions,
  SubAgentBatchResult,
  SubAgentRunResult,
} from "./types.js";

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

export interface SubAgentWorkflowHandle {
  dispatchId: string;
  completion: Promise<SubAgentWorkflowResult>;
}

export interface SubAgentWorkflowPort {
  submit(options: SubAgentBatchOptions): SubAgentWorkflowHandle;
}
