import type { ModelTaskType } from "../model/taskType.js";
import type { AgentRunMode, RunBudget, RunBudgetKey } from "./RunPolicyTypes.js";

export type TaskComplexityTier = "low" | "medium" | "high";

export interface TaskComplexityEstimate {
  tier: TaskComplexityTier;
  suggestedToolCalls: number;
  suggestedReadCalls: number;
  suggestedModelTurns: number;
}

const MODE_BASE_TOOL_CALLS: Record<AgentRunMode, number> = {
  chat: 6,
  plan: 14,
  implement: 28,
  debug: 22,
  review: 14,
};

const HIGH_COMPLEXITY_PATTERNS = [
  /重构|全量|架构|升级|迁移|多模块|整个项目|全面|端到端/i,
];

const MEDIUM_COMPLEXITY_PATTERNS = [
  /分析|扫描|定位|排查|修复|实现|添加|修改|审查|对比/i,
];

export function estimateTaskComplexity(input: {
  goal: string;
  mode: AgentRunMode;
  taskType?: ModelTaskType;
}): TaskComplexityEstimate {
  const goal = input.goal.trim();
  const base = MODE_BASE_TOOL_CALLS[input.mode];

  let tier: TaskComplexityTier = "low";
  if (HIGH_COMPLEXITY_PATTERNS.some((pattern) => pattern.test(goal))) {
    tier = "high";
  } else if (goal.length > 120 || MEDIUM_COMPLEXITY_PATTERNS.some((pattern) => pattern.test(goal))) {
    tier = "medium";
  }

  if ((input.mode === "implement" || input.mode === "debug") && tier === "low") {
    tier = "medium";
  }
  if (input.mode === "plan" && /项目|结构|模块/.test(goal) && tier === "low") {
    tier = "medium";
  }

  const multiplier = tier === "high" ? 1.6 : tier === "medium" ? 1.25 : 1;
  const suggestedToolCalls = Math.max(4, Math.round(base * multiplier));
  const suggestedReadCalls = Math.max(3, Math.round(suggestedToolCalls * 0.7));
  const suggestedModelTurns = Math.max(6, Math.round(suggestedToolCalls * 0.5 + 4));

  return { tier, suggestedToolCalls, suggestedReadCalls, suggestedModelTurns };
}

export function resolveSuggestedToolCalls(input: {
  goal: string;
  mode: AgentRunMode;
  budgetExhausted?: RunBudgetKey;
  currentBudget: RunBudget;
  modeSuggestedToolCalls: number;
  usedToolCalls: number;
}): { suggestedToolCalls: number; tier: TaskComplexityTier } {
  const estimate = estimateTaskComplexity({ goal: input.goal, mode: input.mode });
  let suggested = Math.max(estimate.suggestedToolCalls, input.modeSuggestedToolCalls);
  if (input.budgetExhausted === "maxToolCalls") {
    suggested = Math.max(
      suggested,
      input.currentBudget.maxToolCalls * 2,
      input.usedToolCalls + 4,
    );
  }
  return { suggestedToolCalls: suggested, tier: estimate.tier };
}
