import { z } from "zod";

export const PlanReportRequestHintSchema = z
  .object({
    code: z.literal("PLAN_REPORT_REQUEST"),
    error: z.string(),
    guidance: z.string(),
    suggestedEndpoint: z.literal("/api/plans/analyze"),
    suggestedBody: z
      .object({
        goal: z.string(),
      })
      .strict(),
  })
  .strict();

export type PlanReportRequestHint = z.infer<typeof PlanReportRequestHintSchema>;

const REPORT_TITLE_RE = /#\s*计划模式分析结果/;
const MARKDOWN_SECTION_RE = /(^|\n)##\s*\d+\.\s*/;

/**
 * /api/plans/draft is a machine-plan endpoint. Report-shaped prompts belong
 * to the dedicated read-only plan analysis workflow.
 */
export function detectPlanReportRequest(goal: string): PlanReportRequestHint | null {
  const trimmed = goal.trim();
  const lower = trimmed.toLowerCase();
  const explicitlyReport =
    REPORT_TITLE_RE.test(trimmed) ||
    (trimmed.includes("计划模式") &&
      (trimmed.includes("分析结果") ||
        trimmed.includes("报告") ||
        trimmed.includes("Markdown") ||
        lower.includes("markdown")));
  const sectionTemplate = MARKDOWN_SECTION_RE.test(trimmed);

  if (!explicitlyReport && !sectionTemplate) return null;

  return {
    code: "PLAN_REPORT_REQUEST",
    error: "/api/plans/draft 只生成可持久化的机器计划 JSON 草案，不接受 Markdown 报告型计划提示。",
    guidance: "需要给用户看的计划分析报告时，请调用 /api/plans/analyze。",
    suggestedEndpoint: "/api/plans/analyze",
    suggestedBody: {
      goal: trimmed,
    },
  };
}
