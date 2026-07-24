import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import { isEffectiveWriteStep } from "./toolStepOutcome.js";

export interface EditExecutionWorkflowInput {
  goal: string;
  intent: AgentIntentType;
  step: AgentToolStep;
}

export interface EditExecutionWorkflowResult {
  modelContext: string;
}

/**
 * Write-result phase for edit/generate-file workflows.
 *
 * The workflow does not execute writes. It turns a successful write tool result into
 * explicit next-step guidance so the model verifies or summarizes the actual diff.
 */
export class EditExecutionWorkflow {
  run(input: EditExecutionWorkflowInput): EditExecutionWorkflowResult | undefined {
    if (
      input.intent !== "edit" &&
      input.intent !== "generate_file" &&
      input.intent !== "debug" &&
      input.intent !== "refactor"
    ) {
      return undefined;
    }
    if (!isEffectiveWriteStep(input.step)) {
      return undefined;
    }

    const raw = asRecord(input.step.resultLayers?.raw) ?? asRecord(input.step.output) ?? {};
    return {
      modelContext: renderEditExecutionContext({
        goal: input.goal,
        workflowType:
          input.intent === "generate_file"
            ? "generateFileWorkflow"
            : input.intent === "debug"
              ? "debugWorkflow"
              : input.intent === "refactor"
                ? "refactorWorkflow"
                : "editWorkflow",
        tool: input.step.tool as "write_file" | "apply_patch",
        toolCallId: input.step.toolCallId,
        path: readString(raw.path),
        changeId: readString(raw.changeId),
        diff: readString(raw.diff),
        diffTruncated: raw.truncated === true || raw.diffTruncated === true,
      }),
    };
  }
}

interface RenderInput {
  goal: string;
  workflowType: "editWorkflow" | "generateFileWorkflow" | "debugWorkflow" | "refactorWorkflow";
  tool: "write_file" | "apply_patch";
  toolCallId?: string;
  path?: string;
  changeId?: string;
  diff?: string;
  diffTruncated: boolean;
}

function renderEditExecutionContext(input: RenderInput): string {
  return [
    `${input.workflowType} execution phase:`,
    `goal: ${input.goal}`,
    `writeTool: ${input.tool}`,
    input.toolCallId ? `toolCallId: ${input.toolCallId}` : undefined,
    input.path ? `path: ${input.path}` : undefined,
    input.changeId ? `changeId: ${input.changeId}` : undefined,
    `diffTruncated: ${input.diffTruncated}`,
    input.diff ? ["diff:", input.diff].join("\n") : undefined,
    "",
    "The write-capable tool has already executed. Do not repeat the same write unless the diff is incomplete or wrong.",
    input.workflowType === "refactorWorkflow"
      ? "This is a staged refactor: complete verification for the current stage before starting the next stagedChanges item."
      : undefined,
    "Next, use the smallest useful verification step allowed by the current permission policy. If verification is unnecessary or unavailable, return final with changed files, changeId, and verification status.",
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
