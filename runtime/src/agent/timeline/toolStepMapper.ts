import { sanitizeToolArgs } from "./sanitizeToolArgs.js";
import type { ActivityStepType, StartActivityStepInput } from "./types.js";

export interface ToolActivityDescriptor {
  type: ActivityStepType;
  title: string;
  content?: string;
  collapsible?: boolean;
}

function pickPath(input: Record<string, unknown>): string | undefined {
  const path = input.path ?? input.file ?? input.target;
  return typeof path === "string" ? path : undefined;
}

function pickQuery(input: Record<string, unknown>): string | undefined {
  const q = input.query ?? input.pattern ?? input.goal;
  return typeof q === "string" ? q : undefined;
}

/** 将工具调用映射为公开 Timeline Step（不含模型 thought）。 */
export function mapToolToActivityStep(
  toolName: string,
  input: Record<string, unknown>,
): Omit<StartActivityStepInput, "runId"> {
  const path = pickPath(input);
  const query = pickQuery(input);
  const command = typeof input.command === "string" ? input.command : undefined;
  const sanitized = sanitizeToolArgs(input);

  const base = {
    metadata: {
      toolName,
      args: sanitized,
      filePath: path,
      command,
      collapsible: Boolean(command || Object.keys(sanitized).length > 2),
    },
  };

  switch (toolName) {
    case "read_file":
      return {
        type: "file_read",
        title: "正在读取文件",
        content: path ?? toolName,
        ...base,
      };
    case "write_file":
      return {
        type: "file_write",
        title: "正在写入文件",
        content: path ?? toolName,
        metadata: { ...base.metadata, changedFiles: path ? [path] : undefined },
      };
    case "apply_patch":
      return {
        type: "file_patch",
        title: "正在修改文件",
        content: path ?? toolName,
        metadata: { ...base.metadata, changedFiles: path ? [path] : undefined },
      };
    case "search_text":
    case "locate_relevant_files":
    case "project_scan":
    case "symbol_search":
    case "list_files":
      return {
        type: "file_search",
        title: "正在搜索相关文件",
        content: query ?? path ?? toolName,
        ...base,
      };
    case "shell_run":
      return {
        type: "shell",
        title: "正在执行命令",
        content: command ?? toolName,
        metadata: { ...base.metadata, collapsible: true },
      };
    case "git_status":
    case "git_diff":
      return {
        type: "validation",
        title: "正在检查 Git 状态",
        content: path ?? toolName,
        ...base,
      };
    case "diff_file":
      return {
        type: "validation",
        title: "正在对比文件变更",
        content: path ?? toolName,
        ...base,
      };
    case "dispatch_subagent": {
      const tasks = Array.isArray(input.tasks) ? (input.tasks as Array<{ goal?: string }>) : [];
      const goals = tasks.map((t) => t.goal).filter(Boolean);
      return {
        type: "tool_call",
        title: "正在派生子 Agent",
        content: goals.length > 0 ? `任务：${goals.join("；")}` : "子 Agent 协作",
        ...base,
      };
    }
    default:
      return {
        type: "tool_call",
        title: "正在调用工具",
        content: `${toolName}${path ? `: ${path}` : ""}`,
        ...base,
      };
  }
}

export const ACTIVITY_STEP_ICONS: Record<ActivityStepType, string> = {
  analysis: "💭",
  plan: "📋",
  todo: "☑️",
  tool_call: "🔧",
  file_search: "🔍",
  file_read: "📖",
  file_write: "✏️",
  file_patch: "🧩",
  shell: "💻",
  web_search: "🌐",
  validation: "🧪",
  summary: "✅",
  error: "⚠️",
  retry: "↻",
  escalation: "⬆️",
};
