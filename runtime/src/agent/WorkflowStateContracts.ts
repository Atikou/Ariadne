import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";

export type AgentWorkflowTaskState =
  | "idle"
  | "planning"
  | "waiting_confirmation"
  | "executing"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentWorkflowSwitch {
  switched: true;
  fromIntent: AgentIntentType;
  toIntent: AgentIntentType;
  fromWorkflowType: AgentWorkflowType;
  toWorkflowType: AgentWorkflowType;
  fromTaskState?: AgentWorkflowTaskState;
  sequence: number;
}

export type WorkflowPhaseState =
  | "idle"
  | "planning"
  | "write_ready"
  | "write_pending_verification"
  | "verification_passed"
  | "correction_allowed"
  | "terminated";

export type WorkflowStateEventType =
  | "planning_recorded"
  | "write_succeeded"
  | "verification_succeeded"
  | "verification_failed"
  | "correction_limit_reached";

export interface WorkflowStateEvent {
  type: WorkflowStateEventType;
  toolCallId?: string;
  tool?: string;
  path?: string;
}

export interface WorkflowStateSnapshot {
  workflowType: AgentWorkflowType;
  phase: WorkflowPhaseState;
  taskState: AgentWorkflowTaskState;
  events: WorkflowStateEvent[];
  priorWrites: number;
  readToolsBeforeWrite: number;
  lastWriteToolCallId?: string;
  lastWritePath?: string;
  lastWriteVerified: boolean;
  lastVerificationOk?: boolean;
  failedVerificationAttempts: number;
  maxCorrectionAttempts: number;
  correctionLimitReached: boolean;
  requiresVerificationBeforeNextWrite: boolean;
  planningReady: boolean;
}
