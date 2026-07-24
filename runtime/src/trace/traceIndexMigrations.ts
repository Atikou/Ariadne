import type { DatabaseSync } from "node:sqlite";

import type { SqliteMigration } from "../storage/sqliteMigration.js";

export const TRACE_INDEX_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "trace_index_v1",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trace_index (
          event_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          run_id TEXT,
          session_id TEXT,
          event_type TEXT NOT NULL,
          status TEXT,
          segment_path TEXT NOT NULL,
          byte_offset INTEGER,
          byte_length INTEGER,
          redacted INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_trace_index_run_id ON trace_index(run_id);
        CREATE INDEX IF NOT EXISTS idx_trace_index_session_id ON trace_index(session_id);
        CREATE INDEX IF NOT EXISTS idx_trace_index_ts ON trace_index(ts);
        CREATE INDEX IF NOT EXISTS idx_trace_index_type ON trace_index(event_type);
        CREATE INDEX IF NOT EXISTS idx_trace_index_segment ON trace_index(segment_path);
      `);
    },
  },
];

export type TraceIndexDb = DatabaseSync;
