import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import { EditVerificationWorkflow } from "./EditVerificationWorkflow.js";
import type { AgentWorkflowCorrectionRecord } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";

export const MAX_WORKFLOW_CORRECTION_ATTEMPTS = 2;

export interface WorkflowCorrectionWorkflowInput {
  goal: string;
  intent: AgentIntentType;
  steps: AgentToolStep[];
  currentStep: AgentToolStep;
}

export interface WorkflowCorrectionWorkflowResult {
  modelContext: string;
  record: AgentWorkflowCorrectionRecord;
}

const correctionIntents = new Set<AgentIntentType>(["edit", "generate_file", "debug", "refactor"]);

/**
 * Correction / termination phase for write-verify workflows.
 *
 * When verification after a write fails, this workflow tracks attempt count per
 * path and either asks for the smallest corrective change or stops further writes.
 */
export class WorkflowCorrectionWorkflow {
  run(input: WorkflowCorrectionWorkflowInput): WorkflowCorrectionWorkflowResult | undefined {
    if (!correctionIntents.has(input.intent)) return undefined;

    const verification = new EditVerificationWorkflow().run({
      goal: input.goal,
      intent: input.intent,
      steps: input.steps,
      currentStep: input.currentStep,
    });
    if (!verification || verification.record.ok) return undefined;

    const attempt = countFailedVerificationAttempts(input.steps, input.intent, verification.record.path);
    const limitReached = attempt >= MAX_WORKFLOW_CORRECTION_ATTEMPTS;
    const record: AgentWorkflowCorrectionRecord = {
      workflowType: verification.record.workflowType,
      phase: limitReached ? "termination" : "correction",
      path: verification.record.path,
      changeId: verification.record.changeId,
      writeToolCallId: verification.record.writeToolCallId,
      verificationToolCallId: verification.record.verificationToolCallId,
      verificationTool: verification.record.verificationTool,
      attempt,
      maxAttempts: MAX_WORKFLOW_CORRECTION_ATTEMPTS,
      limitReached,
      verificationError: verification.record.error,
    };
    return {
      record,
      modelContext: renderCorrectionContext(input.goal, record),
    };
  }

  collect(intent: AgentIntentType, steps: AgentToolStep[]): AgentWorkflowCorrectionRecord[] {
    if (!correctionIntents.has(intent)) return [];
    const records: AgentWorkflowCorrectionRecord[] = [];
    const verifier = new EditVerificationWorkflow();
    for (const step of steps) {
      const verification = verifier.run({
        goal: "",
        intent,
        steps,
        currentStep: step,
      });
      if (!verification || verification.record.ok) continue;
      const attempt = countFailedVerificationAttempts(
        steps.slice(0, steps.indexOf(step) + 1),
        intent,
        verification.record.path,
      );
      const limitReached = attempt >= MAX_WORKFLOW_CORRECTION_ATTEMPTS;
      records.push({
        workflowType: verification.record.workflowType,
        phase: limitReached ? "termination" : "correction",
        path: verification.record.path,
        changeId: verification.record.changeId,
        writeToolCallId: verification.record.writeToolCallId,
        verificationToolCallId: verification.record.verificationToolCallId,
        verificationTool: verification.record.verificationTool,
        attempt,
        maxAttempts: MAX_WORKFLOW_CORRECTION_ATTEMPTS,
        limitReached,
        verificationError: verification.record.error,
      });
    }
    return records;
  }
}

function countFailedVerificationAttempts(
  steps: AgentToolStep[],
  intent: AgentIntentType,
  path: string | undefined,
): number {
  const verifier = new EditVerificationWorkflow();
  let count = 0;
  for (const step of steps) {
    const verification = verifier.run({
      goal: "",
      intent,
      steps,
      currentStep: step,
    });
    if (!verification || verification.record.ok) continue;
    if (path && verification.record.path && verification.record.path !== path) continue;
    count += 1;
  }
  return count;
}

function renderCorrectionContext(goal: string, record: AgentWorkflowCorrectionRecord): string {
  if (record.limitReached) {
    return [
      `${record.workflowType} termination phase:`,
      `goal: ${goal}`,
      record.path ? `path: ${record.path}` : undefined,
      record.changeId ? `changeId: ${record.changeId}` : undefined,
      `verificationTool: ${record.verificationTool}`,
      `correctionAttempt: ${record.attempt}/${record.maxAttempts}`,
      `correctionLimitReached: true`,
      record.verificationError ? `verificationError: ${record.verificationError}` : undefined,
      "",
      "Automatic correction limit reached for this write-verify cycle.",
      "Do not call write_file, apply_patch, or shell_run again in this run.",
      "Return final with: what was attempted, the latest verification failure, remaining risk, and the smallest manual follow-up.",
    ]
      .filter((line): line is string => typeof line === "string" && line.length > 0)
      .join("\n");
  }

  return [
    `${record.workflowType} correction phase:`,
    `goal: ${goal}`,
    record.path ? `path: ${record.path}` : undefined,
    record.changeId ? `changeId: ${record.changeId}` : undefined,
    `verificationTool: ${record.verificationTool}`,
    `correctionAttempt: ${record.attempt}/${record.maxAttempts}`,
    record.verificationError ? `verificationError: ${record.verificationError}` : undefined,
    "",
    "Verification failed or contradicted the intended change.",
    "Make exactly one smallest corrective tool call allowed by the current permission policy, then stop writing until verification passes.",
    `You have ${Math.max(0, record.maxAttempts - record.attempt)} more automatic correction round(s) before the workflow forces termination.`,
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}
