import type { AgentNotification } from "../background/types.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ChatMessage } from "../model/types.js";
import { wrapExternalToolOutput } from "../util/injection.js";
import { renderNotifications } from "./AgentNotificationRenderer.js";
import type { PausedRunSnapshot } from "./PausedRunStore.js";
import type {
  AgentWorkflowDebugAnalysis,
  AgentWorkflowInternalPlan,
  AgentWorkflowProposal,
  AgentWorkflowRefactorPlan,
  AgentWorkflowSwitch,
  RunPolicy,
} from "./RunPolicyTypes.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { SessionTaskManager } from "./task/SessionTaskManager.js";
import type { AgentTimelineService } from "./timeline/AgentTimelineService.js";
import type { AgentToolStep } from "./toolStep.js";
import {
  renderWorkflowSwitchContext,
  resolveWorkflowSwitch,
  type WorkflowSessionSnapshot,
} from "./WorkflowSessionSwitch.js";
import type { WorkflowExecutionResult } from "./WorkflowExecutor.js";

export interface AgentRunSession {
  effectiveGoal: string;
  sessionId?: string;
  messages: ChatMessage[];
  steps: AgentToolStep[];
  modelTurns: number;
  consumedNotifications: AgentNotification[];
  injectNotifications: () => void;
  pausedRun?: PausedRunSnapshot;
  system?: string;
}

export interface AgentRunBootstrapInput {
  userMessage: string;
  system?: string;
  effectiveGoal: string;
  isResume: boolean;
  pausedRun?: PausedRunSnapshot;
  initialSessionId?: string;
  initialSteps: AgentToolStep[];
  initialModelTurns: number;
}

export interface AgentRunBootstrapContext {
  contextManager?: ContextManager;
  sessionTaskManager: SessionTaskManager;
  timeline?: AgentTimelineService;
  runId?: string;
  policy: RunPolicy;
  getEffectiveIntent: () => AgentIntentType;
  buildSystemPrompt: (extra?: string) => string;
  drainNotifications: () => AgentNotification[];
  runWorkflowExecutor: (
    goal: string,
    isResume: boolean,
    sessionId?: string,
  ) => Promise<WorkflowExecutionResult>;
  applyWorkflowResult: (result: WorkflowExecutionResult) => void;
  setWorkflowSwitch: (value: AgentWorkflowSwitch | undefined) => void;
  getWorkflowProposals: () => AgentWorkflowProposal[];
  onWorkflowStep?: (step: AgentToolStep) => void;
}

export interface AgentRunBootstrapResult {
  session: AgentRunSession;
}

/** Run 启动：会话、消息、工作流预扫描、暂停续跑 handoff 与 Timeline 分析步骤。 */
export async function bootstrapAgentRunSession(
  ctx: AgentRunBootstrapContext,
  input: AgentRunBootstrapInput,
): Promise<AgentRunBootstrapResult> {
  const contextManager = ctx.contextManager;
  const pausedRun = input.pausedRun;
  const isResume = input.isResume;
  let sessionId = input.initialSessionId;
  const steps = [...input.initialSteps];
  let modelTurns = input.initialModelTurns;
  const consumedNotifications: AgentNotification[] = [];
  let analysisStepId: string | undefined;

  if (!isResume && !pausedRun && ctx.timeline) {
    const runId = ctx.runId ?? ctx.timeline.getRun()?.id ?? "";
    const s = ctx.timeline.startStep({
      runId,
      type: "analysis",
      title: "正在分析任务",
      content: input.effectiveGoal.slice(0, 300),
    });
    analysisStepId = s.id;
  }
  if (contextManager && !sessionId) {
    sessionId = contextManager.createSession().id;
  }
  if (contextManager && sessionId && !isResume && !pausedRun) {
    contextManager.saveUserMessage(sessionId, input.userMessage, ctx.runId);
  }

  const messages: ChatMessage[] = pausedRun
    ? [...pausedRun.messages]
    : contextManager && sessionId
      ? contextManager.buildChatMessages(
          await contextManager.restoreContextPackage(sessionId, input.effectiveGoal),
          ctx.buildSystemPrompt(input.system),
          { phase: "pre_call", currentUser: isResume ? undefined : input.effectiveGoal },
        )
      : [
          { role: "system", content: ctx.buildSystemPrompt(input.system) },
          { role: "user", content: input.effectiveGoal },
        ];

  if (isResume) {
    messages.push({
      role: "system",
      content:
        "Ariadne runtime resume: continue from the saved RunState. This is not a user message.",
    });
  }

  const injectNotifications = () => {
    const notes = ctx.drainNotifications();
    if (notes.length === 0) return;
    consumedNotifications.push(...notes);
    const rendered = renderNotifications(notes);
    const wrapped = wrapExternalToolOutput("notification", rendered);
    messages.push({
      role: "system",
      content: typeof wrapped === "string" ? wrapped : JSON.stringify(wrapped),
    });
  };

  injectNotifications();

  if (!pausedRun && sessionId && !isResume && ctx.policy.intent && ctx.policy.workflowType) {
    const prevCtx = ctx.sessionTaskManager.getContext(sessionId);
    const previous: WorkflowSessionSnapshot | undefined = prevCtx
      ? {
          sessionId,
          intent: prevCtx.intent,
          workflowType: prevCtx.workflowType,
          updatedAt: prevCtx.updatedAt,
          runId: prevCtx.lastRunId,
        }
      : undefined;
    const workflowSwitch = resolveWorkflowSwitch({
      previous,
      current: {
        intent: ctx.getEffectiveIntent(),
        workflowType: ctx.policy.workflowType,
      },
    });
    ctx.setWorkflowSwitch(workflowSwitch);
    if (workflowSwitch?.switched) {
      messages.push({
        role: "system",
        content: renderWorkflowSwitchContext(workflowSwitch),
      });
    }
  }

  if (!pausedRun) {
    const workflowResult = await ctx.runWorkflowExecutor(input.effectiveGoal, isResume, sessionId);
    ctx.applyWorkflowResult(workflowResult);
    for (const step of workflowResult.steps) {
      steps.push(step);
      ctx.onWorkflowStep?.(step);
    }
    for (const modelContext of workflowResult.modelContexts) {
      messages.push({ role: "system", content: modelContext });
    }
  }

  if (ctx.timeline) {
    const tl = ctx.timeline;
    const runId = ctx.runId ?? tl.getRun()?.id ?? "";
    if (analysisStepId) {
      tl.completeStep(analysisStepId, "已识别任务目标，准备执行");
    }
    const proposals = ctx.getWorkflowProposals();
    if (proposals.length > 0) {
      const preview = proposals
        .map((p) => p.goal || p.permissionSummary)
        .filter(Boolean)
        .slice(0, 5)
        .join("；");
      const plan = tl.startStep({
        runId,
        type: "plan",
        title: "正在生成计划",
        content: preview || "工作流方案已就绪",
      });
      tl.completeStep(plan.id, "计划阶段完成");
    }
  }

  return {
    session: {
      effectiveGoal: input.effectiveGoal,
      sessionId,
      messages,
      steps,
      modelTurns,
      consumedNotifications,
      injectNotifications,
      pausedRun,
      system: input.system,
    },
  };
}

export type WorkflowArtifacts = {
  workflowProposals: AgentWorkflowProposal[];
  workflowDebugAnalyses: AgentWorkflowDebugAnalysis[];
  workflowRefactorPlans: AgentWorkflowRefactorPlan[];
  workflowInternalPlans: AgentWorkflowInternalPlan[];
};

export function workflowArtifactsFromResult(result: WorkflowExecutionResult): WorkflowArtifacts {
  return {
    workflowProposals: result.workflowProposals,
    workflowDebugAnalyses: result.workflowDebugAnalyses,
    workflowRefactorPlans: result.workflowRefactorPlans,
    workflowInternalPlans: result.workflowInternalPlans,
  };
}
