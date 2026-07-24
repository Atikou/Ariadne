import type { AgentIntentType } from "./IntentTypes.js";
import {
  afterPlanForVariant,
  detectPlanExecutionVariant,
  type PlanExecutionVariant,
} from "./planExecutionVariant.js";
import type { AgentExecutionStage, AgentRunMode, UserPermissionPolicy } from "./RunPolicyTypes.js";

export function buildRunPolicySystemHint(mode: AgentRunMode): string {
  if (mode === "plan") {
    return [
      "当前运行模式：plan（计划/只读分析）。",
      "执行层只暴露 read 权限工具；禁止写文件、打补丁、执行命令或任何副作用操作。",
      "如果预算不足，必须基于已获得的信息输出部分分析、缺失信息和继续建议。",
    ].join("\n");
  }
  if (mode === "review") {
    return [
      "当前运行模式：review（审阅/只读）。",
      "执行层只暴露 read 权限工具；请优先指出问题、风险和证据，不修改文件。",
      "可将可并行、上下文独立的子步骤委派给 dispatch_subagent（tasks: DelegatedTask[]）；子 Agent 在独立上下文中执行，只回收结构化结果。",
    ].join("\n");
  }
  if (mode === "debug") {
    return "当前运行模式：debug。请先定位证据，再在确认边界内执行必要工具；预算不足时输出已完成排查与下一步。";
  }
  if (mode === "implement") {
    return "当前运行模式：implement。可以在确认边界内完成实现；预算不足时输出已完成变更、缺失事项和继续建议。";
  }
  return "当前运行模式：chat。需要工具时遵守权限和确认边界；预算不足时输出已有信息与继续建议。";
}

export function inferRunPermissionPolicy(input: {
  mode: AgentRunMode;
  intent: string;
  autoConfirm: boolean;
}): UserPermissionPolicy {
  if (
    input.mode === "plan" ||
    input.mode === "review" ||
    input.intent === "answer" ||
    input.intent === "plan" ||
    input.intent === "review" ||
    input.intent === "summarize" ||
    input.intent === "search"
  ) {
    return "readOnly";
  }
  if (input.intent === "run" || input.intent === "verify" || input.intent === "debug") {
    return input.autoConfirm ? "autoRun" : "confirmBeforeRun";
  }
  return input.autoConfirm ? "autoEdit" : "confirmBeforeEdit";
}

export function executionStageForIntent(intent: AgentIntentType): AgentExecutionStage {
  if (intent === "plan") return "plan";
  if (intent === "verify" || intent === "run" || intent === "debug") return "verify";
  if (intent === "edit" || intent === "refactor" || intent === "generate_file") return "execute";
  return "analyze";
}

export function resolvePlanVariantForIntent(
  intent: AgentIntentType,
  message?: string,
): PlanExecutionVariant | undefined {
  if (intent !== "plan") return undefined;
  return detectPlanExecutionVariant(message) ?? "plan_only";
}
