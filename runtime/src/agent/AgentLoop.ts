import type { AgentNotification } from "../background/types.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { ChatMessage } from "../model/types.js";
import type { AgentPromptStrategySummary, AgentRouterDecisionSummary, AgentRoutingMeta } from "../model-router/agent-routing-summary.js";
import type { LoopChatFn, LoopChatResponse } from "../model-router/agent-chat-types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import type { RunAggregateRepository } from "../run/RunAggregateRepository.js";
import { parseAction, type ToolAction } from "./AgentActionParser.js";
import { buildAgentSystemPrompt } from "./AgentSystemPromptBuilder.js";
import { buildWorkflowCapabilityHint } from "./AgentWorkflowCapabilityHint.js";
import type { PausedRunRuntimeState } from "./PausedRunStore.js";
import type { CompletionGuardResult } from "./completion/CompletionFinalGuard.js";
import {
  normalizeCompletionCriteria,
  type CompletionCriterionInput,
} from "./completion/TaskCompletionContract.js";
import { EditProposalWorkflow } from "./EditProposalWorkflow.js";
import { WorkflowExecutor } from "./WorkflowExecutor.js";
import { ToolRecoveryWorkflow } from "./ToolRecoveryWorkflow.js";
import { buildLocationMeta } from "./workflowExecutionMeta.js";
import type { AgentModelTurnEvent } from "./AgentModelTurn.js";
import type { AgentTimelineService } from "./timeline/AgentTimelineService.js";
import { type ToolPermission } from "../core/permissions.js";
import {
  resolveEffectivePermissions,
} from "../policy/PermissionPolicy.js";
import type { WorkspaceGrantStore, WorkspaceScopePermission } from "../policy/WorkspaceScopeManager.js";
import {
  defaultPermissionRequestStore,
  type PermissionRequestStore,
} from "../policy/PermissionRequestStore.js";
import {
  defaultSessionPermissionGrants,
  type SessionPermissionGrants,
} from "../policy/SessionPermissionGrants.js";
import type {
  PermissionRequestPayload,
  ScopedApprovedPermissions,
} from "../policy/permissionRequestTypes.js";
import {
  defaultPlanHandoffStore,
  type PlanHandoffStore,
} from "../policy/PlanHandoffStore.js";
import type { PlanHandoffPayload } from "../policy/planHandoffTypes.js";
import type { AgentPlanStore } from "../plan/AgentPlanStore.js";
import {
  renderAgentPlanMarkdown,
  type AgentPlanContract,
  type AgentPlanExecutionReport,
} from "../plan/AgentPlanContract.js";
import type { AgentToolStep } from "./toolStep.js";
import { isSuccessfulToolStep } from "./toolStepOutcome.js";
import {
  defaultPausedRunStore,
  type AgentHandoffAuthorizationContext,
  type PausedRunSnapshot,
  type PausedRunStore,
} from "./PausedRunStore.js";
import { BudgetManager } from "./BudgetManager.js";
import { defaultFinalizer } from "./Finalizer.js";
import { type RunPolicyManager } from "./RunPolicy.js";
import {
  createAgentRuntimeServices,
  type AgentRuntimeServices,
} from "./AgentRuntimeServices.js";
import type { SessionTaskManager } from "./task/SessionTaskManager.js";
import {
  type AgentExecutionMeta,
  type AgentRunMode,
  type AgentStopReason,
  type AgentWorkflowInternalPlan,
  type AgentWorkflowSwitch,
  type RunBudget,
  type RunBudgetKey,
  type RunPolicy,
} from "./RunPolicyTypes.js";
import type { RunStateStore } from "../orchestrator/RunStateStore.js";
import type { ProjectIndex } from "../context/ProjectIndex.js";
import type { RunState } from "../orchestrator/runStateTypes.js";
import {
  buildRunUsageSummaryTracePayload,
  type AgentModelTurnMetric,
} from "./AgentRunUsageSummary.js";
import { finalizeAgentRun, type AgentRunFinalizeContext } from "./AgentRunFinalizer.js";
import { buildAgentExecutionMeta } from "./AgentExecutionMetaBuilder.js";
import {
  AgentPauseCoordinator,
  type AgentPauseRuntimeSnapshot,
} from "./AgentPauseCoordinator.js";
import {
  AgentToolExecutionCoordinator,
} from "./AgentToolExecutionCoordinator.js";
import { AgentToolRuntimeState } from "./AgentToolRuntimeState.js";
import {
  resumeApprovedToolAction,
  type AgentApprovedToolResumeContext,
} from "./AgentApprovedToolResume.js";
import { bootstrapAgentRunSession } from "./AgentRunBootstrap.js";
import { runAgentReactLoop, type AgentReactLoopContext } from "./AgentReactLoopRunner.js";

export interface AgentRunResult {
  answer: string;
  steps: AgentToolStep[];
  iterations: number;
  /** 本轮运行预算耗尽时为 true。 */
  reachedLimit: boolean;
  /** 等待用户权限确认时为 true。 */
  awaitingPermission?: boolean;
  /** 等待计划交接批准时为 true。 */
  awaitingPlanHandoff?: boolean;
  /** 固定 JSON 权限申请（工具级 JIT）。 */
  permissionRequest?: PermissionRequestPayload;
  /** 计划→执行交接（与 permissionRequest 分离）。 */
  planHandoff?: PlanHandoffPayload;
  /** 计划模式产生的结构化、版本化契约；澄清态与待确认态均由此表达。 */
  agentPlan?: AgentPlanContract;
  /** 已批准计划的逐步骤执行证据。 */
  agentPlanExecutionReport?: AgentPlanExecutionReport;
  /** 本次运行实际生效的模式、预算、调用计数与停止原因。 */
  executionMeta: AgentExecutionMeta;
  /** 首轮模型调用的 Smart 路由摘要（默认 Smart 路径；显式 clientName 时省略）。 */
  routerDecision?: AgentRouterDecisionSummary;
  /** 首轮模型调用的提示策略（temperature/风格/hints）。 */
  promptStrategy?: AgentPromptStrategySummary;
  /** 本轮在安全点消费的系统通知（如后台任务完成）。 */
  notifications?: AgentNotification[];
  /** M6：持久化会话 id（启用 ContextManager 时返回）。 */
  sessionId?: string;
  /** M6：本轮是否触发了历史压缩。 */
  compressed?: boolean;
}

export interface AgentLoopOptions {
  chat: LoopChatFn;
  registry: ToolRegistry;
  workspaceRoot: string;
  resolveInstructions?: (workspaceRoot: string) => string;
  /** Per-run process broker; child agents inject a narrowed write-scope broker. */
  processSandbox?: ProcessSandbox;
  /** 当前应用上下文不可拆分的任务/意图/策略实例链。 */
  agentRuntime?: AgentRuntimeServices;
  /** 暴露给模型/可执行的权限集，默认任务模式全集。 */
  allowedPermissions?: ToolPermission[];
  /** Trusted server grant for this Run; never populated from an Agent HTTP request body. */
  runGrantedPermissions?: ToolPermission[];
  /** 项目级权限上限（来自 config.security.permissions）。 */
  projectAllowedPermissions?: ToolPermission[];
  /** 子 Agent toolPolicy 推导的权限上限（仅子 Agent 路径传入）。 */
  roleAllowedPermissions?: ToolPermission[];
  /** 子 Agent 可见工具名硬白名单；未传时按主 Agent 默认工具集暴露。 */
  allowedToolNames?: readonly string[];
  /** 当前子 Agent 派生深度（主 Agent 为 0）。 */
  subAgentDispatchDepth?: number;
  /** dispatch_subagent 最大派生深度；默认 1，不支持无限递归。 */
  maxSubAgentDispatchDepth?: number;
  /** 运行模式；未传时可由上层 RunPolicy 推断，默认 chat。 */
  mode?: AgentRunMode;
  /** 用户侧权限策略；本阶段仅用于元信息与后续 PermissionGuard 铺垫。 */
  permissionPolicy?: string;
  /** 上层解析好的运行策略。 */
  policy?: RunPolicy;
  budget?: Partial<RunBudget>;
  /** @deprecated 兼容旧策略推断；不得签发授权或跳过 permissionRequest。 */
  autoConfirm?: boolean;
  sensitive?: boolean;
  taskType?: ModelTaskType;
  trace?: TraceLogger;
  /** 每发生一步工具调用时回调（便于流式回显）。 */
  onStep?: (step: AgentToolStep) => void;
  /** 每轮模型调用开始/结束时的决策摘要（供 SSE 思考过程展示）。 */
  onModelTurn?: (turn: AgentModelTurnEvent) => void;
  /** 模型 token 流式增量（需 ModelClient 支持且 request 传入 onToken）。 */
  onToken?: (delta: string) => void;
  /** 单次 Run 费用上限（USD）。 */
  maxCostUsdPerRun?: number;
  /** 通知队列：仅在安全点 drain 后注入上下文。 */
  notificationQueue?: NotificationQueue;
  /** M6：上下文压缩与持久化（可选）。 */
  contextManager?: ContextManager;
  /** M6：已有会话 id；未提供时自动创建。 */
  sessionId?: string;
  projectId?: string;
  /** 编排 Run id，写入 trace 与工具审计。 */
  runId?: string;
  taskId?: string;
  requestId?: string;
  /** 预算耗尽时持久化续跑状态。 */
  runStateStore?: RunStateStore;
  runRepository?: RunAggregateRepository;
  /** 项目索引：写入 RunState.location 的 index 统计。 */
  projectIndex?: ProjectIndex;
  /** 从 RunStateStore 恢复的续跑上下文。 */
  resumeState?: RunState;
  /** 取消信号；子 Agent 显式 cancel 时在各轮次安全点中断。 */
  signal?: AbortSignal;
  /** Activity Timeline：公开执行摘要（非模型 CoT）。 */
  timeline?: AgentTimelineService;
  /** 遇权限确认门时暂停 Run 并返回 permissionRequest（默认始终开启）。 */
  pauseOnPermissionRequest?: boolean;
  /** 仅由服务端提案批准路径注入，随权限暂停快照传递。 */
  handoffAuthorization?: AgentHandoffAuthorizationContext;
  /** 权限申请存储（HTTP 入口注入单例）。 */
  permissionRequestStore?: PermissionRequestStore;
  /** 计划交接存储（HTTP 入口注入单例）。 */
  planHandoffStore?: PlanHandoffStore;
  /** 版本化计划契约存储；计划交接与执行续跑共享同一份冻结契约。 */
  agentPlanStore?: AgentPlanStore;
  /** 会话级已批准作用域权限。 */
  sessionPermissionGrants?: SessionPermissionGrants;
  /** 本轮一次性已批准作用域权限。 */
  scopedGrants?: ScopedApprovedPermissions;
  /** 持久化多工作区授权。 */
  workspaceGrantStore?: WorkspaceGrantStore;
  /** 配置型只读/预授权工作区。 */
  workspaceConfigScopes?: Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;
  /** 暂停 Run 快照存储（HTTP 入口注入单例），用于权限暂停后的忠实续跑。 */
  pausedRunStore?: PausedRunStore;
  /** 恢复执行：从该快照忠实续跑同一段对话（执行被批准工具或按计划进入执行阶段）。 */
  pausedRun?: PausedRunSnapshot;
  /** 计划报告 analyze API：产出 final 后不冻结 planHandoff，直接返回完整 answer。 */
  skipPlanHandoff?: boolean;
  shellPolicy?: import("../policy/ShellPolicy.js").ShellPolicy;
  networkPolicy?: import("../policy/NetworkPolicy.js").NetworkPolicy;
  /** 仅由可信上层任务/计划注入；HTTP 用户输入不能直接覆盖。 */
  completionCriteria?: readonly CompletionCriterionInput[];
}

/**
 * 基础 Agent 对话循环（M1）。
 *
 * 采用可移植的 ReAct 风格 JSON 协议：模型每轮只输出一个 JSON——可请求单个工具、
 * 请求一组独立工具或给出最终答案。批量工具在同一运行上下文中按原始参数受控执行；
 * 工具仍经 ToolRegistry 执行（含校验/权限/风险/超时），结果回灌给模型继续推理。
 * 不依赖各后端的原生 function-calling，本地与远程模型均可用。
 */
export class AgentLoop {
  private readonly allowed: ToolPermission[];
  private readonly runGranted: ToolPermission[];
  private readonly pauseCoordinator: AgentPauseCoordinator;
  private readonly toolExecution: AgentToolExecutionCoordinator;
  private readonly toolState: AgentToolRuntimeState;
  private readonly pauseOnPermissionRequest: boolean;
  private readonly budgetManager: BudgetManager;
  private readonly policy: RunPolicy;
  private readonly runPolicyManager: RunPolicyManager;
  private readonly sessionTaskManager: SessionTaskManager;
  private readonly finalizer = defaultFinalizer;
  private runRoutingMeta?: AgentRoutingMeta;
  private workflowInternalPlans: AgentWorkflowInternalPlan[] = [];
  private workflowSwitch?: AgentWorkflowSwitch;

  constructor(private readonly options: AgentLoopOptions) {
    const agentRuntime = options.agentRuntime ?? createAgentRuntimeServices({
      db: options.contextManager?.db?.connection,
    });
    this.sessionTaskManager = agentRuntime.sessionTaskManager;
    this.runPolicyManager = agentRuntime.runPolicyManager;
    this.policy =
      options.policy ??
      this.runPolicyManager.resolve({
        requestedMode: options.mode,
        forceMode: options.mode != null,
        requestedPermissionPolicy: options.permissionPolicy ?? (options.autoConfirm ? "autoEdit" : undefined),
        autoConfirm: options.autoConfirm,
        budget: options.budget,
        taskType: options.taskType,
      });
    const resolved = resolveEffectivePermissions({
      projectAllowed: options.projectAllowedPermissions,
      modeAllowed: this.policy.allowedPermissions,
      modeSource: `run.mode=${this.policy.mode}`,
      roleAllowed: options.roleAllowedPermissions,
      roleSource: options.roleAllowedPermissions ? "subagent.toolPolicy" : undefined,
      userGranted: options.allowedPermissions,
      userSource: "agent.allowedPermissions",
      strictUserGrant: options.allowedPermissions != null,
    });
    this.allowed = resolved.allowed;
    this.runGranted = (options.runGrantedPermissions ?? []).filter((permission) =>
      this.allowed.includes(permission));
    this.budgetManager = this.runPolicyManager.createBudgetManager(this.policy);
    this.toolState = new AgentToolRuntimeState(this.policy, this.options.completionCriteria);
    this.pauseOnPermissionRequest = options.pauseOnPermissionRequest ?? true;
    this.pauseCoordinator = new AgentPauseCoordinator({
      permissionRequestStore: options.permissionRequestStore ?? defaultPermissionRequestStore,
      planHandoffStore: options.planHandoffStore ?? defaultPlanHandoffStore,
      agentPlanStore: options.agentPlanStore,
      pausedRunStore: options.pausedRunStore ?? defaultPausedRunStore,
      runRepository: options.runRepository,
      runId: options.runId,
      sessionId: options.sessionId,
      projectId: options.projectId,
      mode: this.policy.mode,
      permissionPolicy: this.policy.permissionPolicy,
      intent: this.policy.intent,
      executionStage: this.policy.executionStage,
      planVariant: this.policy.planVariant,
      skipPlanHandoff: options.skipPlanHandoff,
      permissionCeiling: this.allowed,
      runGrantedPermissions: this.runGranted,
      handoffAuthorization: options.handoffAuthorization,
    });
    this.toolExecution = new AgentToolExecutionCoordinator({
      registry: options.registry,
      workspaceRoot: options.workspaceRoot,
      processSandbox: options.processSandbox,
      allowedPermissions: this.allowed,
      runGrantedPermissions: this.runGranted,
      projectAllowedPermissions: options.projectAllowedPermissions,
      allowedToolNames: options.allowedToolNames,
      subAgentDispatchDepth: options.subAgentDispatchDepth,
      maxSubAgentDispatchDepth: options.maxSubAgentDispatchDepth,
      maxCostUsdPerRun: options.maxCostUsdPerRun,
      policy: this.policy,
      budgetManager: this.budgetManager,
      state: this.toolState,
      finalizer: this.finalizer,
      pauseOnPermissionRequest: this.pauseOnPermissionRequest,
      sessionPermissionGrants: options.sessionPermissionGrants ?? defaultSessionPermissionGrants,
      scopedGrants: options.scopedGrants,
      workspaceGrantStore: options.workspaceGrantStore,
      workspaceConfigScopes: options.workspaceConfigScopes,
      shellPolicy: options.shellPolicy,
      networkPolicy: options.networkPolicy,
      contextManager: options.contextManager,
      timeline: options.timeline,
      trace: options.trace,
      signal: options.signal,
      sensitive: options.sensitive,
      runId: options.runId,
      sessionId: options.sessionId,
      projectId: options.projectId,
      taskId: options.taskId,
      requestId: options.requestId,
      runRepository: options.runRepository,
      onStep: options.onStep,
    });
  }

  private get budget(): RunBudget {
    return this.budgetManager.budget;
  }

  private restoreApprovedHandoffArtifacts(pausedRun: PausedRunSnapshot): void {
    if (!pausedRun.resumeMode || this.toolState.workflowProposals.length > 0) return;
    const result = new EditProposalWorkflow().run({
      goal: pausedRun.goal,
      intent: this.getEffectiveIntent(),
      permissionPolicy: this.policy.permissionPolicy,
      allowedPermissions: this.allowed,
      runGrantedPermissions: this.runGranted,
    });
    if (result) {
      this.toolState.workflowProposals = [result.proposal];
    }
  }

  private assertNotCancelled(): void {
    const signal = this.options.signal;
    if (!signal?.aborted) return;
    throw signal.reason ?? new Error("子 Agent 已取消");
  }

  private resetRunState(): void {
    this.budgetManager.markRunStarted();
    this.toolState.reset(this.policy, this.options.completionCriteria);
    this.runRoutingMeta = undefined;
    this.workflowInternalPlans = [];
    this.workflowSwitch = undefined;
  }

  private applyPlanHandoffSystemPrompt(messages: ChatMessage[], pausedRun: PausedRunSnapshot): void {
    if (!pausedRun.resumeMode) return;
    const handoffExecutionContext = [
      "内部运行态：用户已通过权限弹窗批准执行计划。",
      "这不是一条用户消息，不要复述、感谢或询问是否继续。",
      pausedRun.approvedPlan
        ? `必须执行已批准的 ${pausedRun.approvedPlan.planId} v${pausedRun.approvedPlan.version}，不得静默改变范围。`
        : "当前是旧版计划交接；如果计划范围不明确，应停止并说明需要重新规划。",
      pausedRun.approvedPlan
        ? `冻结执行契约：\n${renderAgentPlanMarkdown(pausedRun.approvedPlan)}`
        : "",
      "执行中发现计划错误、范围变化或完成标准无法满足时，停止当前范围并明确要求生成新版本计划；不得自行改写已批准计划。",
      "最终回复必须在 final.planExecution 中引用准确的 planId/version，并逐项报告每个计划步骤的 status、actualScope、evidence、deviations 和 blockingReason。",
      "已完成步骤必须包含验证证据；范围偏差必须记录且会阻止旧版本被标记完成，随后应重新规划。",
      '下一条回复必须直接输出一个 ReAct JSON 对象：{"action":"tool",...} 或 {"action":"final","answer":"...","planExecution":{...}}。',
      "如果需要创建嵌套路径的新文件，调用 write_file 时必须使用 createDirs:true。",
    ].join("\n");
    const executionSystemPrompt = `${this.buildSystemPrompt(pausedRun.system)}\n\n${handoffExecutionContext}`;
    if (messages[0]?.role === "system") {
      messages[0] = { role: "system", content: executionSystemPrompt };
    } else {
      messages.unshift({ role: "system", content: executionSystemPrompt });
    }
  }

  private buildRunBootstrapContext() {
    return {
      contextManager: this.options.contextManager,
      sessionTaskManager: this.sessionTaskManager,
      timeline: this.options.timeline,
      runId: this.options.runId,
      policy: this.policy,
      getEffectiveIntent: () => this.getEffectiveIntent(),
      buildSystemPrompt: (extra?: string) => this.buildSystemPrompt(extra),
      drainNotifications: () => this.drainNotifications(),
      runWorkflowExecutor: (goal: string, isResume: boolean, sessionId?: string) =>
        this.runWorkflowExecutor(goal, isResume, sessionId),
      applyWorkflowResult: (result: Awaited<ReturnType<AgentLoop["runWorkflowExecutor"]>>) => {
        this.toolState.workflowProposals = result.workflowProposals;
        this.toolState.workflowDebugAnalyses = result.workflowDebugAnalyses;
        this.toolState.workflowRefactorPlans = result.workflowRefactorPlans;
        this.workflowInternalPlans = result.workflowInternalPlans;
      },
      setWorkflowSwitch: (value: AgentWorkflowSwitch | undefined) => {
        this.workflowSwitch = value;
      },
      getWorkflowProposals: () => this.toolState.workflowProposals,
      onWorkflowStep: this.options.onStep,
    };
  }

  private buildReactLoopContext(session: {
    pausedRun?: PausedRunSnapshot;
  }): AgentReactLoopContext {
    const allowedToolNames = this.options.registry
      .list()
      .filter(
        (tool) =>
          this.allowed.includes(tool.permissions[0]) &&
          this.toolExecution.isToolExposed(tool.name),
      )
      .map((tool) => tool.name);
    return {
      chat: this.options.chat,
      registry: this.options.registry,
      workspaceRoot: this.options.workspaceRoot,
      allowedToolNames,
      signal: this.options.signal,
      sensitive: this.options.sensitive,
      taskType: this.options.taskType,
      maxCostUsdPerRun: this.options.maxCostUsdPerRun,
      maxModelTurns: this.budget.maxModelTurns,
      budgetManager: this.budgetManager,
      contextManager: this.options.contextManager,
      runId: this.options.runId,
      policy: this.policy,
      pausedRun: session.pausedRun,
      requiresPlanContract: this.policy.mode === "plan" && this.options.skipPlanHandoff !== true,
      capabilityEscalations: this.toolState.capabilityEscalations,
      completionCriteria: this.toolState.completionCriteria,
      getEffectiveIntent: () => this.getEffectiveIntent(),
      getReconciledIntent: () => this.toolState.reconciledIntent,
      getModelTurnMetrics: () => this.toolState.modelTurnMetrics,
      recordModelTurn: (metric) => this.recordModelTurn(metric),
      setRunRoutingMeta: (meta) => {
        this.runRoutingMeta = meta;
      },
      getRunRoutingMeta: () => this.runRoutingMeta,
      onModelTurn: this.options.onModelTurn,
      onStep: this.options.onStep,
      onToken: this.options.onToken,
      onWorkingContextCompacted: (input) => {
        const activity = this.options.timeline?.startSystemActivity({
          kind: "working_context_compaction",
          title: "模型工作上下文已裁剪",
          summaryType: "working_set",
          beforeChars: input.beforeChars,
        });
        if (activity) {
          this.options.timeline?.completeSystemActivity(activity.id, {
            summary: "已压缩模型工作上下文",
            processedMessages: input.processedMessages,
            beforeChars: input.beforeChars,
            afterChars: input.afterChars,
            summaryType: "working_set",
          });
        }
      },
      assertNotCancelled: () => this.assertNotCancelled(),
      isCancelledError: (err) => this.isCancelledError(err),
      makeToolCallId: (iteration, tool) => this.toolExecution.makeToolCallId(iteration, tool),
      writeAgentDecisionTrace: (input) => this.writeAgentDecisionTrace(input),
      createPlanFinalization: (input) => this.pauseCoordinator.createPlanFinalization({
        ...input,
        runtime: this.buildPauseRuntimeSnapshot(),
      }),
      executeToolStep: (input) => this.executeToolStep(input),
      recordToolBatchObservations: (inputs) =>
        this.toolExecution.recordToolBatchObservations(inputs),
      continueAfterRecordedToolBatch: (inputs) =>
        this.toolExecution.continueAfterRecordedToolBatch(inputs),
      buildPartialAnswer: (steps, budgetExhausted, goal) =>
        this.buildPartialAnswer(steps, budgetExhausted, goal),
      finishRun: (input) => this.finishRun(input),
    };
  }

  async run(userMessage: string, system?: string): Promise<AgentRunResult> {
    this.resetRunState();
    const pausedRun = this.options.pausedRun;
    this.toolState.completionCriteria = normalizeCompletionCriteria(
      pausedRun?.completionCriteria ??
      this.options.resumeState?.completionCriteria ??
      this.options.completionCriteria,
    );
    if (pausedRun) {
      this.toolState.workflowProposals = [...(pausedRun.workflowProposals ?? [])];
      this.toolState.workflowDebugAnalyses = [...(pausedRun.workflowDebugAnalyses ?? [])];
      this.toolState.workflowRefactorPlans = [...(pausedRun.workflowRefactorPlans ?? [])];
      this.workflowInternalPlans = [...(pausedRun.workflowInternalPlans ?? [])];
      this.restoreRuntimeSnapshot(pausedRun.runtimeState);
      this.restoreApprovedHandoffArtifacts(pausedRun);
    }
    const isResume = Boolean(this.options.resumeState);
    const effectiveGoal = pausedRun
      ? pausedRun.goal
      : isResume
        ? this.options.resumeState!.goal
        : userMessage;
    const initialSessionId =
      pausedRun?.sessionId ?? this.options.resumeState?.sessionId ?? this.options.sessionId;
    const initialSteps: AgentToolStep[] = pausedRun
      ? [...pausedRun.steps]
      : isResume
        ? [...(this.options.resumeState?.completedToolSteps ?? [])]
        : [];
    let catchState = {
      steps: initialSteps,
      modelTurns: pausedRun?.modelTurns ?? 0,
      sessionId: initialSessionId,
      consumedNotifications: [] as AgentNotification[],
    };

    try {
      const boot = await bootstrapAgentRunSession(this.buildRunBootstrapContext(), {
        userMessage,
        system,
        effectiveGoal,
        isResume,
        resumeState: this.options.resumeState,
        pausedRun,
        initialSessionId,
        initialSteps,
        initialModelTurns: catchState.modelTurns,
      });
      catchState = {
        steps: boot.session.steps,
        modelTurns: boot.session.modelTurns,
        sessionId: boot.session.sessionId,
        consumedNotifications: boot.session.consumedNotifications,
      };
      if (pausedRun?.pendingAction) {
        const earlyResult = await resumeApprovedToolAction(
          this.buildApprovedToolResumeContext(),
          {
            pendingAction: pausedRun.pendingAction,
            messages: boot.session.messages,
            steps: boot.session.steps,
            modelTurns: boot.session.modelTurns,
            goal: boot.session.effectiveGoal,
            system: boot.session.system,
            sessionId: boot.session.sessionId,
            consumedNotifications: boot.session.consumedNotifications,
            injectNotifications: boot.session.injectNotifications,
          },
        );
        if (earlyResult) return earlyResult;
      } else if (pausedRun?.resumeMode) {
        this.applyPlanHandoffSystemPrompt(boot.session.messages, pausedRun);
      }
      return await runAgentReactLoop(this.buildReactLoopContext(boot.session), boot.session);
    } catch (err) {
      if (this.isCancelledError(err)) {
        return await this.finishRun({
          answer: "",
          steps: catchState.steps,
          iterations: catchState.modelTurns,
          reachedLimit: false,
          stopReason: "user_cancelled",
          consumedNotifications: catchState.consumedNotifications,
          sessionId: catchState.sessionId,
          userMessage: effectiveGoal,
        });
      }
      throw err;
    }
  }

  private isCancelledError(err: unknown): boolean {
    const msg = String(err);
    if (msg.includes("运行已取消") || msg.includes("子 Agent 已取消")) return true;
    if (err instanceof Error && err.name === "AbortError") return true;
    const signal = this.options.signal;
    return signal?.aborted === true;
  }

  private buildRunFinalizeContext(): AgentRunFinalizeContext {
    return {
      isResume: Boolean(this.options.resumeState),
      runId: this.options.runId,
      taskId: this.options.taskId,
      policy: this.policy,
      entryIntent: this.toolState.entryIntent,
      entryWorkflowType: this.toolState.entryWorkflowType,
      reconciledIntent: this.toolState.reconciledIntent,
      reconciledWorkflowType: this.toolState.reconciledWorkflowType,
      getEffectiveIntent: () => this.getEffectiveIntent(),
      capabilityEscalations: this.toolState.capabilityEscalations,
      budgetManager: this.budgetManager,
      budget: this.budget,
      timeline: this.options.timeline,
      contextManager: this.options.contextManager,
      sessionTaskManager: this.sessionTaskManager,
      runStateStore: this.options.runStateStore,
      resumeState: this.options.resumeState,
      projectIndex: this.options.projectIndex,
      workspaceRoot: this.options.workspaceRoot,
      runRoutingMeta: this.runRoutingMeta,
      trace: this.options.trace,
      buildExecutionMeta: (input) => this.buildExecutionMeta(input),
      writeRunUsageSummary: (steps, executionMeta) =>
        this.writeRunUsageSummary(steps, executionMeta),
    };
  }

  private async finishRun(input: {
    answer: string;
    steps: AgentToolStep[];
    iterations: number;
    reachedLimit: boolean;
    budgetExhausted?: RunBudgetKey;
    consumedNotifications: AgentNotification[];
    sessionId?: string;
    userMessage: string;
    stopReason?: AgentStopReason;
    permissionRequest?: PermissionRequestPayload;
    planHandoff?: PlanHandoffPayload;
    agentPlan?: AgentPlanContract;
    agentPlanExecutionReport?: AgentPlanExecutionReport;
    awaitingPermission?: boolean;
    awaitingPlanHandoff?: boolean;
    completionGuard?: CompletionGuardResult;
    partialSummary?: string;
  }): Promise<AgentRunResult> {
    return finalizeAgentRun(this.buildRunFinalizeContext(), input);
  }

  private drainNotifications(): AgentNotification[] {
    const queue = this.options.notificationQueue;
    if (!queue) return [];
    // 按 runId 限定消费，避免并发运行互相截走对方的 run 级通知；兼容仅实现 drain 的 mock。
    if (typeof queue.drainForRun === "function") {
      return queue.drainForRun(this.options.runId);
    }
    return queue.drain();
  }

  private runWorkflowExecutor(userMessage: string, isResume: boolean, sessionId?: string) {
    return new WorkflowExecutor({
      registry: this.options.registry,
      workspaceRoot: this.options.workspaceRoot,
      processSandbox: this.options.processSandbox,
      allowedPermissions: this.allowed,
      runGrantedPermissions: this.runGranted,
      budget: this.budget,
      budgetManager: this.budgetManager,
      policy: this.policy,
      trace: this.options.trace,
      contextManager: this.options.contextManager,
      sessionId,
      taskId: this.options.taskId,
      requestId: this.options.requestId ?? this.options.runId,
    }).executeBeforeModel({
      goal: userMessage,
      isResume,
      resumeState: this.options.resumeState,
    });
  }

  private getEffectiveIntent(): import("./IntentTypes.js").AgentIntentType {
    return this.toolState.getEffectiveIntent(this.policy);
  }

  private buildRuntimeSnapshot(): PausedRunRuntimeState {
    return this.toolState.buildPausedRuntimeState(this.policy, this.budgetManager);
  }

  private restoreRuntimeSnapshot(state?: PausedRunRuntimeState): void {
    if (!state) return;
    this.toolState.restorePausedRuntimeState(state, this.budgetManager);
  }

  private buildApprovedToolResumeContext(): AgentApprovedToolResumeContext {
    return {
      makeToolCallId: (iteration, tool) => this.toolExecution.makeToolCallId(iteration, tool),
      executeToolStep: (input) => this.executeToolStep(input),
      finalizePermissionPause: (input) => this.finalizeToolPermissionPause(input),
      finishRun: (input) => this.finishRun(input),
      continueAfterToolStep: (input) => this.toolExecution.continueAfterToolStep(input),
    };
  }

  /** Adapts coordinator pause/budget outcomes to the Agent run finalization boundary. */
  private async executeToolStep(input: {
    action: ToolAction;
    iteration: number;
    toolCallId: string;
    steps: AgentToolStep[];
    goal: string;
    messages: ChatMessage[];
    sessionId?: string;
    system?: string;
    modelTurns: number;
    consumedNotifications: AgentNotification[];
    skipJitPause?: boolean;
    activityBatchId?: string;
    activityDependsOnToolCallIds?: string[];
  }): Promise<
    | { kind: "step"; step: AgentToolStep }
    | { kind: "pause"; result: AgentRunResult }
    | { kind: "budget"; result: AgentRunResult }
  > {
    const pipelineResult = await this.toolExecution.executeToolStep({
      action: input.action,
      iteration: input.iteration,
      toolCallId: input.toolCallId,
      steps: input.steps,
      goal: input.goal,
      messages: input.messages,
      skipJitPause: input.skipJitPause,
      activityBatchId: input.activityBatchId,
      activityDependsOnToolCallIds: input.activityDependsOnToolCallIds,
    });

    if (pipelineResult.kind === "pause") {
      this.options.onStep?.(pipelineResult.step);
      return {
        kind: "pause",
        result: await this.finalizeToolPermissionPause({
          step: pipelineResult.step,
          action: input.action,
          messages: input.messages,
          steps: pipelineResult.pauseSteps,
          modelTurns: input.modelTurns,
          goal: input.goal,
          system: input.system,
          sessionId: input.sessionId,
          consumedNotifications: input.consumedNotifications,
        }),
      };
    }

    if (pipelineResult.kind === "budget") {
      const steps = [...input.steps, pipelineResult.step];
      this.options.onStep?.(pipelineResult.step);
      return {
        kind: "budget",
        result: await this.finishRun({
          answer: "",
          partialSummary: this.buildPartialAnswer(
            steps,
            pipelineResult.budgetExhausted,
            input.goal,
          ),
          steps,
          iterations: input.modelTurns,
          reachedLimit: true,
          budgetExhausted: pipelineResult.budgetExhausted,
          consumedNotifications: input.consumedNotifications,
          sessionId: input.sessionId,
          userMessage: input.goal,
        }),
      };
    }

    return {
      kind: "step",
      step: pipelineResult.step,
    };
  }

  private buildSystemPrompt(extra?: string): string {
    return buildAgentSystemPrompt({
      registry: this.options.registry,
      allowedPermissions: this.allowed,
      isToolExposed: (toolName) => this.toolExecution.isToolExposed(toolName),
      systemHint: this.policy.systemHint,
      workflowCapabilityHint: buildWorkflowCapabilityHint({
        intent: this.getEffectiveIntent(),
        reconciledWorkflowType: this.toolState.reconciledWorkflowType,
        reconciledIntent: this.toolState.reconciledIntent,
      }),
      additionalInstructions: this.options.resolveInstructions?.(this.options.workspaceRoot),
      extra,
    });
  }

  private buildExecutionMeta(input: {
    steps: AgentToolStep[];
    iterations: number;
    stopReason: AgentStopReason;
    budgetExhausted?: RunBudgetKey;
    goal: string;
    completionGuard?: CompletionGuardResult;
    partialSummary?: string;
  }): AgentExecutionMeta {
    return buildAgentExecutionMeta({
      ...input,
      policy: this.policy,
      effectiveIntent: this.getEffectiveIntent(),
      reconciledWorkflowType: this.toolState.reconciledWorkflowType,
      reconciledIntent: this.toolState.reconciledIntent,
      entryIntent: this.toolState.entryIntent,
      entryWorkflowType: this.toolState.entryWorkflowType,
      budget: this.budget,
      budgetManager: this.budgetManager,
      finalizer: this.finalizer,
      workflowProposals: this.toolState.workflowProposals,
      workflowDebugAnalyses: this.toolState.workflowDebugAnalyses,
      workflowRefactorPlans: this.toolState.workflowRefactorPlans,
      workflowInternalPlans: this.workflowInternalPlans,
      workflowWritePhases: this.toolState.workflowWritePhases,
      workflowDebugFixes: this.toolState.workflowDebugFixes,
      workflowSwitch: this.workflowSwitch,
      capabilityEscalations: this.toolState.capabilityEscalations,
    });
  }

  private buildPartialAnswer(
    steps: AgentToolStep[],
    budgetExhausted: RunBudgetKey,
    goal: string,
  ): string {
    return this.finalizer.buildPartialAnswer({
      steps,
      budgetExhausted,
      budgetManager: this.budgetManager,
      mode: this.policy.mode,
      goal,
      location: buildLocationMeta(steps),
    });
  }

  private buildPauseRuntimeSnapshot(): AgentPauseRuntimeSnapshot {
    return {
      runtimeState: this.buildRuntimeSnapshot(),
      workflowProposals: this.toolState.workflowProposals,
      workflowDebugAnalyses: this.toolState.workflowDebugAnalyses,
      workflowRefactorPlans: this.toolState.workflowRefactorPlans,
      workflowInternalPlans: this.workflowInternalPlans,
      completionCriteria: this.toolState.completionCriteria,
    };
  }

  /** Finalizes a JIT pause after the coordinator atomically pairs approval state with a snapshot. */
  private async finalizeToolPermissionPause(input: {
    step: AgentToolStep;
    action: ToolAction;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    modelTurns: number;
    goal: string;
    system?: string;
    sessionId?: string;
    consumedNotifications: AgentNotification[];
  }): Promise<AgentRunResult> {
    const permissionRequest = this.pauseCoordinator.createToolPermissionPause({
      ...input,
      intent: this.getEffectiveIntent(),
      runtime: this.buildPauseRuntimeSnapshot(),
    });
    return await this.finishRun({
      answer: "",
      steps: input.steps,
      iterations: input.modelTurns,
      reachedLimit: false,
      consumedNotifications: input.consumedNotifications,
      sessionId: input.sessionId,
      userMessage: input.goal,
      stopReason: "awaiting_permission",
      permissionRequest,
      awaitingPermission: true,
    });
  }

  private writeAgentDecisionTrace(event: {
    iteration: number;
    action: "tool" | "final" | "parse_error" | "final_guard_rejected";
    tool?: string;
    toolCallId?: string;
    thought?: string;
    inputPreview?: string;
    rawPreview?: string;
    answerLength?: number;
    completionStatus?: string;
  }): void {
    this.options.trace?.write({
      type: "agent_decision",
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.policy.mode,
      ...event,
    });
  }

  private recordModelTurn(metric: AgentModelTurnMetric): void {
    this.toolState.modelTurnMetrics.push(metric);
    this.options.trace?.write({
      type: "agent_model_turn",
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.policy.mode,
      ...metric,
    });
  }

  private writeRunUsageSummary(steps: AgentToolStep[], executionMeta: AgentExecutionMeta): void {
    this.options.trace?.write(buildRunUsageSummaryTracePayload({
      steps,
      executionMeta,
      modelTurnMetrics: this.toolState.modelTurnMetrics,
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.policy.mode,
    }));
  }

}

export { parseAction, stripModelNoise } from "./AgentActionParser.js";
export { renderNotifications } from "./AgentNotificationRenderer.js";
export type { AgentAction, FinalAction, ToolAction } from "./AgentActionParser.js";
export type { LoopChatFn, LoopChatResponse } from "../model-router/agent-chat-types.js";
