import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** Called under the database owner's offline lease; includes committed WAL through SQLite. */
export function createDurableOfflineBackup(database: DatabaseSync, databasePath: string, label: string): string {
  if (!/^[a-zA-Z0-9._-]+$/u.test(label)) throw new Error('offline_backup_label_invalid');
  const parent = path.join(path.dirname(databasePath), 'migration-backups');
  mkdirSync(parent, { recursive: true });
  const backupPath = path.join(parent, `${label}.${randomUUID()}.sqlite`);
  database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}';`);
  const descriptor = openSync(backupPath, 'r+');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return backupPath;
}
