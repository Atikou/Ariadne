import type { ModelProfile, QualityMode, RouterInput } from "./types.js";

const RELATIVE_COST_ORDER: Record<ModelProfile["relativeCost"], number> = {
  free: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/** 无精确单价时，用 relativeCost 档位估算单次调用成本（USD）。 */
const RELATIVE_COST_ESTIMATE_USD: Record<ModelProfile["relativeCost"], number> = {
  free: 0,
  low: 0.002,
  medium: 0.02,
  high: 0.08,
};

const TIGHT_REMAINING_USD = 0.05;
const TIGHT_REMAINING_RATIO = 0.2;
const SOFT_REMAINING_RATIO = 0.5;

export type CostBudgetPressure = "none" | "soft" | "tight";

export interface CostBudgetContext {
  maxCostUsd?: number;
  spentCostUsd: number;
  remainingUsd?: number;
  pressure: CostBudgetPressure;
  signals: string[];
}

export interface CostBudgetRankingResult {
  candidates: ModelProfile[];
  signals: string[];
  context: CostBudgetContext;
}

/**
 * V8：按请求/会话成本预算与 qualityMode 对候选做成本友好排序（不改配置、不剔除候选）。
 */
export class CostBudgetManager {
  resolveContext(input: RouterInput): CostBudgetContext {
    const signals: string[] = [];
    const spent = Math.max(0, input.spentCostUsd ?? 0);
    const max = input.maxCostUsd;
    let pressure: CostBudgetPressure = "none";

    if (input.qualityMode === "fast") {
      pressure = "soft";
      signals.push("quality_fast=prefer_cheaper");
    }

    if (max !== undefined && max > 0) {
      const remaining = max - spent;
      if (remaining <= 0) {
        pressure = "tight";
        signals.push("budget_exhausted");
      } else if (remaining <= TIGHT_REMAINING_USD || remaining / max <= TIGHT_REMAINING_RATIO) {
        pressure = "tight";
        signals.push(`remaining_usd<=${TIGHT_REMAINING_USD}`);
      } else if (remaining / max <= SOFT_REMAINING_RATIO) {
        pressure = "soft";
        signals.push("remaining_ratio<=0.5");
      }
    }

    return {
      maxCostUsd: max,
      spentCostUsd: spent,
      remainingUsd: max !== undefined && max > 0 ? Math.max(0, max - spent) : undefined,
      pressure,
      signals,
    };
  }

  rankCandidates(
    candidates: ModelProfile[],
    input: RouterInput,
    tokenEstimate?: number,
  ): CostBudgetRankingResult {
    const context = this.resolveContext(input);
    if (candidates.length <= 1 || context.pressure === "none") {
      return { candidates, signals: [], context };
    }

    const multiplier = context.pressure === "tight" ? 25 : 10;
    const tokenFactor = Math.max(1, (tokenEstimate ?? 2000) / 4000);

    const scored = candidates.map((profile, index) => ({
      profile,
      index,
      penalty: this.scoreProfile(profile, context, multiplier, tokenFactor),
    }));

    const reordered = [...scored].sort((a, b) => {
      if (a.penalty !== b.penalty) return a.penalty - b.penalty;
      return a.index - b.index;
    });

    const signals = [...context.signals];
    for (const entry of scored) {
      if (
        context.remainingUsd !== undefined &&
        this.estimateProfileCost(entry.profile) > context.remainingUsd
      ) {
        signals.push(`over_budget:${entry.profile.id}`);
      }
    }
    const firstBefore = scored[0]!.profile.id;
    const firstAfter = reordered[0]!.profile.id;
    if (firstBefore !== firstAfter) {
      const demoted = scored.find((s) => s.profile.id === firstBefore);
      if (demoted && demoted.penalty > 0) {
        signals.push(
          `deprioritize:${firstBefore}(cost=${demoted.profile.relativeCost},penalty=${demoted.penalty})`,
        );
      }
    }

    return {
      candidates: reordered.map((s) => s.profile),
      signals: [...new Set(signals)],
      context,
    };
  }

  estimateProfileCost(profile: ModelProfile, tokenEstimate = 2000): number {
    const base = RELATIVE_COST_ESTIMATE_USD[profile.relativeCost];
    return base * Math.max(1, tokenEstimate / 1000);
  }

  private scoreProfile(
    profile: ModelProfile,
    context: CostBudgetContext,
    multiplier: number,
    tokenFactor: number,
  ): number {
    const tier = RELATIVE_COST_ORDER[profile.relativeCost];
    if (tier === 0) return 0;

    let penalty = tier * multiplier * tokenFactor;
    if (context.pressure === "tight" && profile.relativeCost === "high") {
      penalty += 40;
    }
    if (context.remainingUsd !== undefined) {
      const est = this.estimateProfileCost(profile) * tokenFactor;
      if (est > context.remainingUsd) {
        penalty += 60;
      }
    }
    return Math.round(penalty);
  }
}

export const defaultCostBudgetManager = new CostBudgetManager();
