import type { RoutingStrategy } from "../config/types.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { MetricsRegistry } from "./MetricsRegistry.js";
import { createDirectChatFn, type ClientPricing } from "./directChat.js";
import type { RouteOptions } from "./routeOptions.js";
import type { ChatRequest, ModelClient, ModelResponse } from "./types.js";

export type { ClientPricing } from "./directChat.js";
export type { RouteOptions } from "./routeOptions.js";

export interface ModelRouterOptions {
  strategy: RoutingStrategy;
  fallback: boolean;
  metrics?: MetricsRegistry;
  trace?: TraceLogger;
  pricing?: Map<string, ClientPricing>;
}

/**
 * 兼容层：保留旧 API 以兼容测试与历史导入。
 * 运行时实际实现已迁移到 `createDirectChatFn`。
 */
export class ModelRouter {
  private readonly chatImpl: (request: ChatRequest, opts?: RouteOptions) => Promise<ModelResponse>;

  constructor(
    private readonly clients: ModelClient[],
    private readonly options: ModelRouterOptions,
  ) {
    this.chatImpl = createDirectChatFn(clients, options);
  }

  listCandidates(opts: RouteOptions = {}): ModelClient[] {
    if (opts.forceClient) return this.clients.filter((c) => c.name === opts.forceClient);
    const strategy = opts.strategy ?? this.options.strategy;
    const local = this.clients.filter((c) => c.location === "local");
    const remote = this.clients.filter((c) => c.location === "remote");
    if (opts.sensitive || strategy === "privacy-first") return local;
    if (strategy === "cloud-first" || strategy === "quality-first") return [...remote, ...local];
    return [...local, ...remote];
  }

  async chat(request: ChatRequest, opts: RouteOptions = {}): Promise<ModelResponse> {
    return this.chatImpl(request, opts);
  }
}
