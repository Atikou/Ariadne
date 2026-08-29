export type ProviderErrorCategory =
  | "authentication"
  | "invalid_request"
  | "rate_limit"
  | "temporary"
  | "timeout"
  | "cancelled"
  | "fatal";

export class ProviderRequestError extends Error {
  constructor(
    readonly category: ProviderErrorCategory,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export function providerHttpError(
  status: number,
  message: string,
  retryAfterHeader?: string | null,
): ProviderRequestError {
  const category: ProviderErrorCategory =
    status === 401 || status === 403 ? "authentication"
      : status === 408 || status === 504 ? "timeout"
        : status === 429 ? "rate_limit"
          : status >= 500 ? "temporary"
            : status >= 400 ? "invalid_request"
              : "fatal";
  return new ProviderRequestError(
    category,
    message,
    status,
    parseRetryAfter(retryAfterHeader),
  );
}

export function classifyProviderError(error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ProviderRequestError("cancelled", "Provider request cancelled.");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|cancelled|canceled/iu.test(message)) {
    return new ProviderRequestError("cancelled", message);
  }
  if (/timeout|timed out|etimedout/iu.test(message)) {
    return new ProviderRequestError("timeout", message);
  }
  if (/econnreset|econnrefused|eai_again|fetch failed|network/iu.test(message)) {
    return new ProviderRequestError("temporary", message);
  }
  return new ProviderRequestError("fatal", message);
}

function parseRetryAfter(value?: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}
