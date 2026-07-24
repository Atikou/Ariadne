import { DebugFixWorkflow } from "./DebugFixWorkflow.js";
import { EditExecutionWorkflow } from "./EditExecutionWorkflow.js";
import { EditVerificationWorkflow } from "./EditVerificationWorkflow.js";
import { EditWriteWorkflow } from "./EditWriteWorkflow.js";
import type { AgentIntentType } from "./IntentTypes.js";
import { ToolRecoveryWorkflow } from "./ToolRecoveryWorkflow.js";
import { WorkflowCorrectionWorkflow } from "./WorkflowCorrectionWorkflow.js";
import type { AgentToolStep } from "./toolStep.js";
import { isSuccessfulToolStep } from "./toolStepOutcome.js";

export interface WorkflowFollowupContextsInput {
  intent: AgentIntentType | undefined;
  goal: string;
  step: AgentToolStep;
  steps: AgentToolStep[];
  pendingWritePhaseContext?: string;
}

export interface WorkflowFollowupContextsResult {
  blockedContext?: string;
  writePhaseContext?: string;
  editExecutionContext?: string;
  editVerificationContext?: string;
  workflowCorrectionContext?: string;
  toolRecoveryContext?: string;
  pendingWritePhaseContext?: string;
}

export function buildWorkflowFollowupContexts(
  input: WorkflowFollowupContextsInput,
): WorkflowFollowupContextsResult {
  const intent = input.intent ?? "answer";
  const blockedContext = input.step.workflowPhaseBlocked
    ? renderWritePhaseBlockedContext(
      input.goal,
      intent,
      input.step.error ?? "workflow write gate blocked",
    )
    : undefined;
  const writePhaseContext = input.pendingWritePhaseContext && isSuccessfulToolStep(input.step)
    ? input.pendingWritePhaseContext
    : undefined;
  const editExecutionContext = new EditExecutionWorkflow()
    .run({
      goal: input.goal,
      intent,
      step: input.step,
    })?.modelContext;
  const editVerificationContext = new EditVerificationWorkflow()
    .run({
      goal: input.goal,
      intent,
      steps: input.steps,
      currentStep: input.step,
    })?.modelContext;
  const workflowCorrectionContext = new WorkflowCorrectionWorkflow()
    .run({
      goal: input.goal,
      intent,
      steps: input.steps,
      currentStep: input.step,
    })?.modelContext;
  const toolRecoveryContext = new ToolRecoveryWorkflow()
    .run({
      intent,
      goal: input.goal,
      step: input.step,
    })?.modelContext;
  return {
    blockedContext,
    writePhaseContext,
    editExecutionContext,
    editVerificationContext,
    workflowCorrectionContext,
    toolRecoveryContext,
    pendingWritePhaseContext: writePhaseContext ? undefined : input.pendingWritePhaseContext,
  };
}

function renderWritePhaseBlockedContext(
  goal: string,
  intent: AgentIntentType | undefined,
  reason: string,
): string | undefined {
  if (!intent) return undefined;
  if (intent === "edit" || intent === "generate_file" || intent === "refactor") {
    return new EditWriteWorkflow().renderBlockedContext(goal, intent, reason);
  }
  if (intent === "debug") {
    return new DebugFixWorkflow().renderBlockedContext(goal, reason);
  }
  return undefined;
}
