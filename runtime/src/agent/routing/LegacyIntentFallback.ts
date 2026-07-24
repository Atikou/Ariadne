import type { IntentRouteInput } from "../IntentRouter.js";
import { defaultWorkflowPlanner } from "../WorkflowPlanner.js";
import { defaultWorkflowRouter } from "../WorkflowRouter.js";
import type { IntentDecision } from "./IntentDecision.js";
import { extractLegacyIntentHints } from "./LegacyIntentHints.js";

/**
 * Legacy 路径：输出中性语义候选（answer/chat），关键词仅写入 legacyIntentHint。
 * 最终 intent/workflow 由 WorkflowResolver + 代码裁决决定。
 */
export function resolveLegacyIntentFallback(input: IntentRouteInput): IntentDecision {
  const goal = input.message ?? "";
  const hints = extractLegacyIntentHints(goal);
  const workflowType = defaultWorkflowRouter.routeIntent("answer").workflowType;
  return {
    mode: "chat",
    modeSource: "inferred",
    intent: "answer",
    workflowType,
    workflowPlan: defaultWorkflowPlanner.plan(goal, "chat", "answer"),
    isContinuation: false,
    isNewTask: false,
    confidence: 0.45,
    reason: hints.hintedIntent
      ? `legacy_hint_only:${hints.hintedIntent}`
      : "legacy_neutral_answer_candidate",
    source: "legacy_fallback",
    legacyIntentHint: hints.hintedIntent,
    legacyHintSources: hints.hintSources,
  };
}
