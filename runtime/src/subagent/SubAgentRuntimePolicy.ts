export const MIN_SUBAGENT_TIMEOUT_MS = 120_000;
export const DEFAULT_SUBAGENT_BATCH_CONCURRENCY = 2;
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 180_000;

/** 子 Agent 超时是运行策略：合法请求可提高预算，但不能低于安全下限。 */
export function resolveSubagentTimeoutMs(
  requested: number | undefined,
  configuredDefault = DEFAULT_SUBAGENT_TIMEOUT_MS,
): number {
  const fallback = requirePositiveFiniteInteger(configuredDefault, "configuredDefault");
  if (requested === undefined) return Math.max(fallback, MIN_SUBAGENT_TIMEOUT_MS);
  const value = requirePositiveFiniteInteger(requested, "requested");
  return Math.max(value, MIN_SUBAGENT_TIMEOUT_MS);
}

function requirePositiveFiniteInteger(value: number, field: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`SubAgent timeout ${field} must be a positive finite integer`);
  }
  return value;
}
