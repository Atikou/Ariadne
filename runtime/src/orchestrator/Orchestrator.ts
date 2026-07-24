import { Planner } from "../agent/Planner.js";

import {
  type AgentRunResult,
  type LoopChatFn,
} from "../agent/AgentLoop.js";
import type { AgentCompletionContext } from "../agent/completion/TaskCompletionContract.js";
import type { AgentActivityEvent } from "../agent/timeline/types.js";
import { ActivityRunStore } from "../agent/timeline/ActivityRunStore.js";
import { defaultActivityEventBus } from "../agent/timeline/AgentEventBus.js";
import type { AgentStreamEvent } from "./AgentStream.js";

import type { PausedRunStore } from "../agent/PausedRunStore.js";
import {
  createAgentRuntimeServices,
  type AgentRuntimeServices,
} from "../agent/AgentRuntimeServices.js";
import { resolveAgentRunOutcome } from "../agent/AgentRunOutcome.js";

import type { NotificationQueue } from "../background/NotificationQueue.js";

import type { ContextManager } from "../context/ContextManager.js";

import type { TaskStore } from "../context/stores.js";

import type { CorrelationContext } from "../core/correlation.js";
import type { ApiResult } from "../core/apiResult.js";
import type { ToolPermission } from "../core/permissions.js";

import type { PlanService } from "../plan/PlanService.js";
import { PlanAgentStepBindingStore } from "../plan/PlanAgentStepBindingStore.js";

import type { PlanHandoffStore } from "../policy/PlanHandoffStore.js";
import type { PermissionRequestStore } from "../policy/PermissionRequestStore.js";
import type { SessionPermissionGrants } from "../policy/SessionPermissionGrants.js";
import type { WorkspaceGrantStore, WorkspaceScopePermission } from "../policy/WorkspaceScopeManager.js";

import type { ToolRegistry } from "../tools/ToolRegistry.js";

import type { TraceLogger } from "../trace/TraceLogger.js";

import type { RunAggregateRepository } from "../run/RunAggregateRepository.js";
import { RunStateStore } from "./RunStateStore.js";
import { AgentRunRegistry } from "./AgentRunRegistry.js";
import { AgentRunLifecycle } from "./AgentRunLifecycle.js";
import { AgentLoopFactory } from "./AgentLoopFactory.js";
import { AgentRequestService } from "./AgentRequestService.js";
import type { AgentRequestExecutionOptions } from "./AgentRequestService.js";
import {
  agentConversationRequestBodySchema,
  formatAgentRequestValidationError,
} from "./AgentRequestSchemas.js";
import { AgentEntryService } from "./AgentEntryService.js";
import { AgentResumeService } from "./AgentResumeService.js";
import { PlanExecutionService } from "./PlanExecutionService.js";
import { PlanExecutionFinalizer } from "./PlanExecutionFinalizer.js";
import { PlanAgentTaskWorkflow } from "./PlanAgentTaskWorkflow.js";
import { PlanAgentStepContinuationService } from "./PlanAgentStepContinuationService.js";
import {
  RunTerminalEventBus,
  type RunTerminalEvent,
} from "./RunTerminalEventBus.js";
import { SessionWorkspaceResolver } from "./SessionWorkspaceResolver.js";
import { TaskService } from "./TaskService.js";
import type { ProjectIndex } from "../context/ProjectIndex.js";
import type { RunState } from "./runStateTypes.js";
import { toPublicError } from "../util/publicError.js";
import type { HookManager } from "../hooks/HookManager.js";



export interface OrchestratorDeps {

  workspaceRoot: string;

  /** 按会话 workspaceKey 解析工具沙箱根路径；省略时回退 workspaceRoot。 */
  resolveWorkspaceRoot?: (sessionId?: string) => string;
  resolveWorkspaceConfigScopes?: (sessionId?: string) => Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;

  planner: Planner;

  registry: ToolRegistry;

  contextManager: ContextManager;

  /** 当前 AppContext 独占且不可拆分的任务/意图/策略实例链。 */
  agentRuntime?: AgentRuntimeServices;

  tasks: TaskStore;

  runs: RunAggregateRepository;

  runStateStore: RunStateStore;

  projectIndex?: ProjectIndex;

  notificationQueue: NotificationQueue;

  trace?: TraceLogger;

  makeChatFn: (forceClient?: string) => LoopChatFn;

  planService: PlanService;

  /** 单次 Agent Run 费用上限（USD），来自 security.budget.maxCostUsdPerRun。 */
  maxCostUsdPerRun?: number;

  /** 项目级权限上限，来自 config.security.permissions。 */
  projectAllowedPermissions: ToolPermission[];

  /** 子 Agent 最大派生深度（security.subagent.maxDispatchDepth），默认 1。 */
  maxSubAgentDispatchDepth?: number;

  /** 流式 Agent Run 取消注册表。 */
  agentRunRegistry: AgentRunRegistry;

  permissionRequestStore?: PermissionRequestStore;
  planHandoffStore?: PlanHandoffStore;
  sessionPermissionGrants?: SessionPermissionGrants;
  workspaceGrantStore?: WorkspaceGrantStore;
  pausedRunStore?: PausedRunStore;
  shellPolicy?: import("../policy/ShellPolicy.js").ShellPolicy;
  networkPolicy?: import("../policy/NetworkPolicy.js").NetworkPolicy;
  resolveInstructions?: (workspaceRoot: string) => string;
  hooks?: HookManager;
}



export type { ApiResult } from "../core/apiResult.js";



/**

 * 统一编排层：Agent / Task / Chat / Plan 均创建 Run 记录并写入关联 id。

 * 后续 DAG、调度自动执行、流式推送均在此扩展，避免 server handler 膨胀。

 */

export class Orchestrator {


  private readonly agentRunLifecycle: AgentRunLifecycle;

  private readonly agentLoopFactory: AgentLoopFactory;

  private readonly agentRuntime: AgentRuntimeServices;

  private readonly taskService: TaskService;

  private readonly sessionWorkspace: SessionWorkspaceResolver;

  private readonly agentRequestService: AgentRequestService;

  private readonly agentEntryService: AgentEntryService;

  private readonly agentResumeService: AgentResumeService;

  private readonly planExecutionService: PlanExecutionService;

  private readonly runTerminalEvents: RunTerminalEventBus;

  private readonly planAgentStepContinuation: PlanAgentStepContinuationService;

  constructor(private readonly deps: OrchestratorDeps) {
    this.agentRuntime = deps.agentRuntime ?? createAgentRuntimeServices({
      db: deps.contextManager.db.connection,
    });
    this.sessionWorkspace = new SessionWorkspaceResolver({
      workspaceRoot: deps.workspaceRoot,
      resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
      contextManager: deps.contextManager,
    });
    this.agentLoopFactory = new AgentLoopFactory({
      workspaceRoot: deps.workspaceRoot,
      resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
      resolveWorkspaceConfigScopes: deps.resolveWorkspaceConfigScopes,
      registry: deps.registry,
      agentRuntime: this.agentRuntime,
      contextManager: deps.contextManager,
      runStateStore: deps.runStateStore,
      runRepository: deps.runs,
      projectIndex: deps.projectIndex,
      notificationQueue: deps.notificationQueue,
      trace: deps.trace,
      projectAllowedPermissions: deps.projectAllowedPermissions,
      maxCostUsdPerRun: deps.maxCostUsdPerRun,
      maxSubAgentDispatchDepth: deps.maxSubAgentDispatchDepth,
      permissionRequestStore: deps.permissionRequestStore,
      planHandoffStore: deps.planHandoffStore,
      sessionPermissionGrants: deps.sessionPermissionGrants,
      workspaceGrantStore: deps.workspaceGrantStore,
      pausedRunStore: deps.pausedRunStore,
      shellPolicy: deps.shellPolicy,
      networkPolicy: deps.networkPolicy,
      resolveInstructions: deps.resolveInstructions,
    });
    this.taskService = new TaskService({
      sessionWorkspace: this.sessionWorkspace,
      contextManager: deps.contextManager,
      tasks: deps.tasks,
    });
    this.agentRunLifecycle = new AgentRunLifecycle({
      taskService: this.taskService,
      runs: deps.runs,
      runStateStore: deps.runStateStore,
      trace: deps.trace,
    });
    this.agentRequestService = new AgentRequestService({
      agentRuntime: this.agentRuntime,
      sessionWorkspace: this.sessionWorkspace,
      taskService: this.taskService,
      runs: deps.runs,
      agentRunRegistry: deps.agentRunRegistry,
      agentLoopFactory: this.agentLoopFactory,
      agentRunLifecycle: this.agentRunLifecycle,
      makeChatFn: deps.makeChatFn,
      planHandoffStore: deps.planHandoffStore,
      permissionRequestStore: deps.permissionRequestStore,
      pausedRunStore: deps.pausedRunStore,
      hooks: deps.hooks,
    });
    this.runTerminalEvents = new RunTerminalEventBus();
    const planAgentStepBindings = new PlanAgentStepBindingStore(
      deps.contextManager.db.connection,
    );
    const planExecutionFinalizer = new PlanExecutionFinalizer({
      planner: deps.planner,
      planService: deps.planService,
      taskService: this.taskService,
      sessionWorkspace: this.sessionWorkspace,
      registry: deps.registry,
      tasks: deps.tasks,
      runs: deps.runs,
      trace: deps.trace,
    });
    const planAgentTaskWorkflow = new PlanAgentTaskWorkflow({
      agentRequestService: this.agentRequestService,
      taskService: this.taskService,
      planService: deps.planService,
      bindings: planAgentStepBindings,
      sessionWorkspace: this.sessionWorkspace,
      registry: deps.registry,
      projectAllowedPermissions: deps.projectAllowedPermissions,
      trace: deps.trace,
    });
    this.agentResumeService = new AgentResumeService({
      agentRuntime: this.agentRuntime,
      sessionWorkspace: this.sessionWorkspace,
      taskService: this.taskService,
      tasks: deps.tasks,
      runs: deps.runs,
      runStateStore: deps.runStateStore,
      agentRunRegistry: deps.agentRunRegistry,
      agentLoopFactory: this.agentLoopFactory,
      agentRunLifecycle: this.agentRunLifecycle,
      makeChatFn: deps.makeChatFn,
      permissionRequestStore: deps.permissionRequestStore,
      planHandoffStore: deps.planHandoffStore,
      pausedRunStore: deps.pausedRunStore,
      runTerminalEvents: this.runTerminalEvents,
    });
    this.planExecutionService = new PlanExecutionService({
      planner: deps.planner,
      planService: deps.planService,
      agentTaskWorkflow: planAgentTaskWorkflow,
      finalizer: planExecutionFinalizer,
      taskService: this.taskService,
      sessionWorkspace: this.sessionWorkspace,
      registry: deps.registry,
      projectAllowedPermissions: deps.projectAllowedPermissions,
      tasks: deps.tasks,
      runs: deps.runs,
      trace: deps.trace,
    });
    this.planAgentStepContinuation = new PlanAgentStepContinuationService({
      planner: deps.planner,
      registry: deps.registry,
      planService: deps.planService,
      agentTaskWorkflow: planAgentTaskWorkflow,
      finalizer: planExecutionFinalizer,
      bindings: planAgentStepBindings,
      taskService: this.taskService,
      tasks: deps.tasks,
      runs: deps.runs,
      trace: deps.trace,
    });
    this.runTerminalEvents.subscribe((event) =>
      this.planAgentStepContinuation.handleRunTerminal(event));
    this.agentEntryService = new AgentEntryService({
      planner: deps.planner,
      planService: deps.planService,
      planExecutionService: this.planExecutionService,
      agentRequestService: this.agentRequestService,
    });
  }

  async publishRunTerminal(
    runId: string,
    source: RunTerminalEvent["source"],
  ): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (
      !run
      || (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled")
    ) {
      return;
    }
    await this.runTerminalEvents.publish({
      runId,
      status: run.status,
      source,
      at: new Date().toISOString(),
    });
  }

  recoverPlanAgentContinuations(): Promise<number> {
    return this.planAgentStepContinuation.recover();
  }



  ensureSession(sessionId: string | undefined, title: string, workspaceKey?: string, projectId?: string): string {
    return this.sessionWorkspace.ensureSession(sessionId, title, workspaceKey, projectId);
  }

  private workspaceForRun(runId: string): string {
    const run = this.deps.runs.get(runId);
    return this.sessionWorkspace.workspaceForSession(run?.sessionId);
  }



  listRuns(limit?: number) {

    return this.deps.runs.list({ limit: limit ?? 50 });

  }



  getRun(id: string) {

    return this.deps.runs.get(id);

  }



  async runAgent(
    body: unknown,
    makeChat?: LoopChatFn,
    completionContext?: AgentCompletionContext,
  ): Promise<ApiResult> {
    return this.agentEntryService.run(body, makeChat, completionContext);
  }

  /** Starts a temporary Agent from a server-created handoff grant, bypassing public entry routing. */
  async runAgentFromHandoff(
    body: unknown,
    execution: AgentRequestExecutionOptions,
    makeChat?: LoopChatFn,
  ): Promise<ApiResult> {
    return this.agentRequestService.run(body, makeChat, undefined, execution);
  }

  /** 从 RunStateStore 恢复预算耗尽的可续跑 Agent Run（PlanWorkflow pendingSteps）。 */
  async resumeAgent(body: unknown, makeChat?: LoopChatFn): Promise<ApiResult> {
    return this.agentResumeService.resumeBudget(body, makeChat);
  }

  getRunState(runId: string): RunState | null {
    return this.deps.runStateStore.get(runId);
  }

  /**
   * 弹窗批准后由客户端调用：用暂停时的对话快照忠实续跑同一段对话。
   *
   * 第一性原则：不重新喊话、不用正则猜权限。
   * - 工具级 JIT 暂停：恢复后直接执行那个被批准的工具，再继续模型循环（沿用原模式/策略 + 作用域授权）。
   * - 计划→执行交接：恢复后切到 implement，按对话历史中的计划继续执行；具体工具仍由
   *   服务端 Run grant / UI 批准的 permissionRequest grant 与 PermissionGuard 共同裁决。
   */
  async resumeAfterPermission(body: unknown, makeChat?: LoopChatFn): Promise<ApiResult> {
    return this.agentResumeService.resumePermission(body, makeChat);
  }

  /**
   * 计划交接批准后续跑：用暂停快照在 implement 模式下忠实执行计划。
   * 与 resumeAfterPermission（工具级 JIT）分离。
   */
  async resumeAfterPlanHandoff(body: unknown, makeChat?: LoopChatFn): Promise<ApiResult> {
    return this.agentResumeService.resumePlanHandoff(body, makeChat);
  }

  listRunningAgentRuns() {
    return this.deps.agentRunRegistry.listRunning();
  }

  cancelRun(runId: string): ApiResult {
    const id = runId.trim();
    if (!id) return { status: 400, body: { error: "runId 不能为空" } };
    const result = this.deps.agentRunRegistry.cancel(id);
    if (!result) return { status: 404, body: { error: "运行不存在或已结束", runId: id } };
    return { status: 200, body: result };
  }

  getActivityRun(runId: string): ApiResult {
    const store = new ActivityRunStore(this.workspaceForRun(runId));
    const run = store.loadRun(runId);
    if (!run) return { status: 404, body: { error: "Activity Run 不存在", runId } };
    return { status: 200, body: { run } };
  }

  subscribeActivityEvents(
    runId: string,
    emit: (event: AgentActivityEvent) => void,
    opts?: { replay?: boolean },
  ): () => void {
    const store = new ActivityRunStore(this.workspaceForRun(runId));
    if (opts?.replay !== false) {
      for (const event of store.listEvents(runId)) {
        emit(event);
      }
    }
    return defaultActivityEventBus.subscribe(runId, emit);
  }

  /** SSE：推送 run_start / model_turn / step / token / done | error。 */
  async runAgentStream(
    body: unknown,
    emit: (event: AgentStreamEvent) => void,
    makeChat?: LoopChatFn,
  ): Promise<void> {
    const parsed = agentConversationRequestBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      emit({
        type: "error",
        error: formatAgentRequestValidationError(parsed.error),
        runId: "",
        taskId: "",
      });
      return;
    }
    const payload = parsed.data;
    let activeIteration = 0;
    // run_start 必须是流的首帧；AgentRequestService.prepare 会在准备阶段就启动 timeline 并产生
    // activity_event，因此先缓冲这些事件，待 run_start 发出后再按序补发，避免乱序。
    let runStarted = false;
    const activityBuffer: AgentActivityEvent[] = [];
    const prepared = await this.agentRequestService.prepare(payload, makeChat, {
      onStep: (step) => emit({ type: "step", step }),
      onModelTurn: (turn) => {
        activeIteration = turn.iteration;
        emit({ type: "model_turn", turn });
      },
      onToken: payload.streamTokens
        ? (delta) => emit({ type: "token", delta, iteration: activeIteration || undefined })
        : undefined,
      registerForCancel: true,
      enableTimeline: true,
      onActivityEvent: (event) => {
        if (!runStarted) {
          activityBuffer.push(event);
          return;
        }
        emit({ type: "activity_event", event });
      },
    });
    if ("error" in prepared) {
      const errBody = prepared.error.body as Record<string, unknown>;
      emit({
        type: "error",
        error: String(errBody.error ?? "准备运行失败"),
        runId: String(errBody.runId ?? ""),
        taskId: "",
        ...errBody,
      });
      return;
    }
    const { ctx } = prepared;

    emit({ type: "run_start", runId: ctx.run.id, taskId: ctx.task.id, sessionId: ctx.sessionId });
    runStarted = true;
    for (const event of activityBuffer) emit({ type: "activity_event", event });
    activityBuffer.length = 0;

    let result: AgentRunResult;
    try {
      this.agentRunLifecycle.traceStart(ctx);
      result = await ctx.loop.run(ctx.message, ctx.system);
    } catch (error) {
      const body = this.agentRunLifecycle.finalizeFailure(ctx, error);
      try {
        await this.agentRequestService.notifyPost(ctx.run.id);
      } catch (hookError) {
        emit({
          type: "error",
          error: String(hookError),
          code: "HOOK_REJECTED",
          runId: ctx.run.id,
          taskId: ctx.task.id,
        });
        this.deps.agentRunRegistry.unregister(ctx.run.id);
        return;
      }
      emit({
        type: "error",
        error: String((body as { error?: string }).error),
        code: String((body as { code?: string }).code ?? "INTERNAL_ERROR"),
        runId: ctx.run.id,
        taskId: ctx.task.id,
      });
      this.deps.agentRunRegistry.unregister(ctx.run.id);
      return;
    }
    const finalized = this.agentRunLifecycle.finalizeSuccess(ctx, result);
    try {
      await this.agentRequestService.notifyPost(ctx.run.id);
      emit({ type: "done", ...finalized });
    } catch (hookError) {
      emit({
        type: "error",
        error: String(hookError),
        code: "HOOK_REJECTED",
        runId: ctx.run.id,
        taskId: ctx.task.id,
      });
    } finally {
      this.deps.agentRunRegistry.unregister(ctx.run.id);
    }
  }



  /** 调度器无人值守触发：创建 scheduled Run 并执行 Agent 循环（不持久化会话）。 */

  async executeUnattendedTrigger(input: {

    triggerId: string;

    goal: string;

    sessionId?: string;

  }): Promise<{ runId: string }> {

    const createdRun = this.deps.runs.execute({

      type: "run.create",

      kind: "scheduled",

      goal: input.goal,

      triggerId: input.triggerId,

      sessionId: input.sessionId,

    });
    const hook = await this.deps.hooks?.dispatch({
      event: "run.pre",
      eventId: createdRun.id,
      payload: {
        runId: createdRun.id,
        kind: "scheduled",
        sessionId: input.sessionId,
        triggerId: input.triggerId,
      },
      authority: {
        permissions: this.deps.projectAllowedPermissions,
        timeoutMs: 30 * 60_000,
      },
    });
    if (hook && !hook.allowed) {
      this.deps.runs.execute({
        type: "run.fail",
        runId: createdRun.id,
        expectedAggregateVersion: createdRun.aggregateVersion,
        error: hook.reason ?? "run_hook_rejected",
      });
      await this.agentRequestService.notifyPost(createdRun.id);
      return { runId: createdRun.id };
    }

    const run = this.deps.runs.execute({
      type: "run.start",
      runId: createdRun.id,
      expectedAggregateVersion: createdRun.aggregateVersion,
    });



    // 无人值守运行也登记为可取消，并把 signal 注入循环，使其可被显式取消/关闭。
    const abortController = this.deps.agentRunRegistry.register(run.id, "agent");
    const hookTimeout = setTimeout(
      () => abortController.abort(new Error("run_hook_timeout")),
      hook?.authority.timeoutMs ?? 30 * 60_000,
    );
    hookTimeout.unref?.();

    const loop = this.agentLoopFactory.create({
      chat: this.deps.makeChatFn(),
      autoConfirm: false,
      persistContext: false,
      runId: run.id,
      sessionId: input.sessionId,
      projectId: this.sessionWorkspace.projectIdForSession(input.sessionId),
      signal: abortController.signal,
      allowedPermissions: hook?.authority.permissions ?? this.deps.projectAllowedPermissions,
    });



    try {

      this.deps.trace?.write({

        type: "run_start",

        runId: run.id,

        kind: "scheduled",

        triggerId: input.triggerId,

      });

      const result = await loop.run(input.goal);

      const outcome = resolveAgentRunOutcome(result.executionMeta.stopReason);

      const current = this.deps.runs.get(run.id);
      if (!current) throw new Error(`Run ${run.id} does not exist.`);
      const resultPayload = {
          answer: result.answer,
          iterations: result.iterations,
          executionMeta: result.executionMeta,
      };
      if (outcome.runStatus === "completed") {
        this.deps.runs.execute({
          type: "run.complete",
          runId: current.id,
          expectedAggregateVersion: current.aggregateVersion,
          result: resultPayload,
        });
      } else if (outcome.runStatus === "cancelled") {
        this.deps.runs.execute({
          type: "run.cancel",
          runId: current.id,
          expectedAggregateVersion: current.aggregateVersion,
          reason: result.answer,
        });
      } else if (outcome.runStatus === "paused") {
        this.deps.runs.execute({
          type: "run.pause",
          runId: current.id,
          expectedAggregateVersion: current.aggregateVersion,
          reason: {
            code: result.executionMeta.stopReason,
            message: "The scheduled run reached its execution budget.",
            details: resultPayload,
          },
        });
      } else if (outcome.runStatus === "waiting_confirmation") {
        this.deps.runs.execute({
          type: "run.request_confirmation",
          runId: current.id,
          expectedAggregateVersion: current.aggregateVersion,
          reason: {
            code: "permission_required",
            message: "The scheduled run requires an explicit permission decision.",
            details: resultPayload,
          },
        });
      } else if (outcome.runStatus === "waiting_plan_handoff") {
        this.deps.runs.execute({
          type: "run.request_plan_handoff",
          runId: current.id,
          expectedAggregateVersion: current.aggregateVersion,
          reason: {
            code: "plan_handoff_required",
            message: "The scheduled run requires an explicit plan handoff decision.",
            details: resultPayload,
          },
        });
      } else if (outcome.runStatus === "blocked") {
        this.deps.runs.execute({
          type: "run.block",
          runId: current.id,
          expectedAggregateVersion: current.aggregateVersion,
          reason: {
            code: result.executionMeta.stopReason,
            message: result.answer || "The scheduled run was blocked.",
          },
        });
      } else {
        this.deps.runs.execute({
          type: "run.fail",
          runId: current.id,
          expectedAggregateVersion: current.aggregateVersion,
          error: result.answer || result.executionMeta.stopReason,
        });
      }

      this.deps.trace?.write({

        type: "run_end",

        runId: run.id,

        kind: "scheduled",

        status: outcome.runStatus,

      });

    } catch (error) {
      const publicError = toPublicError(error, "调度任务执行失败");

      const current = this.deps.runs.get(run.id);
      if (current && current.status === "running") {
        this.deps.runs.execute({
          type: "run.fail",
          runId: current.id,
          expectedAggregateVersion: current.aggregateVersion,
          error: publicError.message,
        });
      }

      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "scheduled", status: "failed" });

    } finally {

      clearTimeout(hookTimeout);
      await this.agentRequestService.notifyPost(run.id);
      this.deps.agentRunRegistry.unregister(run.id);

    }

    return { runId: run.id };

  }



  createScheduledRun(input: {

    goal: string;

    triggerId: string;

    sessionId?: string;

  }): { runId: string } {

    const run = this.deps.runs.execute({

      type: "run.create",
      kind: "scheduled",

      goal: input.goal,

      triggerId: input.triggerId,

      sessionId: input.sessionId,

    });

    return { runId: run.id };

  }



  private correlationFor(runId: string, extra: Omit<CorrelationContext, "runId">): CorrelationContext {

    return { runId, ...extra };

  }

  getTask(taskId: string): ApiResult {
    return this.taskService.getTask(taskId);
  }

}
