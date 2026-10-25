import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { BACKUP_FIXED_FILES, validateBackupFileEntry, type BackupFileEntry, type BackupManifest } from './backup-manifest';
import { copySnapshotFile, digestSnapshotFile } from './snapshot-file';
import type { TaskNotificationReceipts } from '../persistence/task-notification-receipts';

export interface MainSnapshotResult { files: BackupFileEntry[]; absent: BackupManifest['absent'] }
/** Exact Main catalog only. The caller holds its persistence freeze and has
 * flushed all original queues. No arbitrary workspace or directory recursion. */
export async function captureMainSnapshot(input: { userData: string; sessionData: string; stage: string;
  taskNotificationReceipts: Pick<TaskNotificationReceipts, 'captureSnapshot'> }): Promise<MainSnapshotResult> {
  const roots = { userData: await canonicalSourceRoot(input.userData), sessionData: await canonicalSourceRoot(input.sessionData) };
  const stage = await canonicalSourceRoot(input.stage);
  for (const root of Object.values(roots)) {
    const distance = relative(root, stage);
    if (!distance || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith('..' + sep)))
      throw new Error('main_snapshot_destination_inside_source');
  }
  for (const scope of ['userData', 'sessionData'] as const) await mkdir(join(stage, scope));
  const files: BackupFileEntry[] = [], absent: BackupManifest['absent'] = [];
  for (const item of BACKUP_FIXED_FILES) {
    if (item.scope === 'runtime') continue;
    const source = join(roots[item.scope], item.path), destination = join(stage, item.scope, item.path);
    let named: Awaited<ReturnType<typeof lstat>>;
    try { named = await lstat(source); }
    catch (error) {
      if (!item.required && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        absent.push({ scope: item.scope, path: item.path }); continue;
      }
      throw error;
    }
    if (!named.isFile() || named.isSymbolicLink()) throw new Error('main_snapshot_catalog_file_invalid');
    if (item.kind === 'database') {
      const sqlite = await input.taskNotificationReceipts.captureSnapshot(destination), digest = await digestSnapshotFile(destination);
      files.push(validateBackupFileEntry({ scope: item.scope, path: item.path, kind: item.kind, ...digest, sqlite }));
    } else {
      const digest = await copySnapshotFile(source, destination);
      files.push(validateBackupFileEntry({ scope: item.scope, path: item.path, kind: item.kind, ...digest, sqlite: null }));
    }
  }
  return { files, absent };
}

async function canonicalSourceRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('main_snapshot_root_invalid');
  const named = await lstat(path);
  if (!named.isDirectory() || named.isSymbolicLink()) throw new Error('main_snapshot_root_invalid');
  return realpath(path);
}
