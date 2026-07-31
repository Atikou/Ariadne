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
      "先使用只读工具确认环境事实，再收敛目标、约束、关键歧义和完成标准。",
      "最终必须返回 final action，并提供 plan 对象：",
      '{"action":"final","completionClaim":"completed","answer":"给用户的简短说明","plan":{"basePlanId":"仅修订时填写","baseVersion":1,"title":"计划标题","goal":"用户可观察的最终结果","facts":[{"id":"fact-1","statement":"已确认事实","evidence":"只读工具证据"}],"constraints":[{"id":"constraint-1","kind":"constraint|non_goal|assumption","statement":"约束"}],"clarifications":[{"id":"question-1","question":"仅关键问题","impact":"它会如何改变方案"}],"steps":[{"id":"step-1","title":"完整里程碑","dependsOn":[],"action":"做什么","scope":["影响文件或模块"],"expectedOutcome":"产出什么","verification":"如何证明完成"}],"completionCriteria":[{"id":"done-1","behavior":"用户可观察行为","verification":"可重复验证方法"}]}}',
      "存在会实质改变实现的关键歧义时，把问题写入 clarifications，steps 和 completionCriteria 必须为空；不得猜测后伪装成完整计划。",
      "没有关键歧义时，clarifications 必须为空，并提供 3 到 7 个粒度一致的执行里程碑和完整完成标准。",
      "禁止把环境检查结果列为执行步骤；禁止发明行数、时间限制；禁止把必要验证写成可选；禁止用“完善、优化、处理”等不可验收描述。",
      "计划阶段未写文件是正确行为，completionClaim 仍为 completed；不得因为尚未执行而声明 partial。",
      "如果正在修订系统提供的计划，必须原样回传 basePlanId 与 baseVersion；新计划不要填写这两个字段。",
      "如果预算不足，返回 partial 且说明缺失上下文，不得构造 plan 字段冒充可确认计划。",
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
