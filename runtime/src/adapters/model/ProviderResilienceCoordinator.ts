export interface ProviderResiliencePolicy {
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly jitterRatio: number;
  readonly maxConcurrency: number;
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
  readonly circuitFailureThreshold: number;
  readonly circuitOpenMs: number;
}

export interface ProviderResilienceFailure {
  readonly category: string;
  readonly retryable: boolean;
  readonly error: unknown;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export interface ProviderResilienceTelemetryRecord {
  readonly providerId: string;
  readonly model: string;
  readonly outcome: 'success' | 'failure';
  readonly durationMs: number;
  readonly retryCount: number;
  readonly errorCategory?: string;
  readonly statusCode?: number;
}

export interface ProviderResilienceTelemetrySink {
  recordProviderCall(record: ProviderResilienceTelemetryRecord): void;
}

export interface ProviderResilienceCoordinatorDependencies {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly telemetry?: ProviderResilienceTelemetrySink;
  readonly createCircuitOpenError: () => unknown;
  readonly createRateLimitError: () => unknown;
}

interface TimedUsage {
  readonly at: number;
  readonly tokens: number;
}

export interface ProviderResilienceRun<T> {
  readonly signal?: AbortSignal;
  readonly reservedTokens: number;
  readonly execute: (markOutputStarted: () => void) => Promise<T>;
  readonly classify: (error: unknown) => ProviderResilienceFailure;
}

/** One process-local resilience state machine for one exact Provider route. */
export class ProviderResilienceCoordinator {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly telemetry?: ProviderResilienceTelemetrySink;
  private readonly usage: TimedUsage[] = [];
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  public constructor(
    private readonly providerId: string,
    private readonly model: string,
    private readonly policy: ProviderResiliencePolicy,
    private readonly dependencies: ProviderResilienceCoordinatorDependencies
  ) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? abortableDelay;
    this.random = dependencies.random ?? Math.random;
    this.telemetry = dependencies.telemetry;
  }

  public isCircuitOpen(): boolean {
    return this.circuitOpenUntil > this.now();
  }

  public async run<T>(request: ProviderResilienceRun<T>): Promise<T> {
    request.signal?.throwIfAborted();
    if (!Number.isSafeInteger(request.reservedTokens) || request.reservedTokens <= 0) {
      throw new Error('provider_resilience_reserved_tokens_invalid');
    }
    if (request.reservedTokens > this.policy.tokensPerMinute) {
      throw this.dependencies.createRateLimitError();
    }
    const startedAt = this.now();
    await this.acquire(request.signal);
    let attempt = 0;
    let outputStarted = false;
    try {
      while (true) {
        request.signal?.throwIfAborted();
        this.assertCircuitClosed();
        await this.enforceRateLimit(request.reservedTokens, request.signal);
        attempt += 1;
        try {
          const result = await request.execute(() => { outputStarted = true; });
          this.consecutiveFailures = 0;
          this.recordTelemetry('success', startedAt, attempt - 1);
          return result;
        } catch (error) {
          request.signal?.throwIfAborted();
          const failure = request.classify(error);
          if (!failure.retryable || outputStarted || attempt >= this.policy.maxAttempts) {
            this.recordFailure(failure);
            this.recordTelemetry('failure', startedAt, attempt - 1, failure);
            throw failure.error;
          }
          await this.sleep(this.retryDelay(attempt, failure.retryAfterMs), request.signal);
        }
      }
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    while (this.active >= this.policy.maxConcurrency) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = this.waiters.indexOf(onReady);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const onReady = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        this.waiters.push(onReady);
        signal?.addEventListener('abort', onAbort, { once: true });
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
      if (
        this.usage.length < this.policy.requestsPerMinute
        && this.usage.reduce((total, item) => total + item.tokens, 0) + tokens
          <= this.policy.tokensPerMinute
      ) {
        this.usage.push({ at: now, tokens });
        return;
      }
      const oldest = this.usage[0];
      if (oldest === undefined) throw this.dependencies.createRateLimitError();
      await this.sleep(Math.max(1, oldest.at + 60_000 - now), signal);
    }
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpenUntil > this.now()) {
      throw this.dependencies.createCircuitOpenError();
    }
    if (this.circuitOpenUntil !== 0) {
      this.circuitOpenUntil = 0;
      this.consecutiveFailures = 0;
    }
  }

  private recordFailure(failure: ProviderResilienceFailure): void {
    if (!failure.retryable) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.policy.circuitFailureThreshold) {
      this.circuitOpenUntil = this.now() + this.policy.circuitOpenMs;
    }
  }

  private retryDelay(attempt: number, retryAfterMs: number | undefined): number {
    const exponential = Math.min(
      this.policy.maxBackoffMs,
      this.policy.baseBackoffMs * 2 ** (attempt - 1)
    );
    const jitter = Math.floor(exponential * this.policy.jitterRatio * this.random());
    return Math.min(
      this.policy.maxBackoffMs,
      Math.max(retryAfterMs ?? 0, exponential + jitter)
    );
  }

  private recordTelemetry(
    outcome: 'success' | 'failure',
    startedAt: number,
    retryCount: number,
    failure?: ProviderResilienceFailure
  ): void {
    this.telemetry?.recordProviderCall({
      providerId: this.providerId,
      model: this.model,
      outcome,
      durationMs: Math.max(0, this.now() - startedAt),
      retryCount,
      ...(failure?.category === undefined ? {} : { errorCategory: failure.category }),
      ...(failure?.status === undefined ? {} : { statusCode: failure.status })
    });
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer.unref?.();
  });
}
