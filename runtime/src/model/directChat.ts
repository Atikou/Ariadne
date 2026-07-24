import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import type { RoutingStrategy } from "../config/types.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { toPublicError } from "../util/publicError.js";
import type { MetricsRegistry } from "./MetricsRegistry.js";
import { prepareRemoteChatRequest } from "./prepareRemoteChatRequest.js";
import { prepareChatRequestForModel } from "./prepareChatRequestForModel.js";
import { orderCandidatesByTaskType, type ModelTaskType } from "./taskType.js";
import type { ChatRequest, ModelClient, ModelResponse } from "./types.js";
import type { RouteOptions } from "./routeOptions.js";
import {
  classifyModelCallOutcome,
  createModelAbortError,
  throwIfModelAborted,
} from "./modelCancellation.js";

export interface ClientPricing {
  inputPer1k?: number;
  outputPer1k?: number;
}

export interface DirectChatOptions {
  strategy: RoutingStrategy;
  fallback: boolean;
  metrics?: MetricsRegistry;
  trace?: TraceLogger;
  pricing?: Map<string, ClientPricing>;
}

function listCandidates(
  clients: ModelClient[],
  opts: RouteOptions,
  strategy: RoutingStrategy,
): ModelClient[] {
  if (opts.forceClient) {
    return clients.filter((c) => c.name === opts.forceClient);
  }
  const local = clients.filter((c) => c.location === "local");
  const remote = clients.filter((c) => c.location === "remote");
  if (opts.sensitive || strategy === "privacy-first") return local;
  const byTask = orderCandidatesByTaskType(opts.taskType, local, remote);
  if (byTask) return byTask;
  if (strategy === "cloud-first" || strategy === "quality-first") return [...remote, ...local];
  return [...local, ...remote];
}

function priceFor(
  pricing: Map<string, ClientPricing> | undefined,
  clientName: string,
  inputTokens?: number,
  outputTokens?: number,
): number | undefined {
  const p = pricing?.get(clientName);
  if (!p) return undefined;
  const inCost = ((inputTokens ?? 0) / 1000) * (p.inputPer1k ?? 0);
  const outCost = ((outputTokens ?? 0) / 1000) * (p.outputPer1k ?? 0);
  return inCost + outCost;
}

export function createDirectChatFn(
  clients: ModelClient[] | (() => ModelClient[]),
  options: DirectChatOptions,
) {
  return async (request: ChatRequest, opts: RouteOptions = {}): Promise<ModelResponse> => {
    const requestId = randomUUID();
    const strategy = opts.strategy ?? options.strategy;
    const currentClients = typeof clients === "function" ? clients() : clients;
    let candidates = listCandidates(currentClients, opts, strategy);
    if (candidates.length === 0) {
      const error = new Error(
        opts.forceClient
          ? `未找到指定模型：${opts.forceClient}`
          : "没有满足当前策略的候选模型（可能要求仅本地但无本地模型）。",
      );
      options.trace?.write({
        type: "model.routing.error",
        level: "error",
        category: "model.routing",
        message: error.message,
        metadata: {
          requestId,
          lifecycleStage: "candidate_resolution",
          modelSelectionMode: opts.forceClient ? "manual" : "automatic",
          requestedClientName: opts.forceClient ?? null,
          resolvedClientName: null,
          strategy,
          taskType: opts.taskType ?? "unspecified",
          retryable: false,
          availableClientNames: currentClients.map((client) => client.name),
        },
      });
      throw error;
    }
    if (!options.fallback && !opts.forceClient) candidates = candidates.slice(0, 1);

    const errors: string[] = [];
    for (const client of candidates) {
      throwIfModelAborted(request.signal);
      const start = performance.now();
      try {
        const clientRequest = requestForClient(request, client);
        options.trace?.write({
          type: "model.request.started",
          level: "info",
          category: "model.request",
          message: `正在调用模型 ${client.name}`,
          metadata: {
            requestId,
            clientName: client.name,
            modelName: client.model,
            location: client.location,
            modelSelectionMode: opts.forceClient ? "manual" : "automatic",
            requestedClientName: opts.forceClient ?? null,
            resolvedClientName: client.name,
            bindingMatched: opts.forceClient ? client.name === opts.forceClient : null,
            strategy,
            taskType: opts.taskType ?? "unspecified",
            messageCount: clientRequest.messages.length,
            inputChars: clientRequest.messages.reduce(
              (total, message) => total + message.content.length,
              0,
            ),
            toolCallCapability: client.toolCallCapability,
            toolSchemaCount: clientRequest.tools?.length ?? 0,
          },
        });
        const safeRequest = prepareRemoteChatRequest(clientRequest, client, options.trace);
        const prepared = await prepareChatRequestForModel(safeRequest, client);
        if (prepared.droppedMessageCount > 0) {
          options.trace?.write({
            type: "context_packed",
            client: client.name,
            model: client.model,
            inputTokens: prepared.inputTokens,
            outputReserve: prepared.outputReserve,
            toolSchemaTokens: prepared.toolSchemaTokens,
            droppedMessageCount: prepared.droppedMessageCount,
            exact: prepared.exact,
            tokenizer: prepared.tokenizer,
          });
        }
        const response = await client.chat(prepared.request);
        const latencyMs = response.latencyMs || performance.now() - start;
        const costUsd = priceFor(
          options.pricing,
          client.name,
          response.usage?.inputTokens,
          response.usage?.outputTokens,
        );
        options.metrics?.record({
          clientName: client.name,
          model: response.modelName,
          location: client.location,
          success: true,
          outcome: "completed",
          latencyMs,
          contextMessages: request.messages.length,
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          costUsd,
          strategy,
          taskType: opts.taskType as ModelTaskType | undefined,
        });
        options.trace?.write({
          type: "model.response.completed",
          level: "info",
          category: "model.response",
          message: `模型 ${client.name} 已完成响应`,
          metadata: {
            requestId,
            clientName: client.name,
            modelName: response.modelName,
            location: client.location,
            modelSelectionMode: opts.forceClient ? "manual" : "automatic",
            requestedClientName: opts.forceClient ?? null,
            resolvedClientName: client.name,
            bindingMatched: opts.forceClient ? client.name === opts.forceClient : null,
            latencyMs: Math.max(0, Math.round(latencyMs)),
            outputChars: response.content.length,
            toolCallCount: response.toolCalls.length,
            inputTokens: response.usage?.inputTokens ?? null,
            outputTokens: response.usage?.outputTokens ?? null,
            toolCallCapability: client.toolCallCapability,
          },
        });
        return {
          ...response,
          toolCallCapability: client.toolCallCapability,
          ...(costUsd === undefined ? {} : { costUsd }),
        };
      } catch (error) {
        const latencyMs = performance.now() - start;
        const outcome = classifyModelCallOutcome(error, request.signal);
        const publicError = toPublicError(error, "模型调用失败");
        options.metrics?.record({
          clientName: client.name,
          model: client.model,
          location: client.location,
          success: false,
          outcome,
          latencyMs,
          contextMessages: request.messages.length,
          strategy,
          taskType: opts.taskType as ModelTaskType | undefined,
          error: publicError.message,
        });
        options.trace?.write({
          type: "model.request.warning",
          level: "warning",
          category: "model.request",
          message: `模型 ${client.name} 调用失败：${publicError.message}`,
          metadata: {
            requestId,
            clientName: client.name,
            modelName: client.model,
            location: client.location,
            modelSelectionMode: opts.forceClient ? "manual" : "automatic",
            requestedClientName: opts.forceClient ?? null,
            resolvedClientName: client.name,
            bindingMatched: opts.forceClient ? client.name === opts.forceClient : null,
            latencyMs: Math.max(0, Math.round(latencyMs)),
            outcome,
            errorCode: publicError.code,
            retryable: outcome === "timeout",
            toolCallCapability: client.toolCallCapability,
          },
        });
        if (outcome === "cancelled") {
          throw createModelAbortError(request.signal?.reason ?? error);
        }
        errors.push(`${client.name}: ${publicError.message}`);
      }
    }
    options.trace?.write({
      type: "model.request.error",
      level: "error",
      category: "model.request",
      message: "所有候选模型均调用失败",
      metadata: {
        requestId,
        lifecycleStage: "model_call",
        modelSelectionMode: opts.forceClient ? "manual" : "automatic",
        requestedClientName: opts.forceClient ?? null,
        candidateCount: candidates.length,
        failureCount: errors.length,
        failures: errors.slice(0, 8),
      },
    });
    throw new Error(`所有候选模型均失败：\n${errors.join("\n")}`);
  };
}

function requestForClient(request: ChatRequest, client: ModelClient): ChatRequest {
  if (client.toolCallCapability === "native" || !request.tools?.length) return request;
  const { tools: _unsupportedTools, ...withoutTools } = request;
  return withoutTools;
}
