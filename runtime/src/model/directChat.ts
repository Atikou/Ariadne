import { performance } from "node:perf_hooks";

import type { RoutingStrategy } from "../config/types.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { toPublicError } from "../util/publicError.js";
import type { MetricsRegistry } from "./MetricsRegistry.js";
import { prepareRemoteChatRequest } from "./prepareRemoteChatRequest.js";
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
    const strategy = opts.strategy ?? options.strategy;
    const currentClients = typeof clients === "function" ? clients() : clients;
    let candidates = listCandidates(currentClients, opts, strategy);
    if (candidates.length === 0) {
      throw new Error(
        opts.forceClient
          ? `未找到指定模型：${opts.forceClient}`
          : "没有满足当前策略的候选模型（可能要求仅本地但无本地模型）。",
      );
    }
    if (!options.fallback && !opts.forceClient) candidates = candidates.slice(0, 1);

    const errors: string[] = [];
    for (const client of candidates) {
      throwIfModelAborted(request.signal);
      const start = performance.now();
      try {
        const safeRequest = prepareRemoteChatRequest(request, client, options.trace);
        const response = await client.chat(safeRequest);
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
        return costUsd === undefined ? response : { ...response, costUsd };
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
        if (outcome === "cancelled") {
          throw createModelAbortError(request.signal?.reason ?? error);
        }
        errors.push(`${client.name}: ${publicError.message}`);
      }
    }
    throw new Error(`所有候选模型均失败：\n${errors.join("\n")}`);
  };
}
