import type { DatabaseSync } from 'node:sqlite';
import type { SqliteOwnerLease } from './SqliteOwnerLease.js';
import { upgradeOwnedProductivityTaskIsolation } from './ProductivityTaskIsolationV2ToV3Migration.js';
import { markAuthorityUnavailableError } from './SqliteAuthorityHealth.js';

export const PRODUCTIVITY_DB_SCHEMA_VERSION = 3;
export const PRODUCTIVITY_BASELINE_DB_SCHEMA_VERSION = 2;

/** Full source audit, additive upgrade and verified backup under the one owner. */
export function initializeProductivitySchema(database: DatabaseSync, lease: SqliteOwnerLease): void {
  const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
  if (version === 0) {
    if (database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() !== undefined)
      throw markAuthorityUnavailableError('productivity', new Error('productivity_unversioned_database_unsupported'));
    initializeProductivitySchemaV2(database);
  } else if (version !== 2 && version !== 3) {
    throw markAuthorityUnavailableError('productivity', new Error(`productivity_offline_migration_required:${String(version)}:3`));
  }
  upgradeOwnedProductivityTaskIsolation(database, lease);
}

export function addProductivitySchemaV2(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE productivity_schedule_occurrences ADD COLUMN attempt_started_at TEXT
      CHECK(attempt_started_at IS NULL OR julianday(attempt_started_at) IS NOT NULL);
    ALTER TABLE productivity_schedule_occurrences ADD COLUMN next_attempt_at TEXT
      CHECK(next_attempt_at IS NULL OR julianday(next_attempt_at) IS NOT NULL)
      CHECK(attempt_started_at IS NULL OR (status='dispatching' AND next_attempt_at IS NOT NULL));
    CREATE INDEX productivity_occurrence_ready ON productivity_schedule_occurrences(status,next_attempt_at,due_at,occurrence_id);
  `);
}

/** Frozen released Schema 2 construction, retained for layout proof and fresh creation. */
export function initializeProductivitySchemaV2(database: DatabaseSync): void {
  const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version !== 0 && version !== PRODUCTIVITY_BASELINE_DB_SCHEMA_VERSION) {
    throw new Error(`productivity_offline_migration_required:${String(version)}:2`);
  }
  if (version === PRODUCTIVITY_BASELINE_DB_SCHEMA_VERSION) return;
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE productivity_goals(goal_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,goal_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX productivity_goal_session ON productivity_goals(workspace_id,session_id);
    CREATE TABLE productivity_todo_snapshots(goal_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,revision INTEGER NOT NULL,items_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE productivity_workflows(workflow_id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,workflow_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE productivity_schedules(schedule_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,next_fire_at TEXT,schedule_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX productivity_schedule_due ON productivity_schedules(status,next_fire_at);
    CREATE TABLE productivity_schedule_occurrences(occurrence_id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,prompt TEXT NOT NULL,due_at TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE,message_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,attempts INTEGER NOT NULL,last_error TEXT);
    CREATE TABLE productivity_commands(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,committed_at TEXT NOT NULL);
    CREATE TABLE productivity_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT NOT NULL,kind TEXT NOT NULL,event_json TEXT NOT NULL,occurred_at TEXT NOT NULL);
  `);
  try { addProductivitySchemaV2(database); database.exec('PRAGMA user_version=2; COMMIT;'); }
  catch (error) { if (database.isTransaction) database.exec('ROLLBACK;'); throw error; }
}
