import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { DatabaseManager } from "../context/DatabaseManager.js";
import { atomicWriteFile } from "./fsUtils.js";
import { writeTombstone } from "./CleanupJournal.js";
import { cleanupSessionArtifacts } from "./SessionArtifactCleaner.js";
import { purgeSessionFromTraceSegments } from "./TraceSegmentPurger.js";
import { runSqliteMaintenance } from "./sqliteMaintenance.js";
import { compactSchedulerJournalFile } from "./schedulerJournalCompact.js";
import type { LifecyclePolicy } from "./types.js";
import type { TraceCatalog } from "../trace/traceCatalog.js";

export interface SessionPurgeResult {
  sessionId: string;
  runIds: string[];
  mode: "purge";
  trace: { segmentsRewritten: number; eventsRemoved: number; indexEntriesRemoved: number };
  tools: { toolLogsRemoved: number; fileChangesRemoved: number };
  routing: { routeLogsRemoved: number; callLogsRemoved: number; collaborationRunsRemoved: number; fallbackLogsRemoved: number };
  notifications: { linesRemoved: number };
  schedulerJournalBytesFreed: number;
  artifactsBytesFreed: number;
  vacuumed: boolean;
}

export interface SessionPrivacyPurgerDeps {
  dataDir: string;
  workspaceRoot: string;
  memoryDb: DatabaseManager;
  toolsDbPath?: string;
  traceCatalog: TraceCatalog;
  notificationFile: string;
  schedulerJournalFile?: string;
  policy: LifecyclePolicy;
}

export function purgeSessionPrivacy(
  deps: SessionPrivacyPurgerDeps,
  sessionId: string,
  runIds: string[],
): SessionPurgeResult {
  const trace = purgeSessionFromTraceSegments({
    catalog: deps.traceCatalog,
    sessionId,
    runIds,
  });

  const tools = purgeToolsDb(deps.toolsDbPath, sessionId);
  const routing = purgeRoutingTables(deps.memoryDb, sessionId);
  const notifications = purgeNotificationsJournal(deps.notificationFile, sessionId, runIds);
  const schedulerJournalBytesFreed =
    deps.schedulerJournalFile && deps.policy.cleanup.autoEnabled
      ? compactSchedulerJournalFile(deps.schedulerJournalFile)
      : 0;

  const artifacts = cleanupSessionArtifacts({
    dataDir: deps.dataDir,
    workspaceRoot: deps.workspaceRoot,
    sessionId,
    runIds,
    deleteTimeline: deps.policy.privacy.deleteActivityRunsOnSessionDelete,
    tombstone: false,
  });

  writeTombstone(deps.dataDir, {
    kind: "session_purge",
    sessionId,
    runIds,
    mode: "purge",
  });

  const vacuumed = runSqliteMaintenance(deps.memoryDb, deps.toolsDbPath, deps.policy);

  return {
    sessionId,
    runIds,
    mode: "purge",
    trace,
    tools,
    routing,
    notifications,
    schedulerJournalBytesFreed,
    artifactsBytesFreed: artifacts.bytesFreed,
    vacuumed,
  };
}

function purgeToolsDb(toolsDbPath: string | undefined, sessionId: string): {
  toolLogsRemoved: number;
  fileChangesRemoved: number;
} {
  if (!toolsDbPath || !existsSync(toolsDbPath)) {
    return { toolLogsRemoved: 0, fileChangesRemoved: 0 };
  }
  const db = new DatabaseSync(toolsDbPath);
  try {
    const toolLogs = db
      .prepare(`DELETE FROM tool_logs WHERE session_id=?`)
      .run(sessionId);
    const fileChanges = db
      .prepare(`DELETE FROM file_changes WHERE session_id=?`)
      .run(sessionId);
    return {
      toolLogsRemoved: Number(toolLogs.changes),
      fileChangesRemoved: Number(fileChanges.changes),
    };
  } finally {
    db.close();
  }
}

function purgeRoutingTables(memoryDb: DatabaseManager, sessionId: string): {
  routeLogsRemoved: number;
  callLogsRemoved: number;
  collaborationRunsRemoved: number;
  fallbackLogsRemoved: number;
} {
  const conn = memoryDb.connection;
  const routeLogs = conn.prepare(`DELETE FROM model_route_logs WHERE session_id=?`).run(sessionId);
  const callLogs = conn.prepare(`DELETE FROM model_call_logs WHERE session_id=?`).run(sessionId);
  const collab = conn.prepare(`DELETE FROM model_collaboration_runs WHERE session_id=?`).run(sessionId);
  const fallback = conn.prepare(`DELETE FROM fallback_logs WHERE session_id=?`).run(sessionId);
  return {
    routeLogsRemoved: Number(routeLogs.changes),
    callLogsRemoved: Number(callLogs.changes),
    collaborationRunsRemoved: Number(collab.changes),
    fallbackLogsRemoved: Number(fallback.changes),
  };
}

function purgeNotificationsJournal(
  notificationFile: string,
  sessionId: string,
  runIds: string[],
): { linesRemoved: number } {
  if (!existsSync(notificationFile)) return { linesRemoved: 0 };
  const runIdSet = new Set(runIds);
  const lines = readFileSync(notificationFile, "utf-8").split("\n").filter((l) => l.trim());
  const kept: string[] = [];
  let removed = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.op === "consume") {
        kept.push(line);
        continue;
      }
      const payload = parsed.payload as Record<string, unknown> | undefined;
      const matchRun =
        typeof parsed.runId === "string" && runIdSet.has(parsed.runId);
      const matchPayloadSession = payload?.sessionId === sessionId;
      const matchPayloadRun =
        typeof payload?.runId === "string" && runIdSet.has(payload.runId);
      if (matchRun || matchPayloadSession || matchPayloadRun) {
        removed += 1;
        continue;
      }
    } catch {
      // keep
    }
    kept.push(line);
  }

  if (removed > 0) {
    atomicWriteFile(notificationFile, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  }
  return { linesRemoved: removed };
}
