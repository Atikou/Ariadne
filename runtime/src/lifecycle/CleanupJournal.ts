import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { lifecycleDir } from "./policy.js";
import {
  CleanupApplyResultSchema,
  CleanupHistoryResultSchema,
  CleanupJournalEntrySchema,
  type CleanupApplyResult,
  type CleanupHistoryResult,
  type CleanupJournalEntry,
} from "./StorageLifecycleContracts.js";

export class CleanupJournal {
  private readonly journalFile: string;

  constructor(dataDir: string) {
    const dir = lifecycleDir(dataDir);
    mkdirSync(dir, { recursive: true });
    this.journalFile = path.join(dir, "cleanup-runs.jsonl");
  }

  append(entry: CleanupJournalEntry): void {
    const validated = CleanupJournalEntrySchema.parse(entry);
    appendFileSync(this.journalFile, `${JSON.stringify(validated)}\n`, "utf-8");
  }

  listRecentRuns(limit = 50): CleanupHistoryResult {
    if (!existsSync(this.journalFile)) {
      return { runs: [], count: 0, invalidEntries: 0 };
    }
    const lines = readFileSync(this.journalFile, "utf-8").split("\n").filter(Boolean);
    const groups = new Map<string, CleanupApplyResult & { actionIds: Set<string> }>();
    let invalidEntries = 0;
    for (const line of lines) {
      try {
        const parsed = CleanupJournalEntrySchema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          invalidEntries += 1;
          continue;
        }
        const entry = parsed.data;
        const current = groups.get(entry.cleanupRunId) ?? {
          cleanupRunId: entry.cleanupRunId,
          mode: "apply" as const,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          applied: 0,
          skipped: 0,
          failed: 0,
          bytesFreed: 0,
          actions: [],
          actionIds: new Set<string>(),
        };
        if (current.actionIds.has(entry.actionId)) {
          invalidEntries += 1;
          continue;
        }
        current.actionIds.add(entry.actionId);
        current.startedAt = Math.min(current.startedAt, entry.startedAt);
        current.endedAt = Math.max(current.endedAt, entry.endedAt);
        current.applied += entry.status === "success" ? 1 : 0;
        current.skipped += entry.status === "skipped" ? 1 : 0;
        current.failed += entry.status === "failed" ? 1 : 0;
        current.bytesFreed += entry.bytesFreed;
        current.actions.push({
          actionId: entry.actionId,
          type: entry.type,
          target: entry.target,
          status: entry.status,
          bytesFreed: entry.bytesFreed,
          ...(entry.error ? { error: entry.error } : {}),
        });
        groups.set(entry.cleanupRunId, current);
      } catch {
        invalidEntries += 1;
      }
    }
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    const runs = [...groups.values()]
      .map(({ actionIds: _actionIds, ...run }) => CleanupApplyResultSchema.parse(run))
      .sort((left, right) => right.endedAt - left.endedAt)
      .slice(0, safeLimit);
    return CleanupHistoryResultSchema.parse({
      runs,
      count: runs.length,
      invalidEntries,
    });
  }
}

export function writeTombstone(dataDir: string, entry: {
  kind: "session_delete" | "session_purge" | "run_delete";
  sessionId?: string;
  runIds: string[];
  mode: "normal" | "purge";
}): void {
  const dir = lifecycleDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "tombstones.jsonl");
  const line = {
    id: randomUUID(),
    ...entry,
    deletedAt: Date.now(),
  };
  appendFileSync(file, `${JSON.stringify(line)}\n`, "utf-8");
}
