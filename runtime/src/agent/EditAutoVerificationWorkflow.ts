import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import { isEffectiveWriteStep } from "./toolStepOutcome.js";

export interface EditAutoVerificationWorkflowInput {
  intent: AgentIntentType;
  step: AgentToolStep;
}

export interface EditAutoVerificationWorkflowResult {
  tool: "read_file";
  input: { path: string };
  thought: string;
}

/**
 * Minimal automatic verification planner for edit/generate-file workflows.
 *
 * It does not execute tools. It only turns a successful write result with a
 * concrete path into a read-only verification action that AgentLoop can run
 * through the normal ToolRegistry, permission, and budget path.
 */
export class EditAutoVerificationWorkflow {
  run(input: EditAutoVerificationWorkflowInput): EditAutoVerificationWorkflowResult | undefined {
    if (input.intent !== "edit" && input.intent !== "generate_file" && input.intent !== "debug" && input.intent !== "refactor") {
      return undefined;
    }
    if (!isEffectiveWriteStep(input.step)) {
      return undefined;
    }
    const raw = asRecord(input.step.resultLayers?.raw) ?? asRecord(input.step.output) ?? {};
    const path = readString(raw.path) ?? readFirstString(raw.restoredFiles);
    if (!path) return undefined;
    return {
      tool: "read_file",
      input: { path },
      thought: "自动读回刚写入的文件，验证实际内容与 diff 是否一致。",
    };
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readFirstString(value: unknown): string | undefined {
  return Array.isArray(value) ? value.map(readString).find(Boolean) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
