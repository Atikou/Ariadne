import type { Planner } from "../agent/Planner.js";
import { TaskExecutionWorkflow } from "../agent/TaskExecutionWorkflow.js";
import { buildCorrectionSteps } from "../plan/planReplanOnFailure.js";
import type { Plan } from "../agent/types.js";
import type { TaskStore } from "../context/stores.js";
import type { TaskRecord } from "../context/types.js";
import type { ApiResult } from "../core/apiResult.js";
import type { ToolPermission } from "../core/permissions.js";
import type { PlanExecutionMode } from "../plan/PlanActivationWorkflow.js";
import { toTaskRunnerPlan } from "../plan/planConverter.js";
import type { PlanService } from "../plan/PlanService.js";
import { PlanValidationError } from "../plan/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { toPublicError } from "../util/publicError.js";
import type { PlanAgentTaskWorkflow } from "./PlanAgentTaskWorkflow.js";
import type { PlanExecutionFinalizer } from "./PlanExecutionFinalizer.js";
import type {
  RunAggregate,
  RunAggregateRepository,
} from "../run/RunAggregateRepository.js";
import type { SessionWorkspaceResolver } from "./SessionWorkspaceResolver.js";
import type { TaskService } from "./TaskService.js";

export interface PlanExecutionPayload {
  permissionPolicy?: import("../agent/RunPolicyTypes.js").UserPermissionPolicy;
  /** Internal server grant only. AgentEntryService never accepts this from public input. */
  runGrantedPermissions?: readonly ToolPermission[];
  sessionId?: string;
  rollbackOnFailure?: boolean;
  fallbackToPlanOnUncertainty?: boolean;
  executionMode?: PlanExecutionMode;
}

export interface PlanExecutionServiceDeps {
  planner: Planner;
  planService: PlanService;
  agentTaskWorkflow: PlanAgentTaskWorkflow;
  finalizer: PlanExecutionFinalizer;
  taskService: Pick<
    TaskService,
    "resolveOrCreateTask" | "persistPlan" | "applyExecutionResult" | "markFailed"
  >;
  sessionWorkspace: SessionWorkspaceResolver;
  registry: ToolRegistry;
  projectAllowedPermissions: ToolPermission[];
  tasks: TaskStore;
  runs: RunAggregateRepository;
  trace?: TraceLogger;
}

export function resolvePlanExecutionMode(
  plan: Plan,
  requested?: PlanExecutionMode,
): PlanExecutionMode {
  if (requested) return requested;
  const requiresAdaptiveSideEffects = plan.steps.some((step) =>
    step.requiredPermissions.some((permission) =>
      permission === "write"
      || permission === "shell"
      || permission === "network"
      || permission === "dangerous"));
  return requiresAdaptiveSideEffects ? "agent_loop" : "static";
}

/** Owns approved-plan execution, persistence, rollback, and fallback as one use case. */
export class PlanExecutionService {
  constructor(private readonly deps: PlanExecutionServiceDeps) {}

  async executeStoredPlan(
    planId: string,
    version: number,
    payload: PlanExecutionPayload,
    dryRun = false,
    planner?: Planner,
  ): Promise<ApiResult> {
    let internal;
    try {
      if (dryRun) {
        if (!this.deps.planService.getRecord(planId, version)) {
          return { status: 404, body: { error: "计划不存在", code: "PLAN_NOT_FOUND" } };
        }
        this.deps.planService.ensureApprovedForDryRun(planId, version);
      }
      internal = this.deps.planService.loadExecutable(planId, version);
    } catch (error) {
      if (error instanceof PlanValidationError) {
        return { status: 400, body: { error: error.message, code: error.code } };
      }
      const publicError = toPublicError(error, "加载计划失败");
      return { status: 404, body: { error: publicError.message, code: publicError.code } };
    }

    const plan = toTaskRunnerPlan(internal);
    const planGoal = plan.goal ?? plan.steps[0]?.title ?? "任务";
    const executionMode = resolvePlanExecutionMode(plan, payload.executionMode);
    const stepRowIds = new Map<string, string>();
    let planRun: ReturnType<PlanService["createPlanRun"]> | undefined;
    let sessionId: string | undefined;
    let task: TaskRecord | undefined;
    let run: RunAggregate | undefined;

    try {
      this.deps.planService.markRunning(planId, version);
      planRun = this.deps.planService.createPlanRun(planId, version);
      sessionId = payload.sessionId
        ? this.deps.sessionWorkspace.ensureSession(payload.sessionId, planGoal)
        : undefined;
      task = this.deps.taskService.resolveOrCreateTask(sessionId, planGoal);
      this.deps.taskService.persistPlan(task.id, plan);

      const createdRun = this.deps.runs.execute({
        type: "run.create",
        kind: dryRun ? "task_dry_run" : "task",
        sessionId,
        taskId: task.id,
        goal: planGoal,
      });
      run = this.deps.runs.execute({
        type: "run.start",
        runId: createdRun.id,
        expectedAggregateVersion: createdRun.aggregateVersion,
      });
      this.deps.trace?.write({
        type: "run_start",
        runId: run.id,
        kind: dryRun ? "task_dry_run" : "task",
        sessionId,
        taskId: task.id,
      });

      const dynamicReplan = (payload.fallbackToPlanOnUncertainty ?? false)
        ? async ({ step, plan: currentPlan }: { step: Plan["steps"][number]; plan: Plan }) =>
            buildCorrectionSteps({
              failedStep: step,
              plan: currentPlan,
              planner: planner ?? this.deps.planner,
              registry: this.deps.registry,
            })
        : undefined;
      const executedPlan = executionMode === "agent_loop" && !dryRun
        ? await this.deps.agentTaskWorkflow.run({
            plan,
            planId,
            planVersion: version,
            planRunId: planRun.id,
            parentRunId: run.id,
            parentTaskId: task.id,
            sessionId,
            planGoal,
            bindingPayload: {
              schemaVersion: 1,
              executionMode: "agent_loop",
              permissionPolicy: payload.permissionPolicy,
              runGrantedPermissions: payload.runGrantedPermissions
                ? [...payload.runGrantedPermissions]
                : undefined,
              rollbackOnFailure: payload.rollbackOnFailure ?? false,
              fallbackToPlanOnUncertainty: payload.fallbackToPlanOnUncertainty ?? false,
            },
            onStepFailed: dynamicReplan,
            maxDynamicReplans: 2,
          })
        : await new TaskExecutionWorkflow({
            registry: this.deps.registry,
            workspaceRoot: this.deps.sessionWorkspace.workspaceForSession(sessionId),
            projectAllowedPermissions: this.deps.projectAllowedPermissions,
            trace: this.deps.trace,
          }).run({
            plan,
            dryRun,
            permissionPolicy: payload.permissionPolicy,
            runGrantedPermissions: payload.runGrantedPermissions,
            taskId: task.id,
            sessionId,
            projectId: this.deps.sessionWorkspace.projectIdForSession(sessionId),
            runId: run.id,
            requireToolBinding: true,
            executionMode,
            planGoal,
            onUpdate: (updated) => this.deps.taskService.persistPlan(task!.id, updated),
            onStepLifecycle: (event) => {
              if (event.type === "started") {
                const rowId = this.deps.planService.recordPlanRunStepStarted({
                  planRunId: planRun!.id,
                  stepId: event.step.id,
                  toolName: event.step.tool,
                });
                stepRowIds.set(event.step.id, rowId);
                return;
              }
              const rowId = stepRowIds.get(event.step.id);
              if (!rowId || event.type === "deferred") return;
              this.deps.planService.recordPlanRunStepFinished(rowId, {
                status: event.type === "completed" ? "completed" : "failed",
                error: event.error,
                outputPreview: event.result?.output,
                planRunId: planRun!.id,
                stepId: event.step.id,
              });
            },
            onDagWave: (event) => {
              this.deps.trace?.write({
                type: "plan_event",
                eventType: "plan.dag_wave",
                planRunId: planRun!.id,
                waveIndex: event.waveIndex,
                stepIds: event.stepIds,
                at: new Date().toISOString(),
              });
            },
            maxDynamicReplans: 2,
          });

      return this.deps.finalizer.finalizeSuccess({
        planId,
        version,
        planRunId: planRun.id,
        executionMode,
        planGoal,
        executedPlan,
        runId: run.id,
        task,
        sessionId,
        dryRun,
        rollbackOnFailure: payload.rollbackOnFailure ?? false,
        fallbackToPlanOnUncertainty: payload.fallbackToPlanOnUncertainty ?? false,
        runGrantedPermissions: payload.runGrantedPermissions,
        planner,
      });
    } catch (error) {
      const publicError = toPublicError(error, "执行任务失败");
      if (run && task) {
        return this.deps.finalizer.finalizeFailure({
          planId,
          version,
          planRunId: planRun!.id,
          executionMode,
          planGoal,
          runId: run.id,
          task,
          sessionId,
          dryRun,
          rollbackOnFailure: payload.rollbackOnFailure ?? false,
          fallbackToPlanOnUncertainty: payload.fallbackToPlanOnUncertainty ?? false,
          runGrantedPermissions: payload.runGrantedPermissions,
          planner,
        }, error);
      }
      if (task) this.deps.taskService.markFailed(task.id, sessionId, publicError.message);
      if (run) {
        const current = this.deps.runs.get(run.id);
        if (current && current.status === "running") {
          this.deps.runs.execute({
            type: "run.fail",
            runId: current.id,
            expectedAggregateVersion: current.aggregateVersion,
            error: publicError.message,
          });
        }
        this.deps.trace?.write({ type: "run_end", runId: run.id, status: "failed" });
      }
      this.finishFailedPlan(planId, version, planRun, publicError.code);
      return {
        status: 500,
        body: {
          error: publicError.message,
          code: publicError.code,
          planRunId: planRun?.id,
          runId: run?.id,
          taskId: task?.id,
        },
      };
    }
  }

  private finishFailedPlan(
    planId: string,
    version: number,
    planRun: ReturnType<PlanService["createPlanRun"]> | undefined,
    stopReason: string,
  ): void {
    try {
      this.deps.planService.markExecutionFinished(planId, version, "failed");
    } catch {
      // Preserve the original execution error when terminal persistence is already closed.
    }
    if (planRun) this.deps.planService.finishPlanRun(planRun.id, "failed", stopReason);
  }

}
