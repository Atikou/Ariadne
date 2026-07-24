import type { AgentToolStep } from "../agent/toolStep.js";
import type { SubAgentRunResult, SubAgentWriteConflict } from "./types.js";

export type { SubAgentWriteConflict };

const WRITE_TOOLS = new Set(["write_file", "apply_patch"]);

export function extractWritePathsFromSteps(steps: AgentToolStep[]): Array<{ path: string; changeId?: string }> {
  const out: Array<{ path: string; changeId?: string }> = [];
  for (const step of steps) {
    if (!step.ok || !WRITE_TOOLS.has(step.tool)) continue;
    const input = step.input as Record<string, unknown> | undefined;
    const output = step.output as Record<string, unknown> | undefined;
    const path =
      typeof input?.path === "string"
        ? input.path
        : typeof output?.path === "string"
          ? output.path
          : undefined;
    if (!path) continue;
    const changeId = typeof output?.changeId === "string" ? output.changeId : undefined;
    out.push({ path: normalizeRelPath(path), changeId });
  }
  return out;
}

export function detectWriteConflicts(results: SubAgentRunResult[]): SubAgentWriteConflict[] {
  const byPath = new Map<string, { resultIds: Set<string>; taskIds: string[]; changeIds: string[] }>();
  for (const result of results) {
    if (result.status !== "completed") continue;
    for (const { path, changeId } of extractWritePathsFromSteps(result.steps)) {
      const entry = byPath.get(path) ?? { resultIds: new Set<string>(), taskIds: [], changeIds: [] };
      if (!entry.resultIds.has(result.id)) {
        entry.resultIds.add(result.id);
        entry.taskIds.push(result.taskId);
      }
      if (changeId) entry.changeIds.push(changeId);
      byPath.set(path, entry);
    }
  }
  const conflicts: SubAgentWriteConflict[] = [];
  for (const [path, entry] of byPath) {
    if (entry.resultIds.size < 2) continue;
    conflicts.push({
      path,
      taskIds: entry.taskIds,
      changeIds: entry.changeIds,
      reason: "多个子任务写入同一文件",
    });
  }
  return conflicts;
}

export function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
