import { performance } from "node:perf_hooks";

import { prepareRemoteChatRequest } from "../model/prepareRemoteChatRequest.js";
import type { ModelClient } from "../model/types.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ModelChatFn } from "../model-orchestrator/types.js";
import {
  ModelAvailabilityRegistry,
  ModelUnavailableError,
  looksLikeModelUnavailableError,
} from "./model-availability.js";
import type { ModelCallLogStore } from "./route-stores.js";
import { redactString } from "../util/redact.js";

function preview(text: string, max = 400): string {
  // 落库前一律脱敏，避免 model_call_logs 的输入/输出预览泄露密钥/隐私。
  const safe = redactString(text);
  return safe.length <= max ? safe : `${safe.slice(0, max)}…`;
}

export function createModelChatFn(
  clientMap: Map<string, ModelClient>,
  callLogStore: ModelCallLogStore,
  trace?: TraceLogger,
  availability?: ModelAvailabilityRegistry,
): ModelChatFn {
  return async (modelId, request, meta) => {
    const client = clientMap.get(modelId);
    if (!client) throw new Error(`未找到模型：${modelId}`);
    if (availability && !availability.isAllowed(modelId)) {
      const record = availability.get(modelId);
      throw new ModelUnavailableError(modelId, `模型 ${modelId} 当前不可用：${record?.reason ?? "availability cache"}`);
    }
    const start = performance.now();
    const inputPreview = preview(
      request.messages
        .slice(-2)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n"),
    );
    try {
      if (availability?.shouldProbe(modelId)) {
        const record = await availability.refreshModel(modelId, client);
        if (!record.available) {
          throw new ModelUnavailableError(modelId, `模型 ${modelId} 当前不可用：${record.reason ?? "preflight failed"}`);
        }
      }
      const safeRequest = prepareRemoteChatRequest(request, client, trace);
      const response = await client.chat(safeRequest);
      const durationMs = Math.round(response.latencyMs || performance.now() - start);
      const callLogId = callLogStore.create({
        routeLogId: meta.routeLogId,
        collaborationRunId: meta.collaborationRunId,
        sessionId: meta.sessionId,
        modelId,
        role: meta.role,
        inputPreview,
        outputPreview: preview(response.content),
        status: "ok",
        promptTokens: response.usage?.inputTokens,
        completionTokens: response.usage?.outputTokens,
        durationMs,
      });
      trace?.write({
        type: "model_call",
        success: true,
        client: response.clientName,
        model: response.modelName,
        location: response.location,
        latencyMs: durationMs,
        role: meta.role,
        routeLogId: meta.routeLogId,
        collaborationRunId: meta.collaborationRunId,
      });
      return { response, callLogId };
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      if (availability && (error instanceof ModelUnavailableError || looksLikeModelUnavailableError(error))) {
        availability.markUnavailable(modelId, String(error));
      }
      const callLogId = callLogStore.create({
        routeLogId: meta.routeLogId,
        collaborationRunId: meta.collaborationRunId,
        sessionId: meta.sessionId,
        modelId,
        role: meta.role,
        inputPreview,
        status: "error",
        errorMessage: redactString(String(error)),
        durationMs,
      });
      trace?.write({
        type: "model_call",
        success: false,
        client: modelId,
        model: client.model,
        location: client.location,
        latencyMs: durationMs,
        role: meta.role,
        routeLogId: meta.routeLogId,
        error: String(error),
      });
      throw error;
    }
  };
}
