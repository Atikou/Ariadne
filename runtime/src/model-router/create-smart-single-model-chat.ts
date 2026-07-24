import type { RouteOptions } from "../model/routeOptions.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { ModelChatFn } from "../model-orchestrator/types.js";
import type { LoopChatFn, LoopChatResponse } from "./agent-chat-types.js";
import { buildAgentRoutingMeta } from "./agent-routing-summary.js";
import { applyPromptStrategyToMessages } from "./apply-prompt-strategy-messages.js";
import {
  defaultPromptStrategyBuilder,
} from "./prompt-strategy-builder.js";
import { buildRouterInputFromChat } from "./router-input.js";
import { resolveRuleOnlyAnswer } from "./rule-only-responses.js";
import { estimateRouterContextTokens } from "./router-context-estimate.js";
import { isModelUnavailableError } from "./model-availability.js";
import type { SmartModelRouter } from "./smart-model-router.js";
import { RouterError, type RouterInput } from "./types.js";
import { AGENT_PROTOCOL_REQUIRED_CAPABILITIES } from "./model-capability-profile.js";
import type { ModelRegistry } from "./model-registry.js";
import type { AgentProtocolQualificationStore } from "./agent-protocol-qualification.js";
import { parseAgentModelAction } from "../core/AgentActionProtocol.js";

export type { AgentRoutingMeta } from "./agent-routing-summary.js";

export type SmartSingleModelChatFn = (
  request: ChatRequest,
  opts?: { sensitive?: boolean; taskType?: ModelTaskType },
) => Promise<LoopChatResponse>;

/** 取最近一条 user 消息作为路由输入。 */
export function extractLastUserMessage(
  messages: { role: string; content: string }[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "user") return msg.content.trim();
  }
  return "";
}

/** Agent 循环路由：尊重 taskType / sensitive，强制单模型（每轮 ReAct 不走协作流水线）。 */
export function buildAgentRouterInput(
  userInput: string,
  opts?: {
    sensitive?: boolean;
    taskType?: ModelTaskType;
    messages?: ReadonlyArray<{ role: string; content: string }>;
    spentCostUsd?: number;
    maxCostUsd?: number;
  },
): RouterInput {
  const messages = opts?.messages ?? [];
  return buildRouterInputFromChat({
    message: userInput,
    sensitive: opts?.sensitive,
    taskType: opts?.taskType,
    forceSingleModel: true,
    allowCollaboration: false,
    contextTokenEstimate: messages.length > 0 ? estimateRouterContextTokens(messages) : undefined,
    recentMessagesCount: messages.length > 0 ? messages.length : undefined,
    maxCostUsd: opts?.maxCostUsd,
    spentCostUsd: opts?.spentCostUsd,
    mayUseTools: true,
    requiredCapabilities: [...AGENT_PROTOCOL_REQUIRED_CAPABILITIES],
    agentProtocolRequired: true,
  });
}

/** 经 SmartModelRouter + ModelRegistry 选模型并调用（单模型，写 model_call_logs）。 */
export function createSmartSingleModelChatFn(deps: {
  smartRouter: SmartModelRouter;
  modelChatFn: ModelChatFn;
  buildInput: (
    userInput: string,
    opts?: {
      sensitive?: boolean;
      taskType?: ModelTaskType;
      spentCostUsd?: number;
      maxCostUsd?: number;
    },
    context?: { messages?: ReadonlyArray<{ role: string; content: string }> },
  ) => RouterInput;
}): SmartSingleModelChatFn {
  return async (request, opts) => {
    const userInput = extractLastUserMessage(request.messages);
    const routerInput = deps.buildInput(userInput, opts, { messages: request.messages });
    let lastUnavailable: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let routed;
      try {
        routed = deps.smartRouter.routeDetailed(routerInput);
      } catch (error) {
        if (error instanceof RouterError) {
          throw new Error(lastUnavailable ? `${error.message}；上一候选不可用：${String(lastUnavailable)}` : error.message);
        }
        throw error;
      }
      const decision = routed.decision;
      const promptStrategy = defaultPromptStrategyBuilder.build({
        decision,
        routingContext: routed.routingContext,
        userInput,
        qualityMode: routerInput.qualityMode,
      });
      const routingMeta = buildAgentRoutingMeta(decision, promptStrategy);

      const modelId = decision.selectedModelId;
      if (decision.executionStrategy === "rule_only") {
        const content = JSON.stringify({
          action: "final",
          answer: resolveRuleOnlyAnswer(decision.taskType, userInput),
        });
        return {
          content,
          toolCalls: [],
          clientName: "rule-only",
          modelName: "rule-only",
          location: "local",
          latencyMs: 0,
          routingMeta,
        };
      }
      if (!modelId) {
        throw new Error("路由未选出可用模型");
      }

      const chatRequest: ChatRequest = {
        ...request,
        temperature: promptStrategy.temperature,
        messages: applyPromptStrategyToMessages(request.messages, promptStrategy),
      };
      try {
        const { response } = await deps.modelChatFn(modelId, chatRequest, {
          routeLogId: decision.id,
          role: "primary",
          sessionId: decision.sessionId,
        });
        return { ...response, routingMeta };
      } catch (error) {
        if (!isModelUnavailableError(error)) throw error;
        lastUnavailable = error;
      }
    }
    throw new Error(`路由候选模型均不可用：${String(lastUnavailable)}`);
  };
}

/** AgentLoop 默认 chat：Smart 单模型路由。 */
export function createAgentChatFn(deps: {
  smartRouter: SmartModelRouter;
  modelChatFn: ModelChatFn;
  modelRegistry?: ModelRegistry;
  qualificationStore?: AgentProtocolQualificationStore;
}): LoopChatFn {
  const routedChat = createSmartSingleModelChatFn({
    ...deps,
    buildInput: (userInput, opts, context) =>
      buildAgentRouterInput(userInput, {
        sensitive: opts?.sensitive,
        taskType: opts?.taskType,
        messages: context?.messages,
        spentCostUsd: opts?.spentCostUsd,
        maxCostUsd: opts?.maxCostUsd,
      }),
  });
  return async (request, opts) => {
    const response = await routedChat(request, opts);
    const modelId = response.routingMeta?.routerDecision.selectedModelId ?? response.clientName;
    const profile = deps.modelRegistry?.get(modelId);
    if (profile && deps.qualificationStore) {
      if (parseAgentModelAction(response.content, response.toolCalls)) {
        deps.qualificationStore.recordSuccess(profile);
      } else {
        deps.qualificationStore.recordFailure(profile, "模型响应未通过严格 AgentAction schema");
      }
    }
    return response;
  };
}
