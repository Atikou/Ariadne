import type { AgentNotification } from "../background/types.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { ChatMessage } from "../model/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { AgentRoutingMeta } from "../model-router/agent-routing-summary.js";
import type { LoopChatFn, LoopChatResponse } from "../model-router/agent-chat-types.js";
import {
  assertWithinCostBudget,
  isCostBudgetReached,
  sumModelTurnCost,
} from "../util/costBudget.js";
import { redactPreview } from "../util/redact.js";
import {
  sanitizeAgentAction,
  stripModelNoise,
  type FinalAction,
  type ToolAction,
} from "./AgentActionParser.js";
import {
  AgentProtocolRepairBudget,
  admitAgentModelAction,
  buildAgentProtocolRepairMessage,
} from "./AgentActionAdmission.js";
import { AgentProtocolError } from "./AgentProtocolError.js";
import type { AgentRunSession } from "./AgentRunBootstrap.js";
import type { AgentRunFinalizeInput, AgentRunFinalizeResult } from "./AgentRunFinalizer.js";
import type { AgentModelTurnEvent } from "./AgentModelTurn.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { BudgetManager } from "./BudgetManager.js";
import { evaluateCompletionGuard } from "./completion/CompletionFinalGuard.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { PausedRunSnapshot } from "./PausedRunStore.js";
import type { AgentPlanFinalization } from "./AgentPauseCoordinator.js";
import {
  evaluateAgentPlanExecutionReport,
  evaluateAgentPlanDraft,
  planDraftRepairMessage,
  planExecutionRepairMessage,
  renderAgentPlanClarification,
  renderAgentPlanMarkdown,
  type AgentPlanModelDraft,
} from "../plan/AgentPlanContract.js";
import { AgentPlanQualityError } from "../plan/AgentPlanStore.js";
import type { RunBudgetKey, RunPolicy } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import type { CompletionCriterionInput } from "./completion/TaskCompletionContract.js";
import type {
  AgentToolContinuationInput,
  AgentToolContinuationResult,
} from "./AgentToolExecutionCoordinator.js";
import { DEFAULT_TOOL_CONCURRENCY, planToolExecutionBatches } from "./ToolConcurrencyPlanner.js";

const MAX_WORKING_MESSAGE_CHARS = 48_000;
const RECENT_MESSAGE_CHARS = 28_000;
const MAX_FIRST_SYSTEM_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_GOAL_CHARS = 4_000;
const MAX_RECENT_MESSAGE_CHARS = 4_000;

export type AgentToolStepExecResult =
  | { kind: "step"; step: AgentToolStep }
  | { kind: "pause" | "budget"; result: AgentRunFinalizeResult };

export interface AgentReactLoopContext {
  chat: LoopChatFn;
  registry: ToolRegistry;
  workspaceRoot: string;
  allowedToolNames: readonly string[];
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
  requiresPlanContract: boolean;
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
  onWorkingContextCompacted?: (input: {
    beforeChars: number;
    afterChars: number;
    processedMessages: number;
  }) => void;
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
  createPlanFinalization: (input: {
    sessionId?: string;
    goal: string;
    system?: string;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    modelTurns: number;
    planDraft: AgentPlanModelDraft;
  }) => AgentPlanFinalization | null;
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
    activityBatchId?: string;
    activityDependsOnToolCallIds?: string[];
  }) => Promise<AgentToolStepExecResult>;
  recordToolBatchObservations: (
    inputs: readonly AgentToolContinuationInput[],
  ) => void;
  continueAfterRecordedToolBatch: (
    inputs: readonly AgentToolContinuationInput[],
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
  const allowedToolNames = new Set(ctx.allowedToolNames);
  const modelTools = ctx.registry
    .list()
    .filter((tool) => allowedToolNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputJsonSchema,
    }));
  const protocolRepairs = new AgentProtocolRepairBudget();
  let planQualityRepairs = 0;
  let planExecutionRepairs = 0;
  const finalizationReserve = finalizationReserveTurns(ctx.maxModelTurns);

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
    const turnsRemainingAfterThis = ctx.maxModelTurns - iteration;
    const finalizationOnly = turnsRemainingAfterThis < finalizationReserve;
    const budgetNotice = buildBudgetNotice({
      manager: ctx.budgetManager,
      steps,
      modelTurns,
      finalizationOnly,
      finalizationReserve,
    });
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
      const beforeWorkingChars = messageChars(messages);
      const workingMessages = buildWorkingMessages(messages, steps, effectiveGoal);
      const afterWorkingChars = messageChars(workingMessages);
      if (afterWorkingChars < beforeWorkingChars) {
        ctx.onWorkingContextCompacted?.({
          beforeChars: beforeWorkingChars,
          afterChars: afterWorkingChars,
          processedMessages: Math.max(0, messages.length - workingMessages.length),
        });
      }
      response = await ctx.chat(
        {
          messages: budgetNotice
            ? [...workingMessages, { role: "system", content: budgetNotice }]
            : workingMessages,
          tools: finalizationOnly ? [] : modelTools,
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
    const costBudgetReached = isCostBudgetReached(
      sumModelTurnCost([
        ...ctx.getModelTurnMetrics().map((m) => m.costUsd),
        response.costUsd,
      ]),
      ctx.maxCostUsdPerRun,
    );
    const admission = admitAgentModelAction({
      content: response.content,
      nativeToolCalls: response.toolCalls,
      registry: ctx.registry,
      allowedToolNames,
      workspaceRoot: ctx.workspaceRoot,
    });
    if (!admission.ok) {
      const tracePreview = stripModelNoise(response.content);
      recordResponseTurn(false, `MODEL_PROTOCOL_ERROR:${admission.category}`);
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
      if (protocolRepairs.consume() && modelTurns < ctx.maxModelTurns) {
        messages.push({
          role: "system",
          content: buildAgentProtocolRepairMessage({
            failure: admission,
            allowedToolNames: ctx.allowedToolNames,
          }),
        });
        continue;
      }
      throw new AgentProtocolError({
        clientName: response.clientName,
        modelName: response.modelName,
      }, admission.category, protocolRepairs.used);
    }
    protocolRepairs.reset();
    const action = sanitizeAgentAction(admission.action);
    const actionContent = JSON.stringify(action);
    if (
      action.action === "final"
      && ctx.requiresPlanContract
      && !pausedRun
    ) {
      const evaluation = evaluateAgentPlanDraft(action.plan);
      const validCompletionClaim = action.completionClaim === "completed";
      if (!evaluation.acceptable || !evaluation.draft || !validCompletionClaim) {
        const repair = !validCompletionClaim
          ? `${planDraftRepairMessage(evaluation)}\n- completionClaim 必须为 completed。`
          : planDraftRepairMessage(evaluation);
        recordResponseTurn(false, "AGENT_PLAN_QUALITY_INVALID");
        ctx.onModelTurn?.({
          iteration,
          phase: "parse_error",
          contentPreview: "计划草案未通过结构和质量校验",
          clientName: response.clientName,
          modelName: response.modelName,
          latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
        });
        messages.push({ role: "assistant", content: actionContent });
        if (planQualityRepairs < 2 && modelTurns < ctx.maxModelTurns) {
          planQualityRepairs += 1;
          messages.push({ role: "system", content: repair });
          continue;
        }
        throw new AgentPlanQualityError(
          evaluation.issues.map((issue) => issue.message).concat(
            validCompletionClaim ? [] : ["completionClaim 必须为 completed"],
          ),
        );
      }
      planQualityRepairs = 0;
    }
    if (action.action === "final" && pausedRun?.approvedPlan) {
      const evaluation = evaluateAgentPlanExecutionReport(
        pausedRun.approvedPlan,
        action.planExecution,
      );
      const completedClaimMatchesReport = action.completionClaim !== "completed"
        || (
          evaluation.report?.steps.every((step) => step.status === "completed")
          && evaluation.report.steps.every((step) => step.deviations.length === 0)
        );
      if (!evaluation.acceptable || !evaluation.report || !completedClaimMatchesReport) {
        const repair = [
          planExecutionRepairMessage(pausedRun.approvedPlan, evaluation),
          ...(!completedClaimMatchesReport
            ? ["- completionClaim=completed 时，所有步骤必须有证据地完成且不能存在范围偏差。"]
            : []),
        ].join("\n");
        recordResponseTurn(false, "AGENT_PLAN_EXECUTION_REPORT_INVALID");
        ctx.onModelTurn?.({
          iteration,
          phase: "parse_error",
          contentPreview: "计划执行报告未通过结构和证据校验",
          clientName: response.clientName,
          modelName: response.modelName,
          latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
        });
        messages.push({ role: "assistant", content: actionContent });
        if (planExecutionRepairs < 2 && modelTurns < ctx.maxModelTurns) {
          planExecutionRepairs += 1;
          messages.push({ role: "system", content: repair });
          continue;
        }
        throw new AgentPlanQualityError([
          ...evaluation.issues,
          ...(!completedClaimMatchesReport
            ? ["完成声明与逐步骤执行报告不一致。"]
            : []),
        ]);
      }
      planExecutionRepairs = 0;
    }
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
    if (costBudgetReached && action.action !== "final") {
      const completedTools = steps
        .filter((step) => step.ok && step.executed !== false)
        .slice(-12)
        .map((step) => step.tool);
      const partialSummary = [
        "The configured per-run model cost limit was reached by the response that requested",
        "another tool. That tool was not executed because no paid model turn remains to",
        "observe its result and produce a truthful final answer.",
        `Completed verified tool steps before the stop: ${JSON.stringify(completedTools)}.`,
      ].join(" ");
      ctx.writeAgentDecisionTrace({
        iteration,
        action: "tool",
        tool: toolCalls.length === 1
          ? toolCalls[0]!.action.tool
          : `batch:${toolCalls.map((call) => call.action.tool).join(",")}`,
        thought: action.thought,
        rawPreview: "cost_budget_reached_before_tool_execution",
      });
      ctx.onModelTurn?.({
        iteration,
        phase: "completed",
        action: "tool",
        tool: toolCalls.length === 1
          ? toolCalls[0]!.action.tool
          : `batch:${toolCalls.map((call) => call.action.tool).join(",")}`,
        thought: action.thought,
        contentPreview: "Cost limit reached; requested tool was not executed.",
        clientName: response.clientName,
        modelName: response.modelName,
        latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
      });
      return await ctx.finishRun({
        answer: partialSummary,
        partialSummary,
        steps,
        iterations: modelTurns,
        reachedLimit: false,
        stopReason: "blocked_by_policy",
        consumedNotifications,
        sessionId,
        userMessage: effectiveGoal,
      });
    }
    if (finalizationOnly && action.action !== "final") {
      messages.push({ role: "assistant", content: actionContent });
      messages.push({
        role: "system",
        content: [
          "The requested tool was not executed because the remaining model turns are reserved",
          "for observing existing results, checkpointing, and returning a truthful final answer.",
          "Return a final action now. Do not request another tool.",
        ].join(" "),
      });
      if (receivedStreamToken) ctx.onToken?.(actionContent);
      ctx.onModelTurn?.({
        iteration,
        phase: "completed",
        action: "tool",
        tool: toolCalls.length === 1
          ? toolCalls[0]!.action.tool
          : `batch:${toolCalls.map((call) => call.action.tool).join(",")}`,
        thought: action.thought,
        contentPreview: redactPreview(actionContent, 400),
        clientName: response.clientName,
        modelName: response.modelName,
        latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
      });
      if (modelTurns < ctx.maxModelTurns) continue;
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
    const remainingCalls = [...toolCalls];
    const turnContinuations: AgentToolContinuationInput[] = [];
    let batchSequence = 0;
    let previousBatchToolCallIds = latestToolCallIds(steps);
    while (remainingCalls.length > 0) {
      const usage = ctx.budgetManager.buildUsage(steps, modelTurns);
      const remainingToolCalls = Math.max(
        1,
        ctx.budgetManager.budget.maxToolCalls - usage.toolCalls,
      );
      const remainingReadCalls = ctx.budgetManager.budget.maxReadCalls > 0
        ? Math.max(1, ctx.budgetManager.budget.maxReadCalls - usage.readCalls)
        : DEFAULT_TOOL_CONCURRENCY;
      const concurrency = Math.min(
        DEFAULT_TOOL_CONCURRENCY,
        remainingToolCalls,
        remainingReadCalls,
      );
      const batch = planToolExecutionBatches(
        remainingCalls.map((call) => call.action),
        ctx.registry,
        concurrency,
      )[0] ?? [0];
      const calls = batch.map((index) => remainingCalls[index]!);
      const activityBatchId = `iteration-${iteration}-batch-${batchSequence++}`;
      for (const index of [...batch].sort((left, right) => right - left)) {
        remainingCalls.splice(index, 1);
      }
      for (const { action, toolCallId } of calls) {
        ctx.writeAgentDecisionTrace({
          iteration,
          action: "tool",
          tool: action.tool,
          toolCallId,
          thought: action.thought,
          inputPreview: redactPreview(action.input ?? {}, 500),
        });
      }
      const executionInputs = calls.map(({ action, toolCallId }) => ({
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
        activityBatchId,
        activityDependsOnToolCallIds: previousBatchToolCallIds,
      }));
      const executionResults = calls.length > 1
        ? await Promise.all(executionInputs.map((input) => ctx.executeToolStep(input)))
        : [await ctx.executeToolStep(executionInputs[0]!)];
      const terminal = executionResults.find((result) => result.kind !== "step");
      if (terminal) return terminal.result;

      const continuationInputs = executionResults.map((result, index) => ({
        step: result.kind === "step" ? result.step : neverToolStep(),
        action: calls[index]!.action,
        messages,
        steps,
        goal: effectiveGoal,
        system,
        sessionId,
        iteration,
        modelTurns,
        consumedNotifications,
        injectNotifications,
      }));
      ctx.recordToolBatchObservations(continuationInputs);
      turnContinuations.push(...continuationInputs);
      previousBatchToolCallIds = calls.map((call) => call.toolCallId);
    }
    const continuation = await ctx.continueAfterRecordedToolBatch(turnContinuations);
    if (continuation.kind === "finalize") {
      return await ctx.finishRun(continuation.input);
    }
    if (continuation.kind === "permission_pause") {
      throw new Error("普通工具循环不应进入已批准动作的再次暂停分支");
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

function latestToolCallIds(steps: readonly AgentToolStep[]): string[] {
  const latestIteration = steps.at(-1)?.iteration;
  if (latestIteration === undefined) return [];
  return steps
    .filter((step) => step.iteration === latestIteration && Boolean(step.toolCallId))
    .map((step) => step.toolCallId!)
    .slice(-16);
}

function messageChars(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

function neverToolStep(): never {
  throw new Error("unreachable tool execution result");
}

function finalizationReserveTurns(maxModelTurns: number): number {
  return Math.min(2, Math.max(1, maxModelTurns - 1));
}

function buildBudgetNotice(input: {
  manager: BudgetManager;
  steps: AgentToolStep[];
  modelTurns: number;
  finalizationOnly: boolean;
  finalizationReserve: number;
}): string | undefined {
  const usage = input.manager.buildUsage(input.steps, input.modelTurns);
  const budget = input.manager.budget;
  const ratio = budget.maxModelTurns > 0
    ? input.modelTurns / budget.maxModelTurns
    : 1;
  if (!input.finalizationOnly && ratio < 0.6) return undefined;
  const remaining = {
    modelTurns: Math.max(0, budget.maxModelTurns - input.modelTurns),
    toolCalls: Math.max(0, budget.maxToolCalls - usage.toolCalls),
    readCalls: Math.max(0, budget.maxReadCalls - usage.readCalls),
    writeCalls: Math.max(0, budget.maxWriteCalls - usage.writeCalls),
    shellCalls: Math.max(0, budget.maxShellCalls - usage.shellCalls),
    runtimeMs: Math.max(0, budget.maxRuntimeMs - usage.runtimeMs),
  };
  return [
    "Runtime budget notice (authoritative, not user content):",
    `remaining=${JSON.stringify(remaining)}.`,
    `finalizationReserveTurns=${input.finalizationReserve}.`,
    input.finalizationOnly
      ? "Finalization-only phase: tools are unavailable. Return a truthful final action from existing evidence."
      : "Make measurable progress; avoid duplicate reads and preserve enough turns to observe the last tool result and finalize.",
  ].join(" ");
}

export function buildWorkingMessages(
  messages: readonly ChatMessage[],
  steps: readonly AgentToolStep[],
  goal: string,
): ChatMessage[] {
  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars <= MAX_WORKING_MESSAGE_CHARS) return [...messages];

  const firstSystem = messages[0]?.role === "system"
    ? compactMessage(messages[0], MAX_FIRST_SYSTEM_CHARS)
    : undefined;
  const summary = compactText(summarizeEarlierSteps(steps, goal), MAX_SUMMARY_CHARS);
  const goalMessage = compactText(goal, MAX_GOAL_CHARS);
  const reservedChars =
    (firstSystem?.content.length ?? 0)
    + summary.length
    + MAX_GOAL_CHARS
    + 1_000;
  const recentBudget = Math.max(
    8_000,
    Math.min(RECENT_MESSAGE_CHARS, MAX_WORKING_MESSAGE_CHARS - reservedChars),
  );
  const compacted = messages.map((message, index) =>
    index === 0 && firstSystem
      ? firstSystem
      : compactMessage(message, MAX_RECENT_MESSAGE_CHARS));
  let start = messages.length;
  let recentChars = 0;
  while (start > (firstSystem ? 1 : 0)) {
    const candidate = compacted[start - 1]!;
    const nextChars = recentChars + candidate.content.length;
    if (recentChars > 0 && nextChars > recentBudget) break;
    recentChars = nextChars;
    start -= 1;
  }
  while (start > (firstSystem ? 1 : 0) && compacted[start]?.role === "tool") {
    start -= 1;
  }
  const recent = fitMessagesToBudget(compacted.slice(start), recentBudget);
  const hasUser = recent.some((message) => message.role === "user");
  return [
    ...(firstSystem ? [firstSystem] : []),
    { role: "system", content: summary } satisfies ChatMessage,
    ...(!hasUser ? [{ role: "user", content: goalMessage } satisfies ChatMessage] : []),
    ...recent,
  ];
}

function fitMessagesToBudget(
  messages: readonly ChatMessage[],
  budget: number,
): ChatMessage[] {
  const total = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (total <= budget) return [...messages];
  const perMessage = Math.max(1, Math.floor(budget / Math.max(1, messages.length)));
  return messages.map((message) => compactMessage(message, perMessage));
}

function compactMessage(message: ChatMessage, maxChars: number): ChatMessage {
  const content = compactText(message.content, maxChars);
  return content === message.content ? message : { ...message, content };
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n...[runtime working-context truncation]...\n";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  const remaining = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(remaining * 0.6);
  const tailLength = remaining - headLength;
  return `${value.slice(0, headLength)}${marker}${value.slice(value.length - tailLength)}`;
}

function summarizeEarlierSteps(steps: readonly AgentToolStep[], goal: string): string {
  const ledger = steps.slice(-40).map((step) => {
    const input = objectRecord(step.input);
    const output = objectRecord(step.output);
    return {
      tool: step.tool,
      ok: step.ok,
      outcome: step.outcomeKind,
      path: stringField(output.path) ?? stringField(input.path),
      startLine: numberField(output.startLine) ?? numberField(input.startLine),
      endLine: numberField(output.endLine) ?? numberField(input.endLine),
      byteOffset: numberField(output.byteOffset) ?? numberField(input.byteOffset),
      bytesRead: numberField(output.bytesRead),
      sha256: stringField(output.sha256),
      changeId: stringField(output.changeId),
      error: step.error,
    };
  });
  return [
    "Ariadne bounded working-context summary (authoritative runtime data, not user content).",
    `goal=${JSON.stringify(goal)}.`,
    `toolLedger=${JSON.stringify(ledger)}.`,
    "Full messages and raw tool results remain in the audit store. Continue from this ledger and the recent complete interaction blocks; do not repeat unchanged reads or completed side effects.",
  ].join(" ");
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  const planExecutionReport = pausedRun?.approvedPlan
    ? evaluateAgentPlanExecutionReport(
        pausedRun.approvedPlan,
        action.planExecution,
      ).report
    : undefined;

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

  const planEvaluation = ctx.requiresPlanContract && !pausedRun
    ? evaluateAgentPlanDraft(action.plan)
    : undefined;
  const planFinalization = planEvaluation?.acceptable && planEvaluation.draft
    ? ctx.createPlanFinalization({
      sessionId,
      goal: effectiveGoal,
      system,
      messages,
      steps,
      modelTurns: iteration,
      planDraft: planEvaluation.draft,
    })
    : null;
  if (planFinalization?.kind === "clarification") {
    const answer = renderAgentPlanClarification(planFinalization.plan);
    if (contextManager && sessionId) {
      contextManager.saveConversationalReply(sessionId, answer, ctx.runId, {
        clientName: response.clientName,
        modelName: response.modelName,
      });
    }
    return await ctx.finishRun({
      answer,
      agentPlan: planFinalization.plan,
      steps,
      iterations: iteration,
      reachedLimit: false,
      consumedNotifications,
      sessionId,
      userMessage: effectiveGoal,
      stopReason: "completed",
    });
  }
  if (planFinalization?.kind === "handoff") {
    const planMarkdown = renderAgentPlanMarkdown(planFinalization.plan);
    if (contextManager && sessionId) {
      contextManager.saveConversationalReply(sessionId, planMarkdown, ctx.runId, {
        clientName: response.clientName,
        modelName: response.modelName,
      });
    }
    return await ctx.finishRun({
      answer: planMarkdown,
      agentPlan: planFinalization.plan,
      steps,
      iterations: iteration,
      reachedLimit: false,
      consumedNotifications,
      sessionId,
      userMessage: effectiveGoal,
      stopReason: "awaiting_plan_handoff",
      planHandoff: planFinalization.handoff,
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
      agentPlanExecutionReport: planExecutionReport,
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
    agentPlanExecutionReport: planExecutionReport,
  });
}
