import type { AgentToolStep } from "../agent/toolStep.js";
import { isSuccessfulToolStep } from "../agent/toolStepOutcome.js";
import type { PlanReportQuality, PlanReportQualityIssue } from "./PlanReportContracts.js";

const MIN_MARKDOWN_CHARS = 280;
const SHELL_DISCLAIMER = "本次仅生成计划，未修改任何文件。";

function stepOutputText(step: AgentToolStep, maxChars = 6000): string {
  const layer = step.resultLayers?.userDisplay ?? step.resultLayers?.modelVisible;
  if (typeof layer === "string" && layer.trim()) return layer.trim().slice(0, maxChars);
  if (step.outcomeMessage?.trim()) return step.outcomeMessage.trim().slice(0, maxChars);
  if (typeof step.output === "string" && step.output.trim()) return step.output.trim().slice(0, maxChars);
  if (step.output != null) {
    try {
      return JSON.stringify(step.output, null, 2).slice(0, maxChars);
    } catch {
      return String(step.output).slice(0, maxChars);
    }
  }
  return "";
}

/** 判断是否为 normalizePlanMarkdown 生成的空壳（仅标题 + 任务理解 + 免责声明）。 */
export function isPlanReportShellOnly(markdown: string, goal: string): boolean {
  const trimmed = markdown.trim();
  if (trimmed.length >= MIN_MARKDOWN_CHARS) return false;
  const hasSubstantiveSection = /##\s*[2-9]\./.test(trimmed);
  const hasTodos = /^[-*]\s+\[[ xX]\]\s+P[0-3]/m.test(trimmed);
  if (hasSubstantiveSection || hasTodos) return false;
  return trimmed.includes(goal.trim()) || trimmed.length < 120;
}

export function assessPlanReportQuality(markdown: string, goal: string): PlanReportQuality {
  const issues: PlanReportQualityIssue[] = [];
  const trimmed = markdown.trim();

  if (!trimmed) issues.push("empty_answer");
  if (isPlanReportShellOnly(trimmed, goal)) issues.push("shell_only");
  if (trimmed.length < MIN_MARKDOWN_CHARS) issues.push("content_too_short");
  if (!/##\s*2\./.test(trimmed)) issues.push("missing_scan_section");
  if (!/##\s*6\.|TodoList/i.test(trimmed)) issues.push("missing_todo_section");
  const todoCount = (trimmed.match(/^[-*]\s+\[[ xX]\]\s+P[0-3]/gm) ?? []).length;
  if (todoCount === 0) issues.push("no_todos");

  const penalty = issues.length * 18;
  const score = Math.max(0, 100 - penalty);
  const acceptable =
    !issues.includes("empty_answer") &&
    !issues.includes("shell_only") &&
    todoCount >= 1 &&
    trimmed.length >= MIN_MARKDOWN_CHARS;

  return { acceptable, issues, score };
}

export function countSuccessfulReadSteps(steps: readonly AgentToolStep[]): number {
  return steps.filter(
    (s) =>
      isSuccessfulToolStep(s) &&
      (s.permission === "read" || s.tool === "project_scan" || s.tool === "context_pack"),
  ).length;
}

/** 用预扫描 / 只读工具结果拼装可审阅的计划报告（模型 final 过短时兜底）。 */
export function buildPlanReportFromToolSteps(goal: string, steps: readonly AgentToolStep[]): string {
  const useful = steps.filter((s) => isSuccessfulToolStep(s) && stepOutputText(s).length > 0);
  const scanLines: string[] = [];
  for (const step of useful) {
    const text = stepOutputText(step);
    if (!text) continue;
    const label = step.preflight ? `${step.tool}（预扫描）` : step.tool;
    scanLines.push(`### ${label}`, "", text, "");
  }

  const scanBody =
    scanLines.length > 0
      ? scanLines.join("\n").trim()
      : "_本轮未成功执行只读扫描工具，无法基于仓库事实生成计划。请检查工作区授权与模型配置后重试。_";

  const todoSeed = [
    "- [ ] P0 复核只读扫描结果：确认项目入口、路由与关键模块清单是否完整",
    "- [ ] P1 按扫描结果列出架构差距：模块边界 / 依赖 / 测试覆盖",
    "- [ ] P2 输出分阶段修复路线：每阶段目标、验收标准与回滚策略",
  ].join("\n");

  return [
    "# 计划模式分析结果",
    "",
    "## 1. 任务理解",
    goal,
    "",
    "## 2. 只读扫描结果",
    scanBody,
    "",
    "## 3. 当前完成度判断",
    useful.length > 0
      ? `已执行 ${useful.length} 次只读工具；下方 Todo 需结合扫描摘要人工确认后再编译执行。`
      : "尚未获得有效只读扫描输出，本报告为占位草案，不可直接当作完整架构分析。",
    "",
    "## 4. 差距分析",
    "_模型未输出完整差距分析；请根据 §2 扫描摘要补充，或重新发起分析。_",
    "",
    "## 5. 推荐实现路线",
    "_建议先完成 §6 Todo 中的复核项，再编译为 InternalTaskPlan。_",
    "",
    "## 6. TodoList",
    todoSeed,
    "",
    "## 7. 风险和注意事项",
    "- 本报告由系统根据工具扫描结果自动补全，不等同于模型完整推理结论。",
    "- 编译执行前请在 §② 审阅 Todo 中勾选并修订。",
    "",
    "## 8. 需要用户确认的事项",
    "- 是否以当前工作区为分析范围",
    "- 分阶段修复的优先级与是否允许副作用工具",
    "",
    "## 9. 下一步建议",
    "修订 Todo 后使用「编译选中 Todo」或「一键激活执行」。",
    "",
    SHELL_DISCLAIMER,
  ].join("\n");
}

export function resolvePlanReportMarkdown(input: {
  goal: string;
  modelAnswer?: string;
  planHandoffMarkdown?: string;
  steps?: readonly AgentToolStep[];
}): { markdown: string; enriched: boolean; quality: PlanReportQuality } {
  const primary = (input.planHandoffMarkdown ?? input.modelAnswer ?? "").trim();
  let markdown = primary;
  let enriched = false;

  let quality = assessPlanReportQuality(markdown, input.goal);
  if (!quality.acceptable && (input.steps?.length ?? 0) > 0) {
    const fallback = buildPlanReportFromToolSteps(input.goal, input.steps ?? []);
    if (primary && !isPlanReportShellOnly(primary, input.goal)) {
      markdown = `${primary}\n\n---\n\n## 附录：只读扫描原始摘要\n\n${buildPlanReportFromToolSteps(input.goal, input.steps ?? [])
        .split("\n")
        .slice(2)
        .join("\n")}`;
    } else {
      markdown = fallback;
    }
    enriched = true;
    quality = assessPlanReportQuality(markdown, input.goal);
  }

  return { markdown, enriched, quality };
}
