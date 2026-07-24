import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentWorkflowVerificationRecord } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";

export interface EditVerificationWorkflowInput {
  goal: string;
  intent: AgentIntentType;
  steps: AgentToolStep[];
  currentStep: AgentToolStep;
}

export interface EditVerificationWorkflowResult {
  modelContext: string;
  record: AgentWorkflowVerificationRecord;
}

/**
 * Verification-result phase for edit/generate-file workflows.
 *
 * The workflow does not run tools. It observes the first verification-like tool
 * after a successful write and turns that result into structured guidance.
 */
export class EditVerificationWorkflow {
  run(input: EditVerificationWorkflowInput): EditVerificationWorkflowResult | undefined {
    if (!supportsWriteVerifyIntent(input.intent)) return undefined;
    if (!isVerificationTool(input.currentStep.tool)) return undefined;

    const writeStep = findNearestPriorWrite(input.steps, input.currentStep);
    if (!writeStep) return undefined;

    const record = buildVerificationRecord({
      intent: input.intent,
      writeStep,
      verificationStep: input.currentStep,
    });
    return {
      record,
      modelContext: renderVerificationContext(input.goal, record),
    };
  }

  collect(intent: AgentIntentType, steps: AgentToolStep[]): AgentWorkflowVerificationRecord[] {
    if (!supportsWriteVerifyIntent(intent)) return [];
    const records: AgentWorkflowVerificationRecord[] = [];
    for (const step of steps) {
      if (!isVerificationTool(step.tool)) continue;
      const writeStep = findNearestPriorWrite(steps, step);
      if (!writeStep) continue;
      records.push(buildVerificationRecord({ intent, writeStep, verificationStep: step }));
    }
    return records;
  }
}

interface RecordInput {
  intent: Extract<AgentIntentType, "edit" | "generate_file" | "debug" | "refactor">;
  writeStep: AgentToolStep;
  verificationStep: AgentToolStep;
}

function buildVerificationRecord(input: RecordInput): AgentWorkflowVerificationRecord {
  const writeRaw = asRecord(input.writeStep.resultLayers?.raw) ?? asRecord(input.writeStep.output) ?? {};
  const output = input.verificationStep.ok
    ? input.verificationStep.resultLayers?.raw ?? input.verificationStep.resultLayers?.modelVisible ?? input.verificationStep.output
    : input.verificationStep.error;
  return {
    workflowType: workflowTypeForIntent(input.intent),
    writeToolCallId: input.writeStep.toolCallId,
    writeTool: input.writeStep.tool as "write_file" | "apply_patch",
    path: readString(writeRaw.path),
    changeId: readString(writeRaw.changeId),
    verificationToolCallId: input.verificationStep.toolCallId,
    verificationTool: input.verificationStep.tool,
    ok: input.verificationStep.ok,
    blocked: input.verificationStep.blocked || undefined,
    error: input.verificationStep.ok ? undefined : input.verificationStep.error,
    outputPreview: previewValue(output),
  };
}

function renderVerificationContext(goal: string, record: AgentWorkflowVerificationRecord): string {
  return [
    `${record.workflowType} verification phase:`,
    `goal: ${goal}`,
    `writeTool: ${record.writeTool}`,
    record.writeToolCallId ? `writeToolCallId: ${record.writeToolCallId}` : undefined,
    record.path ? `path: ${record.path}` : undefined,
    record.changeId ? `changeId: ${record.changeId}` : undefined,
    `verificationTool: ${record.verificationTool}`,
    record.verificationToolCallId ? `verificationToolCallId: ${record.verificationToolCallId}` : undefined,
    `verificationStatus: ${record.ok ? "completed" : record.blocked ? "blocked" : "failed"}`,
    record.error ? `verificationError: ${record.error}` : undefined,
    record.outputPreview ? ["verificationOutputPreview:", record.outputPreview].join("\n") : undefined,
    "",
    "If the verification output confirms the intended change, return final with changed files, changeId, and verification status.",
    "If verification failed or contradicts the intended diff, make the smallest corrective tool call allowed by the current permission policy.",
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

function findNearestPriorWrite(steps: AgentToolStep[], currentStep: AgentToolStep): AgentToolStep | undefined {
  const currentIndex = steps.lastIndexOf(currentStep);
  if (currentIndex <= 0) return undefined;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.ok && (step.tool === "write_file" || step.tool === "apply_patch")) return step;
  }
  return undefined;
}

function isVerificationTool(tool: string): boolean {
  return (
    tool === "read_file" ||
    tool === "search_text" ||
    tool === "diff_file" ||
    tool === "shell_run" ||
    tool === "project_index_update" ||
    tool === "context_pack"
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function previewValue(value: unknown, maxChars = 1_500): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... (verification output truncated)`;
}

function supportsWriteVerifyIntent(intent: AgentIntentType): intent is Extract<AgentIntentType, "edit" | "generate_file" | "debug" | "refactor"> {
  return intent === "edit" || intent === "generate_file" || intent === "debug" || intent === "refactor";
}

function workflowTypeForIntent(
  intent: Extract<AgentIntentType, "edit" | "generate_file" | "debug" | "refactor">,
): AgentWorkflowVerificationRecord["workflowType"] {
  if (intent === "generate_file") return "generateFileWorkflow";
  if (intent === "debug") return "debugWorkflow";
  if (intent === "refactor") return "refactorWorkflow";
  return "editWorkflow";
}
