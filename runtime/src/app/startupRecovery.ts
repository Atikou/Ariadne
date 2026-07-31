import type { PausedRunStore } from "../agent/PausedRunStore.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { PlanHandoffStore } from "../policy/PlanHandoffStore.js";
import type { PermissionRequestStore } from "../policy/PermissionRequestStore.js";
import type { RunAggregateRepository } from "../run/RunAggregateRepository.js";
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

/**
 * Marks interrupted work for explicit recovery. Startup never guesses that an
 * in-flight effect completed or silently replays it.
 */
export function recoverOnStartup(deps: {
  runs: RunAggregateRepository;
  notificationQueue: NotificationQueue;
  trace?: TraceLogger;
  pausedRunStore?: PausedRunStore;
  permissionRequestStore?: PermissionRequestStore;
  planHandoffStore?: PlanHandoffStore;
  subAgentWorkspaceRecovery?: SubAgentWorkspaceRecoverySummary;
}): StartupRecoverySummary {
  const interrupted = deps.runs.list({ status: "running", limit: 500 });
  let decisionRequiredRuns = 0;
  let recoverablePausedRuns = 0;

  for (const run of interrupted) {
    const paused = deps.pausedRunStore?.get(run.id);
    const pendingPermission = deps.permissionRequestStore?.getPendingByRunId(run.id);
    const pendingHandoff = deps.planHandoffStore?.getPendingByRunId(run.id);
    const ledger = deps.runs
      .listToolLedger(run.id)
      .filter((entry) => entry.status === "intended" || entry.status === "started");
    const resumability = new Map(
      run.state.inFlightEffects.map((effect) => [effect.idempotencyKey, effect.resumable]),
    );
    const uncertainSideEffects = ledger.filter(
      (entry) => entry.status === "started" && resumability.get(entry.idempotencyKey) !== true,
    );
    if (
      ledger.every((entry) => entry.status !== "started")
      && paused?.pendingAction
      && pendingPermission
    ) {
      deps.runs.execute({
        type: "run.request_confirmation",
        runId: run.id,
        expectedAggregateVersion: run.aggregateVersion,
        reason: {
          code: "permission_pause_interrupted",
          message: "The permission request and paused checkpoint were restored after interruption.",
        },
      });
      recoverablePausedRuns += 1;
      deps.trace?.write({
        type: "startup_recovery_run",
        runId: run.id,
        kind: run.kind,
        previousStatus: "running",
        recoveredStatus: "waiting_confirmation",
      });
      continue;
    }
    if (
      ledger.every((entry) => entry.status !== "started")
      && paused?.resumeMode
      && pendingHandoff
    ) {
      deps.runs.execute({
        type: "run.request_plan_handoff",
        runId: run.id,
        expectedAggregateVersion: run.aggregateVersion,
        reason: {
          code: "plan_handoff_pause_interrupted",
          message: "The plan handoff and paused checkpoint were restored after interruption.",
        },
      });
      recoverablePausedRuns += 1;
      deps.trace?.write({
        type: "startup_recovery_run",
        runId: run.id,
        kind: run.kind,
        previousStatus: "running",
        recoveredStatus: "waiting_plan_handoff",
      });
      continue;
    }
    const recoverable = uncertainSideEffects.length === 0;

    deps.runs.execute({
      type: "run.require_recovery",
      runId: run.id,
      expectedAggregateVersion: run.aggregateVersion,
      recoverable,
      reason: recoverable
        ? {
            code: pendingHandoff
              ? "plan_handoff_interrupted"
              : paused
                ? "paused_run_interrupted"
                : ledger.some((entry) => entry.status === "started")
                  ? "resumable_tool_interrupted"
                  : "safe_checkpoint_interrupted",
            message:
              "The process stopped at a recoverable checkpoint. Resume through the recovery command.",
          }
        : {
            code: "uncertain_side_effect",
            message:
              "A non-resumable tool started before the process stopped. User disposition is required.",
            details: {
              idempotencyKeys: uncertainSideEffects.map((entry) => entry.idempotencyKey),
              tools: [...new Set(uncertainSideEffects.map((entry) => entry.toolName))],
            },
          },
    });

    if (recoverable) {
      recoverablePausedRuns += 1;
      deps.trace?.write({
        type: "startup_recovery_run",
        runId: run.id,
        kind: run.kind,
        previousStatus: "running",
        recoveredStatus: "recovery_required",
      });
      continue;
    }
    decisionRequiredRuns += 1;
    deps.trace?.write({
      type: "startup_recovery_run",
      runId: run.id,
      kind: run.kind,
      previousStatus: "running",
      recoveredStatus: "recovery_required",
    });
  }

  const pendingNotifications = deps.notificationQueue.listPending().length;
  const scopeRecovery = deps.subAgentWorkspaceRecovery ?? {
    recoveredScopes: 0,
    preservedActiveScopes: 0,
    quarantinedEntries: 0,
  };
  if (
    decisionRequiredRuns > 0 ||
    recoverablePausedRuns > 0 ||
    pendingNotifications > 0 ||
    scopeRecovery.recoveredScopes > 0 ||
    scopeRecovery.preservedActiveScopes > 0 ||
    scopeRecovery.quarantinedEntries > 0
  ) {
    deps.trace?.write({
      type: "startup_recovery_summary",
      interruptedRuns: decisionRequiredRuns,
      preservedPausedRuns: recoverablePausedRuns,
      recoveredSubAgentScopes: scopeRecovery.recoveredScopes,
      preservedActiveSubAgentScopes: scopeRecovery.preservedActiveScopes,
      quarantinedSubAgentScopeEntries: scopeRecovery.quarantinedEntries,
      pendingNotifications,
    });
  }

  return {
    interruptedRuns: decisionRequiredRuns,
    preservedPausedRuns: recoverablePausedRuns,
    recoveredSubAgentScopes: scopeRecovery.recoveredScopes,
    preservedActiveSubAgentScopes: scopeRecovery.preservedActiveScopes,
    quarantinedSubAgentScopeEntries: scopeRecovery.quarantinedEntries,
    pendingNotifications,
    recoveredAt: new Date().toISOString(),
  };
}
