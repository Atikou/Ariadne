import type { AgentIntentType } from "../IntentTypes.js";
import type { ToolOutcome, ToolObservationFailureKind } from "../../tools/toolOutcome.js";
import type { AgentToolStep } from "../toolStep.js";

export function buildDuplicateActionBlockReason(
  tool: string,
  record: { observationKind: string; executedCount: number },
  circuitOpen: boolean,
  path?: string,
): string {
  if (circuitOpen) {
    return [
      `重复失败保护已熔断：${tool}${path ? ` ${path}` : ""} 已确认 ${record.observationKind}。`,
      "禁止继续相同调用；必须输出 final，总结根因、已尝试步骤与建议修复。",
    ].join(" ");
  }
  const hint = recoveryHintForKind(record.observationKind as ToolObservationFailureKind);
  return [
    `相同工具+参数已记录观察失败 ${record.executedCount} 次（${record.observationKind}）。`,
    "禁止重复相同调用。",
    hint,
  ].join(" ");
}

function recoveryHintForKind(kind: ToolObservationFailureKind | string): string {
  switch (kind) {
    case "not_found":
      return "下一步：list_files、read_file package.json、search_text 或 locate_relevant_files；必要时 write_file 创建缺失项。";
    case "no_results":
      return "下一步：放宽 search_text 关键词/范围，或改用 locate_relevant_files。";
    case "command_failed":
      return "下一步：分析 stderr/stdout，进入 debug 流程，不要重复相同命令。";
    case "command_not_found":
      return "下一步：检查 package.json、依赖安装与 PATH，不要重复相同命令。";
    default:
      return `请更换策略或输出 final（观察类型：${kind}）。`;
  }
}

export interface ToolRecoveryWorkflowInput {
  intent: AgentIntentType | undefined;
  goal: string;
  step: AgentToolStep;
}

export function renderToolRecoveryContext(input: ToolRecoveryWorkflowInput): string | undefined {
  if (input.step.outcomeClass !== "observation_failure") return undefined;
  const intent = input.intent ?? "answer";
  const kind = input.step.outcomeKind;
  const outcome = stepOutcome(input.step);
  if (!outcome) return undefined;

  const recoveryIntents = new Set<AgentIntentType>(["run", "debug", "edit", "generate_file", "refactor"]);
  if (!recoveryIntents.has(intent)) return undefined;

  switch (kind) {
    case "not_found":
      return renderNotFoundRecovery(input.goal, intent, outcome);
    case "no_results":
      return renderNoResultsRecovery(input.goal, outcome);
    case "command_failed":
      return renderCommandFailedRecovery(input.goal, intent, outcome);
    case "command_not_found":
      return renderCommandNotFoundRecovery(input.goal, outcome);
    default:
      return undefined;
  }
}

function stepOutcome(step: AgentToolStep): ToolOutcome | undefined {
  if (!step.outcomeClass) return undefined;
  return {
    class: step.outcomeClass,
    kind: step.outcomeKind as ToolOutcome["kind"],
    message: step.outcomeMessage ?? step.error ?? "",
    recoverable: step.outcomeClass === "observation_failure",
    path: step.outcomePath,
    command: step.outcomeCommand,
    exitCode: step.outcomeExitCode,
    suggestedNextActions: step.suggestedNextActions,
  };
}

function renderNotFoundRecovery(goal: string, intent: AgentIntentType, outcome: ToolOutcome): string {
  const path = outcome.path ?? "目标路径";
  const parent = path.includes("/") ? path.replace(/\/[^/]+$/, "") : ".";
  return [
    "（系统）toolRecoveryWorkflow：not_found 恢复路线",
    `用户目标：${goal}`,
    `当前意图：${intent}`,
    `已确认：${path} 不存在（工具已正常执行，此为观察失败）。`,
    "",
    "按顺序执行（勿重复 read_file 同一路径）：",
    `1. list_files root=${parent}`,
    `2. read_file ${parent === "." ? "package.json" : `${parent}/package.json`}`,
    "3. search_text / locate_relevant_files 定位实际入口",
    path.endsWith("index.html")
      ? "4. 若缺 Vite 入口：write_file 创建 index.html（遵守权限/proposal）"
      : "4. 修正路径或创建缺失文件；无法继续则 final 说明根因",
  ].join("\n");
}

function renderNoResultsRecovery(goal: string, outcome: ToolOutcome): string {
  return [
    "（系统）toolRecoveryWorkflow：no_results 恢复路线",
    `用户目标：${goal}`,
    outcome.message,
    "按顺序：放宽 search_text 关键词 → 扩大 root/dir → locate_relevant_files → 输出 final 说明已搜索范围。",
  ].join("\n");
}

function renderCommandFailedRecovery(goal: string, intent: AgentIntentType, outcome: ToolOutcome): string {
  return [
    "（系统）toolRecoveryWorkflow：command_failed 恢复路线",
    `用户目标：${goal}`,
    `当前意图：${intent}`,
    outcome.message,
    `命令：${outcome.command ?? "unknown"}，exitCode=${outcome.exitCode ?? "?"}`,
    "按顺序：阅读 stderr 关键错误 → 定位相关源文件 → 最小修复 → 再运行验证；不要无分析重复同一命令。",
  ].join("\n");
}

function renderCommandNotFoundRecovery(goal: string, outcome: ToolOutcome): string {
  return [
    "（系统）toolRecoveryWorkflow：command_not_found 恢复路线",
    `用户目标：${goal}`,
    outcome.message,
    "按顺序：read_file package.json → 检查 scripts/依赖 → 提示安装或换用正确命令；不要重复相同 shell_run。",
  ].join("\n");
}
