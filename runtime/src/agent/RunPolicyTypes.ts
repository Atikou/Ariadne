import type { ModelTaskType } from "../model/taskType.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { ToolPermission } from "../core/permissions.js";

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
  /** 主执行阶段模型轮次（不含系统恢复注入） */
  maxModelTurns: number;
  maxToolCalls: number;
  maxReadCalls: number;
  maxWriteCalls: number;
  maxShellCalls: number;
  maxRuntimeMs: number;
  /** 工作流预扫描只读工具上限（与主 toolCalls 分层计数） */
  maxPreflightTools: number;
  /** 系统工具恢复动作上限（不消耗主 model turn） */
  maxRecoveryTurns: number;
  /** 相同 tool+input 允许失败次数，达到后熔断 */
  maxRepeatedToolFailures: number;
}

export interface RunBudgetUsage {
  modelTurns: number;
  /** 已通过授权与预算门、实际消费执行预算的工具调用数。 */
  toolCalls: number;
  /** 模型/工作流提出的工具动作总数，包含被权限、策略或预算阻止的动作。 */
  attemptedToolCalls?: number;
  readCalls: number;
  writeCalls: number;
  shellCalls: number;
  runtimeMs: number;
  mainModelTurns?: number;
  preflightTools?: number;
  recoveryTurns?: number;
  cachedToolHits?: number;
  /** 观察失败 + 执行错误（不含 blocked） */
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

export interface AgentWorkflowProposal {
  workflowType: Extract<AgentWorkflowType, "editWorkflow" | "generateFileWorkflow">;
  phase: "proposal";
  goal: string;
  intent: Extract<AgentIntentType, "edit" | "generate_file">;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  writeAllowedByPolicy: boolean;
  requiresConfirmationBeforeWrite: boolean;
  permissionChecks: AgentWorkflowPermissionCheck[];
  permissionSummary: "write_allowed" | "confirmation_required" | "denied";
}

export interface AgentWorkflowPermissionCheck {
  toolName: "apply_patch" | "write_file";
  permission: Extract<ToolPermission, "write">;
  decision: "allow" | "needsConfirmation" | "deny";
  reason?: string;
  risk: {
    tier: "low" | "medium" | "high" | "critical";
    category: string;
    requiresConfirmation: boolean;
    policyBlocked: boolean;
  };
}

export interface AgentWorkflowDiffRecord {
  toolCallId?: string;
  tool: "write_file" | "apply_patch";
  path?: string;
  changeId?: string;
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
  diffTruncated: boolean;
}

export interface AgentWorkflowVerificationRecord {
  workflowType: Extract<
    AgentWorkflowType,
    "editWorkflow" | "generateFileWorkflow" | "debugWorkflow" | "refactorWorkflow"
  >;
  writeToolCallId?: string;
  writeTool: "write_file" | "apply_patch";
  path?: string;
  changeId?: string;
  verificationToolCallId?: string;
  verificationTool: string;
  ok: boolean;
  blocked?: boolean;
  error?: string;
  outputPreview?: string;
}

export interface AgentWorkflowCorrectionRecord {
  workflowType: Extract<
    AgentWorkflowType,
    "editWorkflow" | "generateFileWorkflow" | "debugWorkflow" | "refactorWorkflow"
  >;
  phase: "correction" | "termination";
  path?: string;
  changeId?: string;
  writeToolCallId?: string;
  verificationToolCallId?: string;
  verificationTool: string;
  attempt: number;
  maxAttempts: number;
  limitReached: boolean;
  verificationError?: string;
}

export interface AgentWorkflowDebugAnalysis {
  workflowType: Extract<AgentWorkflowType, "debugWorkflow">;
  phase: "analysis";
  goal: string;
  intent: Extract<AgentIntentType, "debug">;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  suggestedTools: string[];
  writeAllowedByPolicy: boolean;
  requiresConfirmationBeforeWrite: boolean;
}

export interface AgentWorkflowWritePhase {
  workflowType: Extract<AgentWorkflowType, "editWorkflow" | "generateFileWorkflow" | "refactorWorkflow">;
  phase: "write";
  goal: string;
  intent: Extract<AgentIntentType, "edit" | "generate_file" | "refactor">;
  permissionPolicy: UserPermissionPolicy;
  writeTool: "write_file" | "apply_patch";
  proposalReady: boolean;
  readToolsBeforeWrite: number;
  gated: true;
}

export interface AgentWorkflowDebugFix {
  workflowType: Extract<AgentWorkflowType, "debugWorkflow">;
  phase: "fix";
  goal: string;
  permissionPolicy: UserPermissionPolicy;
  writeTool: "write_file" | "apply_patch";
  analysisReady: boolean;
  readToolsBeforeWrite: number;
  gated: true;
}

export interface AgentWorkflowRefactorPlan {
  workflowType: Extract<AgentWorkflowType, "refactorWorkflow">;
  phase: "plan";
  goal: string;
  intent: Extract<AgentIntentType, "refactor">;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  maxStages: number;
  suggestedTools: string[];
  writeAllowedByPolicy: boolean;
  requiresConfirmationBeforeWrite: boolean;
}

export interface AgentWorkflowInternalPlan {
  workflowType: AgentWorkflowType;
  phase: "implicit";
  goal: string;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  complexitySignals: string[];
  /** 明确区分：内部轻量计划，不是用户可见计划模式。 */
  userVisiblePlanMode: false;
  maxSteps: number;
}

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

export interface AgentCapabilityEscalation {
  fromWorkflow: AgentWorkflowType;
  fromIntent: AgentIntentType;
  toWorkflow: AgentWorkflowType;
  toIntent: AgentIntentType;
  requestedTool: string;
  requestedPermission: ToolPermission;
  currentExpectedSideEffects: ToolPermission[];
  targetSideEffects: ToolPermission[];
  canEscalate: boolean;
  reason: string;
  iteration: number;
  applied: boolean;
}

export interface AgentExecutionMeta {
  mode: AgentRunMode;
  executionStage?: AgentExecutionStage;
  planVariant?: PlanExecutionVariant;
  modeSource?: "explicit" | "inferred";
  intent?: AgentIntentType;
  workflowType?: AgentWorkflowType;
  permissionPolicy?: UserPermissionPolicy;
  permissionPolicySource?: UserPermissionPolicySource;
  workflowProposals?: AgentWorkflowProposal[];
  workflowDiffs?: AgentWorkflowDiffRecord[];
  workflowVerifications?: AgentWorkflowVerificationRecord[];
  workflowCorrections?: AgentWorkflowCorrectionRecord[];
  workflowWritePhases?: AgentWorkflowWritePhase[];
  workflowDebugFixes?: AgentWorkflowDebugFix[];
  workflowDebugAnalyses?: AgentWorkflowDebugAnalysis[];
  workflowRefactorPlans?: AgentWorkflowRefactorPlan[];
  workflowInternalPlans?: AgentWorkflowInternalPlan[];
  workflowTaskState?: AgentWorkflowTaskState;
  workflowSwitch?: AgentWorkflowSwitch;
  capabilityEscalations?: AgentCapabilityEscalation[];
  reconciledWorkflowType?: AgentWorkflowType;
  reconciledIntent?: AgentIntentType;
  workflowState?: import("./WorkflowStateCenter.js").WorkflowStateSnapshot;
  budget: RunBudget;
  usage: RunBudgetUsage;
  budgetExhausted?: RunBudgetKey;
  location?: LocationExecutionMeta;
  usedIterations: number;
  usedModelTurns: number;
  usedToolCalls: number;
  usedReadCalls: number;
  usedWriteCalls: number;
  usedShellCalls: number;
  stopReason: AgentStopReason;
  needsMoreBudget: boolean;
  suggestedBudget?: RunBudget;
  /** 用户可读执行状态（非 mode）。 */
  userFacingState?: import("./presentation/ExecutionStatePresenter.js").UserFacingExecutionState;
  userFacingLabel?: string;
  /** 入口意图决策来源（task_continuation / session_continuation / ai_classifier / legacy_fallback）。 */
  intentDecisionSource?: import("./routing/IntentDecision.js").IntentDecisionSource;
  isContinuation?: boolean;
  intentDecisionReason?: string;
  intentDecisionConfidence?: number;
  inheritedTaskId?: string;
  previousWorkflowType?: AgentWorkflowType;
  currentWorkflowType?: AgentWorkflowType;
  continuationScore?: number;
  continuationSignals?: Record<string, number | boolean>;
  needsWrite?: boolean;
  needsShell?: boolean;
  requiredSideEffects: import("./completion/TaskCompletionContract.js").SideEffectKind[];
  aiOverridden?: boolean;
  boundaryBreakReason?: string;
  effectiveTaskContextId?: string;
  legacyIntentHint?: AgentIntentType;
  legacyHintSources?: string[];
  entryIntent?: AgentIntentType;
  entryWorkflowType?: AgentWorkflowType;
  effectiveWorkflowType?: AgentWorkflowType;
  /** 按任务复杂度估算的建议工具调用次数（预算耗尽时返回）。 */
  suggestedToolCalls?: number;
  complexityTier?: "low" | "medium" | "high";
  /** 已成功完成的工具步骤摘要（预算耗尽时返回）。 */
  completedSteps?: string[];
  /** 推断的待继续步骤（预算耗尽时返回）。 */
  missingSteps?: string[];
  /** 定位不足或预算耗尽时的结构化继续动作。 */
  suggestedAction?: AgentSuggestedAction;
  /** Final Guard 结论（副作用任务真实性校验）。 */
  completionStatus?: import("./completion/CompletionFinalGuard.js").CompletionStatus;
  completionGuardReason?: string;
  /** FinalGuard 实际使用的结构化完成合同与逐项证据。 */
  completionContract?: import("./completion/TaskCompletionContract.js").TaskCompletionContract;
  completionEvidence?: import("./completion/CompletionEvidence.js").CompletionEvidenceReport;
  guardedAnswer?: string;
  rawModelAnswer?: string;
  /** 系统侧运行摘要（预算耗尽/权限暂停等），禁止作为用户可见 answer。 */
  partialSummary?: string;
  toolLedger?: {
    attemptedReadCalls: number;
    blockedReadCalls: number;
    successfulReadCalls: number;
    attemptedShellCalls: number;
    blockedShellCalls: number;
    successfulShellCalls: number;
    attemptedWriteCalls: number;
    blockedWriteCalls: number;
    successfulWriteCalls: number;
  };
  /** Final Guard / ToolLedger 摘要别名（观测字段）。 */
  toolLedgerSummary?: {
    attemptedReadCalls: number;
    blockedReadCalls: number;
    successfulReadCalls: number;
    attemptedShellCalls: number;
    blockedShellCalls: number;
    successfulShellCalls: number;
    attemptedWriteCalls: number;
    blockedWriteCalls: number;
    successfulWriteCalls: number;
  };
}

export interface RunPolicy {
  mode: AgentRunMode;
  executionStage: AgentExecutionStage;
  modeSource: "explicit" | "inferred";
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  permissionPolicy: UserPermissionPolicy;
  permissionPolicySource: UserPermissionPolicySource;
  planVariant?: PlanExecutionVariant;
  afterPlan: PlanAfterAction;
  budget: RunBudget;
  allowedPermissions: ToolPermission[];
  requireFinalAnswer: boolean;
  allowPartialAnswer: boolean;
  suggestedBudget: RunBudget;
  systemHint: string;
  intentDecisionSource?: import("./routing/IntentDecision.js").IntentDecisionSource;
  isContinuation?: boolean;
  intentDecisionReason?: string;
  intentDecisionConfidence?: number;
  inheritedTaskId?: string;
  previousWorkflowType?: AgentWorkflowType;
  continuationScore?: number;
  continuationSignals?: Record<string, number | boolean>;
  needsWrite?: boolean;
  needsShell?: boolean;
  requiredSideEffects: import("./completion/TaskCompletionContract.js").SideEffectKind[];
  aiOverridden?: boolean;
  boundaryBreakReason?: string;
  effectiveTaskContextId?: string;
  legacyIntentHint?: import("./IntentTypes.js").AgentIntentType;
  legacyHintSources?: string[];
  entryIntent?: import("./IntentTypes.js").AgentIntentType;
  entryWorkflowType?: import("./IntentTypes.js").AgentWorkflowType;
  effectiveWorkflowType?: import("./IntentTypes.js").AgentWorkflowType;
}

export interface ResolveRunPolicyInput {
  requestedMode?: string;
  forceMode?: boolean;
  sessionId?: string;
  requestedPermissionPolicy?: string;
  autoConfirm?: boolean;
  budget?: Partial<RunBudget>;
  taskType?: ModelTaskType;
  message?: string;
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
