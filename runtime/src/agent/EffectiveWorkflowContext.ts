import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import { resolveEffectiveIntent } from "./capabilityEscalationRuntime.js";
import { defaultWorkflowRouter, type WorkflowRouteResult } from "./WorkflowRouter.js";

export interface EffectiveWorkflowContext {
  entryIntent: AgentIntentType;
  entryWorkflowType: AgentWorkflowType;
  reconciledIntent?: AgentIntentType;
  reconciledWorkflowType?: AgentWorkflowType;
  effectiveIntent: AgentIntentType;
  effectiveWorkflowType: AgentWorkflowType;
  capabilityEscalations: CapabilityEscalationRecord[];
}

export function buildEffectiveWorkflowContext(input: {
  entryIntent: AgentIntentType;
  entryWorkflowType: AgentWorkflowType;
  reconciledIntent?: AgentIntentType;
  reconciledWorkflowType?: AgentWorkflowType;
  capabilityEscalations?: CapabilityEscalationRecord[];
}): EffectiveWorkflowContext {
  const effectiveIntent = resolveEffectiveIntent(input.entryIntent, input.reconciledIntent);
  const effectiveWorkflowType =
    input.reconciledWorkflowType ?? input.entryWorkflowType;
  return {
    entryIntent: input.entryIntent,
    entryWorkflowType: input.entryWorkflowType,
    reconciledIntent: input.reconciledIntent,
    reconciledWorkflowType: input.reconciledWorkflowType,
    effectiveIntent,
    effectiveWorkflowType,
    capabilityEscalations: input.capabilityEscalations ?? [],
  };
}

export function effectiveWorkflowRoute(ctx: EffectiveWorkflowContext): WorkflowRouteResult {
  return (
    defaultWorkflowRouter.routeWorkflowType(ctx.effectiveWorkflowType) ??
    defaultWorkflowRouter.routeIntent(ctx.effectiveIntent)
  );
}
