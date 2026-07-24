import type { Planner } from "../agent/Planner.js";
import type { Plan } from "../agent/types.js";
import type { TaskStore } from "../context/stores.js";
import type { TaskRecord } from "../context/types.js";
import type { ApiResult } from "../core/apiResult.js";
import type { ToolPermission } from "../core/permissions.js";
import type { PlanExecutionMode } from "../plan/PlanActivationWorkflow.js";
import type { PlanService } from "../plan/PlanService.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { toPublicError } from "../util/publicError.js";
import type { RunStore } from "./RunStore.js";
import type { SessionWorkspaceResolver } from "./SessionWorkspaceResolver.js";
import { rollbackFileChangesForRun, type TaskRollbackResult } from "./TaskRollback.js";
import type { TaskService } from "./TaskService.js";
import {
  buildPlanFallbackContext,
  detectTaskUncertainty,
  type ModeFallbackResult,
} from "./taskUncertainty.js";

export interface PlanExecutionFinalizerDeps {
  planner: Planner;
  planService: PlanService;
  taskService: Pick<TaskService, "applyExecutionResult" | "markFailed">;
  sessionWorkspace: SessionWorkspaceResolver;
  registry: ToolRegistry;
  tasks: TaskStore;
  runs: RunStore;
  trace?: TraceLogger;
}

export interface PlanExecutionFinalizationContext {
  planId: string;
  version: number;
  planRunId: string;
  executionMode: PlanExecutionMode;
  planGoal: string;
  executedPlan: Plan;
  runId: string;
  task: TaskRecord;
  sessionId?: string;
  dryRun: boolean;
  rollbackOnFailure: boolean;
  fallbackToPlanOnUncertainty: boolean;
  runGrantedPermissions?: readonly ToolPermission[];
  planner?: Planner;
  resumedFromChildRunId?: string;
}

/** Owns the single terminal persistence path for initial and event-resumed Plan executions. */
export class PlanExecutionFinalizer {
  constructor(private readonly deps: PlanExecutionFinalizerDeps) {}

  async finalizeSuccess(input: PlanExecutionFinalizationContext): Promise<ApiResult> {
    const taskStatus = this.deps.taskService.applyExecutionResult(
      input.task.id,
      input.sessionId,
      input.executedPlan,
    );
    const terminal = resolvePlanExecutionTerminalStatuses(taskStatus);
    let rollback: TaskRollbackResult | undefined;
    if (taskStatus === "failed" && !input.dryRun && input.rollbackOnFailure) {
      rollback = await this.tryRollbackTaskFiles(input);
    }
    const modeFallback = await this.tryFallbackToPlan(input);
    const resultPayload = {
      planId: input.planId,
      version: input.version,
      planRunId: input.planRunId,
      executionMode: input.executionMode,
      plan: input.executedPlan,
      ...(rollback ? { rollback } : {}),
      ...(modeFallback ? { modeFallback } : {}),
      ...(input.resumedFromChildRunId
        ? { resumedFromChildRunId: input.resumedFromChildRunId }
        : {}),
    };

    this.deps.runs.update(input.runId, {
      status: terminal.runStatus,
      error: null,
      resultJson: JSON.stringify(resultPayload),
    });
    this.recordOrUpdateAttempt({
      taskId: input.task.id,
      runId: input.runId,
      status: terminal.runStatus,
      result: JSON.stringify({
        stepCount: input.executedPlan.steps.length,
        rollback,
        modeFallback,
        planId: input.planId,
        version: input.version,
      }),
    });
    this.deps.trace?.write({
      type: "run_end",
      runId: input.runId,
      kind: input.dryRun ? "task_dry_run" : "task",
      status: terminal.runStatus,
      resumedFromChildRunId: input.resumedFromChildRunId,
    });
    this.deps.planService.markExecutionFinished(
      input.planId,
      input.version,
      terminal.planStatus,
    );
    this.deps.planService.finishPlanRun(
      input.planRunId,
      terminal.planRunStatus,
      taskStatus,
    );

    return {
      status: 200,
      body: { runId: input.runId, taskId: input.task.id, ...resultPayload },
    };
  }

  async finalizeFailure(
    input: Omit<PlanExecutionFinalizationContext, "executedPlan"> & { executedPlan?: Plan },
    error: unknown,
  ): Promise<ApiResult> {
    const publicError = toPublicError(error, "执行任务失败");
    let rollback: TaskRollbackResult | undefined;
    if (!input.dryRun && input.rollbackOnFailure) {
      rollback = await this.tryRollbackTaskFiles(input);
    }
    this.deps.taskService.markFailed(input.task.id, input.sessionId, publicError.message);
    this.recordOrUpdateAttempt({
      taskId: input.task.id,
      runId: input.runId,
      status: "failed",
      error: publicError.message,
    });
    this.deps.runs.update(input.runId, {
      status: "failed",
      error: publicError.message,
      resultJson: rollback ? JSON.stringify({ rollback }) : undefined,
    });
    this.deps.trace?.write({ type: "run_end", runId: input.runId, status: "failed" });
    this.finishFailedPlan(input.planId, input.version, input.planRunId, publicError.code);
    return {
      status: 500,
      body: {
        error: publicError.message,
        code: publicError.code,
        planRunId: input.planRunId,
        runId: input.runId,
        taskId: input.task.id,
        ...(rollback ? { rollback } : {}),
      },
    };
  }

  private recordOrUpdateAttempt(input: {
    taskId: string;
    runId: string;
    status: string;
    error?: string;
    result?: string;
  }): void {
    const updated = this.deps.tasks.updateLatestAttemptByRun({
      ...input,
      endedAt: new Date().toISOString(),
    });
    if (updated) return;
    this.deps.tasks.recordAttempt({
      ...input,
      endedAt: new Date().toISOString(),
    });
  }

  private finishFailedPlan(
    planId: string,
    version: number,
    planRunId: string,
    stopReason: string,
  ): void {
    try {
      this.deps.planService.markExecutionFinished(planId, version, "failed");
    } catch {
      // Preserve the original execution error when terminal persistence is already closed.
    }
    try {
      this.deps.planService.finishPlanRun(planRunId, "failed", stopReason);
    } catch {
      // Preserve the original execution error.
    }
  }

  private async tryFallbackToPlan(
    input: PlanExecutionFinalizationContext,
  ): Promise<ModeFallbackResult | undefined> {
    if (!input.fallbackToPlanOnUncertainty) return undefined;
    const uncertainty = detectTaskUncertainty(input.executedPlan);
    if (!uncertainty.uncertain) return undefined;

    const planRun = this.deps.runs.create({
      kind: "plan",
      status: "running",
      goal: input.planGoal,
      parentRunId: input.runId,
      sessionId: input.sessionId,
      taskId: input.task.id,
      correlation: {
        runId: "",
        sessionId: input.sessionId,
        taskId: input.task.id,
      },
    });
    this.deps.runs.update(planRun.id, {
      correlationJson: JSON.stringify({
        runId: planRun.id,
        sessionId: input.sessionId,
        taskId: input.task.id,
      }),
    });
    this.deps.trace?.write({
      type: "task_fallback_plan_start",
      runId: input.runId,
      planRunId: planRun.id,
      taskId: input.task.id,
      reasonCount: uncertainty.reasons.length,
    });

    try {
      const draft = await this.deps.planService.createDraftFromPlanner({
        goal: input.planGoal,
        context: buildPlanFallbackContext(input.executedPlan, uncertainty.reasons),
        sessionId: input.sessionId,
        requestId: planRun.id,
        planner: input.planner ?? this.deps.planner,
      });
      this.deps.runs.update(planRun.id, {
        status: "completed",
        resultJson: JSON.stringify({
          planId: draft.planId,
          version: draft.version,
          planHash: draft.planHash,
        }),
      });
      this.deps.trace?.write({
        type: "task_fallback_plan_end",
        runId: input.runId,
        planRunId: planRun.id,
        status: "completed",
        planId: draft.planId,
        version: draft.version,
      });
      return {
        triggered: true,
        reasons: uncertainty.reasons,
        planId: draft.planId,
        version: draft.version,
        previewMarkdown: draft.previewMarkdown,
        planRunId: planRun.id,
      };
    } catch (error) {
      const publicError = toPublicError(error, "生成降级计划失败");
      this.deps.runs.update(planRun.id, { status: "failed", error: publicError.message });
      this.deps.trace?.write({
        type: "task_fallback_plan_end",
        runId: input.runId,
        planRunId: planRun.id,
        status: "failed",
        error: publicError.message,
      });
      return {
        triggered: true,
        reasons: uncertainty.reasons,
        planRunId: planRun.id,
        error: publicError.message,
      };
    }
  }

  private async tryRollbackTaskFiles(input: {
    runId: string;
    sessionId?: string;
    task: TaskRecord;
    runGrantedPermissions?: readonly ToolPermission[];
  }): Promise<TaskRollbackResult | undefined> {
    const storage = this.deps.registry.getStorage();
    if (!storage) return undefined;
    return rollbackFileChangesForRun({
      registry: this.deps.registry,
      storage,
      workspaceRoot: this.deps.sessionWorkspace.workspaceForSession(input.sessionId),
      runId: input.runId,
      sessionId: input.sessionId,
      taskId: input.task.id,
      runGrantedPermissions: input.runGrantedPermissions,
      trace: this.deps.trace,
    });
  }
}

export function resolvePlanExecutionTerminalStatuses(taskStatus: string): {
  runStatus: "completed" | "blocked" | "cancelled" | "failed";
  planStatus: "completed" | "paused" | "cancelled" | "failed";
  planRunStatus: "completed" | "paused" | "cancelled" | "failed";
} {
  if (taskStatus === "completed") {
    return { runStatus: "completed", planStatus: "completed", planRunStatus: "completed" };
  }
  if (taskStatus === "cancelled") {
    return { runStatus: "cancelled", planStatus: "cancelled", planRunStatus: "cancelled" };
  }
  if (taskStatus === "blocked" || taskStatus === "in_progress" || taskStatus === "pending") {
    return { runStatus: "blocked", planStatus: "paused", planRunStatus: "paused" };
  }
  return { runStatus: "failed", planStatus: "failed", planRunStatus: "failed" };
}
