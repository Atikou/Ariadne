import type { SubAgentRunResult, SubAgentWriteConflict } from "./types.js";
import { normalizeRelPath } from "./writeConflictMerge.js";

export type WriteFilePickStrategy = "latest" | "earliest" | "arbitration";

export interface WriteFilePickHint {
  path: string;
  changeId?: string;
  taskId?: string;
  manual?: boolean;
}

export interface WriteFileCandidate {
  changeId?: string;
  taskId: string;
  goal: string;
  content: string;
  sortKey: number;
  createdAt: string;
}

const WRITE_PICK_RE = /^WRITE_PICK:\s*(.+)$/gim;

export function parseWriteFilePickHints(summary: string): WriteFilePickHint[] {
  const hints: WriteFilePickHint[] = [];
  for (const match of summary.matchAll(WRITE_PICK_RE)) {
    const body = match[1]?.trim();
    if (!body) continue;
    const parts = Object.fromEntries(
      body.split(/\s+/).map((token) => {
        const idx = token.indexOf("=");
        if (idx <= 0) return [token, ""];
        return [token.slice(0, idx), token.slice(idx + 1)];
      }),
    ) as Record<string, string>;
    const path = parts.path;
    if (!path) continue;
    const manual = parts.manual === "true" || parts.manual === "1" || body.includes("manual");
    hints.push({
      path: normalizeRelPath(path),
      changeId: parts.changeId,
      taskId: parts.taskId,
      manual,
    });
  }
  return hints;
}

export function collectWriteFileCandidates(
  results: SubAgentRunResult[],
  targetPath: string,
  getCreatedAt: (changeId: string) => string | undefined,
): WriteFileCandidate[] {
  const norm = normalizeRelPath(targetPath);
  const candidates: WriteFileCandidate[] = [];
  for (let ri = 0; ri < results.length; ri++) {
    const result = results[ri]!;
    if (result.status !== "completed") continue;
    for (const step of result.steps) {
      if (!step.ok || step.tool !== "write_file") continue;
      const input = step.input as Record<string, unknown> | undefined;
      const output = step.output as Record<string, unknown> | undefined;
      const stepPath = typeof input?.path === "string" ? normalizeRelPath(input.path) : undefined;
      if (stepPath !== norm) continue;
      const content = typeof input?.content === "string" ? input.content : undefined;
      if (content == null) continue;
      const changeId = typeof output?.changeId === "string" ? output.changeId : undefined;
      const createdAt = changeId ? getCreatedAt(changeId) ?? "" : "";
      candidates.push({
        changeId,
        taskId: result.taskId,
        goal: result.goal,
        content,
        sortKey: ri * 1000 + step.iteration,
        createdAt,
      });
    }
  }
  candidates.sort((a, b) => {
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    return a.sortKey - b.sortKey;
  });
  return candidates;
}

export function pickWriteFileCandidate(
  candidates: WriteFileCandidate[],
  conflict: SubAgentWriteConflict,
  strategy: WriteFilePickStrategy,
  arbitrationSummary?: string,
): { candidate: WriteFileCandidate; strategy: WriteFilePickStrategy; reason: string } | { manual: true; reason: string } {
  if (candidates.length < 2) {
    return { manual: true, reason: "write_file 候选不足" };
  }

  const path = normalizeRelPath(conflict.path);
  const hints = arbitrationSummary ? parseWriteFilePickHints(arbitrationSummary) : [];
  const hint = hints.find((h) => h.path === path);

  if (strategy === "arbitration" && hint) {
    if (hint.manual) {
      return { manual: true, reason: "仲裁建议人工复核该文件" };
    }
    if (hint.changeId) {
      const byId = candidates.find((c) => c.changeId === hint.changeId);
      if (byId) {
        return { candidate: byId, strategy: "arbitration", reason: `仲裁选定 changeId=${hint.changeId}` };
      }
    }
    if (hint.taskId) {
      const byTask = [...candidates].reverse().find((c) => c.taskId === hint.taskId);
      if (byTask) {
        return { candidate: byTask, strategy: "arbitration", reason: `仲裁选定 taskId=${hint.taskId}` };
      }
    }
    if (arbitrationSummary) {
      return { manual: true, reason: "仲裁未给出可解析的 WRITE_PICK，需人工选版" };
    }
  }

  const fallback: WriteFilePickStrategy = strategy === "arbitration" ? "latest" : strategy;
  const picked = fallback === "earliest" ? candidates[0]! : candidates[candidates.length - 1]!;
  return {
    candidate: picked,
    strategy: fallback,
    reason:
      fallback === "earliest"
        ? `按最早写入选版（changeId=${picked.changeId ?? "?"})`
        : `按最晚写入选版（changeId=${picked.changeId ?? "?"})`,
  };
}
