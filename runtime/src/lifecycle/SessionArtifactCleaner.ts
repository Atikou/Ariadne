import path from "node:path";

import { ActivityRunStore } from "../agent/timeline/ActivityRunStore.js";
import type { DatabaseManager } from "../context/DatabaseManager.js";
import { safeDeleteDirectory, walkFiles } from "./fsUtils.js";
import { writeTombstone } from "./CleanupJournal.js";

export function findRunIdsForSession(db: DatabaseManager, sessionId: string): string[] {
  const rows = db.connection
    .prepare(`SELECT id FROM runs WHERE session_id=?`)
    .all(sessionId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export interface SessionArtifactCleanupResult {
  timelineDirs: string[];
  dataRunDirs: string[];
  bytesFreed: number;
}

export function cleanupSessionArtifacts(opts: {
  dataDir: string;
  workspaceRoot: string;
  sessionId: string;
  runIds: string[];
  deleteTimeline: boolean;
  tombstone?: { kind: "session_delete" | "session_purge"; mode: "normal" | "purge" } | false;
}): SessionArtifactCleanupResult {
  const timelineDirs: string[] = [];
  const dataRunDirs: string[] = [];
  let bytesFreed = 0;

  if (opts.deleteTimeline) {
    for (const runId of opts.runIds) {
      const timelineDir = path.join(opts.workspaceRoot, ".agent", "runs", runId);
      timelineDirs.push(timelineDir);
      bytesFreed += dirSizeSafe(timelineDir);
      safeDeleteDirectory(timelineDir);
    }
  }

  for (const runId of opts.runIds) {
    const dataRunDir = path.join(opts.dataDir, "runs", runId);
    dataRunDirs.push(dataRunDir);
    bytesFreed += dirSizeSafe(dataRunDir);
    safeDeleteDirectory(dataRunDir);
  }

  if (opts.tombstone !== false) {
    const ts = opts.tombstone ?? {
      kind: "session_delete" as const,
      mode: "normal" as const,
    };
    writeTombstone(opts.dataDir, {
      kind: ts.kind,
      sessionId: opts.sessionId,
      runIds: opts.runIds,
      mode: ts.mode,
    });
  }

  return { timelineDirs, dataRunDirs, bytesFreed };
}

export interface RunArtifactCleanupResult {
  timelineDir?: string;
  dataRunDir?: string;
  bytesFreed: number;
}

/** 删除单个 Run 的 timeline 与 data/runs 落盘。 */
export function deleteRunArtifacts(opts: {
  dataDir: string;
  workspaceRoot: string;
  runId: string;
  sessionId?: string;
  removeTimeline?: boolean;
}): RunArtifactCleanupResult {
  let bytesFreed = 0;
  let timelineDir: string | undefined;
  let dataRunDir: string | undefined;

  if (opts.removeTimeline !== false) {
    const store = new ActivityRunStore(opts.workspaceRoot);
    timelineDir = path.join(opts.workspaceRoot, ".agent", "runs", opts.runId);
    if (store.deleteRunDirectory(opts.runId)) {
      bytesFreed += dirSizeSafe(timelineDir);
    }
  }

  dataRunDir = path.join(opts.dataDir, "runs", opts.runId);
  bytesFreed += dirSizeSafe(dataRunDir);
  safeDeleteDirectory(dataRunDir);

  writeTombstone(opts.dataDir, {
    kind: "run_delete",
    sessionId: opts.sessionId,
    runIds: [opts.runId],
    mode: "normal",
  });

  return { timelineDir, dataRunDir, bytesFreed };
}

function dirSizeSafe(dir: string): number {
  try {
    return walkFiles(dir).reduce((s, f) => s + f.size, 0);
  } catch {
    return 0;
  }
}
