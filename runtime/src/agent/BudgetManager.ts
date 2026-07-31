import type { ToolPermission } from "../core/permissions.js";
import type { AgentToolStep } from "./toolStep.js";
import type { RunBudget, RunBudgetKey, RunBudgetUsage } from "./RunPolicyTypes.js";
import { countToolOutcomeUsage, isSuccessfulToolStep } from "./toolStepOutcome.js";

export interface BudgetCheckInput {
  toolPermission?: ToolPermission;
  permissionAllowed: boolean;
  steps: AgentToolStep[];
  modelTurns: number;
}

export interface BudgetLedgerSnapshot {
  preflightTools: number;
  recoveryTurns: number;
  cachedToolHits: number;
}

/** 分项运行预算：主执行 / 预扫描 / 系统恢复分层统计与耗尽检测。 */
export class BudgetManager {
  private runStartedAt = 0;
  private preflightTools = 0;
  private recoveryTurns = 0;
  private cachedToolHits = 0;

  constructor(
    readonly budget: RunBudget,
    readonly suggestedBudget: RunBudget,
  ) {}

  markRunStarted(at = Date.now()): void {
    this.runStartedAt = at;
    this.preflightTools = 0;
    this.recoveryTurns = 0;
    this.cachedToolHits = 0;
  }

  recordPreflightTool(count = 1): void {
    this.preflightTools += count;
  }

  recordRecoveryTurn(count = 1): void {
    this.recoveryTurns += count;
  }

  recordCacheHit(count = 1): void {
    this.cachedToolHits += count;
  }

  ledgerSnapshot(): BudgetLedgerSnapshot {
    return {
      preflightTools: this.preflightTools,
      recoveryTurns: this.recoveryTurns,
      cachedToolHits: this.cachedToolHits,
    };
  }

  restoreLedger(snapshot: BudgetLedgerSnapshot): void {
    this.preflightTools = snapshot.preflightTools;
    this.recoveryTurns = snapshot.recoveryTurns;
    this.cachedToolHits = snapshot.cachedToolHits;
  }

  buildUsage(steps: AgentToolStep[], modelTurns: number): RunBudgetUsage {
    const budgetedSteps = steps.filter(consumesToolBudget);
    const permissionUsage = countSuccessfulPermissionUsage(budgetedSteps);
    const outcomeUsage = countToolOutcomeUsage(steps);
    return {
      modelTurns,
      mainModelTurns: modelTurns,
      toolCalls: budgetedSteps.length,
      attemptedToolCalls: steps.filter((s) => !s.cached && !s.systemRecovery).length,
      readCalls: permissionUsage.readCalls,
      writeCalls: permissionUsage.writeCalls,
      shellCalls: permissionUsage.shellCalls,
      runtimeMs: Math.max(0, Date.now() - this.runStartedAt),
      preflightTools: this.preflightTools,
      recoveryTurns: this.recoveryTurns,
      cachedToolHits: this.cachedToolHits,
      ...outcomeUsage,
    };
  }

  findRuntimeExhaustion(): RunBudgetKey | undefined {
    if (Date.now() - this.runStartedAt >= this.budget.maxRuntimeMs) return "maxRuntimeMs";
    return undefined;
  }

  findMainModelTurnExhaustion(modelTurns: number): RunBudgetKey | undefined {
    if (modelTurns >= this.budget.maxModelTurns) return "maxModelTurns";
    return undefined;
  }

  findModelTurnExhaustion(modelTurns: number): RunBudgetKey | undefined {
    return this.findMainModelTurnExhaustion(modelTurns);
  }

  findPreflightExhaustion(): RunBudgetKey | undefined {
    if (this.preflightTools >= this.budget.maxPreflightTools) return "maxPreflightTools";
    return undefined;
  }

  findRecoveryExhaustion(): RunBudgetKey | undefined {
    if (this.recoveryTurns >= this.budget.maxRecoveryTurns) return "maxRecoveryTurns";
    return undefined;
  }

  findToolExhaustion(input: {
    toolPermission?: ToolPermission;
    permissionAllowed: boolean;
    steps: AgentToolStep[];
    isRecovery?: boolean;
    isPreflight?: boolean;
  }): RunBudgetKey | undefined {
    const effectiveSteps = input.steps.filter(consumesToolBudget);
    if (effectiveSteps.length >= this.budget.maxToolCalls) return "maxToolCalls";
    if (!input.toolPermission || !input.permissionAllowed) return undefined;

    const usage = countSuccessfulPermissionUsage(effectiveSteps);
    if (
      input.toolPermission === "read" &&
      this.budget.maxReadCalls > 0 &&
      usage.readCalls >= this.budget.maxReadCalls
    ) {
      return "maxReadCalls";
    }
    if (
      (input.toolPermission === "write" || input.toolPermission === "dangerous") &&
      this.budget.maxWriteCalls > 0 &&
      usage.writeCalls >= this.budget.maxWriteCalls
    ) {
      return "maxWriteCalls";
    }
    if (
      input.toolPermission === "shell" &&
      this.budget.maxShellCalls > 0 &&
      usage.shellCalls >= this.budget.maxShellCalls
    ) {
      return "maxShellCalls";
    }
    if (input.isPreflight && this.findPreflightExhaustion()) return "maxPreflightTools";
    if (input.isRecovery && this.findRecoveryExhaustion()) return "maxRecoveryTurns";
    return undefined;
  }

  findAnyExhaustion(input: BudgetCheckInput): RunBudgetKey | undefined {
    return (
      this.findRuntimeExhaustion() ??
      this.findMainModelTurnExhaustion(input.modelTurns) ??
      this.findToolExhaustion(input)
    );
  }

  buildSuggestedBudget(exhausted?: RunBudgetKey): RunBudget {
    const suggested = { ...this.suggestedBudget };
    if (exhausted) {
      suggested[exhausted] = Math.max(suggested[exhausted], this.budget[exhausted]);
    }
    return suggested;
  }

  remainingWorkflowSteps(steps: AgentToolStep[], pendingWorkflowTools: number): number {
    const usage = countSuccessfulPermissionUsage(steps.filter((s) => !s.cached));
    const preflightRemaining = Math.max(0, this.budget.maxPreflightTools - this.preflightTools);
    return Math.min(
      pendingWorkflowTools,
      preflightRemaining,
      Math.max(0, this.budget.maxToolCalls - steps.filter(consumesToolBudget).length),
      Math.max(0, this.budget.maxReadCalls - usage.readCalls),
    );
  }

  canRunRecovery(): boolean {
    return this.recoveryTurns < this.budget.maxRecoveryTurns;
  }

  formatExhaustedLine(budgetExhausted: RunBudgetKey): string {
    const ledger = this.ledgerSnapshot();
    const poolHint =
      budgetExhausted === "maxModelTurns"
        ? `（主执行轮次；预扫描 ${ledger.preflightTools} 次、系统恢复 ${ledger.recoveryTurns} 次、缓存命中 ${ledger.cachedToolHits} 次未计入主轮次）`
        : "";
    return `已达到当前运行预算（${budgetExhausted}=${this.budget[budgetExhausted]}）${poolHint}，已停止继续调用模型或工具，并基于已有信息做部分收尾。`;
  }
}

function consumesToolBudget(step: AgentToolStep): boolean {
  if (step.cached || step.systemRecovery || step.blocked || step.executed === false) return false;
  return step.executed === true || step.ok || step.outcomeClass !== undefined;
}

export function countSuccessfulPermissionUsage(steps: AgentToolStep[]): Pick<
  RunBudgetUsage,
  "readCalls" | "writeCalls" | "shellCalls"
> {
  const successful = steps.filter((s) => isSuccessfulToolStep(s) && !s.cached);
  return {
    readCalls: successful.filter((s) => s.permission === "read").length,
    writeCalls: successful.filter((s) => s.permission === "write" || s.permission === "dangerous").length,
    shellCalls: successful.filter((s) => s.permission === "shell").length,
  };
}

export function renderBudget(budget: RunBudget): string {
  return [
    `maxModelTurns=${budget.maxModelTurns}`,
    `maxToolCalls=${budget.maxToolCalls}`,
    `maxReadCalls=${budget.maxReadCalls}`,
    `maxWriteCalls=${budget.maxWriteCalls}`,
    `maxShellCalls=${budget.maxShellCalls}`,
    `maxPreflightTools=${budget.maxPreflightTools}`,
    `maxRecoveryTurns=${budget.maxRecoveryTurns}`,
    `maxRepeatedToolFailures=${budget.maxRepeatedToolFailures}`,
    `maxRuntimeMs=${budget.maxRuntimeMs}`,
  ].join(", ");
}
