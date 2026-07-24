/**
 * 文件定位工具的启发式常量（可配置数据层，避免散落在工具实现里）。
 */

export const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
]);

export const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "eslint.config.js",
  "README.md",
  "AGENTS.md",
]);

export const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "当前",
  "项目",
  "系统",
  "这个",
  "一个",
  "需要",
  "实现",
  "完善",
  "问题",
]);

/** project_scan 识别的顶层源码/文档根目录。 */
export const DEFAULT_SOURCE_ROOTS = [
  "src",
  "tests",
  "test",
  "docs",
  "public",
  "config",
] as const;

export const SYMBOL_CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** 关键词→路径提示（中英双语关键词映射同一目录）。 */
export const KEYWORD_PATH_HINTS: ReadonlyArray<{
  readonly match: (normalized: string, raw: string) => boolean;
  readonly path: string;
}> = [
  { match: (n, r) => n.includes("plan") || r.includes("计划"), path: "src/plan" },
  { match: (n, r) => n.includes("agent") || r.includes("智能体"), path: "src/agent" },
  { match: (n, r) => n.includes("context") || r.includes("上下文"), path: "src/context" },
  { match: (n, r) => n.includes("tool") || r.includes("工具"), path: "src/tools" },
  { match: (n, r) => n.includes("router") || r.includes("路由"), path: "src/model-router" },
  { match: (n, r) => n.includes("server") || r.includes("接口"), path: "src/server" },
  { match: (n, r) => n.includes("test") || r.includes("测试"), path: "tests" },
  { match: (n, r) => n.includes("doc") || r.includes("文档"), path: "docs" },
];

/** 审阅模式无其他提示时的默认扫描根。 */
export const REVIEW_MODE_DEFAULT_PATH = "src";
