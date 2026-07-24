import type { AgentIntentType, AgentWorkflowType } from "../IntentTypes.js";
import type { AgentRunMode } from "../RunPolicyTypes.js";
import type { WorkflowPlan } from "../WorkflowPlanner.js";

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
  requiredSideEffects?: import("../completion/TaskCompletionContract.js").SideEffectKind[];
  confidence: number;
  reason: string;
  source: IntentDecisionSource;
  inheritedTaskId?: string;
  previousWorkflowType?: AgentWorkflowType;
  continuationScore?: number;
  continuationSignals?: Record<string, number | boolean>;
  aiOverridden?: boolean;
  /** 关键词 hint，非最终 intent（source=legacy_fallback 时）。 */
  legacyIntentHint?: AgentIntentType;
  legacyHintSources?: string[];
  boundaryBreakReason?: string;
  effectiveTaskContextId?: string;
}
