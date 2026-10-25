import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase } from './SqliteOwnerLease.js';
import { addProductivitySchemaV2, PRODUCTIVITY_BASELINE_DB_SCHEMA_VERSION } from './ProductivityDbSchema.js';
import { scheduleSubmissionRetryDelay } from './ScheduleSubmissionPolicy.js';

/** Only an offline lease owner may upgrade; old command receipts and Goal/Workflow JSON remain unchanged. */
export function migrateProductivityV1ToV2(dataRoot: string, now = new Date()): {
  databasePath: string; fromVersion: number; toVersion: number; migrated: boolean; backupPath?: string;
} {
  if (!path.isAbsolute(dataRoot) || !Number.isFinite(now.getTime())) throw new Error('productivity_migration_arguments_invalid');
  const databasePath = path.resolve(dataRoot, 'data/productivity/productivity.db');
  if (!existsSync(databasePath)) throw new Error('productivity_migration_database_missing');
  const lease = acquireSqliteOwnerLease(databasePath, 'productivity-migration');
  let database: DatabaseSync;
  try { database = new DatabaseSync(databasePath); } catch (error) { lease.close(); throw error; }
  try {
    database.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;');
    assertIntegrity(database);
    const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version === PRODUCTIVITY_BASELINE_DB_SCHEMA_VERSION) return { databasePath, fromVersion: version, toVersion: version, migrated: false };
    if (version !== 1) throw new Error(`productivity_migration_version_unsupported:${String(version)}`);
    for (const [table, expected] of Object.entries({
      productivity_goals: ['goal_id','workspace_id','session_id','version','status','goal_json','updated_at'],
      productivity_todo_snapshots: ['goal_id','workspace_id','session_id','revision','items_json','updated_at'],
      productivity_workflows: ['workflow_id','goal_id','workspace_id','session_id','version','status','workflow_json','updated_at'],
      productivity_schedules: ['schedule_id','workspace_id','session_id','version','status','next_fire_at','schedule_json','created_at','updated_at'],
      productivity_commands: ['command_id','fingerprint','result_json','committed_at'],
      productivity_events: ['cursor','command_id','kind','event_json','occurred_at']
    })) {
      if (JSON.stringify(database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)) !== JSON.stringify(expected)) {
        throw new Error('productivity_migration_source_schema_invalid');
      }
    }
    const columns = database.prepare('PRAGMA table_info(productivity_schedule_occurrences)').all().map(row => row.name);
    if (JSON.stringify(columns) !== JSON.stringify(['occurrence_id','schedule_id','workspace_id','session_id','prompt','due_at','command_id','message_id','status','attempts','last_error'])) {
      throw new Error('productivity_migration_source_schema_invalid');
    }
    const active = database.prepare("SELECT occurrence_id,attempts FROM productivity_schedule_occurrences WHERE status='dispatching'").all() as unknown as { occurrence_id: string; attempts: number }[];
    if (active.some(row => !Number.isSafeInteger(row.attempts) || row.attempts < 0)) throw new Error('productivity_migration_attempts_invalid');
    const backupRoot = path.join(path.dirname(databasePath), 'migration-backups'); mkdirSync(backupRoot, { recursive: true });
    const backupPath = path.join(backupRoot, `productivity.db.v1-to-v2.${now.toISOString().replace(/[:.]/gu, '-')}.sqlite`);
    database.exec(`VACUUM INTO '${backupPath.replace(/'/gu, "''")}'; BEGIN IMMEDIATE;`);
    try {
      addProductivitySchemaV2(database);
      // Old dispatching rows have no surviving lease. Preserve charged history, then wait before reconciling.
      for (const row of active) {
        if (row.attempts >= 8) database.prepare("UPDATE productivity_schedule_occurrences SET status='failed' WHERE occurrence_id=?").run(row.occurrence_id);
        else database.prepare('UPDATE productivity_schedule_occurrences SET next_attempt_at=? WHERE occurrence_id=?')
          .run(new Date(now.getTime() + scheduleSubmissionRetryDelay(Math.max(1, row.attempts))).toISOString(), row.occurrence_id);
      }
      // A failed post-DDL integrity check must still roll back the entire upgrade.
      assertIntegrity(database);
      database.exec('PRAGMA user_version=2; COMMIT;');
    } catch (error) { if (database.isTransaction) database.exec('ROLLBACK;'); throw error; }
    return { databasePath, fromVersion: 1, toVersion: 2, migrated: true, backupPath };
  } finally { closeOwnedSqliteDatabase(database, lease); }
}

function assertIntegrity(database: DatabaseSync): void {
  if ((database.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check !== 'ok'
    || database.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('productivity_migration_integrity_failed');
}
