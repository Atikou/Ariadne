import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { PausedRunStore } from "../agent/PausedRunStore.js";
import type { RunStore } from "../orchestrator/RunStore.js";
import type { SubAgentWorkspaceRecoverySummary } from "../subagent/SubAgentWorkspaceLease.js";
import type { TraceLogger } from "../trace/TraceLogger.js";

export interface StartupRecoverySummary {
  interruptedRuns: number;
  preservedPausedRuns: number;
  recoveredSubAgentScopes: number;
  preservedActiveSubAgentScopes: number;
  quarantinedSubAgentScopeEntries: number;
  pendingNotifications: number;
  recoveredAt: string;
}

/** 启动时恢复控制面状态：暂停授权的 Run 继续等待，其余悬挂 running Run 标记失败。 */
export function recoverOnStartup(deps: {
  runs: RunStore;
  notificationQueue: NotificationQueue;
  trace?: TraceLogger;
  pausedRunStore?: PausedRunStore;
  planHandoffStore?: import("../policy/PlanHandoffStore.js").PlanHandoffStore;
  subAgentWorkspaceRecovery?: SubAgentWorkspaceRecoverySummary;
}): StartupRecoverySummary {
  const interrupted = deps.runs.list({ status: "running", limit: 500 });
  let failedInterruptedRuns = 0;
  let preservedPausedRuns = 0;

  for (const run of interrupted) {
    const paused = deps.pausedRunStore?.get(run.id);
    if (paused) {
      const pendingHandoff = deps.planHandoffStore?.getPendingByRunId(run.id);
      const recoveredStatus = pendingHandoff ? "waiting_plan_handoff" : "waiting_confirmation";
      deps.runs.update(run.id, { status: recoveredStatus });
      preservedPausedRuns += 1;
      deps.trace?.write({
        type: "startup_recovery_run",
        runId: run.id,
        kind: run.kind,
        previousStatus: "running",
        recoveredStatus,
      });
      continue;
    }

    deps.runs.update(run.id, {
      status: "failed",
      error: "进程重启导致运行中断（startupRecovery）",
    });
    failedInterruptedRuns += 1;
    deps.trace?.write({
      type: "startup_recovery_run",
      runId: run.id,
      kind: run.kind,
      previousStatus: "running",
      recoveredStatus: "failed",
    });
  }

  const pendingNotifications = deps.notificationQueue.listPending().length;
  const scopeRecovery = deps.subAgentWorkspaceRecovery ?? {
    recoveredScopes: 0,
    preservedActiveScopes: 0,
    quarantinedEntries: 0,
  };
  if (failedInterruptedRuns > 0 || preservedPausedRuns > 0 || pendingNotifications > 0 ||
      scopeRecovery.recoveredScopes > 0 || scopeRecovery.preservedActiveScopes > 0 ||
      scopeRecovery.quarantinedEntries > 0) {
    deps.trace?.write({
      type: "startup_recovery_summary",
      interruptedRuns: failedInterruptedRuns,
      preservedPausedRuns,
      recoveredSubAgentScopes: scopeRecovery.recoveredScopes,
      preservedActiveSubAgentScopes: scopeRecovery.preservedActiveScopes,
      quarantinedSubAgentScopeEntries: scopeRecovery.quarantinedEntries,
      pendingNotifications,
    });
  }

  return {
    interruptedRuns: failedInterruptedRuns,
    preservedPausedRuns,
    recoveredSubAgentScopes: scopeRecovery.recoveredScopes,
    preservedActiveSubAgentScopes: scopeRecovery.preservedActiveScopes,
    quarantinedSubAgentScopeEntries: scopeRecovery.quarantinedEntries,
    pendingNotifications,
    recoveredAt: new Date().toISOString(),
  };
}
