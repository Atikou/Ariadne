import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  closeOwnedSqliteDatabase,
  acquireSqliteOwnerLease
} from './SqliteOwnerLease.js';
import {
  AGENT_CONTROL_DB_SCHEMA_VERSION,
  resolveAgentControlDatabasePath
} from './agentControlDbSchema.js';

const SOURCE_VERSION = 5;
const TARGET_VERSION = 6;
const MIGRATION_NAME = 'agent_control_v3_continuable_subagent_waiting_input';

export interface AgentControlOfflineMigrationResult {
  readonly databasePath: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrated: boolean;
  readonly backupPath?: string;
}

/**
 * Fenced v5 -> v6 migration for an empty Agent Control ledger.
 *
 * Runtime startup remains fail-closed. This operation must run while Ariadne is
 * stopped, acquires the same process-owner lease as Runtime, creates a durable
 * pre-migration backup, and rejects non-empty ledgers rather than guessing how
 * an older active/terminal Run should be reinterpreted.
 */
export function migrateEmptyAgentControlV5ToV6(
  dataRoot: string
): AgentControlOfflineMigrationResult {
  const databasePath = resolveAgentControlDatabasePath(dataRoot);
  const ownerLease = acquireSqliteOwnerLease(databasePath, 'agent-control-migration');
  const database = new DatabaseSync(databasePath);
  let backupPath: string | undefined;
  try {
    database.exec('PRAGMA busy_timeout = 0;');
    assertIntegrity(database);
    const version = readUserVersion(database);
    if (version === AGENT_CONTROL_DB_SCHEMA_VERSION) {
      return {
        databasePath,
        fromVersion: version,
        toVersion: version,
        migrated: false
      };
    }
    if (version !== SOURCE_VERSION) {
      throw new Error(
        `agent_control_offline_migration_unsupported:${String(version)}:`
        + String(AGENT_CONTROL_DB_SCHEMA_VERSION)
      );
    }
    assertSourceMigrationHistory(database);
    const runCount = Number((database.prepare(
      'SELECT COUNT(*) AS count FROM agent_v3_runs'
    ).get() as { count: number | bigint }).count);
    if (runCount !== 0) {
      throw new Error(`agent_control_offline_migration_nonempty:${String(runCount)}`);
    }

    backupPath = createBackup(database, databasePath);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      BEGIN IMMEDIATE;
    `);
    try {
      database.exec(`
        DROP INDEX idx_agent_v3_runs_status;
        DROP INDEX idx_agent_v3_runs_recovery;
        ALTER TABLE agent_v3_runs RENAME TO agent_v3_runs_v5;

        CREATE TABLE agent_v3_runs (
          run_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK(version > 0),
          state_status TEXT NOT NULL CHECK(state_status IN (
            'queued', 'running', 'waiting', 'recovering',
            'waiting_children', 'waiting_input', 'cancelling',
            'completed', 'failed', 'cancelled'
          )),
          aggregate_json TEXT NOT NULL CHECK(
            json_valid(aggregate_json)
            AND COALESCE(json_type(aggregate_json, '$.turns') = 'array', 0)
            AND COALESCE(
              json_type(aggregate_json, '$.binding.toolCatalog') = 'object',
              0
            )
            AND COALESCE(
              json_type(aggregate_json, '$.binding.toolCatalog.catalogId') = 'text'
              AND length(json_extract(
                aggregate_json,
                '$.binding.toolCatalog.catalogId'
              )) > 0,
              0
            )
            AND COALESCE(
              json_type(aggregate_json, '$.binding.toolCatalog.revision') = 'integer'
              AND json_extract(
                aggregate_json,
                '$.binding.toolCatalog.revision'
              ) > 0,
              0
            )
            AND COALESCE(
              json_type(aggregate_json, '$.binding.toolCatalog.digest') = 'text'
              AND length(json_extract(
                aggregate_json,
                '$.binding.toolCatalog.digest'
              )) = 71
              AND substr(json_extract(
                aggregate_json,
                '$.binding.toolCatalog.digest'
              ), 1, 7) = 'sha256:'
              AND substr(json_extract(
                aggregate_json,
                '$.binding.toolCatalog.digest'
              ), 8) NOT GLOB '*[^0-9a-f]*',
              0
            )
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO agent_v3_runs(
          run_id, version, state_status, aggregate_json, created_at, updated_at
        )
        SELECT run_id, version, state_status, aggregate_json, created_at, updated_at
        FROM agent_v3_runs_v5;

        DROP TABLE agent_v3_runs_v5;

        CREATE INDEX idx_agent_v3_runs_status
          ON agent_v3_runs(state_status, updated_at DESC);
        CREATE INDEX idx_agent_v3_runs_recovery
          ON agent_v3_runs(created_at, run_id)
          WHERE state_status IN (
            'queued', 'running', 'waiting', 'recovering',
            'waiting_children', 'waiting_input', 'cancelling'
          );
        CREATE INDEX idx_agent_v3_runs_waiting_input
          ON agent_v3_runs(updated_at, run_id)
          WHERE state_status = 'waiting_input';
      `);
      database.prepare(
        `INSERT INTO schema_migrations(version, name, applied_at)
         VALUES (?, ?, ?)`
      ).run(TARGET_VERSION, MIGRATION_NAME, new Date().toISOString());
      database.exec(`PRAGMA user_version = ${String(TARGET_VERSION)}; COMMIT;`);
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK;');
      throw error;
    } finally {
      database.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
    }
    assertIntegrity(database);
  } finally {
    closeOwnedSqliteDatabase(database, ownerLease);
  }

  return {
    databasePath,
    fromVersion: SOURCE_VERSION,
    toVersion: TARGET_VERSION,
    migrated: true,
    ...(backupPath === undefined ? {} : { backupPath })
  };
}

function assertSourceMigrationHistory(database: DatabaseSync): void {
  const rows = database.prepare(
    'SELECT version, name FROM schema_migrations ORDER BY version'
  ).all() as unknown as Array<{ version: number; name: string }>;
  const expected = [
    { version: 4, name: 'agent_control_v3_execution_intent_ledger' },
    { version: 5, name: 'agent_control_v3_protected_turn_inputs' }
  ];
  if (JSON.stringify(rows) !== JSON.stringify(expected)) {
    throw new Error('agent_control_offline_migration_history_mismatch');
  }
}

function assertIntegrity(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON;');
  const quickCheck = database.prepare('PRAGMA quick_check;').get() as {
    quick_check: string;
  };
  if (quickCheck.quick_check !== 'ok') {
    throw new Error(`agent_control_offline_migration_integrity_failed:${quickCheck.quick_check}`);
  }
  const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check;').all();
  if (foreignKeyFailures.length !== 0) {
    throw new Error('agent_control_offline_migration_foreign_key_failed');
  }
}

function createBackup(database: DatabaseSync, databasePath: string): string {
  const backupRoot = path.join(path.dirname(databasePath), 'migration-backups');
  mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupPath = path.join(
    backupRoot,
    `agent-control.db.v${String(SOURCE_VERSION)}-to-v${String(TARGET_VERSION)}.${stamp}.sqlite`
  );
  database.exec(`VACUUM INTO '${backupPath.replace(/'/gu, "''")}';`);
  return backupPath;
}

function readUserVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version;').get() as {
    user_version: number;
  }).user_version;
}
