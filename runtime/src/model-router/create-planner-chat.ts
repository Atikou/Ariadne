import type { RouteOptions } from "../model/routeOptions.js";
import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { ModelChatFn } from "../model-orchestrator/types.js";
import { estimateRouterContextTokens } from "./router-context-estimate.js";
import { isModelUnavailableError } from "./model-availability.js";
import type { SmartModelRouter } from "./smart-model-router.js";
import { RouterError, type RouterInput } from "./types.js";

export type PlannerChatFn = (
  request: ChatRequest,
  opts?: RouteOptions,
) => Promise<ModelResponse>;

/** 从 Planner 用户消息中提取路由用目标文本（兼容「目标：…」格式）。 */
export function extractPlannerGoalFromMessages(
  messages: { role: string; content: string }[],
): string {
  const userMsgs = messages.filter((m) => m.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  if (!last) return "";
  const goalMatch = last.content.match(/^目标：([\s\S]+?)(?:\n\n相关上下文：|$)/);
  return goalMatch ? goalMatch[1]!.trim() : last.content.trim();
}

/** 计划模式路由输入：深度质量 + 强制单模型（JSON 计划一次出稿，不走协作流水线）。 */
export function buildPlannerRouterInput(
  userInput: string,
  opts?: RouteOptions & { messages?: ReadonlyArray<{ role: string; content: string }> },
): RouterInput {
  const messages = opts?.messages ?? [];
  return {
    userInput,
    qualityMode: "deep",
    forceSingleModel: true,
    allowCollaboration: false,
    localOnly: opts?.sensitive || opts?.strategy === "privacy-first",
    contextTokenEstimate: messages.length > 0 ? estimateRouterContextTokens(messages) : undefined,
    recentMessagesCount: messages.length > 0 ? messages.length : undefined,
  };
}

/** 计划模式 chat：经 SmartModelRouter + ModelRegistry 选模型，再经 modelChatFn 调用。 */
export function createPlannerChatFn(deps: {
  smartRouter: SmartModelRouter;
  modelChatFn: ModelChatFn;
}): PlannerChatFn {
  return async (request, opts) => {
    const userInput = extractPlannerGoalFromMessages(request.messages);
    const routerInput = buildPlannerRouterInput(userInput, { ...opts, messages: request.messages });
    let lastUnavailable: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let decision;
      try {
        decision = deps.smartRouter.route(routerInput);
      } catch (error) {
        if (error instanceof RouterError) {
          throw new Error(lastUnavailable ? `${error.message}；上一候选不可用：${String(lastUnavailable)}` : error.message);
        }
        throw error;
      }

      const modelId = decision.selectedModelId;
      if (!modelId) {
        throw new Error("计划模式路由未选出可用模型");
      }

      try {
        const { response } = await deps.modelChatFn(modelId, request, {
          routeLogId: decision.id,
          role: "primary",
          sessionId: decision.sessionId,
        });
        return response;
      } catch (error) {
        if (!isModelUnavailableError(error)) throw error;
        lastUnavailable = error;
      }
    }
    throw new Error(`计划模式候选模型均不可用：${String(lastUnavailable)}`);
  };
}
