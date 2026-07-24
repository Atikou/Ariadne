export type ModelCallOutcome = "completed" | "cancelled" | "timeout" | "runtime_crash";

export class ModelAbortError extends Error {
  readonly code: string;

  constructor(message = "模型调用已取消", code = "model_cancelled") {
    super(message);
    this.name = "AbortError";
    this.code = code;
  }
}

export class ModelTimeoutError extends Error {
  readonly code: string;

  constructor(message: string, code = "model_timeout") {
    super(message);
    this.name = "TimeoutError";
    this.code = code;
  }
}

export function createModelAbortError(reason?: unknown): ModelAbortError {
  if (reason instanceof ModelAbortError) return reason;
  if (reason instanceof Error) {
    const code = typeof (reason as Error & { code?: unknown }).code === "string"
      ? String((reason as Error & { code?: string }).code)
      : "model_cancelled";
    return new ModelAbortError(reason.message || "模型调用已取消", code);
  }
  return new ModelAbortError(reason == null ? "模型调用已取消" : String(reason));
}

export function isModelAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

export function throwIfModelAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createModelAbortError(signal.reason);
}

export function classifyModelCallOutcome(error: unknown, signal?: AbortSignal): ModelCallOutcome {
  if (isModelAbortError(error, signal)) return "cancelled";
  if (error instanceof Error) {
    const code = String((error as Error & { code?: unknown }).code ?? "").toLowerCase();
    const text = `${error.name} ${error.message} ${code}`.toLowerCase();
    if (text.includes("timeout") || text.includes("timed out") || text.includes("超时")) return "timeout";
  }
  return "runtime_crash";
}
