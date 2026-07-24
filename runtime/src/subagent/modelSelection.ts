import type { ModelSelection, SubAgentRunResult } from "./types.js";

/** 将首次模型调用的 routingMeta 转为可返回主 Agent 的 ModelSelection。 */
export function toModelSelection(
  routingMeta?: SubAgentRunResult["routingMeta"],
): ModelSelection | undefined {
  if (!routingMeta?.clientName && !routingMeta?.modelName) return undefined;
  const location = routingMeta.location;
  return {
    provider: location === "remote" ? "remote" : "local",
    clientName: routingMeta.clientName ?? "unknown",
    model: routingMeta.modelName ?? routingMeta.clientName ?? "unknown",
    reason: routingMeta.reason ?? "",
    taskType: routingMeta.taskType,
  };
}
