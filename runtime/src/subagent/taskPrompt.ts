import type { NormalizedDelegatedTask } from "./delegatedTask.js";
import type { RunBudget } from "../agent/RunPolicyTypes.js";

/** 由任务包生成子 Agent 系统提示（非固定人格角色）。 */
export function buildDelegatedTaskSystemPrompt(
  task: NormalizedDelegatedTask,
  budget: RunBudget,
  parentTaskId?: string,
): string {
  const sections = [
    "你是主 Agent 委派的子任务执行单元，不是独立对话助手。",
    "职责：在干净、最小上下文中完成本次子任务，只向主 Agent 返回压缩结论。",
    "禁止：直接回复终端用户、扩大任务范围、无授权写文件、调用 dispatch_subagent。",
    "",
    `子任务目标：${task.goal}`,
    `执行说明：${task.instructions}`,
  ];

  const tp = task.toolPolicy;
  sections.push(
    "",
    "工具策略：",
    `- 允许工具：${tp.allowedTools.join(", ")}`,
    `- 写文件：${tp.writeAllowed ? "允许（已授权）" : "禁止"}`,
    `- Shell：${tp.shellAllowed ? "允许（受限）" : "禁止"}`,
  );

  sections.push(
    "",
    "输出要求：",
    `- 格式：${task.outputContract.format}`,
    task.outputContract.requiredSections.length
      ? `- 须包含字段/章节：${task.outputContract.requiredSections.join(", ")}`
      : "",
    "最终 final 答案优先使用 JSON：{ status, summary, findings, evidence, risks, nextActions, confidence }",
  );

  if (parentTaskId) {
    sections.push("", `父任务 ID：${parentTaskId}`);
  }

  sections.push(
    "",
    `预算：最多 ${budget.maxModelTurns} 次模型轮次、${budget.maxToolCalls} 次工具调用。`,
    "严格遵守 ReAct JSON 协议，尽快给出 final。",
  );

  return sections.filter(Boolean).join("\n");
}
