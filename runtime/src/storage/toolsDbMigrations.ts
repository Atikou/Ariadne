import type { SqliteMigration } from "./sqliteMigration.js";
import { addColumnIfMissing } from "./sqliteMigration.js";

export const TOOLS_DB_SCHEMA_VERSION = 2;

export const TOOLS_DB_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "tool_logs_file_changes_backups",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_logs (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          request_id TEXT,
          tool_name TEXT NOT NULL,
          input_json TEXT,
          output_json TEXT,
          ok INTEGER NOT NULL,
          error_code TEXT,
          error_message TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS file_changes (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          tool_name TEXT NOT NULL,
          path TEXT NOT NULL,
          before_hash TEXT,
          after_hash TEXT,
          backup_path TEXT,
          diff TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS backups (
          id TEXT PRIMARY KEY,
          reason TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS backup_files (
          id TEXT PRIMARY KEY,
          backup_id TEXT NOT NULL,
          original_path TEXT NOT NULL,
          backup_path TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: "file_changes_workspace_access",
    up(db) {
      addColumnIfMissing(db, "file_changes", "workspace_root", "workspace_root TEXT");
      addColumnIfMissing(db, "file_changes", "normalized_path", "normalized_path TEXT");
      addColumnIfMissing(db, "file_changes", "workspace_scope_id", "workspace_scope_id TEXT");
      addColumnIfMissing(db, "file_changes", "grant_id", "grant_id TEXT");
      addColumnIfMissing(db, "file_changes", "workspace_access_json", "workspace_access_json TEXT");
    },
  },
];
