import type { AgentStopReason, AgentWorkflowTaskState } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import { isEffectiveWriteStep } from "./toolStepOutcome.js";

const VERIFICATION_TOOLS = new Set(["read_file", "diff_file", "shell_run"]);

export interface ResolveWorkflowTaskStateInput {
  stopReason: AgentStopReason;
  steps: AgentToolStep[];
  hasPlanningPhase: boolean;
}

export function resolveWorkflowTaskState(input: ResolveWorkflowTaskStateInput): AgentWorkflowTaskState {
  const waitingConfirmation = input.steps.some(
    (step) => step.blocked && step.confirmationRequest?.status === "waiting_confirmation",
  );
  const hasWrite = input.steps.some((step) => isEffectiveWriteStep(step));
  const hasVerificationAttempt = input.steps.some((step) => VERIFICATION_TOOLS.has(step.tool));

  if (input.stopReason === "completed") return "completed";
  if (input.stopReason === "user_cancelled") return "cancelled";
  if (waitingConfirmation) return "waiting_confirmation";
  if (input.stopReason === "budget_exhausted" || input.stopReason === "error") {
    if (hasVerificationAttempt && hasWrite) return "verifying";
    if (hasWrite) return "executing";
    if (input.hasPlanningPhase) return "planning";
    return "failed";
  }
  if (hasVerificationAttempt) return "verifying";
  if (hasWrite) return "executing";
  if (input.hasPlanningPhase) return "planning";
  return "idle";
}

export function hasPlanningPhaseArtifacts(input: {
  workflowInternalPlans?: unknown[];
  workflowProposals?: unknown[];
  workflowDebugAnalyses?: unknown[];
  workflowRefactorPlans?: unknown[];
}): boolean {
  return Boolean(
    input.workflowInternalPlans?.length ||
      input.workflowProposals?.length ||
      input.workflowDebugAnalyses?.length ||
      input.workflowRefactorPlans?.length,
  );
}
