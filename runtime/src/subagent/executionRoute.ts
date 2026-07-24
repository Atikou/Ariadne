import type { NormalizedDelegatedTask, DelegatedTaskToolPolicy } from "./delegatedTask.js";

export type ExecutionMode = "direct" | "delegate" | "tool" | "review" | "ask_user";

/** 动态路由对当前步骤的执行策略决策。 */
export interface ExecutionRoute {
  mode: ExecutionMode;
  reason: string;
  delegatedTask?: NormalizedDelegatedTask;
  selectedModel?: {
    provider: "local" | "remote";
    model: string;
    reason: string;
  };
  contextPolicy?: {
    includeFiles?: string[];
    includeSnippets?: string[];
    includeLogs?: string[];
    maxTokens: number;
  };
  toolPolicy?: DelegatedTaskToolPolicy;
  resultPolicy?: {
    returnFormat: "summary" | "json" | "markdown";
    compress: boolean;
    requiredFields: string[];
  };
}

/** 主 Agent 侧用于 ExecutionRouter 判断的任务状态摘要。 */
export interface TaskStateSnapshot {
  /** 用户或主 Agent 当前步骤的自然语言目标。 */
  goal: string;
  /** 可选附加上下文（主 Agent 摘录，非全量历史）。 */
  contextSnippet?: string;
  /** 显式请求委派（如 dispatch_subagent 工具调用）。 */
  forceDelegate?: boolean;
  /** 是否涉及写文件。 */
  needsWrite?: boolean;
  /** 是否涉及 shell。 */
  needsShell?: boolean;
  /** 并行子任务数量提示。 */
  parallelHints?: number;
}
