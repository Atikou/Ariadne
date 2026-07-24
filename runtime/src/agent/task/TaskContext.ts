import type { AgentIntentType, AgentWorkflowType } from "../IntentTypes.js";



/** 会话内连续任务阶段（内部，非用户 mode）。 */

export type TaskPhase =

  | "idle"

  | "analyzing"

  | "planning"

  | "editing"

  | "debugging"

  | "verifying"

  | "waiting_approval"

  | "blocked"

  | "partial"

  | "completed"

  | "failed";



export interface TaskSideEffectSummary {

  wroteFiles: string[];

  ranShell: boolean;

}



/** 单个会话内的连续任务上下文。 */

export interface TaskContext {

  sessionId: string;

  taskId?: string;

  goal?: string;

  currentPhase: TaskPhase;

  intent: AgentIntentType;

  workflowType: AgentWorkflowType;

  lastRunId?: string;

  lastFailure?: string;

  lastStopReason?: string;

  lastCompletedAt?: string;

  lastSideEffectSummary?: TaskSideEffectSummary;

  relatedFiles?: string[];

  /** 入口路由（reconcile 前），供 debug 追溯。 */
  entryIntent?: AgentIntentType;

  entryWorkflowType?: AgentWorkflowType;

  /** reconcile 后的有效 intent/workflow，续写继承以此为准。 */
  reconciledIntent?: AgentIntentType;

  reconciledWorkflowType?: AgentWorkflowType;

  /** 上一轮 Final Guard 结论（供分类器与观测）。 */
  lastCompletionStatus?: string;

  hasPendingPlanHandoff?: boolean;

  hasPendingPermission?: boolean;

  isActive: boolean;

  updatedAt: string;

}



export interface UpdateTaskContextFromRunInput {

  sessionId: string;

  taskId?: string;

  goal: string;

  intent: AgentIntentType;

  workflowType: AgentWorkflowType;

  runId?: string;

  stopReason?: string;

  workflowTaskState?: string;

  failed?: boolean;

  failureSummary?: string;

  relatedFiles?: string[];

  sideEffectSummary?: TaskSideEffectSummary;

  /** 入口路由 intent（未 reconcile 前）。 */
  entryIntent?: AgentIntentType;

  entryWorkflowType?: AgentWorkflowType;

  reconciledIntent?: AgentIntentType;

  reconciledWorkflowType?: AgentWorkflowType;

  completionStatus?: string;

  sideEffectsMet?: boolean;

}
