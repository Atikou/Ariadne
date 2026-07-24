import type { TraceLogger } from "../trace/TraceLogger.js";
import { MODE_PERMISSIONS, type ToolPermission } from "../core/permissions.js";
import { resolveEffectivePermissions } from "../policy/PermissionPolicy.js";
import {
  indexPlanSteps,
  propagateDependencyBlocks,
  readyPendingSteps,
  validateTaskGraph,
} from "./taskGraph.js";
import { aggregateTaskStatus } from "./taskStatus.js";
import type { Plan, PlanStep } from "./types.js";

export interface StepContext {
  signal?: AbortSignal;
}

export interface StepResult {
  output?: string;
  toolCallId?: string;
}

/** 步骤执行器：任务模式下「如何执行一个步骤」的可插拔实现。 */
export interface StepExecutor {
  execute(step: PlanStep, ctx: StepContext): Promise<StepResult>;
}

export class StepExecutionError extends Error {
  constructor(
    message: string,
    readonly toolCallId?: string,
  ) {
    super(message);
    this.name = "StepExecutionError";
  }
}

/** The delegated child Run is persisted and waiting for its own resume control flow. */
export class StepExecutionDeferredError extends StepExecutionError {
  constructor(
    message: string,
    readonly childRunId: string,
    readonly childStopReason: "awaiting_permission" | "awaiting_plan_handoff" | "budget_exhausted",
  ) {
    super(message, `agent:${childRunId}`);
    this.name = "StepExecutionDeferredError";
  }
}

export type StepLifecycleEvent = {
  type: "started" | "completed" | "failed" | "deferred";
  step: PlanStep;
  result?: StepResult;
  error?: string;
  childRunId?: string;
  childStopReason?: StepExecutionDeferredError["childStopReason"];
};

export interface TaskRunnerOptions {
  executor: StepExecutor;
  /** 需要确认的步骤的确认回调；返回 false 则该步骤阻塞。 */
  confirm?: (step: PlanStep) => Promise<boolean>;
  /** 步骤确认所有者：真实 Agent 执行委托给 JIT 权限链，dry-run 不产生副作用。 */
  stepConfirmationMode?: "required" | "delegated_to_agent" | "dry_run";
  /** 本次运行允许的权限边界，默认任务模式的全集。 */
  allowedPermissions?: ToolPermission[];
  /** 项目级权限上限（来自 config.security.permissions）。 */
  projectAllowedPermissions?: ToolPermission[];
  onUpdate?: (plan: Plan) => void;
  trace?: TraceLogger;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  onStepLifecycle?: (event: StepLifecycleEvent) => void;
  onDagWave?: (event: { waveIndex: number; stepIds: string[] }) => void;
  onStepFailed?: (input: {
    step: PlanStep;
    plan: Plan;
  }) => Promise<PlanStep[] | undefined>;
  maxDynamicReplans?: number;
}

/**
 * 任务模式执行器：按计划逐步执行，维护步骤状态机，支持确认、中断、重试。
 * 真实副作用由注入的 StepExecutor 负责（工具系统落地后接入）。
 */
export class TaskRunner {
  private cancelled = false;
  private readonly confirmedStepIds = new Set<string>();
  private readonly allowed: ToolPermission[];
  private lastTaskStatus: string;
  private dynamicReplanCount = 0;

  constructor(
    private readonly plan: Plan,
    private readonly options: TaskRunnerOptions,
  ) {
    const resolved = resolveEffectivePermissions({
      projectAllowed: options.projectAllowedPermissions,
      modeAllowed: MODE_PERMISSIONS.task,
      modeSource: "task.mode",
      taskAllowed: options.allowedPermissions,
      taskSource: "task.allowedPermissions",
    });
    this.allowed =
      resolved.allowed.length > 0
        ? resolved.allowed
        : (options.allowedPermissions ?? MODE_PERMISSIONS.task);
    this.lastTaskStatus = aggregateTaskStatus(plan.steps);
  }

  getPlan(): Plan {
    return this.plan;
  }

  /** 动态插入步骤（须通过 validateTaskGraph）；用于执行期 replan。 */
  insertSteps(newSteps: PlanStep[], byId?: Map<string, PlanStep>): void {
    const merged = [...this.plan.steps, ...newSteps];
    validateTaskGraph(merged);
    this.plan.steps = merged;
    const map = byId ?? indexPlanSteps(this.plan.steps);
    for (const step of newSteps) {
      map.set(step.id, step);
    }
    this.emit();
  }

  /** 请求中断：当前步骤完成后停止，剩余步骤标记为 cancelled。 */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * 按 dependsOn 依赖图调度：无依赖或依赖已完成的步骤在同一波次并行执行。
   * `blocked` 时继续调度其他可执行分支；`failed` 后不再启动新波次；依赖失败/阻塞会传播。
   */
  async run(): Promise<Plan> {
    validateTaskGraph(this.plan.steps);
    const byId = indexPlanSteps(this.plan.steps);

    let haltOnFailure = false;
    let waveIndex = 0;
    while (!haltOnFailure) {
      if (this.cancelled) {
        for (const step of this.plan.steps) {
          if (step.status === "pending") this.setStepStatus(step, "cancelled");
        }
        break;
      }

      this.propagateDependencyBlocks(byId);
      const ready = readyPendingSteps(this.plan.steps, byId);
      if (ready.length === 0) break;

      waveIndex += 1;
      this.options.onDagWave?.({
        waveIndex,
        stepIds: ready.map((step) => step.id),
      });

      const outcomes = await Promise.all(ready.map((step) => this.runStep(step)));
      this.propagateDependencyBlocks(byId);
      const failedStep = ready.find((step) => step.status === "failed");
      if (failedStep && this.options.onStepFailed) {
        const maxReplans = this.options.maxDynamicReplans ?? 2;
        if (this.dynamicReplanCount < maxReplans) {
          const inserted = await this.options.onStepFailed({ step: failedStep, plan: this.plan });
          if (inserted && inserted.length > 0) {
            this.insertSteps(inserted, byId);
            this.dynamicReplanCount += 1;
            continue;
          }
        }
      }
      if (outcomes.some((o) => o === "failed")) {
        haltOnFailure = true;
      }
    }

    this.emit();
    return this.plan;
  }

  /** 人工确认：允许指定 blocked 步骤越过确认门继续执行。 */
  confirmStep(stepId: string): void {
    const step = this.plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`未找到步骤：${stepId}`);
    if (step.status !== "blocked" && step.status !== "pending") {
      throw new Error(`步骤 ${stepId} 当前状态为 ${step.status}，无法确认`);
    }
    this.confirmedStepIds.add(stepId);
    this.setStepStatus(step, "pending", { clearError: true });
    this.emit();
  }

  /** 跳过步骤：标记 skipped，依赖方视为已满足。 */
  skipStep(stepId: string): void {
    const step = this.plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`未找到步骤：${stepId}`);
    if (!["pending", "blocked", "failed"].includes(step.status)) {
      throw new Error(`步骤 ${stepId} 当前状态为 ${step.status}，无法跳过`);
    }
    this.setStepStatus(step, "skipped", { clearError: true, result: "(skipped)" });
    this.emit();
  }

  async resume(action: "retry" | "skip" | "confirm", stepId: string): Promise<Plan> {
    if (action === "retry") return this.retryFrom(stepId);
    if (action === "skip") {
      this.skipStep(stepId);
      return this.run();
    }
    this.confirmStep(stepId);
    return this.run();
  }

  /** 把某步骤重置为 pending 并从该步骤起继续执行。 */
  async retryFrom(stepId: string): Promise<Plan> {
    const index = this.plan.steps.findIndex((s) => s.id === stepId);
    if (index < 0) throw new Error(`未找到步骤：${stepId}`);
    const waiting = this.plan.steps.slice(index).find((step) => step.status === "waiting_agent");
    if (waiting) {
      throw new Error(`步骤 ${waiting.id} 正在等待子 Agent，只能由关联 Run 的终态事件续接`);
    }
    this.cancelled = false;
    for (let i = index; i < this.plan.steps.length; i += 1) {
      const step = this.plan.steps[i]!;
      if (step.status !== "completed") {
        this.setStepStatus(step, "pending", { clearError: true });
      }
    }
    return this.run();
  }

  private async runStep(step: PlanStep): Promise<PlanStep["status"]> {
    // 1) 权限边界：超出本次允许权限集的步骤直接阻塞。
    const disallowed = step.requiredPermissions.filter(
      (p) => !this.allowed.includes(p as ToolPermission),
    );
    if (disallowed.length > 0) {
      this.setStepStatus(step, "blocked", {
        error: `任务模式不允许的权限：${disallowed.join(", ")}`,
      });
      this.emit();
      return step.status;
    }

    // 2) 静态执行才拥有步骤确认门；Agent 执行由 permissionRequest 链负责具体工具授权。
    if (
      step.needsConfirmation &&
      (this.options.stepConfirmationMode ?? "required") === "required" &&
      !this.confirmedStepIds.has(step.id)
    ) {
      const approved = this.options.confirm ? await this.options.confirm(step) : false;
      if (!approved) {
        this.setStepStatus(step, "blocked", { error: "等待用户确认" });
        this.emit();
        return step.status;
      }
    }

    // 3) 执行。
    this.setStepStatus(step, "running", { clearError: true });
    this.emit();
    this.options.onStepLifecycle?.({ type: "started", step });
    try {
      const result = await this.options.executor.execute(step, {});
      step.result = result.output;
      this.setStepStatus(step, "completed");
      this.options.onStepLifecycle?.({ type: "completed", step, result });
      this.options.trace?.write({
        type: "task_step",
        step: step.id,
        status: "completed",
        toolCallId: result.toolCallId,
      });
    } catch (error) {
      if (error instanceof StepExecutionDeferredError) {
        this.setStepStatus(step, "waiting_agent", { error: error.message });
        this.options.onStepLifecycle?.({
          type: "deferred",
          step,
          error: error.message,
          childRunId: error.childRunId,
          childStopReason: error.childStopReason,
        });
        this.options.trace?.write({
          type: "task_step",
          step: step.id,
          status: "waiting_agent",
          toolCallId: error.toolCallId,
          childStopReason: error.childStopReason,
        });
        this.emit();
        return step.status;
      }
      const toolCallId = error instanceof StepExecutionError ? error.toolCallId : undefined;
      this.setStepStatus(step, "failed", { error: String(error) });
      this.options.onStepLifecycle?.({ type: "failed", step, error: String(error) });
      this.options.trace?.write({
        type: "task_step",
        step: step.id,
        status: "failed",
        toolCallId,
        error: String(error),
      });
    }
    this.emit();
    return step.status;
  }

  private propagateDependencyBlocks(byId: Map<string, PlanStep>): void {
    const before = new Map(
      this.plan.steps.map((step) => [step.id, { status: step.status, error: step.error }] as const),
    );
    propagateDependencyBlocks(this.plan.steps, byId);
    for (const step of this.plan.steps) {
      const snapshot = before.get(step.id);
      if (!snapshot || snapshot.status === step.status) continue;
      this.writeStepStatusChange(step, snapshot.status, step.status);
    }
  }

  private setStepStatus(
    step: PlanStep,
    status: PlanStep["status"],
    options: { error?: string; clearError?: boolean; result?: string } = {},
  ): void {
    const from = step.status;
    step.status = status;
    if ("error" in options) step.error = options.error;
    if (options.clearError) step.error = undefined;
    if ("result" in options) step.result = options.result;
    if (from !== status) this.writeStepStatusChange(step, from, status);
  }

  private writeStepStatusChange(
    step: PlanStep,
    from: PlanStep["status"],
    to: PlanStep["status"],
  ): void {
    this.options.trace?.write({
      type: "task_status_change",
      scope: "step",
      runId: this.options.runId,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      step: step.id,
      title: step.title,
      from,
      to,
      status: to,
      error: step.error,
    });
  }

  private writeTaskStatusChange(): void {
    const next = aggregateTaskStatus(this.plan.steps);
    if (next === this.lastTaskStatus) return;
    const from = this.lastTaskStatus;
    this.lastTaskStatus = next;
    this.options.trace?.write({
      type: "task_status_change",
      scope: "task",
      runId: this.options.runId,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      from,
      to: next,
      status: next,
      totalSteps: this.plan.steps.length,
      stepStatusCounts: this.countStepStatuses(),
    });
  }

  private countStepStatuses(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const step of this.plan.steps) {
      counts[step.status] = (counts[step.status] ?? 0) + 1;
    }
    return counts;
  }

  private emit(): void {
    this.writeTaskStatusChange();
    this.options.onUpdate?.(this.plan);
  }
}

/**
 * 默认 dry-run 执行器：不产生任何副作用，仅把步骤标记为已模拟执行。
 * 用于在工具系统就绪前演示任务模式的控制流。
 */
export class DryRunExecutor implements StepExecutor {
  constructor(private readonly options?: { requireToolBinding?: boolean }) {}

  async execute(step: PlanStep): Promise<StepResult> {
    if (!step.tool) {
      if (this.options?.requireToolBinding) {
        throw new StepExecutionError(`步骤 ${step.id} 缺少 tool 绑定，无法 dry-run`);
      }
      return { output: `(dry-run) 已模拟执行：${step.title}` };
    }
    return {
      output: `(dry-run) ${step.tool} ${JSON.stringify(step.toolInput ?? {})}`,
    };
  }
}
