import type { AgentToolStep } from "./toolStep.js";
import { isSuccessfulToolStep } from "./toolStepOutcome.js";
import type { TaskSideEffectSummary } from "./task/TaskContext.js";

function fileFromStep(step: AgentToolStep): string | undefined {
  const input = step.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const path = (input as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
}

export function extractSideEffectSummary(steps: AgentToolStep[]): TaskSideEffectSummary {
  const wroteFiles: string[] = [];
  let ranShell = false;

  for (const step of steps) {
    if (!isSuccessfulToolStep(step)) continue;
    if (step.tool === "write_file" || step.tool === "apply_patch") {
      const path = fileFromStep(step);
      if (path) wroteFiles.push(path);
    }
    if (step.tool === "shell_run") {
      ranShell = true;
    }
  }

  return { wroteFiles: [...new Set(wroteFiles)], ranShell };
}
