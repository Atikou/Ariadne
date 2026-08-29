import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  acquireSqliteOwnerLease,
  closeOwnedSqliteDatabase
} from './SqliteOwnerLease.js';
import {
  AGENT_CONTROL_DB_SCHEMA_VERSION,
  addAgentControlSchemaV7,
  openAgentControlDatabase,
  resolveAgentControlDatabasePath
} from './agentControlDbSchema.js';

const SOURCE_VERSION = 6;
const TARGET_VERSION = 7;
const MIGRATION_NAME = 'agent_control_v3_durable_user_question';

export interface AgentControlV6ToV7MigrationResult {
  readonly databasePath: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrated: boolean;
  readonly backupPath?: string;
}

/**
 * Offline v6 -> v7 migration. Existing ledger rows remain byte-for-byte
 * payload compatible; only the protected Directive payload-kind constraint is
 * widened. Runtime startup remains fail closed and never migrates in place.
 */
export function migrateAgentControlV6ToV7(
  dataRoot: string
): AgentControlV6ToV7MigrationResult {
  const databasePath = resolveAgentControlDatabasePath(dataRoot);
  const ownerLease = acquireSqliteOwnerLease(databasePath, 'agent-control-migration');
  const database = new DatabaseSync(databasePath);
  let backupPath: string | undefined;
  try {
    database.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;');
    assertIntegrity(database);
    const version = readUserVersion(database);
    if (version === TARGET_VERSION && AGENT_CONTROL_DB_SCHEMA_VERSION === TARGET_VERSION) {
      return { databasePath, fromVersion: version, toVersion: version, migrated: false };
    }
    if (version !== SOURCE_VERSION || AGENT_CONTROL_DB_SCHEMA_VERSION !== TARGET_VERSION) {
      throw new Error(
        `agent_control_v6_v7_migration_unsupported:${String(version)}:`
        + String(AGENT_CONTROL_DB_SCHEMA_VERSION)
      );
    }
    assertSourceMigrationHistory(database);
    backupPath = createBackup(database, databasePath);
    database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
    try {
      addAgentControlSchemaV7(database);
      database.prepare(
        `INSERT INTO schema_migrations(version, name, applied_at)
         VALUES (?, ?, ?)`
      ).run(TARGET_VERSION, MIGRATION_NAME, new Date().toISOString());
      database.exec(`PRAGMA user_version = ${String(TARGET_VERSION)}; COMMIT;`);
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK;');
      throw error;
    } finally {
      database.exec('PRAGMA foreign_keys = ON;');
    }
    assertIntegrity(database);
  } finally {
    closeOwnedSqliteDatabase(database, ownerLease);
  }

  const validated = openAgentControlDatabase(dataRoot);
  closeOwnedSqliteDatabase(validated.database, validated.ownerLease);
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
    { version: 5, name: 'agent_control_v3_protected_turn_inputs' },
    { version: 6, name: 'agent_control_v3_continuable_subagent_waiting_input' }
  ];
  if (JSON.stringify(rows) !== JSON.stringify(expected)) {
    throw new Error('agent_control_v6_v7_migration_history_mismatch');
  }
}

function assertIntegrity(database: DatabaseSync): void {
  const quickCheck = database.prepare('PRAGMA quick_check;').get() as {
    quick_check: string;
  };
  if (quickCheck.quick_check !== 'ok') {
    throw new Error(`agent_control_v6_v7_integrity_failed:${quickCheck.quick_check}`);
  }
  if (database.prepare('PRAGMA foreign_key_check;').all().length !== 0) {
    throw new Error('agent_control_v6_v7_foreign_key_failed');
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
