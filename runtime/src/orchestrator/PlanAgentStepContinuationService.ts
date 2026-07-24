import { buildCorrectionSteps } from "../plan/planReplanOnFailure.js";
import { planFromTask } from "../agent/planFromTask.js";
import type { Planner } from "../agent/Planner.js";
import type { Plan } from "../agent/types.js";
import type { TaskStore } from "../context/stores.js";
import type { PlanAgentStepBindingStore } from "../plan/PlanAgentStepBindingStore.js";
import type { PlanService } from "../plan/PlanService.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { PlanAgentTaskWorkflow } from "./PlanAgentTaskWorkflow.js";
import type { PlanExecutionFinalizer } from "./PlanExecutionFinalizer.js";
import type { RunStore } from "./RunStore.js";
import type { RunTerminalEvent } from "./RunTerminalEventBus.js";
import type { TaskService } from "./TaskService.js";

export interface PlanAgentStepContinuationServiceDeps {
  planner: Planner;
  registry: ToolRegistry;
  planService: PlanService;
  agentTaskWorkflow: PlanAgentTaskWorkflow;
  finalizer: PlanExecutionFinalizer;
  bindings: PlanAgentStepBindingStore;
  taskService: Pick<TaskService, "persistPlan" | "applyStateTransition">;
  tasks: TaskStore;
  runs: RunStore;
  trace?: TraceLogger;
}

/** Consumes child Run facts and resumes the durable parent plan without a control-flow backcall. */
export class PlanAgentStepContinuationService {
  private readonly parentLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: PlanAgentStepContinuationServiceDeps) {}

  async handleRunTerminal(event: RunTerminalEvent): Promise<void> {
    const binding = this.deps.bindings.getByChildRunId(event.runId);
    if (!binding || binding.status !== "waiting_child") return;
    await this.withParentLock(binding.parentRunId, async () => {
      const claimed = this.deps.bindings.claim(binding.id);
      if (!claimed) return;
      try {
        const childRun = this.deps.runs.get(claimed.childRunId);
        const parentRun = this.deps.runs.get(claimed.parentRunId);
        const task = this.deps.tasks.get(claimed.parentTaskId);
        if (!childRun || !parentRun || !task) {
          throw new Error("计划子 Agent 续接缺少持久化的 child Run、parent Run 或 Task");
        }
        if (!isTerminalStatus(childRun.status)) {
          this.deps.bindings.release(claimed.id, `子 Run 尚未终止：${childRun.status}`);
          return;
        }

        const plan = planFromTask(task, this.deps.tasks.listSteps(task.id));
        const step = plan.steps.find((candidate) => candidate.id === claimed.stepId);
        if (!step) throw new Error(`父 Task 缺少等待步骤：${claimed.stepId}`);
        if (step.status !== "waiting_agent" && step.status !== "completed") {
          throw new Error(`父计划步骤 ${step.id} 状态不是 waiting_agent：${step.status}`);
        }

        this.deps.planService.markRunning(claimed.planId, claimed.planVersion);
        this.deps.planService.resumePlanRun(claimed.planRunId);
        this.deps.runs.update(parentRun.id, { status: "running", error: null });
        this.deps.taskService.applyStateTransition(task.id, parentRun.sessionId, {
          status: "in_progress",
          summary: `子 Agent ${childRun.id} 已终止，继续父计划`,
          releaseFromSession: false,
        });
        this.deps.trace?.write({
          type: "run_resume",
          runId: parentRun.id,
          kind: "task",
          childRunId: childRun.id,
          planRunId: claimed.planRunId,
          stepId: claimed.stepId,
          source: event.source,
        });

        const childOutcome = readChildOutcome(childRun.status, childRun.resultJson, childRun.error);
        step.error = childOutcome.error;
        step.result = childOutcome.output;
        step.status = childOutcome.status;
        this.deps.taskService.persistPlan(task.id, plan);
        this.deps.planService.recordPlanRunStepFinished(claimed.stepRowId, {
          status: childOutcome.status === "completed" ? "completed" : childOutcome.status,
          error: childOutcome.error,
          outputPreview: childOutcome.output,
          planRunId: claimed.planRunId,
          stepId: claimed.stepId,
        });

        const executedPlan = childOutcome.status === "completed"
          ? await this.deps.agentTaskWorkflow.run({
              plan,
              planId: claimed.planId,
              planVersion: claimed.planVersion,
              planRunId: claimed.planRunId,
              parentRunId: claimed.parentRunId,
              parentTaskId: claimed.parentTaskId,
              sessionId: parentRun.sessionId,
              planGoal: task.goal,
              bindingPayload: claimed.payload,
              onStepFailed: claimed.payload.fallbackToPlanOnUncertainty
                ? async ({ step: failedStep, plan: currentPlan }) => buildCorrectionSteps({
                    failedStep,
                    plan: currentPlan,
                    planner: this.deps.planner,
                    registry: this.deps.registry,
                  })
                : undefined,
              maxDynamicReplans: 2,
            })
          : plan;

        const finalized = await this.deps.finalizer.finalizeSuccess({
          planId: claimed.planId,
          version: claimed.planVersion,
          planRunId: claimed.planRunId,
          executionMode: "agent_loop",
          planGoal: task.goal,
          executedPlan,
          runId: parentRun.id,
          task,
          sessionId: parentRun.sessionId,
          dryRun: false,
          rollbackOnFailure: claimed.payload.rollbackOnFailure,
          fallbackToPlanOnUncertainty: claimed.payload.fallbackToPlanOnUncertainty,
          runGrantedPermissions: claimed.payload.runGrantedPermissions,
          planner: this.deps.planner,
          resumedFromChildRunId: childRun.id,
        });
        const bindingStatus = childOutcome.status === "completed"
          ? (finalized.status === 200 ? "completed" : "failed")
          : childOutcome.status;
        this.deps.bindings.finish(
          claimed.id,
          bindingStatus,
          finalized.status === 200 ? childOutcome.error : "父计划续接终态持久化失败",
        );
      } catch (error) {
        const parent = this.deps.runs.get(claimed.parentRunId);
        if (parent?.status === "running") {
          this.deps.runs.update(parent.id, {
            status: "blocked",
            error: `父计划续接失败：${String(error)}`,
          });
          this.deps.taskService.applyStateTransition(claimed.parentTaskId, parent.sessionId, {
            status: "blocked",
            summary: "父计划续接失败，保留持久关联等待恢复",
            releaseFromSession: false,
          });
          try {
            this.deps.planService.markExecutionFinished(
              claimed.planId,
              claimed.planVersion,
              "paused",
            );
            this.deps.planService.finishPlanRun(
              claimed.planRunId,
              "paused",
              "child_continuation_failed",
            );
          } catch {
            // The binding remains recoverable even if the parent projection is damaged.
          }
        }
        this.deps.bindings.release(claimed.id, String(error));
        this.deps.trace?.write({
          type: "plan_event",
          eventType: "plan.child_continuation_failed",
          planRunId: claimed.planRunId,
          parentRunId: claimed.parentRunId,
          childRunId: claimed.childRunId,
          stepId: claimed.stepId,
          error: String(error),
          at: new Date().toISOString(),
        });
      }
    });
  }

  async recover(): Promise<number> {
    this.deps.bindings.resetInterruptedClaims();
    let resumed = 0;
    for (const binding of this.deps.bindings.listRecoverable()) {
      const child = this.deps.runs.get(binding.childRunId);
      if (!child || !isTerminalStatus(child.status)) continue;
      await this.handleRunTerminal({
        runId: child.id,
        status: child.status,
        source: "startup_recovery",
        at: new Date().toISOString(),
      });
      resumed += 1;
    }
    return resumed;
  }

  private async withParentLock(parentRunId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.parentLocks.get(parentRunId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.parentLocks.set(parentRunId, current);
    try {
      await current;
    } finally {
      if (this.parentLocks.get(parentRunId) === current) this.parentLocks.delete(parentRunId);
    }
  }
}

function isTerminalStatus(value: string): value is RunTerminalEvent["status"] {
  return value === "completed" || value === "failed" || value === "cancelled";
}

function readChildOutcome(
  runStatus: RunTerminalEvent["status"],
  resultJson: string | undefined,
  runError: string | undefined,
): {
  status: Extract<Plan["steps"][number]["status"], "completed" | "failed" | "cancelled">;
  output?: string;
  error?: string;
} {
  if (runStatus === "cancelled") {
    return { status: "cancelled", error: runError ?? "用户拒绝了子 Agent 权限申请" };
  }
  if (runStatus === "failed") {
    return { status: "failed", error: runError ?? "子 Agent 执行失败" };
  }
  try {
    const parsed = JSON.parse(resultJson ?? "{}") as {
      answer?: unknown;
      executionMeta?: { stopReason?: unknown; completionStatus?: unknown };
    };
    if (
      parsed.executionMeta?.stopReason !== "completed"
      || parsed.executionMeta?.completionStatus !== "completed_success"
    ) {
      return {
        status: "failed",
        error: "子 Agent 已终止，但未通过计划步骤完成合同",
      };
    }
    return {
      status: "completed",
      output: typeof parsed.answer === "string" ? parsed.answer : "子 Agent 已完成",
    };
  } catch {
    return { status: "failed", error: "子 Agent 结果不是有效 JSON" };
  }
}
