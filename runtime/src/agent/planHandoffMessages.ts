import type { PlanHandoffVariant } from "../policy/planHandoffTypes.js";

/** planVariant 仅影响交接面板文案，不影响是否生成交接。 */
export function planHandoffMessageForVariant(variant: PlanHandoffVariant): string {
  switch (variant) {
    case "plan_wait_approval":
      return "计划已完成，等待您批准执行。";
    case "plan_then_execute":
      return "计划已完成，是否继续执行？";
    case "plan_only":
    default:
      return "已完成计划，可选择按计划执行。";
  }
}

export function planHandoffPanelTitle(): string {
  return "计划已完成，是否按计划执行？";
}
