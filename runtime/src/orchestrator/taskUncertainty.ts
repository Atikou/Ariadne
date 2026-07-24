import type { Plan } from "../agent/types.js";

/** 任务模式 → 计划模式回退结果（`fallbackToPlanOnUncertainty` 触发时）。 */
export interface ModeFallbackResult {
  triggered: true;
  reasons: string[];
  /** @deprecated 使用 planId/version；Planner legacy Plan 不再直接回传 API */
  revisedPlan?: Plan;
  planId?: string;
  version?: number;
  previewMarkdown?: string;
  planRunId?: string;
  error?: string;
}

export interface TaskUncertainty {
  uncertain: boolean;
  reasons: string[];
}

/** 任务执行遇阻：存在 blocked 或 failed 步骤视为不确定性。 */
export function detectTaskUncertainty(plan: Plan): TaskUncertainty {
  const reasons: string[] = [];
  for (const step of plan.steps) {
    if (step.status === "blocked") {
      reasons.push(`步骤 ${step.id}（${step.title}）阻塞：${step.error ?? "需确认或权限不足"}`);
    } else if (step.status === "failed") {
      reasons.push(`步骤 ${step.id}（${step.title}）失败：${step.error ?? "执行错误"}`);
    }
  }
  return { uncertain: reasons.length > 0, reasons };
}

/** 供 Planner 修订计划的现场摘要（只读上下文）。 */
export function buildPlanFallbackContext(plan: Plan, reasons: string[]): string {
  const stepLines = plan.steps.map((s) => {
    const detail = s.error ?? s.result ?? s.description ?? "";
    return `- ${s.id} [${s.status}] ${s.title}${detail ? `：${detail.slice(0, 400)}` : ""}`;
  });
  return [
    "任务模式执行遇阻，请基于以下现场输出**修订后的 JSON 计划**（仍只读分析，不要执行工具）。",
    "保留已完成步骤的结论，调整或替换未完成的步骤，并说明新的风险与确认点。",
    "",
    "### 不确定原因",
    ...reasons.map((r) => `- ${r}`),
    "",
    "### 各步骤状态",
    ...stepLines,
  ].join("\n");
}
