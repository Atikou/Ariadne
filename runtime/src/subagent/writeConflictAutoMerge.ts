import type { ToolStorage } from "../tools/storage/ToolStorage.js";
import type { SubAgentRunResult, SubAgentWriteConflict, SubAgentWriteMergeAttempt } from "./types.js";
import type { WriteFilePickStrategy } from "./writeFileVersionPick.js";

export interface AutoMergeWriteOptions {
  arbitrationSummary?: string;
  writeFilePickStrategy?: WriteFilePickStrategy;
}

/** 在内存中对文本做唯一匹配的 search/replace；本函数不接触文件系统。 */
export function applySearchReplaceInMemory(
  content: string,
  search: string,
  replace: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  const first = content.indexOf(search);
  if (first === -1) return { ok: false, reason: "search 未找到" };
  const last = content.indexOf(search, first + search.length);
  if (last !== -1) return { ok: false, reason: "search 匹配多处" };
  return {
    ok: true,
    content: content.slice(0, first) + replace + content.slice(first + search.length),
  };
}

/**
 * 子 Agent 聚合层不拥有文件写入权限。
 * 冲突只能返回为待处理结果，后续必须由主 Agent 发起精确路径的 write_file/apply_patch，
 * 重新经过 PathPolicy、PermissionGuard、预算和 ToolLedger。
 */
export async function attemptAutoMergeWriteConflict(
  _storage: ToolStorage,
  _workspaceRoot: string,
  conflict: SubAgentWriteConflict,
  _results: SubAgentRunResult[],
  _mergeOptions?: AutoMergeWriteOptions,
): Promise<SubAgentWriteMergeAttempt> {
  return {
    path: conflict.path,
    status: "manual_required",
    reason: "聚合层禁止直接写盘；请由主 Agent 使用 write_file/apply_patch 处理该冲突并重新经过权限与路径校验",
    appliedPatches: 0,
  };
}

export async function attemptAutoMergeWriteConflicts(
  storage: ToolStorage,
  workspaceRoot: string,
  conflicts: SubAgentWriteConflict[],
  results: SubAgentRunResult[],
  mergeOptions?: AutoMergeWriteOptions,
): Promise<SubAgentWriteMergeAttempt[]> {
  return Promise.all(
    conflicts.map((conflict) =>
      attemptAutoMergeWriteConflict(storage, workspaceRoot, conflict, results, mergeOptions),
    ),
  );
}

export function formatWriteMergeSummary(attempts: SubAgentWriteMergeAttempt[]): string {
  if (attempts.length === 0) return "";
  const lines = ["## 写入冲突处理"];
  for (const attempt of attempts) {
    const tag = attempt.status === "merged" ? "已合并" : attempt.status === "manual_required" ? "待主 Agent 处理" : "跳过";
    lines.push(`- **${attempt.path}**（${tag}）：${attempt.reason}`);
  }
  return lines.join("\n");
}
