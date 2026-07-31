import type { AgentToolStep } from "../agent/toolStep.js";
import type { ToolPermission } from "../core/permissions.js";
import type { WriteFilePickStrategy } from "./writeFileVersionPick.js";
import type { DelegatedTask, SubAgentStructuredResult } from "./delegatedTask.js";
import type { ExecutionRoute } from "./executionRoute.js";

/** ModelRouter 选型结果摘要（具体模型名来自配置，非子 Agent 硬编码）。 */
export interface ModelSelection {
  provider: "local" | "remote";
  clientName: string;
  model: string;
  reason: string;
  taskType?: string;
  fallbackModels?: string[];
}

export type SubAgentStatus = "completed" | "failed" | "timeout" | "cancelled";

export interface DelegatedTaskRunOptions {
  task: DelegatedTask;
  /** Trusted parent-run workspace. This is never accepted from model input. */
  workspaceRoot: string;
  parentTaskId?: string;
  grantedPermissions?: ToolPermission[];
  timeoutMs?: number;
  sensitive?: boolean;
  parentIntent?: string;
  parentWorkflowType?: string;
  dispatchDepth?: number;
  executionRoute?: ExecutionRoute;
  /** 该子任务允许消费的模型费用上限（USD）。 */
  maxCostUsd?: number;
  /** 父 Agent/工具调用取消信号，必须传播到子 Agent 模型和工具。 */
  signal?: AbortSignal;
  activityTimeline?: import("../agent/timeline/AgentTimelineService.js").AgentTimelineService;
  activityRunId?: string;
  activityParentId?: string;
}

export interface SubAgentRunResult {
  id: string;
  taskId: string;
  goal: string;
  parentTaskId?: string;
  status: SubAgentStatus;
  answer: string;
  structured?: SubAgentStructuredResult;
  steps: AgentToolStep[];
  iterations: number;
  durationMs: number;
  grantedPermissions: ToolPermission[];
  error?: string;
  routingMeta?: {
    clientName?: string;
    modelName?: string;
    location?: string;
    taskType?: string;
    selectedLevel?: number;
    reason?: string;
  };
  modelUsed?: ModelSelection;
  executionRoute?: Pick<ExecutionRoute, "mode" | "reason">;
  workspaceIsolation?: import("./SubAgentWorkspaceManager.js").SubAgentWorkspaceArtifact;
  usage?: {
    modelTurns: number;
    toolCalls: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}

export interface SubAgentBatchOptions {
  tasks: DelegatedTask[];
  /** Trusted parent-run workspace shared by every child in this dispatch. */
  workspaceRoot: string;
  parentTaskId?: string;
  grantedPermissions?: ToolPermission[];
  timeoutMs?: number;
  sensitive?: boolean;
  parentIntent?: string;
  parentWorkflowType?: string;
  dispatchDepth?: number;
  arbitrateConflicts?: boolean;
  autoMergeWrites?: boolean;
  writeFilePickStrategy?: WriteFilePickStrategy;
  /** 整批子任务共享的模型费用上限（USD），由协调器按任务数分配。 */
  maxCostUsd?: number;
  signal?: AbortSignal;
  activityTimeline?: import("../agent/timeline/AgentTimelineService.js").AgentTimelineService;
  activityRunId?: string;
  activityParentId?: string;
}

export interface SubAgentConflict {
  topic: string;
  taskIds: string[];
  excerpts: Array<{ taskId: string; goal: string; text: string }>;
  reason: string;
}

export interface SubAgentWriteConflict {
  path: string;
  taskIds: string[];
  changeIds: string[];
  reason: string;
}

export interface SubAgentArbitration {
  applied: boolean;
  summary: string;
  skippedReason?: string;
  writeFilePicks?: Array<{
    path: string;
    changeId?: string;
    taskId?: string;
    manual?: boolean;
  }>;
}

export type SubAgentWriteMergeStatus = "merged" | "manual_required" | "skipped";

export interface SubAgentWriteMergeAttempt {
  path: string;
  status: SubAgentWriteMergeStatus;
  changeId?: string;
  reason: string;
  appliedPatches: number;
  pickedChangeId?: string;
  pickedTaskId?: string;
  pickStrategy?: WriteFilePickStrategy;
}

export interface SubAgentAggregate {
  status: "completed" | "partial" | "conflict" | "failed";
  completed: number;
  failed: number;
  timedOut: number;
  commonFindings: string[];
  conflicts: SubAgentConflict[];
  writeConflicts: SubAgentWriteConflict[];
  writeMerges?: SubAgentWriteMergeAttempt[];
  arbitration?: SubAgentArbitration;
  mergedAnswer: string;
}

export interface SubAgentBatchResult {
  parentTaskId: string;
  results: SubAgentRunResult[];
  summary: string;
  aggregate: SubAgentAggregate;
  durationMs: number;
  arbitrationUsage?: SubAgentRunResult["usage"];
}
