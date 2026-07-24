import type { AgentNotification } from "../background/types.js";
import type { ChatMessage } from "../model/types.js";
import type { ToolAction } from "./AgentActionParser.js";
import type { AgentRunFinalizeResult } from "./AgentRunFinalizer.js";
import type { AgentToolStepExecResult } from "./AgentReactLoopRunner.js";
import type {
  AgentToolContinuationInput,
  AgentToolContinuationResult,
} from "./AgentToolExecutionCoordinator.js";
import type { AgentToolStep } from "./toolStep.js";

export interface AgentApprovedToolResumeInput {
  pendingAction: { tool: string; input?: Record<string, unknown> };
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
  const action: ToolAction = {
    action: "tool",
    tool: input.pendingAction.tool,
    input: input.pendingAction.input,
  };
  const iteration = input.modelTurns;
  const toolCallId = ctx.makeToolCallId(iteration, action.tool);
  const execution = await ctx.executeToolStep({
    action,
    iteration,
    toolCallId,
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

  const continuation = await ctx.continueAfterToolStep({
    step: execution.step,
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
