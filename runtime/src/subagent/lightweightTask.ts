import { countFileReferences } from "./routingSignals.js";
import type { DelegatedTask } from "./delegatedTask.js";

const PROJECT_TOOL_NAMES = new Set([
  "read_file",
  "list_files",
  "search_text",
  "locate_relevant_files",
  "symbol_search",
  "context_pack",
  "git_status",
  "git_diff",
  "diff_file",
  "project_scan",
  "project_index_update",
]);

/** 纯文本只读子任务：无写/Shell、无文件引用、未声明项目工具 → 可走轻量 fast path。 */
export function isLightweightReadonlySubagentTask(task: DelegatedTask): boolean {
  const tp = task.toolPolicy;
  if (tp?.writeAllowed || tp?.shellAllowed) return false;

  const text = [task.goal, task.instructions, task.input].filter(Boolean).join("\n");
  if (countFileReferences(text) > 0) return false;
  if ((task.context?.files?.length ?? 0) > 0) return false;

  const allowed = tp?.allowedTools ?? [];
  if (allowed.length > 0 && allowed.some((name) => PROJECT_TOOL_NAMES.has(name))) {
    return false;
  }

  return true;
}
