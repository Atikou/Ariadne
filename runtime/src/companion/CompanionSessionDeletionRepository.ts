import type { DatabaseSync } from "node:sqlite";

import {
  CompanionSessionDeletionPersistenceSchema,
  type CompanionMemoryContextDeletionStats,
  type CompanionSessionDeletionPersistence,
  type CompanionSessionDeletionStats,
} from "./CompanionSessionContracts.js";

const UNRESTRICTED_DATABASE = "unrestricted_memory";
type DatabasePrefix = "" | `${typeof UNRESTRICTED_DATABASE}.`;
type SessionScopedCountTable =
  | "companion_messages"
  | "companion_memory_candidates"
  | `${typeof UNRESTRICTED_DATABASE}.companion_memory_candidates`;

interface MemoryRow {
  id: string;
  status: string;
}

export interface CompanionSessionDeletionOperation {
  deletions: CompanionSessionDeletionPersistence;
  postCommitWarnings: Array<"unrestricted_memory_detach_failed">;
}

/** Owns the atomic primary + unrestricted-memory session deletion transaction. */
export class CompanionSessionDeletionRepository {
  constructor(private readonly db: DatabaseSync) {}

  deleteSession(
    sessionId: string,
    unrestrictedDbPath?: string,
  ): CompanionSessionDeletionOperation | null {
    const exists = this.db
      .prepare("SELECT 1 AS found FROM companion_sessions WHERE id=?")
      .get(sessionId) as { found: number } | undefined;
    if (!exists) return null;

    let unrestrictedAttached = false;
    let committed = false;
    const postCommitWarnings: CompanionSessionDeletionOperation["postCommitWarnings"] = [];
    try {
      if (unrestrictedDbPath) {
        this.db
          .prepare(`ATTACH DATABASE ? AS ${UNRESTRICTED_DATABASE}`)
          .run(unrestrictedDbPath);
        unrestrictedAttached = true;
      }

      const result = CompanionSessionDeletionPersistenceSchema.parse({
        primary: this.collectPrimaryStats(sessionId),
        unrestrictedMemory: unrestrictedAttached
          ? this.collectMemoryContextStats(`${UNRESTRICTED_DATABASE}.`, sessionId)
          : emptyMemoryContextStats(),
      });

      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.deleteMemoryContext("", sessionId, result.primary);
        if (unrestrictedAttached) {
          this.deleteMemoryContext(
            `${UNRESTRICTED_DATABASE}.`,
            sessionId,
            result.unrestrictedMemory,
          );
        }
        this.deleteVectorMetadata("", "summary", result.primary.deletedSummaryIds);
        this.db.prepare("DELETE FROM companion_sessions WHERE id=?").run(sessionId);
        this.db.exec("COMMIT");
        committed = true;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return { deletions: result, postCommitWarnings };
    } finally {
      if (unrestrictedAttached) {
        try {
          this.db.exec(`DETACH DATABASE ${UNRESTRICTED_DATABASE}`);
        } catch (error) {
          if (!committed) throw error;
          postCommitWarnings.push("unrestricted_memory_detach_failed");
        }
      }
    }
  }

  private collectPrimaryStats(sessionId: string): CompanionSessionDeletionStats {
    const deletedSummaryIds = (this.db
      .prepare("SELECT id FROM companion_summaries WHERE session_id=?")
      .all(sessionId) as unknown as Array<{ id: string }>).map((row) => row.id);
    const memory = this.collectMemoryContextStats("", sessionId);
    return {
      sessionId,
      deletedMessages: this.countSessionRows("companion_messages", sessionId),
      deletedSummaries: deletedSummaryIds.length,
      deletedSummaryIds,
      ...memory,
    };
  }

  private collectMemoryContextStats(
    prefix: DatabasePrefix,
    sessionId: string,
  ): CompanionMemoryContextDeletionStats {
    const rows = this.db
      .prepare(`SELECT id, status FROM ${prefix}companion_memories WHERE session_id=?`)
      .all(sessionId) as unknown as MemoryRow[];
    return {
      deletedCandidates: this.countSessionRows(
        `${prefix}companion_memory_candidates`,
        sessionId,
      ),
      deletedMemoryIds: rows
        .filter((memory) => memory.status !== "confirmed")
        .map((memory) => memory.id),
      detachedMemoryIds: rows
        .filter((memory) => memory.status === "confirmed")
        .map((memory) => memory.id),
    };
  }

  private deleteMemoryContext(
    prefix: DatabasePrefix,
    sessionId: string,
    stats: CompanionMemoryContextDeletionStats,
  ): void {
    this.db
      .prepare(
        `UPDATE ${prefix}companion_memories
         SET session_id=NULL, updated_at=?
         WHERE session_id=? AND status='confirmed'`,
      )
      .run(new Date().toISOString(), sessionId);
    this.db
      .prepare(
        `DELETE FROM ${prefix}companion_memories
         WHERE session_id=? AND status<>'confirmed'`,
      )
      .run(sessionId);
    this.db
      .prepare(`DELETE FROM ${prefix}companion_memory_candidates WHERE session_id=?`)
      .run(sessionId);
    this.deleteVectorMetadata(prefix, "memory", stats.deletedMemoryIds);
  }

  private deleteVectorMetadata(
    prefix: DatabasePrefix,
    sourceType: "memory" | "summary",
    sourceIds: string[],
  ): void {
    const statement = this.db.prepare(
      `DELETE FROM ${prefix}companion_vector_items WHERE source_type=? AND source_id=?`,
    );
    for (const sourceId of sourceIds) statement.run(sourceType, sourceId);
  }

  private countSessionRows(table: SessionScopedCountTable, sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id=?`)
      .get(sessionId) as { count: number };
    return row.count;
  }
}

function emptyMemoryContextStats(): CompanionMemoryContextDeletionStats {
  return {
    deletedCandidates: 0,
    deletedMemoryIds: [],
    detachedMemoryIds: [],
  };
}
