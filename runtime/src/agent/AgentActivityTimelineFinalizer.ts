import type { BudgetLedgerSnapshot } from "./BudgetManager.js";
import type { CompletionGuardResult } from "./completion/CompletionFinalGuard.js";
import type { AgentStopReason, RunBudgetKey } from "./RunPolicyTypes.js";
import { resolveAgentRunOutcome } from "./AgentRunOutcome.js";

export interface AgentActivityTimelineSink {
  getRun(): { id: string } | null;
  startStep(input: {
    runId: string;
    type: "summary";
    title: string;
    content?: string;
  }): { id: string };
  completeStep(stepId: string, result?: string): void;
  completeRun(summary: string): void;
  partialCompleteRun?(summary: string, title?: string): void;
  pauseRun?(summary: string, title?: string): void;
  failRun(error: string): void;
  cancelRun(reason?: string): void;
}

export interface FinalizeAgentActivityTimelineInput {
  timeline?: AgentActivityTimelineSink;
  runId?: string;
  answer: string;
  reachedLimit: boolean;
  budgetExhausted?: RunBudgetKey;
  stopReason?: AgentStopReason;
  completionGuard?: Pick<CompletionGuardResult, "status" | "reason">;
  partialSummary?: string;
  budgetLedger?: BudgetLedgerSnapshot;
  maxRecoveryTurns: number;
}

export function finalizeAgentActivityTimeline(input: FinalizeAgentActivityTimelineInput): void {
  const tl = input.timeline;
  if (!tl) return;
  const runId = input.runId ?? tl.getRun()?.id ?? "";
  const declaredStop = input.stopReason ?? (input.reachedLimit ? "budget_exhausted" : "completed");
  const stop = guardStopReason(input.completionGuard?.status) ?? declaredStop;
  const outcome = resolveAgentRunOutcome(stop);

  if (outcome.timelineOutcome === "cancelled") {
    tl.cancelRun("用户取消");
    return;
  }

  if (stop === "budget_exhausted") {
    const ledger = input.budgetLedger ?? {
      preflightTools: 0,
      recoveryTurns: 0,
      cachedToolHits: 0,
    };
    const summary =
      input.partialSummary ||
      `运行预算耗尽：${input.budgetExhausted ?? "unknown"}（恢复 ${ledger.recoveryTurns}/${input.maxRecoveryTurns}）`;
    pauseOrFail(tl, summary, "等待追加执行预算");
    return;
  }

  if (outcome.timelineOutcome === "partial") {
    const title =
      stop === "misleading_completion"
        ? "检测到虚假完成"
        : stop === "recovery_partial"
          ? "部分完成 · 恢复预算耗尽"
          : "任务未完全完成";
    const summary =
      input.partialSummary ||
      input.completionGuard?.reason ||
      input.stopReason ||
      "";
    partialCompleteOrFail(tl, summary, title);
    return;
  }

  if (outcome.timelineOutcome === "waiting") {
    const waitingForPlan = stop === "awaiting_plan_handoff";
    const defaultMessage = waitingForPlan ? "等待计划审批" : "等待工具授权";
    const summary = input.partialSummary || input.completionGuard?.reason || defaultMessage;
    pauseOrFail(tl, summary, defaultMessage);
    return;
  }

  if (outcome.timelineOutcome === "success") {
    const summary = tl.startStep({
      runId,
      type: "summary",
      title: "任务完成",
      content: input.answer.slice(0, 400),
    });
    tl.completeStep(summary.id, input.answer.slice(0, 500));
    tl.completeRun(input.answer.slice(0, 800));
    return;
  }

  tl.failRun(input.partialSummary || input.completionGuard?.reason || stop);
}

function guardStopReason(
  guardStatus?: CompletionGuardResult["status"],
): AgentStopReason | undefined {
  if (
    guardStatus === "historical_reference" ||
    guardStatus === "completed_partial" ||
    guardStatus === "misleading_completion" ||
    guardStatus === "blocked_by_policy"
  ) {
    return guardStatus;
  }
  return undefined;
}

function partialCompleteOrFail(
  tl: AgentActivityTimelineSink,
  summary: string,
  title: string,
): void {
  if (typeof tl.partialCompleteRun === "function") {
    tl.partialCompleteRun(summary.slice(0, 800), title);
    return;
  }
  tl.failRun(title);
}

function pauseOrFail(
  tl: AgentActivityTimelineSink,
  summary: string,
  title: string,
): void {
  if (typeof tl.pauseRun === "function") {
    tl.pauseRun(summary.slice(0, 800), title);
    return;
  }
  tl.failRun(title);
}
