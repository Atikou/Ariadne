import type { AgentIntentType } from "../IntentTypes.js";
import { isSideEffectTaskIntent } from "./TaskContinuationEngine.js";

/** 可参与会话延续的任务 intent（含 plan，计划交接走 planHandoff）。 */
export function isContinuationEligibleIntent(intent: AgentIntentType): boolean {
  return isSideEffectTaskIntent(intent) || intent === "plan";
}

/** 活跃任务存在时，避免 legacy answer 把会话打回只读 chat。 */
export function shouldInheritActiveTaskOnUncertain(
  ctx: import("../task/TaskContext.js").TaskContext | undefined,
  fallbackIntent: AgentIntentType,
): boolean {
  if (!ctx?.isActive || !isContinuationEligibleIntent(ctx.intent)) return false;
  if (ctx.intent === "plan") return false;
  return fallbackIntent === "answer" || fallbackIntent === "summarize" || fallbackIntent === "search";
}
