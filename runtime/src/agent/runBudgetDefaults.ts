import type { AgentRunMode, RunBudget } from "./RunPolicyTypes.js";

/** 各模式主预算基线（不含分层字段，由 enrichRunBudget 补齐）。 */
export const MODE_BASE_BUDGETS: Record<AgentRunMode, RunBudget> = {
  chat: {
    maxModelTurns: 8,
    maxToolCalls: 8,
    maxReadCalls: 6,
    maxWriteCalls: 2,
    maxShellCalls: 2,
    maxRuntimeMs: 120_000,
    maxPreflightTools: 3,
    maxRecoveryTurns: 3,
    maxRepeatedToolFailures: 1,
  },
  plan: {
    maxModelTurns: 16,
    maxToolCalls: 20,
    maxReadCalls: 20,
    maxWriteCalls: 0,
    maxShellCalls: 0,
    maxRuntimeMs: 180_000,
    maxPreflightTools: 5,
    maxRecoveryTurns: 4,
    maxRepeatedToolFailures: 1,
  },
  implement: {
    maxModelTurns: 24,
    maxToolCalls: 40,
    maxReadCalls: 24,
    maxWriteCalls: 12,
    maxShellCalls: 10,
    maxRuntimeMs: 300_000,
    maxPreflightTools: 4,
    maxRecoveryTurns: 4,
    maxRepeatedToolFailures: 1,
  },
  debug: {
    maxModelTurns: 20,
    maxToolCalls: 36,
    maxReadCalls: 18,
    maxWriteCalls: 4,
    maxShellCalls: 14,
    maxRuntimeMs: 300_000,
    maxPreflightTools: 4,
    maxRecoveryTurns: 5,
    maxRepeatedToolFailures: 1,
  },
  review: {
    maxModelTurns: 16,
    maxToolCalls: 20,
    maxReadCalls: 20,
    maxWriteCalls: 0,
    maxShellCalls: 0,
    maxRuntimeMs: 180_000,
    maxPreflightTools: 4,
    maxRecoveryTurns: 3,
    maxRepeatedToolFailures: 1,
  },
};

export const MODE_SUGGESTED_BUDGETS: Record<AgentRunMode, RunBudget> = {
  ...MODE_BASE_BUDGETS,
  debug: {
    ...MODE_BASE_BUDGETS.debug,
    maxModelTurns: 24,
    maxToolCalls: 42,
    maxReadCalls: 22,
    maxWriteCalls: 6,
    maxShellCalls: 16,
    maxRuntimeMs: 360_000,
    maxRecoveryTurns: 6,
  },
};

const BUDGET_CAPS: Record<keyof RunBudget, number> = {
  maxModelTurns: 60,
  maxToolCalls: 200,
  maxReadCalls: 200,
  maxWriteCalls: 100,
  maxShellCalls: 100,
  maxRuntimeMs: 1_800_000,
  maxPreflightTools: 20,
  maxRecoveryTurns: 20,
  maxRepeatedToolFailures: 5,
};

export function normalizeBudgetValue(value: number | undefined, key: keyof RunBudget): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n <= 0) return undefined;
  return Math.min(n, BUDGET_CAPS[key]);
}

export function mergeRunBudget(base: RunBudget, override: Partial<RunBudget> | undefined): RunBudget {
  const merged = { ...base };
  if (!override) return merged;
  for (const key of Object.keys(merged) as Array<keyof RunBudget>) {
    const value = normalizeBudgetValue(override[key], key);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export function mergeBudgetMax(base: RunBudget, budget: RunBudget): RunBudget {
  const out = { ...base };
  for (const key of Object.keys(out) as Array<keyof RunBudget>) {
    out[key] = Math.max(base[key], budget[key]);
  }
  return out;
}
