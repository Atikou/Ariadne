import type { ToolPermission } from "../core/permissions.js";

/** 按权限推断默认可用工具（模型未给出 availableTools 时补全）。 */
export function inferAvailableTools(permissions: ToolPermission[]): string[] {
  const tools = new Set<string>();
  if (permissions.includes("read")) {
    tools.add("read_file");
    tools.add("list_files");
    tools.add("search_text");
    tools.add("git_diff");
  }
  if (permissions.includes("write")) {
    tools.add("write_file");
    tools.add("apply_patch");
    tools.add("diff_file");
  }
  if (permissions.includes("shell")) {
    tools.add("shell_run");
  }
  return [...tools];
}
