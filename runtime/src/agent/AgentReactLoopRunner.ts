import type { AgentNotification } from "../background/types.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { ChatMessage } from "../model/types.js";
import type { AgentRoutingMeta } from "../model-router/agent-routing-summary.js";
import type { LoopChatFn, LoopChatResponse } from "../model-router/agent-chat-types.js";
import { assertWithinCostBudget, sumModelTurnCost } from "../util/costBudget.js";
import { redactPreview } from "../util/redact.js";
import {
  parseAgentModelAction,
  sanitizeAgentAction,
  stripModelNoise,
  type FinalAction,
  type ToolAction,
} from "./AgentActionParser.js";
import { AgentProtocolError } from "./AgentProtocolError.js";
import type { AgentRunSession } from "./AgentRunBootstrap.js";
import type { AgentRunFinalizeInput, AgentRunFinalizeResult } from "./AgentRunFinalizer.js";
import type { AgentModelTurnEvent } from "./AgentModelTurn.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { BudgetManager } from "./BudgetManager.js";
import { evaluateCompletionGuard } from "./completion/CompletionFinalGuard.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { PausedRunSnapshot } from "./PausedRunStore.js";
import type { PlanHandoffPayload } from "../policy/planHandoffTypes.js";
import type { RunBudgetKey, RunPolicy } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import type { CompletionCriterionInput } from "./completion/TaskCompletionContract.js";
import type {
  AgentToolContinuationInput,
  AgentToolContinuationResult,
} from "./AgentToolExecutionCoordinator.js";

export type AgentToolStepExecResult =
  | { kind: "step"; step: AgentToolStep }
  | { kind: "pause" | "budget"; result: AgentRunFinalizeResult };

export interface AgentReactLoopContext {
  chat: LoopChatFn;
  signal?: AbortSignal;
  sensitive?: boolean;
  taskType?: ModelTaskType;
  maxCostUsdPerRun?: number;
  maxModelTurns: number;
  budgetManager: BudgetManager;
  contextManager?: ContextManager;
  runId?: string;
  policy: RunPolicy;
  pausedRun?: PausedRunSnapshot;
  capabilityEscalations: CapabilityEscalationRecord[];
  completionCriteria: CompletionCriterionInput[];
  getEffectiveIntent: () => AgentIntentType;
  getReconciledIntent: () => AgentIntentType | undefined;
  getModelTurnMetrics: () => Array<{
    costUsd?: number;
  }>;
  recordModelTurn: (metric: {
    iteration: number;
    success: boolean;
    client?: string;
    model?: string;
    location?: string;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    error?: string;
  }) => void;
  setRunRoutingMeta: (meta: AgentRoutingMeta) => void;
  getRunRoutingMeta: () => AgentRoutingMeta | undefined;
  onModelTurn?: (event: AgentModelTurnEvent) => void;
  onStep?: (step: AgentToolStep) => void;
  onToken?: (token: string) => void;
  assertNotCancelled: () => void;
  isCancelledError: (err: unknown) => boolean;
  makeToolCallId: (iteration: number, tool: string) => string;
  writeAgentDecisionTrace: (event: {
    iteration: number;
    action: "tool" | "final" | "parse_error" | "final_guard_rejected";
    tool?: string;
    toolCallId?: string;
    thought?: string;
    inputPreview?: string;
    rawPreview?: string;
    answerLength?: number;
    completionStatus?: string;
  }) => void;
  createPlanHandoff: (input: {
    sessionId?: string;
    goal: string;
    system?: string;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    modelTurns: number;
    planMarkdown: string;
  }) => PlanHandoffPayload | null;
  executeToolStep: (input: {
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
  }) => Promise<AgentToolStepExecResult>;
  continueAfterToolStep: (
    input: AgentToolContinuationInput,
  ) => Promise<AgentToolContinuationResult>;
  buildPartialAnswer: (
    steps: AgentToolStep[],
    budgetExhausted: RunBudgetKey,
    goal: string,
  ) => string;
  finishRun: (input: AgentRunFinalizeInput) => Promise<AgentRunFinalizeResult>;
}

/** ReAct 主循环：模型轮次 → parseAction → final/planHandoff/guard 或工具执行与后处理。 */
export async function runAgentReactLoop(
  ctx: AgentReactLoopContext,
  session: AgentRunSession,
): Promise<AgentRunFinalizeResult> {
  const {
    effectiveGoal,
    sessionId,
    pausedRun,
    system,
    injectNotifications,
    consumedNotifications,
  } = session;
  const messages = session.messages;
  const steps = session.steps;
  let modelTurns = session.modelTurns;
  const contextManager = ctx.contextManager;

  while (modelTurns < ctx.maxModelTurns) {
    ctx.assertNotCancelled();
    const runtimeExhausted = ctx.budgetManager.findRuntimeExhaustion();
    if (runtimeExhausted) {
      return await ctx.finishRun({
        answer: "",
        partialSummary: ctx.buildPartialAnswer(steps, runtimeExhausted, effectiveGoal),
        steps,
        iterations: modelTurns,
        reachedLimit: true,
        budgetExhausted: runtimeExhausted,
        consumedNotifications,
        sessionId,
        userMessage: effectiveGoal,
      });
    }

    const iteration = modelTurns + 1;
    modelTurns = iteration;
    ctx.onModelTurn?.({ iteration, phase: "started" });
    const modelStart = Date.now();
    let response: LoopChatResponse;
    // Agent 输出是可执行协议，不是普通聊天文本。厂商原始 token 只能表明
    // 发生过流式输出；整条动作校验后才发布规范化 AgentAction。
    let receivedStreamToken = false;
    try {
      assertWithinCostBudget(
        sumModelTurnCost(ctx.getModelTurnMetrics().map((m) => m.costUsd)),
        ctx.maxCostUsdPerRun,
      );
      response = await ctx.chat(
        {
          messages,
          temperature: 0.2,
          onToken: ctx.onToken ? () => {
            receivedStreamToken = true;
          } : undefined,
          signal: ctx.signal,
        },
        {
          sensitive: ctx.sensitive,
          taskType: ctx.taskType,
          spentCostUsd: sumModelTurnCost(ctx.getModelTurnMetrics().map((m) => m.costUsd)),
          maxCostUsd: ctx.maxCostUsdPerRun,
        },
      );
    } catch (error) {
      if (ctx.isCancelledError(error)) throw error;
      ctx.recordModelTurn({
        iteration,
        success: false,
        latencyMs: Date.now() - modelStart,
        error: String(error),
      });
      throw error;
    }
    if (!ctx.getRunRoutingMeta() && response.routingMeta) {
      ctx.setRunRoutingMeta(response.routingMeta);
    }
    const recordResponseTurn = (success: boolean, error?: string) => {
      ctx.recordModelTurn({
        iteration,
        success,
        client: response.clientName,
        model: response.modelName,
        location: response.location,
        latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        costUsd: response.costUsd,
        error,
      });
    };
    try {
      assertWithinCostBudget(
        sumModelTurnCost([
          ...ctx.getModelTurnMetrics().map((m) => m.costUsd),
          response.costUsd,
        ]),
        ctx.maxCostUsdPerRun,
      );
    } catch (error) {
      recordResponseTurn(false, String(error));
      throw error;
    }
    const parsedAction = parseAgentModelAction(response.content, response.toolCalls);
    if (!parsedAction) {
      const tracePreview = stripModelNoise(response.content);
      recordResponseTurn(false, "MODEL_PROTOCOL_ERROR");
      ctx.onModelTurn?.({
        iteration,
        phase: "parse_error",
        contentPreview: "模型响应未通过 AgentAction 协议校验",
        clientName: response.clientName,
        modelName: response.modelName,
        latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
      });
      ctx.writeAgentDecisionTrace({
        iteration,
        action: "parse_error",
        rawPreview: tracePreview ? redactPreview(tracePreview, 300) : undefined,
      });
      throw new AgentProtocolError({
        clientName: response.clientName,
        modelName: response.modelName,
      });
    }
    const action = sanitizeAgentAction(parsedAction);
    const actionContent = JSON.stringify(action);
    const toolCalls = action.action === "final"
      ? []
      : action.action === "tools"
        ? action.tools.map((call, index) => ({
            action: {
              action: "tool" as const,
              id: call.id,
              tool: call.tool,
              input: call.input,
              thought: call.thought ?? action.thought,
            },
            toolCallId: call.id?.trim() || ctx.makeToolCallId(iteration, `${call.tool}-${index + 1}`),
          }))
        : [{
            action,
            toolCallId: action.id?.trim() || ctx.makeToolCallId(iteration, action.tool),
          }];
    const protocolToolCalls = toolCalls.map((call) => ({
      id: call.toolCallId,
      name: call.action.tool,
      arguments: call.action.input ?? {},
    }));
    recordResponseTurn(true);
    messages.push({
      role: "assistant",
      content: actionContent,
      toolCalls: protocolToolCalls.length > 0 ? protocolToolCalls : undefined,
      ...(response.reasoningContent
        ? { reasoningContent: response.reasoningContent }
        : {}),
    });
    if (receivedStreamToken) ctx.onToken?.(actionContent);
    if (contextManager && sessionId && action.action !== "final") {
      contextManager.saveAssistantToolAction(sessionId, actionContent, ctx.runId, {
        clientName: response.clientName,
        modelName: response.modelName,
        toolCalls: protocolToolCalls,
      });
    }

    if (action.action === "final") {
      return await handleFinalAction(ctx, {
        action,
        response,
        iteration,
        modelStart,
        effectiveGoal,
        system,
        sessionId,
        pausedRun,
        messages,
        steps,
        consumedNotifications,
      });
    }

    const modelTurnTool = toolCalls.length === 1
      ? toolCalls[0]!.action.tool
      : `batch:${toolCalls.map((call) => call.action.tool).join(",")}`;
    ctx.onModelTurn?.({
      iteration,
      phase: "completed",
      action: "tool",
      tool: modelTurnTool,
      thought: action.thought,
      contentPreview: redactPreview(actionContent, 400),
      clientName: response.clientName,
      modelName: response.modelName,
      latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
    });
    for (const toolCall of toolCalls) {
      const { action, toolCallId } = toolCall;
      ctx.writeAgentDecisionTrace({
        iteration,
        action: "tool",
        tool: action.tool,
        toolCallId,
        thought: action.thought,
        inputPreview: redactPreview(action.input ?? {}, 500),
      });

      const execResult = await ctx.executeToolStep({
        action,
        iteration,
        toolCallId,
        steps,
        goal: effectiveGoal,
        messages,
        sessionId,
        system,
        modelTurns,
        consumedNotifications,
      });
      if (execResult.kind !== "step") {
        return execResult.result;
      }
      const continuation = await ctx.continueAfterToolStep({
        step: execResult.step,
        action,
        messages,
        steps,
        goal: effectiveGoal,
        system,
        sessionId,
        iteration,
        modelTurns,
        consumedNotifications,
        injectNotifications,
      });
      if (continuation.kind === "finalize") {
        return await ctx.finishRun(continuation.input);
      }
      if (continuation.kind === "permission_pause") {
        throw new Error("普通工具循环不应进入已批准动作的再次暂停分支");
      }
    }
  }

  return await ctx.finishRun({
    answer: "",
    partialSummary: ctx.buildPartialAnswer(steps, "maxModelTurns", effectiveGoal),
    steps,
    iterations: modelTurns,
    reachedLimit: true,
    budgetExhausted: "maxModelTurns",
    consumedNotifications,
    sessionId,
    userMessage: effectiveGoal,
  });
}

async function handleFinalAction(
  ctx: AgentReactLoopContext,
  input: {
    action: FinalAction;
    response: LoopChatResponse;
    iteration: number;
    modelStart: number;
    effectiveGoal: string;
    system?: string;
    sessionId?: string;
    pausedRun?: PausedRunSnapshot;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    consumedNotifications: AgentNotification[];
  },
): Promise<AgentRunFinalizeResult> {
  const {
    action,
    response,
    iteration,
    modelStart,
    effectiveGoal,
    system,
    sessionId,
    pausedRun,
    messages,
    steps,
    consumedNotifications,
  } = input;
  const contextManager = ctx.contextManager;

  ctx.onModelTurn?.({
    iteration,
    phase: "completed",
    action: "final",
    contentPreview: redactPreview(action.answer, 400),
    clientName: response.clientName,
    modelName: response.modelName,
    latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
  });
  ctx.writeAgentDecisionTrace({
    iteration,
    action: "final",
    answerLength: action.answer?.length ?? 0,
  });

  const planHandoff = !pausedRun && action.answer.trim()
    ? ctx.createPlanHandoff({
      sessionId,
      goal: effectiveGoal,
      system,
      messages,
      steps,
      modelTurns: iteration,
      planMarkdown: action.answer,
    })
    : null;
  if (planHandoff) {
    if (contextManager && sessionId) {
      contextManager.saveConversationalReply(sessionId, action.answer, ctx.runId, {
        clientName: response.clientName,
        modelName: response.modelName,
      });
    }
    return await ctx.finishRun({
      answer: action.answer,
      steps,
      iterations: iteration,
      reachedLimit: false,
      consumedNotifications,
      sessionId,
      userMessage: effectiveGoal,
      stopReason: "awaiting_plan_handoff",
      planHandoff,
      awaitingPlanHandoff: true,
    });
  }

  const guard = evaluateCompletionGuard({
    goal: effectiveGoal,
    intent: ctx.getEffectiveIntent(),
    reconciledIntent: ctx.getReconciledIntent(),
    capabilityEscalations: ctx.capabilityEscalations,
    mode: ctx.policy.mode,
    answer: action.answer,
    completionClaim: action.completionClaim,
    requiredSideEffects: ctx.policy.requiredSideEffects,
    completionCriteria: ctx.completionCriteria,
    steps,
  });
  if (!guard.accepted) {
    ctx.writeAgentDecisionTrace({
      iteration,
      action: "final_guard_rejected",
      rawPreview: redactPreview(action.answer, 400),
      completionStatus: guard.status,
    });
    if (contextManager && sessionId) {
      contextManager.saveRawModelFinal(sessionId, guard.rawModelAnswer ?? action.answer, ctx.runId, {
        clientName: response.clientName,
        modelName: response.modelName,
      });
      if (guard.guardedAnswer) {
        contextManager.saveGuardedFinalAnswer(sessionId, guard.guardedAnswer, ctx.runId);
      }
    }
    return await ctx.finishRun({
      answer: guard.visibleAnswer ?? guard.guardedAnswer ?? "",
      steps,
      iterations: iteration,
      reachedLimit: false,
      consumedNotifications,
      sessionId,
      userMessage: effectiveGoal,
      stopReason: guard.stopReason,
      completionGuard: guard,
    });
  }
  if (contextManager && sessionId) {
    if (guard.trustedForMemory) {
      contextManager.saveGuardAcceptedModelFinalAnswer(
        sessionId,
        guard.visibleAnswer ?? action.answer,
        ctx.runId,
        {
          clientName: response.clientName,
          modelName: response.modelName,
        },
      );
    } else if (guard.guardedAnswer) {
      contextManager.saveGuardedFinalAnswer(sessionId, guard.guardedAnswer, ctx.runId);
    } else {
      contextManager.saveRawModelFinal(sessionId, action.answer, ctx.runId, {
        clientName: response.clientName,
        modelName: response.modelName,
      });
    }
  }
  return await ctx.finishRun({
    answer: guard.visibleAnswer ?? action.answer,
    steps,
    iterations: iteration,
    reachedLimit: false,
    consumedNotifications,
    sessionId,
    userMessage: effectiveGoal,
    completionGuard: guard,
  });
}
