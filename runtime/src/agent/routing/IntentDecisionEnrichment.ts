import { defaultWorkflowRouter } from "../WorkflowRouter.js";
import type { IntentDecision } from "./IntentDecision.js";
import type { RoutingSnapshot } from "./RoutingSnapshot.js";

/** 为入口决策附加观测字段（边界、legacy hint、副作用需求）。 */
export function enrichIntentDecision(
  decision: IntentDecision,
  snapshot: Pick<RoutingSnapshot, "boundary" | "effectiveTaskContext">,
  legacyHint?: Pick<IntentDecision, "legacyIntentHint" | "legacyHintSources">,
): IntentDecision {
  const decisionRoute = defaultWorkflowRouter.routeWorkflowType(decision.workflowType);
  const route =
    decisionRoute?.intent === decision.intent
      ? decisionRoute
      : defaultWorkflowRouter.routeIntent(decision.intent);
  const side = route?.sideEffectKind ?? "none";
  const boundary = snapshot.boundary;
  const requiredSideEffects = new Set(boundary.requiredSideEffects);
  if (decision.needsWrite ?? (side === "write" || side === "mixed")) {
    requiredSideEffects.add("write");
  }
  if (decision.needsRunCommand ?? (side === "shell" || side === "mixed")) {
    requiredSideEffects.add("shell");
  }
  return {
    ...decision,
    boundaryBreakReason: boundary.breaksContinuation ? boundary.reason : undefined,
    effectiveTaskContextId: snapshot.effectiveTaskContext?.taskId,
    legacyIntentHint: legacyHint?.legacyIntentHint ?? decision.legacyIntentHint,
    legacyHintSources: legacyHint?.legacyHintSources ?? decision.legacyHintSources,
    needsWrite:
      decision.needsWrite ?? (side === "write" || side === "mixed"),
    needsRunCommand:
      decision.needsRunCommand ?? (side === "shell" || side === "mixed"),
    requiredSideEffects: [...requiredSideEffects],
  };
}
