import type { ModelTaskType } from "../model/taskType.js";
import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { AgentRoutingMeta } from "./agent-routing-summary.js";

export interface LoopChatResponse extends ModelResponse {
  /** Smart 路由路径：本轮模型调用的决策与提示策略（首轮回传至 Agent 响应）。 */
  routingMeta?: AgentRoutingMeta;
}

export type LoopChatFn = (
  req: ChatRequest,
  opts?: {
    sensitive?: boolean;
    taskType?: ModelTaskType;
    spentCostUsd?: number;
    maxCostUsd?: number;
  },
) => Promise<LoopChatResponse>;
