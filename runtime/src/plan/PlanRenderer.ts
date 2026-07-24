import type { InternalTaskPlan, PublicPlanJson, RenderedPlanPreview } from "./types.js";

const PREVIEW_WARNING =
  "此 JSON 仅用于展示，不能被任务执行器直接执行。执行已审批计划请通过 POST /api/agent 提交 activatePlan、planId 与 version。";

/** InternalTaskPlan → 用户 Markdown（不含完整 tool args）。 */
export function renderPlanMarkdown(plan: InternalTaskPlan): string {
  const lines: string[] = ["# 执行计划预览", "", "## 目标", "", plan.goal, ""];

  if (plan.inputs.length) {
    lines.push("## 输入", "", ...plan.inputs.map((i) => `- ${i}`), "");
  }
  if (plan.outputs.length) {
    lines.push("## 输出", "", ...plan.outputs.map((o) => `- ${o}`), "");
  }
  if (plan.acceptanceCriteria.length) {
    lines.push("## 验收标准", "", ...plan.acceptanceCriteria.map((a) => `- ${a}`), "");
  }

  lines.push("## 步骤", "");
  plan.steps.forEach((step, index) => {
    const approval = step.requiresApproval ? "（需确认）" : "";
    const risk = step.riskLevel !== "low" ? ` [${step.riskLevel}]` : "";
    lines.push(`${index + 1}. **${step.title}**${risk}${approval}`);
    if (step.objective || step.description) {
      lines.push(`   - ${step.objective ?? step.description}`);
    }
    if (step.dependsOn.length) {
      lines.push(`   - 依赖：${step.dependsOn.join(", ")}`);
    }
    if (step.expectedOutput) {
      lines.push(`   - 预期：${step.expectedOutput}`);
    }
  });

  if (plan.scopeDetail.inScope.length || plan.scopeDetail.outOfScope.length) {
    lines.push("", "## 范围");
    if (plan.scopeDetail.inScope.length) {
      lines.push("", "纳入：", ...plan.scopeDetail.inScope.map((s) => `- ${s}`));
    }
    if (plan.scopeDetail.outOfScope.length) {
      lines.push("", "排除：", ...plan.scopeDetail.outOfScope.map((s) => `- ${s}`));
    }
  }

  const needsApproval = plan.steps.some((s) => s.requiresApproval);
  lines.push(
    "",
    "## 是否需要确认",
    "",
    needsApproval ? "需要用户确认后才可执行。" : "无高风险步骤，可按策略自动执行。",
  );
  lines.push("", "---", "", `_planId: ${plan.planId} · v${plan.version} · ${plan.status}_`);

  return lines.join("\n");
}

/** InternalTaskPlan → PublicPlanJson（executable 恒为 false，脱敏）。 */
export function renderPublicPlanJson(plan: InternalTaskPlan): PublicPlanJson {
  return {
    kind: "public_plan_preview",
    executable: false,
    planId: plan.planId,
    version: plan.version,
    title: plan.goal,
    summary: buildSummary(plan),
    steps: plan.steps.map((s) => ({
      stepId: s.stepId,
      title: s.title,
      description: s.objective ?? s.description,
      riskLevel: s.riskLevel,
      requiresApproval: s.requiresApproval ?? false,
    })),
    warnings: [PREVIEW_WARNING],
  };
}

export function buildRenderedPreviews(plan: InternalTaskPlan): {
  markdown: RenderedPlanPreview;
  json: RenderedPlanPreview;
} {
  const generatedAt = new Date().toISOString();
  const hash = plan.audit.planHash;
  const md = renderPlanMarkdown(plan);
  const publicJson = renderPublicPlanJson(plan);
  return {
    markdown: {
      planId: plan.planId,
      version: plan.version,
      format: "markdown",
      content: md,
      generatedAt,
      sourcePlanHash: hash,
    },
    json: {
      planId: plan.planId,
      version: plan.version,
      format: "json",
      content: JSON.stringify(publicJson, null, 2),
      generatedAt,
      sourcePlanHash: hash,
    },
  };
}

function buildSummary(plan: InternalTaskPlan): string {
  const n = plan.steps.length;
  const high = plan.steps.filter((s) => s.riskLevel === "high").length;
  if (high > 0) {
    return `本计划共 ${n} 个子任务，其中 ${high} 个为高风险步骤，执行前需审批。`;
  }
  return `本计划共 ${n} 个子任务。`;
}
