import type { AgentNotification } from "../background/types.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ProjectIndex } from "../context/ProjectIndex.js";
import type { AgentPromptStrategySummary, AgentRouterDecisionSummary } from "../model-router/agent-routing-summary.js";
import type { AgentStepPlan } from "../plan/types.js";
import type { PermissionRequestPayload } from "../policy/permissionRequestTypes.js";
import type { PlanHandoffPayload } from "../policy/planHandoffTypes.js";
import type {
  AgentPlanContract,
  AgentPlanExecutionReport,
} from "../plan/AgentPlanContract.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { RunStateStore } from "../orchestrator/RunStateStore.js";
import {
  buildRunStateFromAgentRun,
  type RunState,
} from "../orchestrator/runStateTypes.js";
import { finalizeAgentActivityTimeline } from "./AgentActivityTimelineFinalizer.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { BudgetManager } from "./BudgetManager.js";
import type { CompletionGuardResult } from "./completion/CompletionFinalGuard.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { AgentExecutionMeta, AgentStopReason, RunBudget, RunBudgetKey, RunPolicy } from "./RunPolicyTypes.js";
import { extractSideEffectSummary } from "./sideEffectFromSteps.js";
import type { SessionTaskManager } from "./task/SessionTaskManager.js";
import type { AgentTimelineService } from "./timeline/AgentTimelineService.js";
import type { AgentToolStep } from "./toolStep.js";
import { isFailedToolStep, stepPlanTraceStatus } from "./toolStepOutcome.js";

export interface AgentRunFinalizeInput {
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
}

export interface AgentRunFinalizeContext {
  isResume: boolean;
  runId?: string;
  taskId?: string;
  policy: RunPolicy;
  entryIntent?: AgentIntentType;
  entryWorkflowType?: AgentWorkflowType;
  reconciledIntent?: AgentIntentType;
  reconciledWorkflowType?: AgentWorkflowType;
  getEffectiveIntent: () => AgentIntentType;
  capabilityEscalations: CapabilityEscalationRecord[];
  budgetManager: BudgetManager;
  budget: RunBudget;
  timeline?: AgentTimelineService;
  contextManager?: ContextManager;
  sessionTaskManager: SessionTaskManager;
  runStateStore?: RunStateStore;
  resumeState?: RunState;
  projectIndex?: ProjectIndex;
  workspaceRoot: string;
  runRoutingMeta?: {
    routerDecision?: AgentRouterDecisionSummary;
    promptStrategy?: AgentPromptStrategySummary;
  };
  trace?: TraceLogger;
  buildExecutionMeta: (input: {
    steps: AgentToolStep[];
    iterations: number;
    stopReason: AgentStopReason;
    budgetExhausted?: RunBudgetKey;
    goal: string;
    completionGuard?: CompletionGuardResult;
    partialSummary?: string;
  }) => AgentExecutionMeta;
  writeRunUsageSummary: (steps: AgentToolStep[], executionMeta: AgentExecutionMeta) => void;
}

export interface AgentRunFinalizeResult {
  answer: string;
  steps: AgentToolStep[];
  iterations: number;
  reachedLimit: boolean;
  awaitingPermission?: boolean;
  awaitingPlanHandoff?: boolean;
  permissionRequest?: PermissionRequestPayload;
  planHandoff?: PlanHandoffPayload;
  agentPlan?: AgentPlanContract;
  agentPlanExecutionReport?: AgentPlanExecutionReport;
  executionMeta: AgentExecutionMeta;
  routerDecision?: AgentRouterDecisionSummary;
  promptStrategy?: AgentPromptStrategySummary;
  notifications?: AgentNotification[];
  sessionId?: string;
  compressed?: boolean;
}

/** Run 收尾：上下文压缩、executionMeta、SessionTask、RunState、Timeline 与 API 响应组装。 */
export async function finalizeAgentRun(
  ctx: AgentRunFinalizeContext,
  input: AgentRunFinalizeInput,
): Promise<AgentRunFinalizeResult> {
  writeAgentStepPlanTrace(ctx, input.steps);
  let compressed = false;
  if (ctx.contextManager && input.sessionId) {
    let compressionActivityId: string | undefined;
    const result = await ctx.contextManager.finalizeTurn(
      input.sessionId,
      input.userMessage,
      {
        onStarted: (snapshot) => {
          compressionActivityId = ctx.timeline?.startSystemActivity({
            kind: "context_compaction",
            title: "正在自动压缩上下文",
            summaryType: "chunk_summary",
            beforeChars: snapshot.pendingChars,
          }).id;
        },
        onCompleted: ({ before, after, summary }) => {
          if (!compressionActivityId) return;
          ctx.timeline?.completeSystemActivity(compressionActivityId, {
            summary: "已自动压缩上下文",
            processedMessages: Math.max(0, before.pendingMessages - after.pendingMessages),
            beforeChars: before.pendingChars,
            afterChars: after.pendingChars,
            summaryType: summary.summaryType,
          });
        },
        onFailed: (error) => {
          if (!compressionActivityId) return;
          ctx.timeline?.failSystemActivity(
            compressionActivityId,
            error instanceof Error ? error.message : String(error),
          );
        },
      },
    );
    compressed = result.compressed !== null;
  }

  const guard = input.completionGuard;
  const stopReason =
    guard?.stopReason ??
    input.stopReason ??
    (input.reachedLimit ? "budget_exhausted" : "completed");
  const answer = input.answer;
  const executionMeta = ctx.buildExecutionMeta({
    steps: input.steps,
    iterations: input.iterations,
    stopReason,
    budgetExhausted: input.budgetExhausted,
    goal: input.userMessage,
    completionGuard: guard,
    partialSummary: input.partialSummary,
  });
  executionMeta.planVariant = ctx.policy.planVariant;
  ctx.writeRunUsageSummary(input.steps, executionMeta);

  const permissionRequest = input.permissionRequest;
  const planHandoff = input.planHandoff;
  const agentPlan = input.agentPlan;
  const agentPlanExecutionReport = input.agentPlanExecutionReport;
  const awaitingPermission = input.awaitingPermission === true;
  const awaitingPlanHandoff = input.awaitingPlanHandoff === true;

  if (input.sessionId && !ctx.isResume && ctx.policy.intent && ctx.policy.workflowType) {
    ctx.sessionTaskManager.updateFromRun({
      sessionId: input.sessionId,
      taskId: ctx.taskId,
      goal: input.userMessage,
      intent: ctx.getEffectiveIntent(),
      workflowType: ctx.reconciledWorkflowType ?? ctx.policy.workflowType,
      entryIntent: ctx.entryIntent ?? ctx.policy.intent,
      entryWorkflowType: ctx.entryWorkflowType ?? ctx.policy.workflowType,
      reconciledIntent: ctx.reconciledIntent,
      reconciledWorkflowType: ctx.reconciledWorkflowType,
      runId: ctx.runId,
      stopReason,
      completionStatus: guard?.status,
      sideEffectsMet: guard ? guard.status === "completed_success" : undefined,
      sideEffectSummary: extractSideEffectSummary(input.steps),
      workflowTaskState: executionMeta.workflowTaskState,
      failed:
        stopReason === "error" ||
        executionMeta.workflowTaskState === "failed" ||
        input.steps.some((step) => isFailedToolStep(step)),
      failureSummary:
        input.steps.find((step) => isFailedToolStep(step))?.error ??
        input.steps.find((step) => isFailedToolStep(step))?.outcomeMessage,
      relatedFiles: executionMeta.location?.locatedFiles,
    });
  }

  if (ctx.runStateStore && ctx.runId) {
    const cancelled = input.stopReason === "user_cancelled";
    if (input.reachedLimit) {
      const state = buildRunStateFromAgentRun({
        runId: ctx.runId,
        goal: input.userMessage,
        mode: ctx.policy.mode,
        sessionId: input.sessionId,
        taskId: ctx.taskId,
        steps: input.steps,
        executionMeta,
        priorState: ctx.resumeState,
        projectIndexStats: ctx.projectIndex
          ? (() => {
              const stats = ctx.projectIndex!.getStats("default", ctx.workspaceRoot);
              return { fileCount: stats.fileCount, symbolCount: stats.symbolCount };
            })()
          : undefined,
      });
      if (state) ctx.runStateStore.save(state);
    } else if (!cancelled) {
      ctx.runStateStore.markCompleted(ctx.runId);
    }
  }

  finalizeAgentActivityTimeline({
    timeline: ctx.timeline,
    runId: ctx.runId,
    answer,
    reachedLimit: input.reachedLimit,
    budgetExhausted: input.budgetExhausted,
    stopReason,
    completionGuard: guard,
    partialSummary: input.partialSummary,
    budgetLedger: ctx.budgetManager.ledgerSnapshot(),
    maxRecoveryTurns: ctx.budget.maxRecoveryTurns,
  });

  return {
    answer,
    steps: input.steps,
    iterations: input.iterations,
    reachedLimit: input.reachedLimit,
    awaitingPermission,
    awaitingPlanHandoff,
    permissionRequest,
    planHandoff,
    agentPlan,
    agentPlanExecutionReport,
    executionMeta,
    routerDecision: ctx.runRoutingMeta?.routerDecision,
    promptStrategy: ctx.runRoutingMeta?.promptStrategy,
    notifications: input.consumedNotifications.length ? input.consumedNotifications : undefined,
    sessionId: input.sessionId,
    compressed: compressed || undefined,
  };
}

function writeAgentStepPlanTrace(ctx: AgentRunFinalizeContext, steps: AgentToolStep[]): void {
  if (!ctx.trace || !ctx.runId) return;
  const plan: AgentStepPlan = {
    runId: ctx.runId,
    mode: ctx.policy.mode === "implement" ? "execute" : ctx.policy.mode,
    ephemeral: true,
    createdAt: new Date().toISOString(),
    steps: steps.map((step, index) => ({
      id: step.iteration > 0 ? `iteration-${step.iteration}` : `workflow-${index + 1}`,
      intent: step.tool,
      tool: step.tool,
      reason: step.thought ?? `模型请求调用 ${step.tool}`,
      status: stepPlanTraceStatus(step),
    })),
  };
  ctx.trace.write({
    type: "agent_step_plan",
    runId: plan.runId,
    mode: plan.mode,
    ephemeral: true,
    stepCount: plan.steps.length,
    steps: plan.steps,
    createdAt: plan.createdAt,
  });
}
