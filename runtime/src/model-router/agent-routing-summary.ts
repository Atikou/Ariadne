import type { PromptStrategy } from "./prompt-strategy-builder.js";
import type { RouterDecision } from "./types.js";

/** Agent `/api/agent` 响应中的内部模型路由决策摘要。 */
export interface AgentRouterDecisionSummary {
  id: string;
  taskType: string;
  executionStrategy: string;
  selectedModelId?: string;
  draftModelId?: string;
  reviewModelId?: string;
  risk: string;
  reason: string;
  source: string;
  requireUserConfirmation: boolean;
  contextSignals?: string[];
}

/** Agent 响应中的提示策略摘要。 */
export interface AgentPromptStrategySummary {
  temperature: number;
  responseStyle: string;
  preferJsonMode: boolean;
  hints: string[];
}

export interface AgentRoutingMeta {
  routerDecision: AgentRouterDecisionSummary;
  promptStrategy: AgentPromptStrategySummary;
}

export function buildAgentRoutingMeta(
  decision: RouterDecision,
  promptStrategy: PromptStrategy,
): AgentRoutingMeta {
  return {
    routerDecision: {
      id: decision.id,
      taskType: decision.taskType,
      executionStrategy: decision.executionStrategy,
      selectedModelId: decision.selectedModelId,
      draftModelId: decision.draftModelId,
      reviewModelId: decision.reviewModelId,
      risk: decision.risk,
      reason: decision.reason,
      source: decision.source,
      requireUserConfirmation: decision.requireUserConfirmation,
      contextSignals: decision.contextSignals,
    },
    promptStrategy: {
      temperature: promptStrategy.temperature,
      responseStyle: promptStrategy.responseStyle,
      preferJsonMode: promptStrategy.preferJsonMode,
      hints: promptStrategy.hints,
    },
  };
}
