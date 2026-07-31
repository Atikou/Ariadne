import type { AgentNotification } from "../background/types.js";
import type { ToolPermission } from "../core/permissions.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ChatMessage } from "../model/types.js";
import type { NetworkPolicy } from "../policy/NetworkPolicy.js";
import type { SessionPermissionGrants } from "../policy/SessionPermissionGrants.js";
import type { ShellPolicy } from "../policy/ShellPolicy.js";
import type { ToolPathPreparation } from "../policy/PathPolicy.js";
import type {
  ScopedApprovedPermissions,
} from "../policy/permissionRequestTypes.js";
import type {
  WorkspaceGrantStore,
  WorkspaceScopePermission,
} from "../policy/WorkspaceScopeManager.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import { sumModelTurnCost } from "../util/costBudget.js";
import { redactPreview } from "../util/redact.js";
import type { ToolAction } from "./AgentActionParser.js";
import {
  reconcileCapabilityBeforeTool as applyCapabilityEscalationBeforeTool,
} from "./AgentCapabilityEscalationOrchestrator.js";
import {
  runAgentToolAction,
  type AgentToolActionRunContext,
} from "./AgentToolActionRunner.js";
import type { AgentRunFinalizeInput } from "./AgentRunFinalizer.js";
import { renderAgentToolResultObservation } from "./AgentToolResultRenderer.js";
import {
  executeAgentToolStepPipeline,
  type AgentToolStepPipelineResult,
  type ExecuteAgentToolStepInput,
} from "./AgentToolStepPipeline.js";
import { buildPathBlockedToolStep } from "./AgentToolStepBlockBuilder.js";
import type { AgentToolRuntimeState } from "./AgentToolRuntimeState.js";
import type { BudgetManager } from "./BudgetManager.js";
import { EditAutoVerificationWorkflow } from "./EditAutoVerificationWorkflow.js";
import { effectiveWorkflowRoute } from "./EffectiveWorkflowContext.js";
import type { Finalizer } from "./Finalizer.js";
import type { RunBudgetKey, RunPolicy } from "./RunPolicyTypes.js";
import { ToolExecutionGateway } from "./ToolExecutionGateway.js";
import { orchestrateWorkflowWrite } from "./workflowWriteOrchestrator.js";
import { buildWorkflowFollowupContexts } from "./workflowFollowupContexts.js";
import {
  criterionMatchesToolStep,
  criterionMatchesWriteTarget,
} from "./completion/CompletionCriterionMatcher.js";
import { buildLocationMeta } from "./workflowExecutionMeta.js";
import {
  cacheInvalidationPath,
  planSystemRecovery,
  renderCacheReuseContext,
} from "./recovery/SystemToolRecovery.js";
import type { AgentTimelineService } from "./timeline/AgentTimelineService.js";
import type { AgentToolStep } from "./toolStep.js";
import { isEffectiveWriteStep } from "./toolStepOutcome.js";
import { DISPATCH_SUBAGENT_TOOL_NAME } from "../tools/subagentTool.js";
import type { RunAggregateRepository } from "../run/RunAggregateRepository.js";
import { RunToolCheckpointCoordinator } from "../run/RunToolCheckpointCoordinator.js";

export interface AgentToolExecutionCoordinatorOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  processSandbox?: ProcessSandbox;
  allowedPermissions: ToolPermission[];
  runGrantedPermissions?: readonly ToolPermission[];
  projectAllowedPermissions?: ToolPermission[];
  allowedToolNames?: readonly string[];
  subAgentDispatchDepth?: number;
  maxSubAgentDispatchDepth?: number;
  maxCostUsdPerRun?: number;
  policy: RunPolicy;
  budgetManager: BudgetManager;
  state: AgentToolRuntimeState;
  finalizer: Finalizer;
  pauseOnPermissionRequest: boolean;
  sessionPermissionGrants: SessionPermissionGrants;
  scopedGrants?: ScopedApprovedPermissions;
  workspaceGrantStore?: WorkspaceGrantStore;
  workspaceConfigScopes?: Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;
  shellPolicy?: ShellPolicy;
  networkPolicy?: NetworkPolicy;
  contextManager?: ContextManager;
  timeline?: AgentTimelineService;
  trace?: TraceLogger;
  signal?: AbortSignal;
  sensitive?: boolean;
  runId?: string;
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  requestId?: string;
  runRepository?: RunAggregateRepository;
  onStep?: (step: AgentToolStep) => void;
}

export interface AgentToolContinuationInput {
  step: AgentToolStep;
  action?: ToolAction;
  allowPermissionRepause?: boolean;
  messages: ChatMessage[];
  steps: AgentToolStep[];
  goal: string;
  system?: string;
  sessionId?: string;
  iteration: number;
  modelTurns: number;
  consumedNotifications: AgentNotification[];
  injectNotifications: () => void;
}

export type AgentToolContinuationResult =
  | { kind: "continue" }
  | {
      kind: "permission_pause";
      input: {
        step: AgentToolStep;
        action: ToolAction;
        messages: ChatMessage[];
        steps: AgentToolStep[];
        modelTurns: number;
        goal: string;
        system?: string;
        sessionId?: string;
        consumedNotifications: AgentNotification[];
      };
    }
  | { kind: "finalize"; input: AgentRunFinalizeInput };

/** One-way owner for tool evaluation, execution, observation, recovery and verification. */
export class AgentToolExecutionCoordinator {
  private readonly toolGateway: ToolExecutionGateway;

  constructor(private readonly options: AgentToolExecutionCoordinatorOptions) {
    this.toolGateway = new ToolExecutionGateway(
      options.registry,
      options.runRepository && options.runId
        ? new RunToolCheckpointCoordinator(options.runRepository, options.runId)
        : undefined,
    );
  }

  makeToolCallId(iteration: number, tool: string): string {
    const prefix = this.options.runId ?? this.options.requestId ?? this.options.taskId ?? "agent";
    return `${prefix}:iter-${iteration}:${tool}`;
  }

  isToolExposed(toolName: string): boolean {
    if (this.options.allowedToolNames && !this.options.allowedToolNames.includes(toolName)) {
      return false;
    }
    if (toolName !== DISPATCH_SUBAGENT_TOOL_NAME) return true;
    const depth = this.options.subAgentDispatchDepth ?? 0;
    const max = this.options.maxSubAgentDispatchDepth ?? 1;
    return depth < max;
  }

  async executeToolStep(input: ExecuteAgentToolStepInput): Promise<AgentToolStepPipelineResult> {
    const result = await executeAgentToolStepPipeline(
      {
        registry: this.options.registry,
        permissionPolicy: this.options.policy.permissionPolicy,
        getWorkflowContext: () => this.options.state.getEffectiveWorkflowContext(this.options.policy),
        capabilityEscalations: this.options.state.capabilityEscalations,
        budgetManager: this.options.budgetManager,
        timeline: this.options.timeline,
        runId: this.options.runId,
        pauseOnPermissionRequest: this.options.pauseOnPermissionRequest,
        runToolAction: (action, iteration, toolCallId, context) =>
          this.runToolAction(action, iteration, toolCallId, context),
        onCapabilityReconciled: (reconciled) =>
          this.options.state.applyCapabilityReconciliation(reconciled),
      },
      input,
    );
    if (result.kind !== "step") return result;
    return {
      kind: "step",
      step: this.bindCompletionCriteria(result.step, input.steps),
    };
  }

  async continueAfterToolStep(
    input: AgentToolContinuationInput,
  ): Promise<AgentToolContinuationResult> {
    this.recordToolBatchObservations([input]);
    return await this.continueAfterRecordedToolBatch([input]);
  }

  async continueAfterToolBatch(
    inputs: readonly AgentToolContinuationInput[],
  ): Promise<AgentToolContinuationResult> {
    // OpenAI-compatible providers require every tool result for one assistant
    // tool_calls message to be contiguous. Workflow/system follow-ups may only
    // be appended after the whole batch has produced its tool messages.
    this.recordToolBatchObservations(inputs);
    return await this.continueAfterRecordedToolBatch(inputs);
  }

  recordToolBatchObservations(inputs: readonly AgentToolContinuationInput[]): void {
    for (const input of inputs) this.recordToolStepObservation(input);
  }

  async continueAfterRecordedToolBatch(
    inputs: readonly AgentToolContinuationInput[],
  ): Promise<AgentToolContinuationResult> {
    for (const input of inputs) this.recordToolStepFollowups(input);
    for (const input of inputs) {
      const result = await this.continueRecordedToolStep(input);
      if (result.kind !== "continue") return result;
    }
    return { kind: "continue" };
  }

  private recordToolStepObservation(input: AgentToolContinuationInput): void {
    input.steps.push(input.step);
    this.options.onStep?.(input.step);
    this.appendToolStepObservationMessage(input);
  }

  private appendToolStepObservationMessage(input: {
    messages: ChatMessage[];
    step: AgentToolStep;
    steps: AgentToolStep[];
    sessionId?: string;
  }): void {
    const toolText = renderAgentToolResultObservation(input.step, input.steps);
    input.messages.push({
      role: "tool",
      name: input.step.tool,
      toolCallId: input.step.toolCallId,
      content: toolText,
    });
    if (this.options.contextManager && input.sessionId) {
      this.options.contextManager.saveToolMessage(input.sessionId, toolText, this.options.runId, {
        outcomeClass: input.step.outcomeClass,
        outcomeKind: input.step.outcomeKind,
        toolName: input.step.tool,
        toolCallId: input.step.toolCallId,
        ledgerBacked:
          input.step.outcomeClass === "observation_success"
          && input.step.outcomeKind !== "not_found"
          && input.step.outcomeKind !== "no_results",
      });
    }
  }

  private async continueRecordedToolStep(
    input: AgentToolContinuationInput,
  ): Promise<AgentToolContinuationResult> {
    if (
      input.allowPermissionRepause
      && input.action
      && input.step.blocked
      && input.step.confirmationRequest?.status === "waiting_confirmation"
      && this.options.pauseOnPermissionRequest
    ) {
      return {
        kind: "permission_pause",
        input: {
          step: input.step,
          action: input.action,
          messages: input.messages,
          steps: input.steps,
          modelTurns: input.modelTurns,
          goal: input.goal,
          system: input.system,
          sessionId: input.sessionId,
          consumedNotifications: input.consumedNotifications,
        },
      };
    }

    if (!input.step.blocked) {
      const invalidated = cacheInvalidationPath(input.step);
      if (invalidated) this.options.state.toolResultCache.invalidatePath(invalidated);
      await this.maybeRunSystemRecovery(input);

      if (this.options.state.failedActionMemory.shouldForcePartialFinal(input.step)) {
        const recoverySummary = this.options.state.failedActionMemory.buildSummaryContext();
        if (recoverySummary) {
          input.messages.push({ role: "system", content: recoverySummary });
        }
        return {
          kind: "finalize",
          input: {
            answer: "",
            partialSummary: [
              this.options.finalizer.buildRecoveryExhaustedAnswer({
                goal: input.goal,
                steps: input.steps,
              }),
              input.step.error ?? "",
              recoverySummary ?? "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            steps: input.steps,
            iterations: input.modelTurns,
            reachedLimit: false,
            stopReason: "recovery_partial",
            consumedNotifications: input.consumedNotifications,
            sessionId: input.sessionId,
            userMessage: input.goal,
          },
        };
      }

      const verification = await this.runEditAutoVerification(
        input.step,
        input.steps,
        input.iteration,
        input.goal,
      );
      if (verification) {
        input.steps.push(verification);
        this.options.onStep?.(verification);
        this.appendInternalToolObservationMessage({ ...input, step: verification });
        this.recordToolStepFollowups({ ...input, step: verification });
      }
    }

    input.injectNotifications();
    const exhausted = this.options.budgetManager.findRuntimeExhaustion();
    if (!exhausted) return { kind: "continue" };
    return {
      kind: "finalize",
      input: {
        answer: "",
        partialSummary: this.buildPartialAnswer(input.steps, exhausted, input.goal),
        steps: input.steps,
        iterations: input.modelTurns,
        reachedLimit: true,
        budgetExhausted: exhausted,
        consumedNotifications: input.consumedNotifications,
        sessionId: input.sessionId,
        userMessage: input.goal,
      },
    };
  }

  private resolveScopedGrants(): ScopedApprovedPermissions | undefined {
    const sessionId = this.options.sessionId;
    const sessionGrants = sessionId
      ? this.options.sessionPermissionGrants.get(sessionId)
      : undefined;
    if (!this.options.scopedGrants && !sessionGrants) return undefined;
    return {
      read_file: [...new Set([...(this.options.scopedGrants?.read_file ?? []), ...(sessionGrants?.read_file ?? [])])],
      write_file: [...new Set([...(this.options.scopedGrants?.write_file ?? []), ...(sessionGrants?.write_file ?? [])])],
      shell: [...new Set([...(this.options.scopedGrants?.shell ?? []), ...(sessionGrants?.shell ?? [])])],
      delete_file: [...new Set([...(this.options.scopedGrants?.delete_file ?? []), ...(sessionGrants?.delete_file ?? [])])],
      network: [...new Set([...(this.options.scopedGrants?.network ?? []), ...(sessionGrants?.network ?? [])])],
      dangerous: [...new Set([...(this.options.scopedGrants?.dangerous ?? []), ...(sessionGrants?.dangerous ?? [])])],
    };
  }

  private buildPathBlockedStep(
    action: ToolAction,
    iteration: number,
    pathAccess: ToolPathPreparation,
    toolCallId?: string,
  ): AgentToolStep {
    const tool = this.options.registry.get(action.tool);
    return buildPathBlockedToolStep({
      action,
      iteration,
      toolCallId,
      toolPermission: tool?.permissions[0],
      pathAccess,
      intent: this.options.state.getEffectiveIntent(this.options.policy),
      permissionPolicy: this.options.policy.permissionPolicy,
    });
  }

  private async runToolAction(
    action: ToolAction,
    iteration: number,
    toolCallId: string,
    context: {
      steps: AgentToolStep[];
      goal: string;
      workflowRoute: Parameters<typeof runAgentToolAction>[1]["workflowRoute"];
      userConfirmed: boolean;
      isRecovery?: boolean;
      isPreflight?: boolean;
      activityBatchId?: string;
      activityLaneId?: string;
      activityParentId?: string;
      activityDependsOnToolCallIds?: string[];
      verifiesToolCallId?: string;
    },
  ): Promise<AgentToolStep> {
    const result = await runAgentToolAction(this.buildToolActionRunContext(), {
      action,
      iteration,
      toolCallId,
      steps: context.steps,
      goal: context.goal,
      workflowRoute: context.workflowRoute,
      userConfirmed: context.userConfirmed,
      isRecovery: context.isRecovery,
      isPreflight: context.isPreflight,
      activityBatchId: context.activityBatchId,
      activityLaneId: context.activityLaneId,
      activityParentId: context.activityParentId,
      activityDependsOnToolCallIds: context.activityDependsOnToolCallIds,
      verifiesToolCallId: context.verifiesToolCallId,
    });
    this.options.state.applyWorkflowWrite(result.workflowWrite);
    return result.step;
  }

  private buildToolActionRunContext(): AgentToolActionRunContext {
    const state = this.options.state;
    return {
      registry: this.options.registry,
      toolGateway: this.toolGateway,
      timeline: this.options.timeline,
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      projectId: this.options.projectId,
      taskId: this.options.taskId,
      requestId: this.options.requestId,
      trace: this.options.trace,
      workspaceRoot: this.options.workspaceRoot,
      processSandbox: this.options.processSandbox,
      workspaceGrantStore: this.options.workspaceGrantStore,
      workspaceConfigScopes: this.options.workspaceConfigScopes,
      signal: this.options.signal,
      sensitive: this.options.sensitive,
      subAgentDispatchDepth: this.options.subAgentDispatchDepth,
      maxSubAgentDispatchDepth: this.options.maxSubAgentDispatchDepth,
      projectAllowedPermissions: this.options.projectAllowedPermissions,
      subAgentCostBudgetUsd:
        this.options.maxCostUsdPerRun == null || this.options.maxCostUsdPerRun <= 0
          ? undefined
          : Math.max(
              Number.EPSILON,
              this.options.maxCostUsdPerRun
                - sumModelTurnCost(state.modelTurnMetrics.map((metric) => metric.costUsd)),
            ),
      contextManager: this.options.contextManager,
      allowedPermissions: this.options.allowedPermissions,
      runGrantedPermissions: this.options.runGrantedPermissions,
      permissionPolicy: this.options.policy.permissionPolicy,
      mode: this.options.policy.mode,
      reconciledWorkflowType: state.reconciledWorkflowType,
      policyWorkflowType: this.options.policy.workflowType,
      getIntent: () => state.getEffectiveIntent(this.options.policy),
      shellPolicy: this.options.shellPolicy,
      networkPolicy: this.options.networkPolicy,
      isToolExposed: (toolName) => this.isToolExposed(toolName),
      resolveScopedGrants: () => this.resolveScopedGrants(),
      resolveConfirmedScopedGrants: () => this.options.scopedGrants,
      failedActionMemory: state.failedActionMemory,
      toolResultCache: state.toolResultCache,
      budgetManager: this.options.budgetManager,
      buildPathBlockedStep: (action, iteration, pathAccess, toolCallId) =>
        this.buildPathBlockedStep(action, iteration, pathAccess, toolCallId),
      workflowWriteOrchestration: ({ tool, steps, goal }) =>
        orchestrateWorkflowWrite({
          intent: state.getEffectiveIntent(this.options.policy),
          goal,
          permissionPolicy: this.options.policy.permissionPolicy,
          tool,
          steps,
          hasProposal: state.workflowProposals.length > 0,
          hasDebugAnalysis: state.workflowDebugAnalyses.length > 0,
          hasRefactorPlan: state.workflowRefactorPlans.length > 0,
        }),
    };
  }

  private recordToolStepFollowups(input: {
    messages: ChatMessage[];
    step: AgentToolStep;
    steps: AgentToolStep[];
    goal: string;
    sessionId?: string;
  }): void {
    if (input.step.cached) {
      input.messages.push({
        role: "system",
        content: renderCacheReuseContext(
          input.step.tool,
          (input.step.input ?? {}) as Record<string, unknown>,
        ),
      });
    }
    const followups = buildWorkflowFollowupContexts({
      intent: this.options.state.getEffectiveIntent(this.options.policy),
      goal: input.goal,
      step: input.step,
      steps: input.steps,
      pendingWritePhaseContext: this.options.state.pendingWritePhaseContext,
    });
    this.options.state.pendingWritePhaseContext = followups.pendingWritePhaseContext;
    for (const extra of [
      followups.blockedContext,
      followups.toolRecoveryContext,
      followups.writePhaseContext,
      followups.editExecutionContext,
      followups.editVerificationContext,
      followups.workflowCorrectionContext,
    ]) {
      if (extra) input.messages.push({ role: "system", content: extra });
    }
  }

  private async maybeRunSystemRecovery(input: {
    step: AgentToolStep;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    goal: string;
    sessionId?: string;
    iteration: number;
  }): Promise<void> {
    if (input.step.ok || input.step.blocked || input.step.cached || input.step.systemRecovery) return;
    if (!this.options.budgetManager.canRunRecovery()) return;
    const plan = planSystemRecovery(input.step, input.goal);
    if (!plan) return;

    input.messages.push({ role: "system", content: plan.preamble });
    for (const recovery of plan.actions) {
      if (!this.options.budgetManager.canRunRecovery()) break;
      this.options.budgetManager.recordRecoveryTurn();
      const action: ToolAction = {
        action: "tool",
        tool: recovery.tool,
        input: recovery.input,
        thought: recovery.reason,
      };
      const toolCallId = this.makeToolCallId(input.iteration, `recovery:${recovery.tool}`);
      const recoveryStep = await this.runToolAction(action, input.iteration, toolCallId, {
        steps: input.steps,
        goal: input.goal,
        workflowRoute: effectiveWorkflowRoute(
          this.options.state.getEffectiveWorkflowContext(this.options.policy),
        ),
        userConfirmed: false,
        isRecovery: true,
        activityBatchId: `iteration-${input.iteration}-recovery`,
        activityDependsOnToolCallIds: [input.step.toolCallId].filter(
          (value): value is string => Boolean(value),
        ),
      });
      recoveryStep.systemRecovery = true;
      input.steps.push(recoveryStep);
      this.options.onStep?.(recoveryStep);
      this.appendInternalToolObservationMessage({ ...input, step: recoveryStep });
      this.recordToolStepFollowups({ ...input, step: recoveryStep });
      if (recoveryStep.ok) break;
    }
  }

  private async runEditAutoVerification(
    writeStep: AgentToolStep,
    steps: AgentToolStep[],
    iteration: number,
    goal: string,
  ): Promise<AgentToolStep | undefined> {
    const planned = new EditAutoVerificationWorkflow().run({
      intent: this.options.state.getEffectiveIntent(this.options.policy),
      step: writeStep,
    });
    if (!planned) return undefined;

    const action: ToolAction = {
      action: "tool",
      tool: planned.tool,
      input: planned.input,
      thought: planned.thought,
    };
    const tool = this.options.registry.get(action.tool);
    const toolCallId = this.makeToolCallId(iteration, `${action.tool}:auto-verify`);
    const entryWorkflowRoute = effectiveWorkflowRoute(
      this.options.state.getEffectiveWorkflowContext(this.options.policy),
    );
    const reconciliation = applyCapabilityEscalationBeforeTool({
      action,
      toolPermission: tool?.permissions[0],
      workflowRoute: entryWorkflowRoute,
      iteration,
      capabilityEscalations: this.options.state.capabilityEscalations,
      budgetManager: this.options.budgetManager,
      permissionPolicy: this.options.policy.permissionPolicy,
      timeline: this.options.timeline,
      runId: this.options.runId,
    });
    this.options.state.applyCapabilityReconciliation(reconciliation);
    const workflowRoute = effectiveWorkflowRoute(
      this.options.state.getEffectiveWorkflowContext(this.options.policy),
    );
    this.options.trace?.write({
      type: "agent_decision",
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.options.policy.mode,
      iteration,
      action: "tool",
      tool: action.tool,
      toolCallId,
      thought: action.thought,
      inputPreview: redactPreview(action.input ?? {}, 500),
    });
    const verificationStep = await this.runToolAction(action, iteration, toolCallId, {
      steps,
      goal,
      workflowRoute,
      userConfirmed: false,
      activityBatchId: `iteration-${iteration}-verification`,
      activityDependsOnToolCallIds: [writeStep.toolCallId].filter(
        (value): value is string => Boolean(value),
      ),
      verifiesToolCallId: writeStep.toolCallId,
    });
    return {
      ...verificationStep,
      verification: {
        kind: "write_readback",
        systemAssigned: true,
        verifiesToolCallId: writeStep.toolCallId,
        criterionIds: this.options.state.completionCriteria
          .filter(
            (criterion) =>
              criterion.evidenceKind === "write_readback"
              && criterionMatchesWriteTarget(criterion, writeStep),
          )
          .map((criterion) => criterion.id),
      },
    };
  }

  private appendInternalToolObservationMessage(input: {
    messages: ChatMessage[];
    step: AgentToolStep;
    steps: AgentToolStep[];
    sessionId?: string;
  }): void {
    const toolText = renderAgentToolResultObservation(input.step, input.steps);
    const content = [
      `Ariadne internal ${input.step.systemRecovery ? "recovery" : "verification"} observation.`,
      `Tool: ${input.step.tool}`,
      toolText,
    ].join("\n\n");
    input.messages.push({ role: "system", content });
    if (this.options.contextManager && input.sessionId) {
      this.options.contextManager.saveSystemMessage(
        input.sessionId,
        content,
        this.options.runId,
      );
    }
  }

  private bindCompletionCriteria(step: AgentToolStep, priorSteps: AgentToolStep[]): AgentToolStep {
    const criterionIds = this.options.state.completionCriteria
      .filter((criterion) => {
        if (criterion.evidenceKind !== "tool_success") return false;
        if (!criterionMatchesToolStep(criterion, step)) return false;
        if (!criterion.afterLastWrite) return true;
        return priorSteps.some((prior) => isEffectiveWriteStep(prior));
      })
      .map((criterion) => criterion.id);
    if (criterionIds.length === 0) return step;
    return {
      ...step,
      verification: {
        kind: "tool_success",
        systemAssigned: true,
        criterionIds,
      },
    };
  }

  private buildPartialAnswer(
    steps: AgentToolStep[],
    budgetExhausted: RunBudgetKey,
    goal: string,
  ): string {
    return this.options.finalizer.buildPartialAnswer({
      steps,
      budgetExhausted,
      budgetManager: this.options.budgetManager,
      mode: this.options.policy.mode,
      goal,
      location: buildLocationMeta(steps),
    });
  }
}
