import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  opendirSync, realpathSync, statSync, unlinkSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isUnpublishedConversationAttachmentObjectName } from '@ariadne/protocol/host';
import { DATABASE_PATHS } from './DatabasePaths.js';
import { acquireSqliteOwnerLease, type SqliteOwnerLease } from './SqliteOwnerLease.js';

export interface OfflineRuntimeBackupFile {
  readonly path: string; readonly bytes: number; readonly sha256: string;
  readonly sqlite: { readonly userVersion: number; readonly schemaDigest: string } | null;
}
export interface OfflineRuntimeBackupResult { readonly files: readonly OfflineRuntimeBackupFile[]; readonly unpublishedAttachmentFilesExcluded: number }
const MAX_FILES = 20_000;
const ATTACHMENTS = 'data/conversation/attachments/v1/objects';

/** Storage-only operation invoked after the original Runtime's acknowledged
 * shutdown. Acquires every current owner lease before capturing any database.
 * VACUUM INTO includes committed WAL; no migrations or Agent execution run here. */
export function captureOfflineRuntimeBackup(dataRoot: string, snapshotRoot: string): OfflineRuntimeBackupResult {
  if (!path.isAbsolute(dataRoot) || !path.isAbsolute(snapshotRoot)) throw new Error('offline_backup_root_invalid');
  const sourceRoot = realpathSync(dataRoot), destination = path.resolve(snapshotRoot);
  const relative = path.relative(sourceRoot, destination);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('offline_backup_destination_inside_source');
  // Only a newly created, caller-owned snapshot directory is writable.
  const parent = realpathSync(path.dirname(destination));
  if (parent !== path.resolve(path.dirname(destination))) throw new Error('offline_backup_destination_parent_alias');
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const leases: SqliteOwnerLease[] = [], outputs: string[] = [], files: OfflineRuntimeBackupFile[] = [];
  let unpublishedAttachmentFilesExcluded = 0;
  try {
    const databases = Object.entries(DATABASE_PATHS).sort(([left], [right]) => left.localeCompare(right));
    for (const [owner, relativePath] of databases) {
      const source = ownedFile(sourceRoot, relativePath);
      leases.push(acquireSqliteOwnerLease(source, 'backup-' + owner.toLowerCase()));
    }
    for (const [, relativePath] of databases) {
      const source = ownedFile(sourceRoot, relativePath), target = path.join(destination, relativePath);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const original = new DatabaseSync(source, { readOnly: true });
      try {
        const metadata = sqliteMetadata(original);
        outputs.push(target); original.exec("VACUUM INTO '" + target.replaceAll("'", "''") + "';");
        const copy = new DatabaseSync(target, { readOnly: true });
        try { if (JSON.stringify(sqliteMetadata(copy)) !== JSON.stringify(metadata)) throw new Error('offline_backup_sqlite_copy_changed'); }
        finally { copy.close(); }
        syncFile(target); files.push({ path: relativePath, ...fileDigest(target), sqlite: metadata });
      } finally { original.close(); }
    }
    const objects = path.join(sourceRoot, ATTACHMENTS);
    const buckets: Dirent[] = [];
    try {
      for (const bucket of boundedDirectoryEntries(objects)) {
        if (buckets.length >= 256) throw new Error('offline_backup_attachment_bucket_capacity_exceeded');
        buckets.push(bucket);
      }
    } catch (error) { if (!isMissing(error)) throw error; }
    for (const bucket of buckets) {
      if (!bucket.isDirectory() || bucket.isSymbolicLink() || !/^[a-f0-9]{2}$/u.test(bucket.name)) throw new Error('offline_backup_attachment_bucket_invalid');
      const bucketRoot = path.join(objects, bucket.name);
      if (realpathSync(bucketRoot) !== bucketRoot) throw new Error('offline_backup_attachment_bucket_alias');
      for (const entry of boundedDirectoryEntries(bucketRoot)) {
        if (files.length + unpublishedAttachmentFilesExcluded >= MAX_FILES) throw new Error('offline_backup_inventory_capacity_exceeded');
        if (isUnpublishedConversationAttachmentObjectName(entry.name, bucket.name) && entry.isFile() && !entry.isSymbolicLink()) {
          unpublishedAttachmentFilesExcluded++; continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/u.test(entry.name) || !entry.name.startsWith(bucket.name))
          throw new Error('offline_backup_attachment_object_invalid');
        const relativePath = ATTACHMENTS + '/' + bucket.name + '/' + entry.name, source = ownedFile(sourceRoot, relativePath);
        const before = statSync(source);
        if (before.size > 1536 * 1024) throw new Error('offline_backup_attachment_size_invalid');
        const target = path.join(destination, relativePath); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        copyFileSync(source, target, constants.COPYFILE_EXCL); outputs.push(target);
        const digest = fileDigest(target), after = statSync(source);
        if (digest.sha256 !== entry.name || digest.bytes !== before.size || after.ino !== before.ino
          || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.size !== before.size)
          throw new Error('offline_backup_attachment_changed');
        syncFile(target); files.push({ path: relativePath, ...digest, sqlite: null });
      }
    }
    return { files: Object.freeze(files), unpublishedAttachmentFilesExcluded };
  } catch (error) {
    // Delete only exact files produced by this operation, never source data or a
    // recursive caller-selected directory. Empty staging directories may remain.
    const cleanupErrors: unknown[] = [];
    for (const file of outputs.reverse()) {
      try { unlinkSync(file); } catch (cleanupError) { if (!isMissing(cleanupError)) cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'offline_backup_output_cleanup_failed');
    throw error;
  } finally {
    const closeErrors: unknown[] = [];
    for (const lease of leases.reverse()) { try { lease.close(); } catch (error) { closeErrors.push(error); } }
    if (closeErrors.length) throw new AggregateError(closeErrors, 'offline_backup_owner_release_failed');
  }
}

function ownedFile(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath), relative = path.relative(root, resolved);
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('offline_backup_source_path_invalid');
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error('offline_backup_source_alias');
  }
  if (!lstatSync(resolved).isFile() || realpathSync(resolved) !== resolved) throw new Error('offline_backup_source_file_invalid');
  return resolved;
}
function sqliteMetadata(database: DatabaseSync) {
  if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('offline_backup_sqlite_integrity_failed');
  const userVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version);
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return { userVersion, schemaDigest: createHash('sha256').update(JSON.stringify(schema)).digest('hex') };
}
function fileDigest(file: string): { bytes: number; sha256: string } {
  const descriptor = openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024); let bytes = 0;
  try {
    for (let count; (count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) { bytes += count; hash.update(buffer.subarray(0, count)); }
    return { bytes, sha256: hash.digest('hex') };
  } finally { buffer.fill(0); closeSync(descriptor); }
}
function syncFile(file: string): void { const descriptor = openSync(file, 'r+'); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function* boundedDirectoryEntries(root: string): Generator<Dirent> {
  const directory = opendirSync(root);
  try { for (let entry; (entry = directory.readSync()) !== null;) yield entry; }
  finally { directory.closeSync(); }
}
