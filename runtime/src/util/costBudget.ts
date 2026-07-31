export class CostBudgetExceededError extends Error {
  readonly code = "COST_BUDGET_EXCEEDED" as const;

  constructor(
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(`运行费用 ${spentUsd.toFixed(6)} USD 已达到或超过预算上限 ${limitUsd} USD`);
    this.name = "CostBudgetExceededError";
  }
}

export function assertWithinCostBudget(spentUsd: number, limitUsd?: number): void {
  if (limitUsd === undefined || limitUsd <= 0) return;
  if (spentUsd >= limitUsd) {
    throw new CostBudgetExceededError(spentUsd, limitUsd);
  }
}

export function isCostBudgetReached(spentUsd: number, limitUsd?: number): boolean {
  return limitUsd !== undefined && limitUsd > 0 && spentUsd >= limitUsd;
}

export function sumModelTurnCost(costs: Array<number | undefined>): number {
  return costs.reduce<number>((sum, c) => sum + (c ?? 0), 0);
}
