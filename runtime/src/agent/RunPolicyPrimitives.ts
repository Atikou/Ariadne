export type AgentRunMode = "chat" | "plan" | "implement" | "debug" | "review";

export type AgentExecutionStage = "analyze" | "plan" | "execute" | "verify";

export type AgentStopReason =
  | "completed"
  | "completed_partial"
  | "recovery_partial"
  | "misleading_completion"
  | "blocked_by_policy"
  | "budget_exhausted"
  | "historical_reference"
  | "error"
  | "user_cancelled"
  | "awaiting_permission"
  | "awaiting_plan_handoff";

export type PlanExecutionVariant = "plan_only" | "plan_wait_approval" | "plan_then_execute";

export type PlanAfterAction = "final" | "request_permission" | "request_permission_then_execute";

export type UserPermissionPolicy =
  | "readOnly"
  | "confirmBeforeEdit"
  | "autoEdit"
  | "confirmBeforeRun"
  | "autoRun";

export type UserPermissionPolicySource = "explicit" | "inferred";

export interface RunBudget {
  maxModelTurns: number;
  maxToolCalls: number;
  maxReadCalls: number;
  maxWriteCalls: number;
  maxShellCalls: number;
  maxRuntimeMs: number;
  maxPreflightTools: number;
  maxRecoveryTurns: number;
  maxRepeatedToolFailures: number;
}

export interface RunBudgetUsage {
  modelTurns: number;
  toolCalls: number;
  attemptedToolCalls?: number;
  readCalls: number;
  writeCalls: number;
  shellCalls: number;
  runtimeMs: number;
  mainModelTurns?: number;
  preflightTools?: number;
  recoveryTurns?: number;
  cachedToolHits?: number;
  toolFailures?: number;
  toolObservationFailures?: number;
  toolExecutionErrors?: number;
}

export type RunBudgetKey = keyof RunBudget;

export type AgentSuggestedAction = "continue_locating";

export interface LocationExplorationMeta {
  duplicateCount: number;
  newInformationCount: number;
  informationGain: number;
  lowYieldLoop: boolean;
}

export interface LocationExecutionMeta {
  usedLocateSteps: number;
  usedSearchCalls: number;
  usedListCalls: number;
  usedReadForLocationCalls: number;
  locatedFiles: string[];
  candidateFiles: string[];
  stopReason?: string;
  needsContinue: boolean;
  confidence?: number;
  exploration?: LocationExplorationMeta;
  suggestedAction?: AgentSuggestedAction;
}

export function parseRunModeValue(mode: string | undefined): AgentRunMode | undefined {
  if (!mode) return undefined;
  const normalized = mode.trim().toLowerCase();
  if (
    normalized === "chat" ||
    normalized === "plan" ||
    normalized === "implement" ||
    normalized === "debug" ||
    normalized === "review"
  ) {
    return normalized;
  }
  return undefined;
}

export function parseUserPermissionPolicyValue(
  policy: string | undefined,
): UserPermissionPolicy | undefined {
  if (!policy) return undefined;
  const normalized = policy.trim();
  if (
    normalized === "readOnly" ||
    normalized === "confirmBeforeEdit" ||
    normalized === "autoEdit" ||
    normalized === "confirmBeforeRun" ||
    normalized === "autoRun"
  ) {
    return normalized;
  }
  return undefined;
}
