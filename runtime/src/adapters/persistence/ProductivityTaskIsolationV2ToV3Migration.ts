import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE_PATHS } from './DatabasePaths.js';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase, type SqliteOwnerLease } from './SqliteOwnerLease.js';
import { auditProductivityAuthorityV2, auditProductivityAuthorityRecords, assertProductivitySqliteIntegrity } from './ProductivityAuthorityAudit.js';
import { addProductivityTaskIsolationSchemaV3, assertProductivityTaskIsolationSchemaV3 } from './ProductivityTaskIsolationSchemaV3.js';
import { SqliteProductivityTaskIsolation } from './SqliteProductivityTaskIsolation.js';

interface MigrationResult {
  readonly databasePath: string; readonly fromVersion: 2 | 3; readonly toVersion: 3;
  readonly migrated: boolean; readonly backupPath?: string; readonly sourceDigest: string; readonly records: number;
}

/** Offline entry point sharing the production owner's audited upgrade. */
export function migrateProductivityTaskIsolationV2ToV3(dataRoot: string, now = new Date(),
  faultInjector: { readonly beforeFinalTransaction?: () => void; readonly afterAddSchema?: (database: DatabaseSync) => void } = {}): MigrationResult {
  if (!path.isAbsolute(dataRoot) || !Number.isFinite(now.getTime())) throw new Error('productivity_task_isolation_migration_arguments_invalid');
  const databasePath = path.resolve(dataRoot, DATABASE_PATHS.productivity);
  if (!existsSync(databasePath)) throw new Error('productivity_task_isolation_database_missing');
  const lease = acquireSqliteOwnerLease(databasePath, 'productivity-task-isolation-migration');
  let database: DatabaseSync;
  try { database = new DatabaseSync(databasePath); } catch (error) { lease.close(); throw error; }
  try {
    database.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;');
    return upgradeOwnedProductivityTaskIsolation(database, lease, now, faultInjector);
  } finally { closeOwnedSqliteDatabase(database, lease); }
}

/** The caller retains its existing lease and connection. Never acquire another
 * lease inside a production owner's constructor or rewrite original records. */
export function upgradeOwnedProductivityTaskIsolation(database: DatabaseSync, lease: SqliteOwnerLease, now = new Date(),
  faultInjector: { readonly beforeFinalTransaction?: () => void; readonly afterAddSchema?: (database: DatabaseSync) => void } = {}): MigrationResult {
    const databasePath = lease.databasePath;
    const main = database.prepare('PRAGMA database_list').all().find(row => row.name === 'main');
    if (!Number.isFinite(now.getTime()) || database.isTransaction || !main || path.resolve(String(main.file)) !== path.resolve(databasePath))
      throw new Error('productivity_task_isolation_owner_boundary_invalid');
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version === 3) {
      database.exec('BEGIN;');
      try {
        assertProductivityTaskIsolationSchemaV3(database); assertProductivitySqliteIntegrity(database);
        new SqliteProductivityTaskIsolation(database).audit();
        const proof = auditProductivityAuthorityRecords(database);
        database.exec('COMMIT;');
        return { databasePath, fromVersion: 3, toVersion: 3, migrated: false, sourceDigest: proof.digest, records: proof.records };
      } catch (error) { if (database.isTransaction) database.exec('ROLLBACK;'); throw error; }
    }
    if (version.user_version !== 2) throw new Error(`productivity_task_isolation_source_unsupported:${String(version.user_version)}`);
    const before = auditProductivityAuthorityV2(database);
    const backupRoot = path.join(path.dirname(databasePath), 'migration-backups'); mkdirSync(backupRoot, { recursive: true });
    const backupPath = path.join(backupRoot, `productivity.db.v2-to-v3.${now.toISOString().replace(/[:.]/gu, '-')}.sqlite`);
    if (!existsSync(backupPath)) database.exec(`VACUUM INTO '${backupPath.replace(/'/gu, "''")}';`);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try { assertSame(before, auditProductivityAuthorityV2(backup)); } finally { backup.close(); }
    faultInjector.beforeFinalTransaction?.();
    database.exec('BEGIN IMMEDIATE;');
    try {
      // Recheck under the final write transaction before any DDL. Backup and
      // COMMIT must refer to the same authority, even across outside writes.
      assertSame(before, auditProductivityAuthorityV2(database));
      addProductivityTaskIsolationSchemaV3(database); faultInjector.afterAddSchema?.(database);
      assertProductivitySqliteIntegrity(database); assertSame(before, auditProductivityAuthorityRecords(database));
      database.exec('PRAGMA user_version=3;'); assertProductivityTaskIsolationSchemaV3(database);
      database.exec('COMMIT;');
    } catch (error) { if (database.isTransaction) database.exec('ROLLBACK;'); throw error; }
    return { databasePath, fromVersion: 2, toVersion: 3, migrated: true, backupPath, sourceDigest: before.digest, records: before.records };
}

function assertSame(left: { digest: string; records: number }, right: { digest: string; records: number }): void {
  if (left.digest !== right.digest || left.records !== right.records) throw new Error('productivity_task_isolation_source_changed');
}
