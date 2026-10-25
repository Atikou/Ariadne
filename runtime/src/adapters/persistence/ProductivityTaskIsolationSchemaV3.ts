import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';

export const PRODUCTIVITY_TASK_ISOLATION_SCHEMA_V3_DIGEST = 'sha256:975154911054ab45cb575773ceaeb87d30a40973469c23cf05b2b28a270eb783';

export function assertProductivityTaskIsolationSchemaV3(database: DatabaseSync): void {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all().map(row => ({ ...row, sql: typeof row.sql === 'string' ? row.sql.replace(/\s+/gu, ' ').trim() : null }));
  const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version !== 3 || `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}` !== PRODUCTIVITY_TASK_ISOLATION_SCHEMA_V3_DIGEST)
    throw markAuthorityIntegrityError('productivity', new Error('productivity_task_isolation_schema_invalid'));
}

/** Additive task-isolation metadata in the existing Productivity authority.
 * The production opener first audits and backs up the exact Schema 2 source
 * under its existing lease; it publishes version 3 only after revalidation. */
export function addProductivityTaskIsolationSchemaV3(database: DatabaseSync): void {
  const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version !== 2 || !database.isTransaction) throw new Error('productivity_task_isolation_upgrade_boundary_invalid');
  database.exec(`
    CREATE TABLE productivity_task_faults (
      fault_id TEXT PRIMARY KEY,
      task_kind TEXT NOT NULL CHECK(task_kind IN ('workflow','goal','schedule')),
      entity_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      owner_session_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      create_command_id TEXT,
      submit_command_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK(source_version>0),
      source_status TEXT NOT NULL CHECK(source_status IN ('unclaimed','claimed','submitted','pending','dispatching')),
      revision INTEGER NOT NULL CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN ('quarantined','reconciling','resolved')),
      code TEXT NOT NULL CHECK(code IN ('submission_identity_conflict','task_authority_conflict','result_authority_conflict','cancellation_rejected')),
      occurred_at TEXT NOT NULL CHECK(julianday(occurred_at) IS NOT NULL),
      updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
      identity_digest TEXT NOT NULL,
      UNIQUE(task_kind,entity_id,task_id),
      CHECK((task_kind='schedule' AND create_command_id IS NULL) OR (task_kind<>'schedule' AND create_command_id IS NOT NULL))
    );
    CREATE INDEX productivity_task_fault_scope ON productivity_task_faults(workspace_id,owner_session_id,state,updated_at,fault_id);
    CREATE INDEX productivity_task_fault_worker ON productivity_task_faults(task_kind,state,fault_id);
  `);
  // Version publication belongs to the migration's final audited COMMIT.
}
