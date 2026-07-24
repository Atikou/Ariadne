/** 后台任务 timeoutMs 下限（毫秒）。 */
export const MIN_BACKGROUND_TASK_TIMEOUT_MS = 1_000;

/** 后台任务 timeoutMs 上限（毫秒，24h）。 */
export const MAX_BACKGROUND_TASK_TIMEOUT_MS = 86_400_000;

export function parseBackgroundTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error("timeoutMs 须为正整数（毫秒）");
  }
  if (raw < MIN_BACKGROUND_TASK_TIMEOUT_MS || raw > MAX_BACKGROUND_TASK_TIMEOUT_MS) {
    throw new Error(
      `timeoutMs 须在 ${MIN_BACKGROUND_TASK_TIMEOUT_MS}–${MAX_BACKGROUND_TASK_TIMEOUT_MS} 之间`,
    );
  }
  return raw;
}
