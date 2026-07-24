import type { PlanStep } from "./types.js";

/** 从步骤状态聚合任务级状态（§4 状态流转）。 */
export function aggregateTaskStatus(steps: PlanStep[]): string {
  if (steps.length === 0) return "pending";
  if (steps.some((s) => s.status === "running")) return "in_progress";
  if (steps.some((s) => s.status === "waiting_agent")) return "blocked";
  if (steps.some((s) => s.status === "blocked")) return "blocked";
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "cancelled")) return "cancelled";
  if (steps.every((s) => s.status === "completed" || s.status === "skipped")) return "completed";
  if (steps.some((s) => s.status === "pending")) return "in_progress";
  return "in_progress";
}
