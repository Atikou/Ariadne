import type { ToolOutcome, ToolOutcomeClass, ToolOutcomeKind, SuggestedToolAction } from "../../tools/toolOutcome.js";

import { clipModelToolJson } from "../../util/toolResultLayers.js";

import { wrapExternalToolOutput } from "../../util/injection.js";

import type { AgentToolStep } from "../toolStep.js";



const OUTCOME_KIND_LABELS: Record<string, string> = {

  not_found: "目标不存在",

  not_a_file: "不是文件",

  no_results: "无匹配结果",

  command_failed: "命令执行后失败",

  command_not_found: "命令未找到",

  invalid_input: "参数无效",

  permission_denied: "权限拒绝",
  permission_required: "需要用户授权",

  policy_blocked: "策略阻止",

  readonly_mode_blocked: "只读模式禁止",

  workflow_capability_denied: "工作流能力禁止",

  capability_disabled: "能力禁用",

  budget_exhausted: "预算耗尽",

  timeout: "执行超时",

  tool_crash: "工具崩溃",
  empty_result: "空结果",
  no_project_info: "无项目信息",

  unknown_tool: "未知工具",

  ok: "符合预期",

};



function renderSuggestedActions(outcome: ToolOutcome): string {

  const actions = outcome.suggestedNextActions;

  if (!actions?.length) return "";

  const lines = actions.map((action, index) => {

    const inputJson = action.input ? ` ${JSON.stringify(action.input)}` : "";

    return `${index + 1}. ${action.tool}${inputJson} — ${action.reason}`;

  });

  return ["建议下一步：", ...lines].join("\n");

}



/** 观察失败：工具已执行，回灌结构化观察结果（非 execution error）。 */

export function renderToolOutcomeMessage(step: AgentToolStep): string | undefined {

  if (step.outcomeClass !== "observation_failure") return undefined;

  const outcome = stepToOutcome(step);

  const payload = {

    outcomeClass: outcome.class,

    outcomeKind: outcome.kind,

    message: outcome.message,

    recoverable: outcome.recoverable,

    path: outcome.path,

    command: outcome.command,

    exitCode: outcome.exitCode,

    suggestedNextActions: outcome.suggestedNextActions,

    output: step.resultLayers?.modelVisible ?? step.output,

  };

  const wrapped = wrapExternalToolOutput(step.tool, payload);

  const body = clipModelToolJson(wrapped);

  const kindLabel = OUTCOME_KIND_LABELS[outcome.kind] ?? outcome.kind;

  return [

    `工具「${step.tool}」已正常执行，但观察到目标状态不满足。`,

    "",

    `结果类型：${outcome.kind}（${kindLabel}）`,

    outcome.path ? `目标：${outcome.path}` : "",

    outcome.command ? `命令：${outcome.command}` : "",

    outcome.exitCode != null ? `退出码：${outcome.exitCode}` : "",

    `含义：${outcome.message}`,

    "",

    "说明：这不是工具崩溃，而是可恢复的观察失败。",

    "限制：不要在没有新信息的情况下重复相同工具与相同参数。",

    renderSuggestedActions(outcome),

    "",

    "工具回灌数据（JSON）：",

    body,

  ]

    .filter(Boolean)

    .join("\n");

}



export function renderExecutionErrorMessage(step: AgentToolStep): string {

  const kindLabel = OUTCOME_KIND_LABELS[step.outcomeKind ?? ""] ?? step.outcomeKind ?? "执行异常";

  const lines = [

    `工具「${step.tool}」执行异常（${kindLabel}）：${step.error ?? step.outcomeMessage ?? "未知错误"}`,

    "这是工具未能正常完成执行，与观察失败不同。",

  ];

  if (
    step.outcomeKind === "permission_denied" ||
    step.outcomeKind === "permission_required" ||
    step.outcomeKind === "policy_blocked" ||
    step.outcomeKind === "capability_disabled"
  ) {

    lines.push("需要用户授权或调整策略后才能继续。");

  } else if (step.outcomeKind === "budget_exhausted") {

    lines.push("本轮允许次数已用完；可缩小范围或请求提高预算后继续。");

  } else {
    lines.push("请修正入参、权限或换用其它工具；若无法继续请输出 final。");

  }

  return lines.join(" ");

}



function isSideEffectToolStep(step: AgentToolStep): boolean {
  return (
    step.tool === "shell_run" ||
    step.tool === "write_file" ||
    step.tool === "apply_patch" ||
    step.permission === "shell" ||
    step.permission === "write" ||
    step.permission === "network" ||
    step.permission === "dangerous"
  );
}

export function renderBlockedRecoveryMessage(step: AgentToolStep): string {
  if (step.recoveryCircuitOpen) {
    return [
      `工具「${step.tool}」未执行：${step.error}`,
      "重复失败保护已熔断；请如实总结根因、已尝试步骤与建议修复，禁止声称副作用已成功执行。",
    ].join("\n");
  }

  if (
    isSideEffectToolStep(step) &&
    (step.blockedReasonKind === "permission" ||
      step.blockedReasonKind === "workflow" ||
      step.outcomeKind === "permission_denied" ||
      step.outcomeKind === "permission_required" ||
      step.outcomeKind === "policy_blocked")
  ) {
    return [
      `工具「${step.tool}」未执行：${step.error}`,
      "该副作用尚未执行；请说明阻塞原因并等待用户授权或调整策略。",
      "禁止声称任务已成功完成，也不要输出假装已执行的 final。",
    ].join(" ");
  }

  return `工具「${step.tool}」未执行：${step.error}。请换策略或如实说明无法继续的原因。`;
}



function stepToOutcome(step: AgentToolStep): ToolOutcome {

  return {

    class: step.outcomeClass ?? "observation_failure",

    kind: (step.outcomeKind ?? "error") as ToolOutcomeKind,

    message: step.outcomeMessage ?? step.error ?? "",

    recoverable: step.outcomeClass === "observation_failure",

    path: step.outcomePath,

    command: step.outcomeCommand,

    exitCode: step.outcomeExitCode,

    suggestedNextActions: step.suggestedNextActions,

  };

}



export function applyOutcomeToStep(

  base: AgentToolStep,

  outcome: ToolOutcome,

  extras?: Partial<AgentToolStep>,

): AgentToolStep {

  return {

    ...base,

    ...extras,

    outcomeClass: outcome.class,

    outcomeKind: outcome.kind,

    outcomeMessage: outcome.message,

    outcomePath: outcome.path,

    outcomeCommand: outcome.command,

    outcomeExitCode: outcome.exitCode,

    suggestedNextActions: outcome.suggestedNextActions,

    ok: outcome.class === "observation_success",

    error:

      outcome.class === "execution_error" || outcome.class === "observation_failure"

        ? outcome.message

        : undefined,

  };

}



export function traceStatusForOutcome(outcomeClass: ToolOutcomeClass): string {

  switch (outcomeClass) {

    case "observation_success":

      return "ok";

    case "observation_failure":

      return "observation_failure";

    case "execution_error":

      return "execution_error";

  }

}
