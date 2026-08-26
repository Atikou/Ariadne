import type { AgentIntentType, AgentWorkflowType } from "../IntentTypes.js";
import type { AgentRunMode } from "../RunPolicyPrimitives.js";
import type { WorkflowPlan } from "../WorkflowPlanningContracts.js";
import type { SideEffectKind } from "../completion/CompletionContracts.js";

export type IntentDecisionSource =
  | "explicit_mode"
  | "session_continuation"
  | "task_continuation"
  | "task_boundary"
  | "intent_adjudicator"
  | "ai_classifier"
  | "legacy_fallback";

export interface IntentDecision {
  mode: AgentRunMode;
  modeSource: "explicit" | "inferred";
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  workflowPlan: WorkflowPlan | null;
  isContinuation: boolean;
  isNewTask: boolean;
  needsWrite?: boolean;
  needsRunCommand?: boolean;
  requiredSideEffects?: SideEffectKind[];
  confidence: number;
  reason: string;
  source: IntentDecisionSource;
  inheritedTaskId?: string;
  previousWorkflowType?: AgentWorkflowType;
  continuationScore?: number;
  continuationSignals?: Record<string, number | boolean>;
  aiOverridden?: boolean;
  legacyIntentHint?: AgentIntentType;
  legacyHintSources?: string[];
  boundaryBreakReason?: string;
  effectiveTaskContextId?: string;
}
