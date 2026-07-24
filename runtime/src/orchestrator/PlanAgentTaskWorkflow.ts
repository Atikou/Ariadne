import { TaskExecutionWorkflow } from "../agent/TaskExecutionWorkflow.js";
import type { Plan, PlanStep } from "../agent/types.js";
import type { ToolPermission } from "../core/permissions.js";
import type {
  PlanAgentStepBindingPayload,
  PlanAgentStepBindingStore,
} from "../plan/PlanAgentStepBindingStore.js";
import type { PlanService } from "../plan/PlanService.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { AgentRequestService } from "./AgentRequestService.js";
import type { SessionWorkspaceResolver } from "./SessionWorkspaceResolver.js";
import type { TaskService } from "./TaskService.js";

export interface PlanAgentTaskWorkflowDeps {
  agentRequestService: Pick<AgentRequestService, "run">;
  taskService: Pick<TaskService, "persistPlan">;
  planService: PlanService;
  bindings: PlanAgentStepBindingStore;
  sessionWorkspace: SessionWorkspaceResolver;
  registry: ToolRegistry;
  projectAllowedPermissions: ToolPermission[];
  trace?: TraceLogger;
}

export interface PlanAgentTaskWorkflowInput {
  plan: Plan;
  planId: string;
  planVersion: number;
  planRunId: string;
  parentRunId: string;
  parentTaskId: string;
  sessionId?: string;
  planGoal: string;
  bindingPayload: PlanAgentStepBindingPayload;
  onStepFailed?: (input: { step: PlanStep; plan: Plan }) => Promise<PlanStep[] | undefined>;
  maxDynamicReplans?: number;
}

/** Executes Agent-backed plan steps and persists every child wait before returning control. */
export class PlanAgentTaskWorkflow {
  constructor(private readonly deps: PlanAgentTaskWorkflowDeps) {}

  async run(input: PlanAgentTaskWorkflowInput): Promise<Plan> {
    const stepRowIds = new Map<string, string>();
    return new TaskExecutionWorkflow({
      registry: this.deps.registry,
      workspaceRoot: this.deps.sessionWorkspace.workspaceForSession(input.sessionId),
      projectAllowedPermissions: this.deps.projectAllowedPermissions,
      trace: this.deps.trace,
    }).run({
      plan: input.plan,
      taskId: input.parentTaskId,
      sessionId: input.sessionId,
      projectId: this.deps.sessionWorkspace.projectIdForSession(input.sessionId),
      runId: input.parentRunId,
      requireToolBinding: true,
      executionMode: "agent_loop",
      planGoal: input.planGoal,
      runAgent: (agentBody, completion) => this.deps.agentRequestService.run(
        agentBody,
        undefined,
        completion,
        { parentRunId: input.parentRunId, taskBinding: "detached" },
      ),
      onUpdate: (updated) => this.deps.taskService.persistPlan(input.parentTaskId, updated),
      onStepLifecycle: (event) => {
        if (event.type === "started") {
          const rowId = this.deps.planService.recordPlanRunStepStarted({
            planRunId: input.planRunId,
            stepId: event.step.id,
            toolName: event.step.tool,
          });
          stepRowIds.set(event.step.id, rowId);
          return;
        }

        const rowId = stepRowIds.get(event.step.id);
        if (!rowId) {
          throw new Error(`计划步骤 ${event.step.id} 缺少 PlanRunStep 关联`);
        }
        if (event.type === "deferred") {
          if (!event.childRunId || !event.childStopReason) {
            throw new Error(`计划步骤 ${event.step.id} 的子 Agent 暂停事件不完整`);
          }
          this.deps.planService.recordPlanRunStepWaiting(rowId, {
            planRunId: input.planRunId,
            stepId: event.step.id,
            childRunId: event.childRunId,
            error: event.error ?? `等待子 Agent：${event.childStopReason}`,
          });
          this.deps.bindings.createWaiting({
            planId: input.planId,
            planVersion: input.planVersion,
            planRunId: input.planRunId,
            parentRunId: input.parentRunId,
            parentTaskId: input.parentTaskId,
            stepId: event.step.id,
            stepRowId: rowId,
            childRunId: event.childRunId,
            payload: input.bindingPayload,
          });
          return;
        }
        this.deps.planService.recordPlanRunStepFinished(rowId, {
          status: event.type === "completed" ? "completed" : "failed",
          error: event.error,
          outputPreview: event.result?.output,
          planRunId: input.planRunId,
          stepId: event.step.id,
        });
      },
      onDagWave: (event) => {
        this.deps.trace?.write({
          type: "plan_event",
          eventType: "plan.dag_wave",
          planRunId: input.planRunId,
          waveIndex: event.waveIndex,
          stepIds: event.stepIds,
          at: new Date().toISOString(),
        });
      },
      onStepFailed: input.onStepFailed,
      maxDynamicReplans: input.maxDynamicReplans,
    });
  }
}
