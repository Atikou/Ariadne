import { randomUUID } from "node:crypto";

import type { UserVisiblePlan, UserVisibleTodo } from "./types.js";

const DEFAULT_PLAN_SECTIONS = [
  "## 1. 任务理解",
  "## 2. 只读扫描结果",
  "## 3. 当前完成度判断",
  "## 4. 差距分析",
  "## 5. 推荐实现路线",
  "## 6. TodoList",
  "## 7. 风险和注意事项",
  "## 8. 需要用户确认的事项",
  "## 9. 下一步建议",
];

export interface BuildPlanAnalysisPromptInput {
  goal: string;
  context?: string;
}

export function buildPlanAnalysisPrompt(input: BuildPlanAnalysisPromptInput): string {
  const context = input.context?.trim();
  return [
    "请进入计划报告模式，只读分析，不要修改文件，不要执行写入或安装命令。",
    "你必须先使用 project_scan / locate_relevant_files / context_pack 等只读工具了解仓库，再输出 final。",
    "最终回答必须放在 JSON 的 answer 字段内，且为完整 Markdown（含下方所有章节），禁止只输出标题或空 answer。",
    "请输出给用户阅读的 Markdown 计划文档，必须包含以下固定结构：",
    "# 计划模式分析结果",
    ...DEFAULT_PLAN_SECTIONS,
    "",
    "TodoList 中每项请尽量使用如下格式：- [ ] P0 标题：目标 / 验收 / 风险",
    "结尾必须明确写出：本次仅生成计划，未修改任何文件。",
    "",
    `用户目标：${input.goal}`,
    context ? `\n补充上下文：\n${context}` : "",
  ].join("\n");
}

export interface RenderUserVisiblePlanInput {
  sourceRunId: string;
  sessionId?: string;
  goal: string;
  markdown: string;
}

export function renderUserVisiblePlan(input: RenderUserVisiblePlanInput): UserVisiblePlan {
  const normalized = normalizePlanMarkdown(input.markdown, input.goal);
  const todos = extractTodos(normalized);
  return {
    kind: "user_visible_plan",
    id: `uvp_${randomUUID()}`,
    sourceRunId: input.sourceRunId,
    sessionId: input.sessionId,
    title: inferTitle(normalized, input.goal),
    markdown: normalized,
    todos,
    risks: extractRisks(normalized),
    requiresUserConfirmation: todos.some((t) => t.requiresUserConfirmation) || todos.length > 0,
    createdAt: new Date().toISOString(),
  };
}

function normalizePlanMarkdown(markdown: string, goal: string): string {
  const trimmed = markdown.trim();
  const withTitle = trimmed.startsWith("# ") ? trimmed : `# 计划模式分析结果\n\n${trimmed}`;
  const withGoal = withTitle.includes("## 1. 任务理解")
    ? withTitle
    : `${withTitle}\n\n## 1. 任务理解\n${goal}`;
  if (/本次仅生成计划，未修改任何文件。/.test(withGoal)) return withGoal;
  return `${withGoal}\n\n本次仅生成计划，未修改任何文件。`;
}

function inferTitle(markdown: string, fallback: string): string {
  const first = markdown.split(/\r?\n/).find((line) => line.startsWith("# "));
  return first?.replace(/^#\s+/, "").trim() || fallback;
}

function extractTodos(markdown: string): UserVisibleTodo[] {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[[ xX]\]\s+P[0-3]/.test(line) || /^[-*]\s+P[0-3]/.test(line));
  return lines.map((line, index) => {
    const text = line.replace(/^[-*]\s+(?:\[[ xX]\]\s+)?/, "");
    const match = text.match(/^(P[0-3])\s*[:：-]?\s*(.+)$/);
    const priority = (match?.[1] ?? "P2") as UserVisibleTodo["priority"];
    const body = match?.[2]?.trim() || text;
    const [titlePart, ...rest] = body.split(/[：:]/);
    const title = titlePart?.trim() || `Todo ${index + 1}`;
    const detail = rest.join("：").trim() || body;
    const riskLevel = /高风险|危险|删除|部署|推送|数据库|migration/i.test(body)
      ? "high"
      : /写|修改|实现|补丁|命令|安装/i.test(body)
        ? "medium"
        : "low";
    return {
      id: `todo-${index + 1}`,
      priority,
      title,
      goal: detail,
      implementationIdea: detail,
      acceptanceCriteria: inferAcceptance(detail),
      riskLevel,
      allowAutoImplement: riskLevel === "low",
      requiresUserConfirmation: riskLevel !== "low",
    };
  });
}

function inferAcceptance(text: string): string[] {
  const acceptance = text.match(/验收\s*[\/：:]\s*([^/]+)/);
  if (acceptance?.[1]?.trim()) return [acceptance[1].trim()];
  return ["用户确认该 Todo 已完成"];
}

function extractRisks(markdown: string): UserVisiblePlan["risks"] {
  const riskLines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /风险|注意/.test(line) && /^[-*]/.test(line));
  return riskLines.slice(0, 10).map((line, index) => ({
    id: `risk-${index + 1}`,
    level: /高|危险|删除|部署|推送/.test(line) ? "high" : "medium",
    title: line.replace(/^[-*]\s*/, ""),
  }));
}
