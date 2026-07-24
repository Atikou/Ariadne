import { planFromTask } from "../agent/planFromTask.js";
import { aggregateTaskStatus } from "../agent/taskStatus.js";
import type { Plan } from "../agent/types.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { TaskStore } from "../context/stores.js";
import type { TaskRecord } from "../context/types.js";
import type { ApiResult } from "../core/apiResult.js";
import type { SessionWorkspaceResolver } from "./SessionWorkspaceResolver.js";

export interface TaskServiceDeps {
  sessionWorkspace: Pick<SessionWorkspaceResolver, "projectIdForSession">;
  contextManager: ContextManager;
  tasks: TaskStore;
}

export interface TaskStateTransition {
  status: string;
  summary: string;
  releaseFromSession: boolean;
}

/** Owns durable Task state, session ownership, snapshots, and the Task resume use case. */
export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  getTask(taskId: string): ApiResult {
    const task = this.deps.tasks.get(taskId);
    if (!task) return { status: 404, body: { error: "任务不存在" } };
    const steps = this.deps.tasks.listSteps(taskId);
    const plan = planFromTask(task, steps);
    return {
      status: 200,
      body: {
        task: { ...task, status: aggregateTaskStatus(plan.steps) },
        steps,
        plan,
      },
    };
  }

  resolveOrCreateTask(sessionId: string | undefined, goal: string): TaskRecord {
    if (sessionId) {
      const active = this.deps.tasks.getActiveForSession(sessionId);
      if (active) return active;
    }
    const task = this.deps.tasks.create({ goal, sessionId, status: "in_progress" });
    if (sessionId) this.deps.contextManager.setActiveTask(sessionId, task.id);
    return task;
  }

  createDetachedTask(sessionId: string | undefined, goal: string): TaskRecord {
    return this.deps.tasks.create({
      goal,
      sessionId,
      projectId: this.deps.sessionWorkspace.projectIdForSession(sessionId),
      status: "in_progress",
    });
  }

  persistPlan(taskId: string, plan: Plan): void {
    this.deps.tasks.update(taskId, {
      inputs: plan.inputs,
      outputs: plan.outputs,
      acceptanceCriteria: plan.acceptanceCriteria,
    });
    this.deps.tasks.upsertSteps(
      taskId,
      plan.steps.map((step, index) => ({
        stepId: step.id,
        position: index,
        title: step.title,
        objective: step.objective,
        description: step.description,
        status: step.status,
        requiredPermissions: step.requiredPermissions,
        needsConfirmation: step.needsConfirmation,
        acceptance: step.acceptance,
        dependsOn: step.dependsOn,
        requiredContext: step.requiredContext,
        availableTools: step.availableTools,
        expectedArtifacts: step.expectedArtifacts,
        priority: step.priority,
        tool: step.tool,
        toolInput: step.toolInput,
        result: step.result,
        error: step.error,
      })),
    );
  }

  applyExecutionResult(taskId: string, sessionId: string | undefined, plan: Plan): string {
    this.persistPlan(taskId, plan);
    const taskStatus = aggregateTaskStatus(plan.steps);
    this.applyStateTransition(taskId, sessionId, {
      status: taskStatus,
      summary: taskStatus === "completed"
        ? "全部步骤完成"
        : taskStatus === "blocked"
          ? "存在阻塞步骤，可 resume"
          : "部分步骤未完成",
      releaseFromSession: taskStatus === "completed",
    });
    return taskStatus;
  }

  markFailed(taskId: string, sessionId: string | undefined, summary: string): void {
    this.applyStateTransition(taskId, sessionId, {
      status: "failed",
      summary,
      releaseFromSession: true,
    });
  }

  applyStateTransition(
    taskId: string,
    sessionId: string | undefined,
    transition: TaskStateTransition,
  ): void {
    this.deps.tasks.update(taskId, {
      status: transition.status,
      summary: transition.summary,
    });
    if (transition.releaseFromSession) this.releaseFromSession(sessionId, taskId);
  }

  private releaseFromSession(sessionId: string | undefined, taskId: string): void {
    if (!sessionId) return;
    const session = this.deps.contextManager.getSession(sessionId);
    if (session?.activeTaskId === taskId) {
      this.deps.contextManager.setActiveTask(sessionId, null);
    }
  }

}
