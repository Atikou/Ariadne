import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase } from './SqliteOwnerLease.js';
import { assertAgentControlSchema, resolveAgentControlDatabasePath } from './agentControlDbSchema.js';
import { normalizeAgentControlDatabaseNames } from './AgentControlFixedNames.js';

/** Offline normalization preserves every ledger value; version belongs only to metadata/history. */
export function migrateAgentControlDatabaseNames(dataRoot: string): {
  databasePath: string; fromVersion: number; toVersion: number; migrated: boolean; backupPath?: string;
} {
  if (!path.isAbsolute(dataRoot)) throw new Error('agent_control_naming_absolute_root_required');
  const databasePath = resolveAgentControlDatabasePath(dataRoot);
  if (!existsSync(databasePath)) throw new Error('agent_control_naming_database_missing');
  const lease = acquireSqliteOwnerLease(databasePath, 'agent-control-naming');
  let database: DatabaseSync;
  try { database = new DatabaseSync(databasePath); } catch (error) { lease.close(); throw error; }
  try {
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
    const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
    if (version === 8) { assertAgentControlSchema(database); return { databasePath, fromVersion: 8, toVersion: 8, migrated: false }; }
    if (version !== 7) throw new Error(`agent_control_naming_source_unsupported:${version}`);
    assertAgentControlSchema(database, 7);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'agent_v3_*' ORDER BY name")
      .all() as unknown as { name: string }[];
    const before = tables.map(({ name }) => digestTable(database, name));
    const backupRoot = path.join(path.dirname(databasePath), 'migration-backups');
    mkdirSync(backupRoot, { recursive: true });
    const backupPath = path.join(backupRoot, `agent-control.before-fixed-names.${randomUUID()}.sqlite`);
    database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}';`);
    const backupFile = openSync(backupPath, 'r+');
    try { fsyncSync(backupFile); } finally { closeSync(backupFile); }
    database.exec('BEGIN IMMEDIATE;');
    try {
      normalizeAgentControlDatabaseNames(database);
      database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
        .run(8, 'agent_control_fixed_database_names', new Date().toISOString());
      database.exec('PRAGMA user_version=8;');
      assertAgentControlSchema(database);
      for (const [index, { name }] of tables.entries()) {
        if (digestTable(database, name.replace('agent_v3_', 'agent_')) !== before[index]) {
          throw new Error('agent_control_naming_record_preservation_failed');
        }
      }
      database.exec('COMMIT;');
    } catch (error) { if (database.isTransaction) database.exec('ROLLBACK;'); throw error; }
    return { databasePath, fromVersion: 7, toVersion: 8, migrated: true, backupPath };
  } finally { closeOwnedSqliteDatabase(database, lease); }
}

function digestTable(database: DatabaseSync, table: string): string {
  const hash = createHash('sha256');
  for (const row of database.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).iterate()) {
    const value = JSON.stringify(row);
    hash.update(String(Buffer.byteLength(value))).update(':').update(value);
  }
  return hash.digest('hex');
}
