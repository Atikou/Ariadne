import type { UpdateTaskContextFromRunInput } from "./TaskContext.js";
import type { TaskPhase } from "./TaskContext.js";

const PARTIAL_STOP_REASONS = new Set([
  "completed_partial",
  "misleading_completion",
  "blocked_by_policy",
]);

export function resolvePhaseFromRun(input: UpdateTaskContextFromRunInput): TaskPhase {
  if (input.failed || input.stopReason === "error") return "failed";
  if (input.stopReason === "awaiting_plan_handoff") return "waiting_approval";
  if (input.stopReason === "awaiting_permission" || input.completionStatus === "awaiting_permission") {
    return "waiting_approval";
  }
  if (
    input.completionStatus === "completed_partial" ||
    input.stopReason === "completed_partial" ||
    (input.stopReason === "completed" && input.sideEffectsMet === false)
  ) {
    return "partial";
  }
  if (
    input.completionStatus === "misleading_completion" ||
    input.completionStatus === "blocked_by_policy" ||
    (input.stopReason && PARTIAL_STOP_REASONS.has(input.stopReason))
  ) {
    return "blocked";
  }
  if (input.stopReason === "completed" && input.sideEffectsMet !== false) return "completed";
  if (input.workflowTaskState === "completed") return "completed";
  if (input.workflowTaskState === "failed") return "failed";
  if (input.intent === "plan") return "planning";
  if (input.intent === "debug") return "debugging";
  if (input.intent === "verify" || input.intent === "run") return "verifying";
  if (input.intent === "edit" || input.intent === "generate_file" || input.intent === "refactor") {
    return "editing";
  }
  return "analyzing";
}
