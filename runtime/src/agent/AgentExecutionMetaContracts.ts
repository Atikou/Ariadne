import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type {
  AgentExecutionStage,
  AgentRunMode,
  AgentStopReason,
  AgentSuggestedAction,
  LocationExecutionMeta,
  PlanExecutionVariant,
  RunBudget,
  RunBudgetKey,
  RunBudgetUsage,
  UserPermissionPolicy,
  UserPermissionPolicySource,
} from "./RunPolicyPrimitives.js";
import type {
  AgentWorkflowCorrectionRecord,
  AgentWorkflowDebugAnalysis,
  AgentWorkflowDebugFix,
  AgentWorkflowDiffRecord,
  AgentWorkflowInternalPlan,
  AgentWorkflowProposal,
  AgentWorkflowRefactorPlan,
  AgentWorkflowVerificationRecord,
  AgentWorkflowWritePhase,
} from "./WorkflowExecutionContracts.js";
import type {
  AgentWorkflowSwitch,
  AgentWorkflowTaskState,
  WorkflowStateSnapshot,
} from "./WorkflowStateContracts.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalationContracts.js";
import type {
  CompletionEvidenceReport,
  CompletionStatus,
  SideEffectKind,
  TaskCompletionContract,
} from "./completion/CompletionContracts.js";
import type { ToolLedgerSummary } from "./completion/ToolLedgerContracts.js";
import type { UserFacingExecutionState } from "./presentation/ExecutionPresentationContracts.js";
import type { IntentDecisionSource } from "./routing/IntentDecisionContracts.js";

export type ExecutionToolLedgerSummary = Pick<
  ToolLedgerSummary,
  | "attemptedReadCalls"
  | "blockedReadCalls"
  | "successfulReadCalls"
  | "attemptedShellCalls"
  | "blockedShellCalls"
  | "successfulShellCalls"
  | "attemptedWriteCalls"
  | "blockedWriteCalls"
  | "successfulWriteCalls"
>;

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
  capabilityEscalations?: CapabilityEscalationRecord[];
  reconciledWorkflowType?: AgentWorkflowType;
  reconciledIntent?: AgentIntentType;
  workflowState?: WorkflowStateSnapshot;
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
  userFacingState?: UserFacingExecutionState;
  userFacingLabel?: string;
  intentDecisionSource?: IntentDecisionSource;
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
  requiredSideEffects: SideEffectKind[];
  aiOverridden?: boolean;
  boundaryBreakReason?: string;
  effectiveTaskContextId?: string;
  legacyIntentHint?: AgentIntentType;
  legacyHintSources?: string[];
  entryIntent?: AgentIntentType;
  entryWorkflowType?: AgentWorkflowType;
  effectiveWorkflowType?: AgentWorkflowType;
  suggestedToolCalls?: number;
  complexityTier?: "low" | "medium" | "high";
  completedSteps?: string[];
  missingSteps?: string[];
  suggestedAction?: AgentSuggestedAction;
  completionStatus?: CompletionStatus;
  completionGuardReason?: string;
  completionContract?: TaskCompletionContract;
  completionEvidence?: CompletionEvidenceReport;
  guardedAnswer?: string;
  rawModelAnswer?: string;
  partialSummary?: string;
  toolLedger?: ExecutionToolLedgerSummary;
  toolLedgerSummary?: ExecutionToolLedgerSummary;
}
