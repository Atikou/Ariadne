import type { ProviderResilienceConfig } from "../config/types.js";
import {
  ProviderRequestError,
  classifyProviderError,
} from "../adapters/model/ProviderError.js";
import type { ChatRequest, ModelClient, ModelResponse } from "./types.js";
import {
  ProviderResilienceCoordinator,
  type ProviderResilienceTelemetrySink,
} from "../adapters/model/ProviderResilienceCoordinator.js";

export interface ProviderResilienceDependencies {
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  telemetry?: ProviderResilienceTelemetrySink;
}

/** Per Provider/model retry, rate-limit, concurrency and circuit-breaker boundary. */
export class ResilientModelClient implements ModelClient {
  readonly name: string;
  readonly location;
  readonly model: string;
  readonly toolCallCapability;
  readonly tokenCounter;
  readonly contextWindowTokens;
  private readonly resilience: ProviderResilienceCoordinator;

  constructor(
    private readonly inner: ModelClient,
    readonly providerId: string,
    private readonly policy: ProviderResilienceConfig,
    dependencies: ProviderResilienceDependencies = {},
  ) {
    this.name = inner.name;
    this.location = inner.location;
    this.model = inner.model;
    this.toolCallCapability = inner.toolCallCapability;
    this.tokenCounter = inner.tokenCounter;
    this.contextWindowTokens = inner.contextWindowTokens;
    this.resilience = new ProviderResilienceCoordinator(providerId, this.model, policy, {
      ...dependencies,
      createCircuitOpenError: () => new ProviderRequestError(
        "temporary",
        `provider_circuit_open:${providerId}:${this.model}`,
      ),
      createRateLimitError: () => new ProviderRequestError(
        "rate_limit",
        "Request exceeds Provider token limit.",
      ),
    });
  }

  isAvailable(): Promise<boolean> {
    if (this.resilience.isCircuitOpen()) return Promise.resolve(false);
    return this.inner.isAvailable();
  }

  async chat(request: ChatRequest): Promise<ModelResponse> {
    const inputTokens = (await this.tokenCounter.countRequest(request)).tokens;
    const reservedTokens = inputTokens + Math.max(0, request.maxTokens ?? 0);
    return this.resilience.run({
      signal: request.signal,
      reservedTokens,
      execute: (markOutputStarted) => this.inner.chat({
        ...request,
        ...(request.onToken === undefined ? {} : {
          onToken: (delta: string) => {
            markOutputStarted();
            request.onToken!(delta);
          },
        }),
        ...(request.onReasoningToken === undefined ? {} : {
          onReasoningToken: (delta: string) => {
            markOutputStarted();
            request.onReasoningToken!(delta);
          },
        }),
      }),
      classify: (error) => {
        const classified = classifyProviderError(error);
        return {
          category: classified.category,
          retryable: classified.category === "rate_limit"
            || classified.category === "temporary"
            || classified.category === "timeout",
          error: classified,
          ...(classified.status === undefined ? {} : { status: classified.status }),
          ...(classified.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: classified.retryAfterMs }),
        };
      },
    });
  }
}
