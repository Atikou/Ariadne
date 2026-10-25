import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, constants, existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireSqliteOwnerLease } from '../../adapters/persistence/SqliteOwnerLease.js';
import { assertModelCapabilityDatabaseSchema } from './ModelCapabilityDbSchema.js';

/** A stopped owner can adopt the fixed filename without changing any stored record. */
export function migrateModelCapabilityDatabaseName(dataRoot: string): {
  databasePath: string; migrated: boolean; backupPath?: string;
} {
  if (!path.isAbsolute(dataRoot)) throw new Error('model_capability_naming_absolute_root_required');
  const root = path.resolve(dataRoot, 'data/model-capability');
  const source = path.join(root, 'model-capability-v1.db');
  const target = path.join(root, 'model-capability.db');
  if (!existsSync(source)) {
    if (!existsSync(target)) throw new Error('model_capability_naming_database_missing');
    validate(target); return { databasePath: target, migrated: false };
  }
  const sourceLease = acquireSqliteOwnerLease(source, 'model-capability-naming');
  let targetLease: ReturnType<typeof acquireSqliteOwnerLease> | undefined;
  try {
    targetLease = acquireSqliteOwnerLease(target, 'model-capability-naming');
    if (existsSync(target)) throw new Error('model_capability_naming_dest_exists');
    if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error('model_capability_naming_source_not_regular');
    // Never move the main file away from uncheckpointed state or an uncertain live journal.
    if (['-wal', '-journal'].some(suffix => existsSync(source + suffix) && lstatSync(source + suffix).size > 0)) {
      throw new Error('model_capability_naming_checkpoint_required');
    }
    validate(source);
    const before = digest(source);
    const backupRoot = path.join(root, 'migration-backups'); mkdirSync(backupRoot, { recursive: true });
    const backupPath = path.join(backupRoot, `model-capability.before-fixed-name.${randomUUID()}.sqlite`);
    copyFileSync(source, backupPath, constants.COPYFILE_EXCL);
    const backupFile = openSync(backupPath, 'r+');
    try { fsyncSync(backupFile); } finally { closeSync(backupFile); }
    if (digest(backupPath) !== before || digest(source) !== before) throw new Error('model_capability_naming_backup_mismatch');
    // Same-directory rename publishes the existing database atomically, with no deletion or copy gap.
    renameSync(source, target);
    return { databasePath: target, migrated: true, backupPath };
  } finally { targetLease?.close(); sourceLease.close(); }
}

function validate(file: string): void {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assertModelCapabilityDatabaseSchema(database);
    if (database.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok'
      || database.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('model_capability_naming_integrity_failed');
  } finally { database.close(); }
}
function digest(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
