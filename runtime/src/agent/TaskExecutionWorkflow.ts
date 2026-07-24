import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolPermission } from "../core/permissions.js";
import type { PlanExecutionMode } from "../plan/PlanActivationWorkflow.js";
import type { UserPermissionPolicy } from "./RunPolicyTypes.js";
import {
  DryRunExecutor,
  TaskRunner,
  type StepExecutor,
  type StepLifecycleEvent,
} from "./TaskRunner.js";
import { PlanStepAgentExecutor, type AgentLoopRunFn } from "./PlanStepAgentExecutor.js";
import { ToolStepExecutor } from "./ToolStepExecutor.js";
import { BudgetManager } from "./BudgetManager.js";
import { MODE_BASE_BUDGETS, MODE_SUGGESTED_BUDGETS } from "./runBudgetDefaults.js";
import type { Plan, PlanStep } from "./types.js";
import type { StepResult } from "./TaskRunner.js";

export interface TaskExecutionWorkflowOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  projectAllowedPermissions?: ToolPermission[];
  trace?: TraceLogger;
}

export interface TaskExecutionWorkflowRunInput {
  plan: Plan;
  dryRun?: boolean;
  permissionPolicy?: UserPermissionPolicy;
  runGrantedPermissions?: readonly ToolPermission[];
  taskId?: string;
  sessionId?: string;
  projectId?: string;
  runId?: string;
  onUpdate?: (plan: Plan) => void;
  executor?: StepExecutor;
  requireToolBinding?: boolean;
  executionMode?: PlanExecutionMode;
  runAgent?: AgentLoopRunFn;
  planGoal?: string;
  onStepLifecycle?: (event: StepLifecycleEvent) => void;
  onDagWave?: (event: { waveIndex: number; stepIds: string[] }) => void;
  onStepFailed?: (input: { step: PlanStep; plan: Plan }) => Promise<PlanStep[] | undefined>;
  maxDynamicReplans?: number;
}

/**
 * Workflow-level entry for approved task execution.
 *
 * PlanExecutionService owns run/task persistence and rollback policy; this
 * class only wires the already-approved stored plan into TaskRunner.
 */
export class TaskExecutionWorkflow {
  private taskBudgetManager?: BudgetManager;

  constructor(private readonly options: TaskExecutionWorkflowOptions) {}

  async run(input: TaskExecutionWorkflowRunInput): Promise<Plan> {
    return this.createRunner(input).run();
  }

  createRunner(input: TaskExecutionWorkflowRunInput): TaskRunner {
    return new TaskRunner(input.plan, {
      executor: this.createExecutor(input),
      stepConfirmationMode: input.dryRun
        ? "dry_run"
        : input.executionMode === "agent_loop"
          ? "delegated_to_agent"
          : "required",
      projectAllowedPermissions: this.options.projectAllowedPermissions,
      onUpdate: input.onUpdate,
      trace: this.options.trace,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      onStepLifecycle: input.onStepLifecycle,
      onDagWave: input.onDagWave,
      onStepFailed: input.onStepFailed,
      maxDynamicReplans: input.maxDynamicReplans,
    });
  }

  private createExecutor(input: TaskExecutionWorkflowRunInput): StepExecutor {
    if (input.executor) return input.executor;
    if (input.dryRun) {
      return new DryRunExecutor({ requireToolBinding: input.requireToolBinding });
    }
    const mode = input.executionMode ?? "static";
    if (mode === "agent_loop" && input.runAgent) {
      return new PlanStepAgentExecutor({
        runAgent: input.runAgent,
        sessionId: input.sessionId,
        planGoal: input.planGoal ?? input.plan.goal,
      });
    }
    const budgetManager = this.getOrCreateTaskBudgetManager();
    return new ToolStepExecutor({
      registry: this.options.registry,
      workspaceRoot: this.options.workspaceRoot,
      taskId: input.taskId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      requestId: input.runId,
      projectAllowedPermissions: this.options.projectAllowedPermissions,
      requireToolBinding: input.requireToolBinding,
      budgetManager,
      budgetBucket: "main",
      permissionPolicy:
        input.permissionPolicy ?? "confirmBeforeRun",
      runGrantedPermissions: input.runGrantedPermissions,
    });
  }

  /** 任务执行共享 BudgetManager，与 PlanWorkflow preflight 分层语义一致。 */
  getOrCreateTaskBudgetManager(): BudgetManager {
    if (!this.taskBudgetManager) {
      const base = MODE_BASE_BUDGETS.implement;
      this.taskBudgetManager = new BudgetManager(base, MODE_SUGGESTED_BUDGETS.implement);
      this.taskBudgetManager.markRunStarted();
    }
    return this.taskBudgetManager;
  }
}
