/**
 * 意图识别与工作流预扫描共用的模式词表与正则。
 *
 * IntentRouter（意图→运行模式）与 WorkflowPlanner（预扫描工作流选择）原先各维护一套
 * 中英文关键词/正则，易漂移。本模块为单一来源；语义不同的模式分开命名（如
 * INTENT_EDIT vs WORKFLOW_EDIT），避免合并后改变行为。
 */
import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentRunMode } from "./RunPolicyTypes.js";

// ── IntentRouter：意图分类（Unicode 正则，优先于 ASCII hasAny 兜底） ──────────

export const PLAN_INTENT_RE =
  /\u5148\u522b\u6539|\u4e0d\u8981\u4fee\u6539|\u4e0d\u505a\u4fee\u6539|\u53ea\u8bfb|\u8ba1\u5212\u6a21\u5f0f|\u8ba1\u5212|\u65b9\u6848|\u8bbe\u8ba1|\u89c4\u5212|\u62c6\u5206\u4efb\u52a1|\u5b9e\u73b0\u6b65\u9aa4|plan mode/;
export const REVIEW_INTENT_RE =
  /\u5ba1\u9605|\u5ba1\u67e5|review|\u4ee3\u7801\u8d28\u91cf|\u67b6\u6784\u95ee\u9898|\u6f5c\u5728 bug/;
export const VERIFY_INTENT_RE =
  /\u6d4b\u8bd5|\u7f16\u8bd1|\u6784\u5efa|build|typecheck|\u9a8c\u8bc1|\u68c0\u67e5\u662f\u5426|\u8dd1\u4e00\u4e0b/;
export const RUN_INTENT_RE =
  /\u8fd0\u884c|\u6267\u884c|\u5b89\u88c5|\u542f\u52a8|npm run|yarn|pnpm|python/;
export const DEBUG_INTENT_RE =
  /\u62a5\u9519|\u9519\u8bef|\u5931\u8d25|\u5d29\u4e86|\u4fee\u590d\u8fd9\u4e2a\u95ee\u9898|debug|\u8c03\u8bd5|\u6392\u9519/;
export const REFACTOR_INTENT_RE =
  /\u91cd\u6784|\u89e3\u8026|\u5faa\u73af\u5f15\u7528|\u5f3a\u4f9d\u8d56|\u67b6\u6784\u8c03\u6574|refactor/;
export const GENERATE_FILE_INTENT_RE =
  /(\u751f\u6210|\u65b0\u5efa|\u521b\u5efa|\u65b0\u589e|\u5199).{0,20}\u6587\u4ef6|generate file/;
export const EDIT_INTENT_RE =
  /\u4fee\u6539|\u8865\u5145\u5b8c\u6574|\u6539\u6210|\u66ff\u6362|\u76f4\u63a5\u5b9e\u73b0|\u5f00\u59cb\u4f18\u5316|\u7ee7\u7eed\u5b8c\u6210|\u5b9e\u73b0/;
export const SEARCH_INTENT_RE =
  /\u641c\u7d22|\u67e5\u627e|\u5b9a\u4f4d|\u5f15\u7528|\u5728\u54ea\u91cc|\u627e\u4e00\u4e0b|search/;
export const SUMMARIZE_INTENT_RE =
  /\u603b\u7ed3|\u6982\u62ec|\u5f53\u524d\u9879\u76ee\u8fdb\u5ea6|\u9879\u76ee\u5982\u4f55|summarize/;

/** IntentRouter ASCII 兜底关键词（inferUnicodeIntent 未命中时使用）。 */
export const INTENT_KEYWORD_FALLBACK: Readonly<Record<AgentIntentType, readonly string[]>> = {
  answer: [],
  plan: [
    "先别改",
    "不要修改",
    "不做修改",
    "只读",
    "计划模式",
    "计划",
    "方案",
    "设计",
    "规划",
    "拆分任务",
    "实现步骤",
    "plan mode",
  ],
  review: ["审阅", "审查", "review", "代码质量", "架构问题", "潜在 bug"],
  verify: ["测试", "编译", "构建", "build", "typecheck", "验证", "检查是否", "跑一下"],
  run: ["运行", "执行", "安装", "启动", "npm run", "yarn", "pnpm", "python"],
  debug: ["报错", "错误", "失败", "崩了", "修复这个问题", "debug", "调试", "排错"],
  refactor: ["重构", "解耦", "循环引用", "强依赖", "架构调整", "refactor"],
  generate_file: ["生成文件", "新建文件", "创建文件", "写一份", "新增文档", "generate file"],
  edit: ["修改", "补充完整", "改成", "替换", "直接实现", "开始优化", "继续完成", "实现"],
  search: ["搜索", "查找", "定位", "引用", "在哪里", "找一下", "search"],
  summarize: ["总结", "概括", "当前项目进度", "项目如何", "summarize"],
};

// ── 子 Agent 协作 vs 项目上下文（IntentRouter 专用） ───────────────────────────

export const SUBAGENT_COLLAB_RE = /\u5b50\s*(agent|agnet)|sub\s*agent/i;
export const GENERAL_ADVICE_RE =
  /\u6bcf\u5929|\u63d0\u5347\u81ea\u6211|\u6210\u957f|\u5b66\u4e60|\u751f\u6d3b|\u4e60\u60ef|\u5efa\u8bae|\u65b9\u6cd5|\u5982\u4f55|advice|self[-\s]?improve/i;
export const PROJECT_CONTEXT_RE =
  /\u5f53\u524d\u9879\u76ee|\u9879\u76ee|\u4ee3\u7801|\u4ed3\u5e93|\u6587\u4ef6|\u6a21\u5757|\u67b6\u6784|\u6d4b\u8bd5|src|docs|tests|codebase|repository/i;

// ── WorkflowPlanner：预扫描工作流选择 ─────────────────────────────────────────

export const EXPLICIT_NO_WORKFLOW_RE =
  /不要使用工具|不允许使用工具|不要扫描|不允许扫描|不要读取文件|不允许读取文件/;
export const EXPLICIT_NO_WORKFLOW_UNICODE_RE =
  /\u4e0d\u8981\u4f7f\u7528\u5de5\u5177|\u4e0d\u5141\u8bb8\u4f7f\u7528\u5de5\u5177|\u4e0d\u8981\u626b\u63cf|\u4e0d\u5141\u8bb8\u626b\u63cf|\u4e0d\u8981\u8bfb\u53d6\u6587\u4ef6|\u4e0d\u5141\u8bb8\u8bfb\u53d6\u6587\u4ef6/;
export const PROJECT_SCOPE_UNICODE_RE =
  /\u5f53\u524d\u9879\u76ee|\u9879\u76ee|\u4ee3\u7801|\u6a21\u5757|\u7ed3\u6784|\u67b6\u6784|\u4ed3\u5e93|\u8def\u7531|\u4e0a\u4e0b\u6587|\u5de5\u5177|\u65e5\u5fd7|\u914d\u7f6e|todolist|agent|src|docs|tests/;
export const TARGET_HINT_UNICODE_RE =
  /\.[tj]sx?|src\/|\u6a21\u5757|\u6587\u4ef6|\u51fd\u6570|\u7c7b|\u5de5\u5177|\u8def\u7531|\u5faa\u73af|AgentLoop|ToolRegistry|handler/;
export const ANALYSIS_UNICODE_RE =
  /\u5206\u6790|\u5ba1\u9605|\u68c0\u67e5|\u626b\u63cf|\u68b3\u7406|\u627e\u51fa|\u5b9a\u4f4d|\u67e5\u770b|\u751f\u6210.*\u8ba1\u5212|\u5347\u7ea7.*\u8ba1\u5212|review|scan|analyze/;
/** WorkflowPlanner 生成文件检测（比 INTENT 版更宽，含 create.*file）。 */
export const GENERATE_FILE_WORKFLOW_RE =
  /(\u751f\u6210|\u521b\u5efa|\u65b0\u589e|\u5199).{0,20}\u6587\u4ef6|generate.*file|create.*file|new file/;
/** WorkflowPlanner 编辑检测（比 INTENT 版更宽，含 fix/edit/patch）。 */
export const EDIT_WORKFLOW_RE =
  /\u4fee\u6539|\u66f4\u65b0|\u8c03\u6574|\u4fee\u590d|\u8865\u4e01|\u6539\u52a8|\u7f16\u8f91|fix|edit|update|patch|change/;
/** WorkflowPlanner 重构检测（与 REFACTOR_INTENT_RE 相同，复用）。 */
export const REFACTOR_WORKFLOW_RE = REFACTOR_INTENT_RE;
export const CODE_WORK_UNICODE_RE =
  /\u4fee\u6539|\u5b9e\u73b0|\u4fee\u590d|\u6dfb\u52a0|\u91cd\u6784|\u66f4\u65b0|\u7f16\u5199|\u8c03\u6574|fix|implement|refactor|add|update|patch|debug/;

// ── 意图→运行模式映射（统一词汇） ─────────────────────────────────────────────

const INTENT_TO_RUN_MODE: Readonly<Record<AgentIntentType, AgentRunMode>> = {
  answer: "chat",
  plan: "plan",
  edit: "implement",
  run: "debug",
  debug: "debug",
  review: "review",
  verify: "debug",
  summarize: "chat",
  search: "chat",
  refactor: "implement",
  generate_file: "implement",
};

const EXPLICIT_MODE_TO_INTENT: Readonly<Record<AgentRunMode, AgentIntentType>> = {
  chat: "answer",
  plan: "plan",
  implement: "edit",
  debug: "debug",
  review: "review",
};

/** 按优先级顺序尝试 Unicode 正则匹配意图（与 IntentRouter.inferUnicodeIntent 一致）。 */
const UNICODE_INTENT_ORDER: ReadonlyArray<{
  intent: Exclude<AgentIntentType, "answer">;
  pattern: RegExp;
}> = [
  { intent: "plan", pattern: PLAN_INTENT_RE },
  { intent: "review", pattern: REVIEW_INTENT_RE },
  { intent: "verify", pattern: VERIFY_INTENT_RE },
  { intent: "run", pattern: RUN_INTENT_RE },
  { intent: "debug", pattern: DEBUG_INTENT_RE },
  { intent: "refactor", pattern: REFACTOR_INTENT_RE },
  { intent: "generate_file", pattern: GENERATE_FILE_INTENT_RE },
  { intent: "edit", pattern: EDIT_INTENT_RE },
  { intent: "search", pattern: SEARCH_INTENT_RE },
  { intent: "summarize", pattern: SUMMARIZE_INTENT_RE },
];

/** ASCII 兜底意图检测顺序（与 IntentRouter.inferIntent 一致）。 */
const FALLBACK_INTENT_ORDER: readonly Exclude<AgentIntentType, "answer">[] = [
  "plan",
  "review",
  "verify",
  "run",
  "debug",
  "refactor",
  "generate_file",
  "edit",
  "search",
  "summarize",
];

// ── 工具函数 ─────────────────────────────────────────────────────────────────

export function normalizeIntentText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

export function hasAnyKeyword(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}

export function matchUnicodeIntent(text: string): AgentIntentType | undefined {
  for (const { intent, pattern } of UNICODE_INTENT_ORDER) {
    if (pattern.test(text)) return intent;
  }
  return undefined;
}

export function matchFallbackIntent(text: string): AgentIntentType | undefined {
  for (const intent of FALLBACK_INTENT_ORDER) {
    if (hasAnyKeyword(text, INTENT_KEYWORD_FALLBACK[intent])) return intent;
  }
  return undefined;
}

export function isGeneralSubagentCollaborationRequest(text: string): boolean {
  return (
    SUBAGENT_COLLAB_RE.test(text) &&
    GENERAL_ADVICE_RE.test(text) &&
    !PROJECT_CONTEXT_RE.test(text)
  );
}

export function intentForExplicitMode(mode: AgentRunMode): AgentIntentType {
  return EXPLICIT_MODE_TO_INTENT[mode];
}

export function runModeForIntent(intent: AgentIntentType): AgentRunMode {
  return INTENT_TO_RUN_MODE[intent];
}

export function explicitNoWorkflow(goal: string): boolean {
  return EXPLICIT_NO_WORKFLOW_RE.test(goal) || EXPLICIT_NO_WORKFLOW_UNICODE_RE.test(goal);
}

export function hasProjectScope(goal: string): boolean {
  const text = goal.toLowerCase();
  return PROJECT_SCOPE_UNICODE_RE.test(goal) || text.includes("codebase");
}

export function hasTargetHint(goal: string): boolean {
  return TARGET_HINT_UNICODE_RE.test(goal);
}

export function asksForAnalysis(goal: string): boolean {
  const text = goal.toLowerCase();
  return ANALYSIS_UNICODE_RE.test(goal) || text.includes("plan");
}

export function wantsGenerateFile(goal: string, intent?: AgentIntentType): boolean {
  return intent === "generate_file" || GENERATE_FILE_WORKFLOW_RE.test(goal);
}

export function wantsRefactor(goal: string, intent?: AgentIntentType): boolean {
  return intent === "refactor" || REFACTOR_WORKFLOW_RE.test(goal);
}

export function wantsEdit(goal: string, intent?: AgentIntentType): boolean {
  return intent === "edit" || EDIT_WORKFLOW_RE.test(goal);
}

export function wantsCodeWork(goal: string): boolean {
  return CODE_WORK_UNICODE_RE.test(goal);
}
