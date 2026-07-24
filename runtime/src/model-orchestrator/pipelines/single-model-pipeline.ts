import type { OrchestratorInput, ModelChatFn, OrchestratorResult } from "../types.js";

export async function runSingleModelPipeline(
  input: OrchestratorInput,
  chat: ModelChatFn,
): Promise<OrchestratorResult> {
  const modelId =
    input.routerDecision.selectedModelId ?? input.routerDecision.finalModelId;
  if (!modelId) throw new Error("single_model 缺少 selectedModelId");

  const usedStrategy =
    input.routerDecision.executionStrategy === "strong_model_direct"
      ? "strong_model_direct"
      : "single_model";

  const { response, callLogId } = await chat(
    modelId,
    {
      messages: input.renderedPrompt.finalMessages,
      temperature: input.temperature ?? 0.3,
      onToken: input.onToken,
      signal: input.signal,
    },
    {
      role: "primary",
      routeLogId: input.routerDecision.id,
      sessionId: input.sessionId,
    },
  );

  return {
    finalAnswer: response.content,
    usedStrategy,
    usedModelIds: [modelId],
    modelCallIds: [callLogId],
    clientName: response.clientName,
    modelName: response.modelName,
    location: response.location,
    latencyMs: response.latencyMs,
    usage: response.usage,
  };
}
