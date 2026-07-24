import type { ToolPermission } from "../core/permissions.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { NetworkPolicy } from "../policy/NetworkPolicy.js";
import type { ShellPolicy } from "../policy/ShellPolicy.js";
import type { ToolPathPreparation } from "../policy/PathPolicy.js";
import type { ScopedApprovedPermissions } from "../policy/permissionRequestTypes.js";
import type { WorkspaceGrantStore, WorkspaceScopePermission } from "../policy/WorkspaceScopeManager.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolOutcome } from "../tools/toolOutcome.js";
import { resolveToolOutcome } from "../tools/toolOutcome.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import { buildToolResultLayers } from "../util/toolResultLayers.js";
import type { ToolAction } from "./AgentActionParser.js";
import { AgentToolActivityTracker } from "./AgentToolActivityTracker.js";
import type { BudgetManager } from "./BudgetManager.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { FailedActionMemory } from "./recovery/FailedActionMemory.js";
import { applyOutcomeToStep, traceStatusForOutcome } from "./recovery/renderToolOutcome.js";
import type { RunToolResultCache } from "./recovery/RunToolResultCache.js";
import type { AgentRunMode, UserPermissionPolicy } from "./RunPolicyTypes.js";
import {
  assessSubagentDispatchGuard,
  assessSubagentSideEffectGuard,
} from "./SubagentDispatchGuard.js";
import type { AgentTimelineService } from "./timeline/AgentTimelineService.js";
import type { AgentToolStep } from "./toolStep.js";
import {
  ToolExecutionGateway,
  type ToolExecutionEvaluation,
} from "./ToolExecutionGateway.js";
import {
  buildBudgetBlockedToolStep,
  buildPermissionBlockedToolStep,
  buildWorkflowBlockedToolStep,
} from "./AgentToolStepBlockBuilder.js";
import type { WorkflowRouteResult } from "./WorkflowRouter.js";
import type { WorkflowWriteOrchestratorResult } from "./workflowWriteOrchestrator.js";

export interface AgentToolActionRunContext {
  registry: ToolRegistry;
  toolGateway: ToolExecutionGateway;
  timeline?: AgentTimelineService;
  runId?: string;
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  requestId?: string;
  trace?: TraceLogger;
  workspaceRoot: string;
  processSandbox?: ProcessSandbox;
  workspaceGrantStore?: WorkspaceGrantStore;
  workspaceConfigScopes?: Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;
  signal?: AbortSignal;
  sensitive?: boolean;
  subAgentDispatchDepth?: number;
  maxSubAgentDispatchDepth?: number;
  projectAllowedPermissions?: ToolPermission[];
  subAgentCostBudgetUsd?: number;
  contextManager?: ContextManager;
  allowedPermissions: ToolPermission[];
  runGrantedPermissions?: readonly ToolPermission[];
  permissionPolicy: UserPermissionPolicy;
  mode: AgentRunMode;
  reconciledWorkflowType?: AgentWorkflowType;
  policyWorkflowType: AgentWorkflowType;
  getIntent: () => AgentIntentType;
  shellPolicy?: ShellPolicy;
  networkPolicy?: NetworkPolicy;
  isToolExposed: (toolName: string) => boolean;
  resolveScopedGrants: () => ScopedApprovedPermissions | undefined;
  resolveConfirmedScopedGrants: () => ScopedApprovedPermissions | undefined;
  failedActionMemory: FailedActionMemory;
  toolResultCache: RunToolResultCache;
  budgetManager: BudgetManager;
  buildPathBlockedStep: (
    action: ToolAction,
    iteration: number,
    pathAccess: ToolPathPreparation,
    toolCallId?: string,
  ) => AgentToolStep;
  workflowWriteOrchestration: (input: {
    tool: string;
    steps: AgentToolStep[];
    goal: string;
  }) => WorkflowWriteOrchestratorResult;
}

export interface RunAgentToolActionInput {
  action: ToolAction;
  iteration: number;
  toolCallId: string;
  steps: AgentToolStep[];
  goal: string;
  workflowRoute: Pick<
    WorkflowRouteResult,
    "workflowKind" | "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind"
  >;
  userConfirmed?: boolean;
  isRecovery?: boolean;
  isPreflight?: boolean;
}

export interface AgentToolActionRunResult {
  step: AgentToolStep;
  workflowWrite?: WorkflowWriteOrchestratorResult;
}

function buildCachedToolStep(
  ctx: AgentToolActionRunContext,
  base: AgentToolStep,
  tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
  cachedOutput: unknown,
): AgentToolStep {
  const layers = buildToolResultLayers(base.tool, cachedOutput, {
    compact: ctx.contextManager
      ? (t, out) => ctx.contextManager!.compactToolOutput(t, out)
      : undefined,
  });
  const outcome = resolveToolOutcome(base.tool, cachedOutput);
  ctx.budgetManager.recordCacheHit();
  return applyOutcomeToStep(
    base,
    outcome,
    {
      executed: false,
      cached: true,
      output: layers.modelVisible,
      resultLayers: layers,
      toolCallId: base.toolCallId,
    },
  );
}

function recordPathAccessAudit(
  ctx: AgentToolActionRunContext,
  input: {
    action: ToolAction;
    toolCallId: string;
    pathAccess: ToolPathPreparation;
  },
): void {
  ctx.trace?.write({
    type: "path_access_decision",
    tool: input.action.tool,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    toolCallId: input.toolCallId,
    allowed: input.pathAccess.decision.allowed,
    needsConfirmation: input.pathAccess.decision.needsConfirmation,
    reason: input.pathAccess.decision.reason,
    operation: input.pathAccess.decision.requiredPermission,
    normalizedPath: input.pathAccess.decision.normalizedPath,
    matchedRoot: input.pathAccess.audit.matchedRoot,
    crossWorkspace: input.pathAccess.audit.crossWorkspace,
    permissionSource: input.pathAccess.audit.permissionSource,
    pathRisk: input.pathAccess.audit.pathRisk,
    workspaceScopeId: input.pathAccess.audit.workspaceScopeId,
    grantId: input.pathAccess.audit.grantId,
  });
  ctx.workspaceGrantStore?.recordAccess({
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    toolCallId: input.toolCallId,
    toolName: input.action.tool,
    operation: input.pathAccess.decision.requiredPermission,
    normalizedPath: input.pathAccess.decision.normalizedPath,
    matchedRoot: input.pathAccess.audit.matchedRoot,
    workspaceScopeId: input.pathAccess.audit.workspaceScopeId,
    grantId: input.pathAccess.audit.grantId,
    permissionSource: input.pathAccess.audit.permissionSource,
    decision: input.pathAccess.decision.allowed
      ? "allowed"
      : input.pathAccess.decision.needsConfirmation
        ? "needs_confirmation"
        : "denied",
    reason: input.pathAccess.decision.reason,
    crossWorkspace: input.pathAccess.audit.crossWorkspace,
    pathRisk: input.pathAccess.audit.pathRisk,
    pathRiskTier: input.pathAccess.audit.pathRiskTier,
  });
}

function buildAuthorizationBlockedStep(
  ctx: AgentToolActionRunContext,
  input: RunAgentToolActionInput,
  toolPermission: ToolPermission,
  evaluation: ToolExecutionEvaluation,
): AgentToolStep {
  const { action, iteration, toolCallId } = input;
  if (evaluation.workflowBlock) {
    return buildWorkflowBlockedToolStep({
      action,
      iteration,
      toolCallId,
      toolPermission,
      block: evaluation.workflowBlock,
    });
  }
  if (evaluation.pathAccess && !evaluation.pathAccess.decision.allowed) {
    return ctx.buildPathBlockedStep(action, iteration, evaluation.pathAccess, toolCallId);
  }

  const permissionDecision = evaluation.permissionDecision;
  const step = buildPermissionBlockedToolStep({
    action,
    iteration,
    toolCallId,
    toolPermission,
    reason: evaluation.reason ?? "权限拒绝",
  });
  if (!permissionDecision) {
    return {
      ...step,
      blockedReasonKind: evaluation.blockReasonKind ?? "policy",
      outcomeKind:
        evaluation.blockReasonKind === "policy" ? "policy_blocked" : step.outcomeKind,
    };
  }
  return {
    ...step,
    outcomeKind:
      permissionDecision.decision === "needsConfirmation"
        ? "permission_required"
        : "permission_denied",
    risk: permissionDecision.risk,
    confirmationRequest: permissionDecision.confirmationRequest,
  };
}

/** Agent 主循环工具实际执行：Timeline、PathPolicy 审计/拦截、缓存、子 Agent 门控、write gate、PermissionGuard、registry 调用。 */
export async function runAgentToolAction(
  ctx: AgentToolActionRunContext,
  input: RunAgentToolActionInput,
): Promise<AgentToolActionRunResult> {
  const { action, iteration, toolCallId } = input;
  const base: AgentToolStep = {
    iteration,
    toolCallId,
    tool: action.tool,
    input: action.input ?? {},
    thought: action.thought,
    ok: false,
  };

  const tool = ctx.registry.get(action.tool);
  const activityRunId = ctx.runId ?? ctx.timeline?.getRun()?.id ?? "";
  const activity = new AgentToolActivityTracker(ctx.timeline, activityRunId);
  const inputRecord = (action.input ?? {}) as Record<string, unknown>;

  if (!tool) {
    activity.startTool({ tool: action.tool, toolInput: inputRecord, iteration, toolCallId });
    activity.fail(`未知工具：${action.tool}`);
    return { step: { ...base, error: `未知工具：${action.tool}` } };
  }

  const toolPermission = ctx.registry.resolvePrimaryPermission(action.tool, inputRecord) ?? tool.permissions[0];

  activity.startTool({ tool: action.tool, toolInput: inputRecord, iteration, toolCallId });
  if (!ctx.isToolExposed(action.tool)) {
    const err = `工具「${action.tool}」仅主 Agent 可用，当前上下文不可调用。`;
    activity.fail(err);
    return { step: { ...base, permission: toolPermission, error: err } };
  }

  const withPermission = { ...base, permission: toolPermission };
  const subagentDispatchGuard = assessSubagentDispatchGuard(action, input.steps);
  if (subagentDispatchGuard) {
    activity.fail(subagentDispatchGuard);
    return { step: { ...withPermission, blocked: true, error: subagentDispatchGuard } };
  }

  const subagentSideEffectGuard = assessSubagentSideEffectGuard({
    action,
    allowedPermissions: ctx.allowedPermissions,
    runGrantedPermissions: ctx.runGrantedPermissions,
  });
  if (subagentSideEffectGuard) {
    activity.fail(subagentSideEffectGuard);
    return { step: { ...withPermission, blocked: true, error: subagentSideEffectGuard } };
  }

  const writeOrchestration = ctx.workflowWriteOrchestration({
    tool: action.tool,
    steps: input.steps,
    goal: input.goal,
  });
  if (writeOrchestration.writePhaseBlocked) {
    const reason = writeOrchestration.blockedReason ?? "workflow write gate blocked";
    activity.fail(reason);
    return {
      step: {
        ...withPermission,
        blocked: true,
        workflowPhaseBlocked: true,
        error: reason,
      },
      workflowWrite: writeOrchestration,
    };
  }

  const authorization = ctx.toolGateway.authorize({
    toolName: action.tool,
    input: inputRecord,
    source: input.userConfirmed ? "resume" : "agent_loop",
    budgetBucket: input.isRecovery ? "recovery" : input.isPreflight ? "preflight" : "main",
    workspaceRoot: ctx.workspaceRoot,
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    requestId: ctx.requestId ?? ctx.runId,
    toolCallId,
    signal: ctx.signal,
    allowedPermissions: ctx.allowedPermissions,
    runGrantedPermissions: ctx.runGrantedPermissions,
    intent: ctx.getIntent(),
    permissionPolicy: ctx.permissionPolicy,
    mode: ctx.mode,
    workflowRoute: input.workflowRoute,
    scopedGrants: ctx.resolveScopedGrants(),
    confirmedScopedGrants: input.userConfirmed
      ? ctx.resolveConfirmedScopedGrants()
      : undefined,
    workspaceGrantStore: ctx.workspaceGrantStore,
    workspaceConfigScopes: ctx.workspaceConfigScopes,
    budgetManager: ctx.budgetManager,
    existingSteps: input.steps,
    isRecovery: input.isRecovery,
    isPreflight: input.isPreflight,
    shellPolicy: ctx.shellPolicy,
    networkPolicy: ctx.networkPolicy,
    registryExtras: {
      processSandbox: ctx.processSandbox,
      sensitive: ctx.sensitive,
      subAgentDispatchDepth: ctx.subAgentDispatchDepth ?? 0,
      maxSubAgentDispatchDepth: ctx.maxSubAgentDispatchDepth ?? 1,
      projectAllowedPermissions: ctx.projectAllowedPermissions,
      parentAgentIntent: ctx.getIntent(),
      parentAgentWorkflowType: ctx.reconciledWorkflowType ?? ctx.policyWorkflowType,
      subAgentCostBudgetUsd: ctx.subAgentCostBudgetUsd,
    },
  });

  const pathAccess = authorization.pathAccess;
  if (pathAccess) {
    recordPathAccessAudit(ctx, { action, toolCallId, pathAccess });
  }

  if (authorization.blocked) {
    const step = buildAuthorizationBlockedStep(ctx, input, toolPermission, authorization);
    activity.fail(step.error ?? "工具执行授权被拒绝", {
      outcomeKind: step.outcomeKind,
      workspaceAccess: pathAccess?.audit,
    });
    return { step, workflowWrite: writeOrchestration };
  }

  const cacheInputRecord = pathAccess?.grantVersionKey
    ? { ...inputRecord, _workspaceGrantVersion: pathAccess.grantVersionKey }
    : inputRecord;
  if (!input.isRecovery) {
    const cached = ctx.toolResultCache.lookup(action.tool, cacheInputRecord);
    if (cached) {
      activity.ok("复用本 run 缓存结果");
      return {
        step: buildCachedToolStep(ctx, withPermission, tool, cached.entry.output),
        workflowWrite: writeOrchestration,
      };
    }
  }

  const executionDecision = ctx.toolGateway.applyBudget(authorization);
  if (executionDecision.blocked) {
    const budgetExhausted = executionDecision.budgetExhausted;
    const step = budgetExhausted
      ? buildBudgetBlockedToolStep({
          action,
          iteration,
          toolCallId,
          toolPermission,
          budgetExhausted,
        })
      : buildPermissionBlockedToolStep({
          action,
          iteration,
          toolCallId,
          toolPermission,
          reason: executionDecision.reason ?? "工具执行许可生成失败",
        });
    activity.fail(step.error ?? "工具执行被阻止", { outcomeKind: step.outcomeKind });
    return { step, workflowWrite: writeOrchestration };
  }

  const failedActionAssessment = ctx.failedActionMemory.assess(action);
  if (failedActionAssessment) {
    activity.fail(failedActionAssessment.reason);
    const blockedStep: AgentToolStep = {
      ...withPermission,
      blocked: true,
      executed: false,
      recoveryCircuitOpen: failedActionAssessment.circuitOpen,
      error: failedActionAssessment.reason,
    };
    ctx.failedActionMemory.record(blockedStep);
    return { step: blockedStep, workflowWrite: writeOrchestration };
  }

  ctx.trace?.write({
    type: "agent_tool",
    tool: action.tool,
    iteration,
    toolCallId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    workspaceAccess: pathAccess?.audit,
  });

  const result = await ctx.toolGateway.execute(executionDecision);

  if (result.executed) {
    const layers = buildToolResultLayers(action.tool, result.output, {
      compact: ctx.contextManager
        ? (t, out) => ctx.contextManager!.compactToolOutput(t, out)
        : undefined,
    });
    const outcome: ToolOutcome = {
      class: result.outcomeClass,
      kind: result.outcomeKind as ToolOutcome["kind"],
      message: result.message,
      recoverable: result.recoverable,
      path: result.outcomePath,
      command: result.outcomeCommand,
      exitCode: result.outcomeExitCode,
      suggestedNextActions: result.suggestedNextActions,
    };
    ctx.trace?.write({
      type: "agent_tool",
      tool: action.tool,
      iteration,
      toolCallId,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
      status: traceStatusForOutcome(result.outcomeClass),
      outcomeClass: result.outcomeClass,
      outcomeKind: result.outcomeKind,
      rawJsonLength: layers.rawJsonLength,
      modelJsonLength: layers.modelJsonLength,
      userDisplay: layers.userDisplay,
      rawOutput: layers.raw,
      workspaceAccess: pathAccess?.audit,
    });
    const rawPath = action.input?.path;
    const path = typeof rawPath === "string" ? rawPath : undefined;
    const summary = layers.userDisplay.summary.slice(0, 200) || result.message;
    if (result.outcomeClass === "observation_failure") {
      activity.observe(summary, {
        durationMs: result.durationMs,
        outcomeKind: result.outcomeKind,
        exitCode: result.outcomeExitCode,
        command: result.outcomeCommand,
        workspaceAccess: pathAccess?.audit,
      });
    } else if (result.outcomeClass === "execution_error") {
      activity.fail(summary, {
        durationMs: result.durationMs,
        outcomeKind: result.outcomeKind,
        workspaceAccess: pathAccess?.audit,
      });
    } else {
      activity.ok(summary, {
        durationMs: result.durationMs,
        changedFiles: path ? [path] : undefined,
        workspaceAccess: pathAccess?.audit,
      });
    }
    const step = applyOutcomeToStep(withPermission, outcome, {
      executed: true,
      output: layers.modelVisible,
      resultLayers: layers,
      durationMs: result.durationMs,
      toolCallId: result.toolCallId,
      risk: result.risk,
      workspaceAccess: pathAccess?.audit,
    });
    if (
      !input.isRecovery &&
      result.outcomeClass === "observation_success" &&
      result.output !== undefined
    ) {
      ctx.toolResultCache.store(action.tool, cacheInputRecord, result.output);
    }
    ctx.failedActionMemory.record(step);
    return { step, workflowWrite: writeOrchestration };
  }

  const errMsg = result.error ?? result.message;
  activity.fail(errMsg, { durationMs: result.durationMs, outcomeKind: result.outcomeKind });
  const failedStep = applyOutcomeToStep(
    withPermission,
    {
      class: "execution_error",
      kind: result.outcomeKind as ToolOutcome["kind"],
      message: errMsg,
      recoverable: false,
    },
    {
      executed: false,
      durationMs: result.durationMs,
      toolCallId: result.toolCallId,
      risk: result.risk,
      workspaceAccess: pathAccess?.audit,
    },
  );
  ctx.failedActionMemory.record(failedStep);
  return { step: failedStep, workflowWrite: writeOrchestration };
}
