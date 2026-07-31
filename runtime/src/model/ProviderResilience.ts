import type { ProviderResilienceConfig } from "../config/types.js";
import {
  ProviderRequestError,
  classifyProviderError,
} from "./ProviderError.js";
import type { ChatRequest, ModelClient, ModelResponse } from "./types.js";
import type { ProviderTelemetryRecord } from "../telemetry/TelemetryService.js";

interface TimedUsage {
  at: number;
  requests: number;
  tokens: number;
}

export interface ProviderResilienceDependencies {
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  telemetry?: { recordProviderCall(record: ProviderTelemetryRecord): void };
}

/** Per Provider/model retry, rate-limit, concurrency and circuit-breaker boundary. */
export class ResilientModelClient implements ModelClient {
  readonly name: string;
  readonly location;
  readonly model: string;
  readonly toolCallCapability;
  readonly tokenCounter;
  readonly contextWindowTokens;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly telemetry?: ProviderResilienceDependencies["telemetry"];
  private readonly usage: TimedUsage[] = [];
  private active = 0;
  private waiters: Array<() => void> = [];
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

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
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? abortableDelay;
    this.random = dependencies.random ?? Math.random;
    this.telemetry = dependencies.telemetry;
  }

  isAvailable(): Promise<boolean> {
    if (this.circuitOpenUntil > this.now()) return Promise.resolve(false);
    return this.inner.isAvailable();
  }

  async chat(request: ChatRequest): Promise<ModelResponse> {
    const startedAt = this.now();
    const inputTokens = (await this.tokenCounter.countRequest(request)).tokens;
    const reservedTokens = inputTokens + Math.max(0, request.maxTokens ?? 0);
    await this.acquire(request.signal);
    try {
      await this.enforceRateLimit(reservedTokens, request.signal);
      let attempt = 0;
      let firstTokenEmitted = false;
      const wrappedRequest: ChatRequest = request.onToken || request.onReasoningToken
        ? {
            ...request,
            ...(request.onToken
              ? {
                  onToken: (delta: string) => {
                    firstTokenEmitted = true;
                    request.onToken!(delta);
                  },
                }
              : {}),
            ...(request.onReasoningToken
              ? {
                  onReasoningToken: (delta: string) => {
                    firstTokenEmitted = true;
                    request.onReasoningToken!(delta);
                  },
                }
              : {}),
          }
        : request;

      while (true) {
        this.assertCircuitClosed();
        attempt += 1;
        try {
          const response = await this.inner.chat(wrappedRequest);
          this.consecutiveFailures = 0;
          this.telemetry?.recordProviderCall({
            providerId: this.providerId,
            model: this.model,
            outcome: "success",
            durationMs: this.now() - startedAt,
            retryCount: attempt - 1,
          });
          return response;
        } catch (error) {
          const classified = classifyProviderError(error);
          const retryable = classified.category === "rate_limit"
            || classified.category === "temporary"
            || classified.category === "timeout";
          if (!retryable || firstTokenEmitted || attempt >= this.policy.maxAttempts) {
            this.recordFailure(classified);
            this.telemetry?.recordProviderCall({
              providerId: this.providerId,
              model: this.model,
              outcome: "failure",
              durationMs: this.now() - startedAt,
              retryCount: attempt - 1,
              errorCategory: classified.category,
              statusCode: classified.status,
            });
            throw classified;
          }
          const exponential = Math.min(
            this.policy.maxBackoffMs,
            this.policy.baseBackoffMs * 2 ** (attempt - 1),
          );
          const jitter = Math.floor(exponential * this.policy.jitterRatio * this.random());
          await this.sleep(
            Math.max(classified.retryAfterMs ?? 0, exponential + jitter),
            request.signal,
          );
        }
      }
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    while (this.active >= this.policy.maxConcurrency) {
      if (signal?.aborted) throw new ProviderRequestError("cancelled", "Provider request cancelled.");
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = this.waiters.indexOf(onReady);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new ProviderRequestError("cancelled", "Provider request cancelled."));
        };
        const onReady = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        this.waiters.push(onReady);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }

  private async enforceRateLimit(tokens: number, signal?: AbortSignal): Promise<void> {
    while (true) {
      const now = this.now();
      while (this.usage[0] && this.usage[0].at <= now - 60_000) this.usage.shift();
      const requests = this.usage.reduce((total, item) => total + item.requests, 0);
      const usedTokens = this.usage.reduce((total, item) => total + item.tokens, 0);
      if (
        requests < this.policy.requestsPerMinute
        && usedTokens + tokens <= this.policy.tokensPerMinute
      ) {
        this.usage.push({ at: now, requests: 1, tokens });
        return;
      }
      const oldest = this.usage[0];
      if (!oldest) {
        throw new ProviderRequestError("rate_limit", "Request exceeds Provider token limit.");
      }
      await this.sleep(Math.max(1, oldest.at + 60_000 - now), signal);
    }
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpenUntil > this.now()) {
      throw new ProviderRequestError(
        "temporary",
        `provider_circuit_open:${this.providerId}:${this.model}`,
      );
    }
    if (this.circuitOpenUntil !== 0) {
      this.circuitOpenUntil = 0;
      this.consecutiveFailures = 0;
    }
  }

  private recordFailure(error: ProviderRequestError): void {
    if (
      error.category !== "temporary"
      && error.category !== "timeout"
      && error.category !== "rate_limit"
    ) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.policy.circuitFailureThreshold) {
      this.circuitOpenUntil = this.now() + this.policy.circuitOpenMs;
    }
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ProviderRequestError("cancelled", "Provider request cancelled.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderRequestError("cancelled", "Provider request cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}
