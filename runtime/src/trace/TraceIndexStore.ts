import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { applySqliteMigrations, getSchemaInfo, type SchemaInfo } from "../storage/sqliteMigration.js";
import { TRACE_INDEX_MIGRATIONS } from "./traceIndexMigrations.js";
import { ACTIVE_REL } from "./tracePaths.js";

export interface TraceIndexInsert {
  eventId: string;
  ts: number;
  runId?: string;
  sessionId?: string;
  eventType: string;
  status?: string;
  segmentPath: string;
  byteOffset?: number;
  byteLength?: number;
  redacted?: boolean;
}

export class TraceIndexStore {
  readonly db: DatabaseSync;
  readonly schemaVersion: number;
  readonly schemaInfo: SchemaInfo;

  constructor(private readonly indexDbPath: string) {
    mkdirSync(pathDir(indexDbPath), { recursive: true });
    this.db = new DatabaseSync(indexDbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    const { version } = applySqliteMigrations(this.db, TRACE_INDEX_MIGRATIONS);
    this.schemaVersion = version;
    this.schemaInfo = getSchemaInfo(this.db);
  }

  insert(row: TraceIndexInsert): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO trace_index
         (event_id, ts, run_id, session_id, event_type, status, segment_path, byte_offset, byte_length, redacted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.eventId,
        row.ts,
        row.runId ?? null,
        row.sessionId ?? null,
        row.eventType,
        row.status ?? null,
        row.segmentPath,
        row.byteOffset ?? null,
        row.byteLength ?? null,
        row.redacted === false ? 0 : 1,
      );
  }

  reassignSegment(oldSegmentPath: string, newSegmentPath: string): number {
    const result = this.db
      .prepare(`UPDATE trace_index SET segment_path=? WHERE segment_path=?`)
      .run(newSegmentPath, oldSegmentPath);
    return Number(result.changes);
  }

  findSegmentPathsByRunId(runId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT segment_path FROM trace_index WHERE run_id=? ORDER BY ts ASC`,
      )
      .all(runId) as Array<{ segment_path: string }>;
    return rows.map((r) => r.segment_path);
  }

  findSegmentPathsBySessionId(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT segment_path FROM trace_index WHERE session_id=? ORDER BY ts ASC`,
      )
      .all(sessionId) as Array<{ segment_path: string }>;
    return rows.map((r) => r.segment_path);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM trace_index`).get() as { c: number };
    return row.c;
  }

  deleteBySessionId(sessionId: string): number {
    const result = this.db.prepare(`DELETE FROM trace_index WHERE session_id=?`).run(sessionId);
    return Number(result.changes);
  }

  deleteByRunIds(runIds: string[]): number {
    if (runIds.length === 0) return 0;
    const placeholders = runIds.map(() => "?").join(",");
    const result = this.db
      .prepare(`DELETE FROM trace_index WHERE run_id IN (${placeholders})`)
      .run(...runIds);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

export const ACTIVE_SEGMENT_PATH = ACTIVE_REL.replace(/\\/g, "/");

function pathDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(0, idx) : p;
}
