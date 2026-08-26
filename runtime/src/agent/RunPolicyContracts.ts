import type { ToolPermission } from "../core/permissions.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type {
  AgentExecutionStage,
  AgentRunMode,
  PlanAfterAction,
  PlanExecutionVariant,
  RunBudget,
  UserPermissionPolicy,
  UserPermissionPolicySource,
} from "./RunPolicyPrimitives.js";
import type { SideEffectKind } from "./completion/CompletionContracts.js";
import type { IntentDecisionSource } from "./routing/IntentDecisionContracts.js";

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
  intentDecisionSource?: IntentDecisionSource;
  isContinuation?: boolean;
  intentDecisionReason?: string;
  intentDecisionConfidence?: number;
  inheritedTaskId?: string;
  previousWorkflowType?: AgentWorkflowType;
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
