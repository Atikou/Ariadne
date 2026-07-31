import type { AgentNotification } from "../background/types.js";
import type { ChatMessage } from "../model/types.js";
import { isDeepStrictEqual } from "node:util";
import type { ToolAction } from "./AgentActionParser.js";
import type { AgentRunFinalizeResult } from "./AgentRunFinalizer.js";
import type { AgentToolStepExecResult } from "./AgentReactLoopRunner.js";
import type {
  AgentToolContinuationInput,
  AgentToolContinuationResult,
} from "./AgentToolExecutionCoordinator.js";
import type { PendingToolAction } from "./PausedRunStore.js";
import type { AgentToolStep } from "./toolStep.js";

export interface AgentApprovedToolResumeInput {
  pendingAction: PendingToolAction;
  messages: ChatMessage[];
  steps: AgentToolStep[];
  modelTurns: number;
  goal: string;
  system?: string;
  sessionId?: string;
  consumedNotifications: AgentNotification[];
  injectNotifications: () => void;
}

export interface AgentApprovedToolResumeContext {
  makeToolCallId: (iteration: number, tool: string) => string;
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
    skipJitPause: true;
  }) => Promise<AgentToolStepExecResult>;
  finalizePermissionPause: (input: {
    step: AgentToolStep;
    action: ToolAction;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    modelTurns: number;
    goal: string;
    system?: string;
    sessionId?: string;
    consumedNotifications: AgentNotification[];
  }) => Promise<AgentRunFinalizeResult>;
  finishRun: (input: import("./AgentRunFinalizer.js").AgentRunFinalizeInput) =>
    Promise<AgentRunFinalizeResult>;
  continueAfterToolStep: (
    input: AgentToolContinuationInput,
  ) => Promise<AgentToolContinuationResult>;
}

/** Executes the approved pending tool once, then rejoins the normal tool continuation path. */
export async function resumeApprovedToolAction(
  ctx: AgentApprovedToolResumeContext,
  input: AgentApprovedToolResumeInput,
): Promise<AgentRunFinalizeResult | null> {
  const iteration = input.modelTurns;
  const restoredToolCallId = resolvePendingToolCallId(input.pendingAction, input.messages);
  const legacyCheckpointToolCallId = input.pendingAction.toolCallId?.trim()
    ? undefined
    : ctx.makeToolCallId(iteration, input.pendingAction.tool);
  const protocolToolCallId = restoredToolCallId
    ?? legacyCheckpointToolCallId
    ?? ctx.makeToolCallId(iteration, input.pendingAction.tool);
  const executionToolCallId = legacyCheckpointToolCallId ?? protocolToolCallId;
  const action: ToolAction = {
    action: "tool",
    id: protocolToolCallId,
    tool: input.pendingAction.tool,
    input: input.pendingAction.input,
  };
  const execution = await ctx.executeToolStep({
    action,
    iteration,
    toolCallId: executionToolCallId,
    steps: input.steps,
    goal: input.goal,
    messages: input.messages,
    sessionId: input.sessionId,
    system: input.system,
    modelTurns: input.modelTurns,
    consumedNotifications: input.consumedNotifications,
    skipJitPause: true,
  });
  if ("result" in execution) return execution.result;
  const step = execution.step.toolCallId === protocolToolCallId
    ? execution.step
    : { ...execution.step, toolCallId: protocolToolCallId };

  const continuation = await ctx.continueAfterToolStep({
    step,
    action,
    allowPermissionRepause: true,
    messages: input.messages,
    steps: input.steps,
    goal: input.goal,
    system: input.system,
    sessionId: input.sessionId,
    iteration,
    modelTurns: input.modelTurns,
    consumedNotifications: input.consumedNotifications,
    injectNotifications: input.injectNotifications,
  });
  if (continuation.kind === "continue") return null;
  if (continuation.kind === "finalize") return ctx.finishRun(continuation.input);
  return ctx.finalizePermissionPause(continuation.input);
}

function resolvePendingToolCallId(
  pendingAction: PendingToolAction,
  messages: ChatMessage[],
): string | undefined {
  if (pendingAction.toolCallId?.trim()) return pendingAction.toolCallId.trim();
  const expectedInput = pendingAction.input ?? {};
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== "assistant" || !message.toolCalls?.length) continue;
    for (let callIndex = message.toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = message.toolCalls[callIndex];
      if (
        call?.name === pendingAction.tool
        && isDeepStrictEqual(call.arguments ?? {}, expectedInput)
        && call.id.trim()
      ) {
        return call.id.trim();
      }
    }
  }
  return undefined;
}
