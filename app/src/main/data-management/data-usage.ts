import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { dataUsageViewSchema, type DataUsageView } from '@shared/data-management';
import { BACKUP_FIXED_FILES, MAX_BACKUP_FILES } from './backup-manifest';
import { RUNTIME_DERIVED_DATABASE_PATHS } from '../runtime/runtime-storage-layout';
import { isUnpublishedConversationAttachmentObjectName } from '@ariadne/protocol/host';

/** Metadata-only inventory of the current owners' exact files. Measurements
 * are logical file lengths sampled while the application is live, including
 * SQLite WAL/SHM. They are not allocated disk blocks or a backup boundary.
 * No user workspace, sibling recovery directory or arbitrary profile walk. */
export async function measureOwnedDataUsage(input: { userData: string; sessionData: string; runtime: string }): Promise<DataUsageView> {
  const roots = { userData: await directory(input.userData), sessionData: await directory(input.sessionData), runtime: await directory(input.runtime) };
  const category = () => ({ files: 0, bytes: 0 });
  const databases = category(), attachments = category(), privateFiles = category(), unpublishedAttachments = category(), derivedCaches = category();
  let files = 0;
  const add = async (root: string, path: string, target: ReturnType<typeof category>, optional: boolean): Promise<void> => {
    try {
      const resolved = join(root, path);
      await assertOwnedPath(root, resolved);
      const value = await lstat(resolved);
      if (!value.isFile() || !Number.isSafeInteger(value.size) || value.size < 0) throw new Error('data_usage_file_invalid');
      if (++files > MAX_BACKUP_FILES) throw new Error('data_usage_capacity_exceeded');
      target.files++; target.bytes += value.size;
      if (!Number.isSafeInteger(target.bytes)) throw new Error('data_usage_capacity_exceeded');
    } catch (error) { if (!(optional && missing(error))) throw error; }
  };
  for (const item of BACKUP_FIXED_FILES) {
    const target = item.kind === 'database' ? databases : privateFiles;
    await add(roots[item.scope], item.path, target, !item.required);
    if (item.kind === 'database') for (const suffix of ['-wal', '-shm']) await add(roots[item.scope], item.path + suffix, databases, true);
  }
  for (const path of Object.values(RUNTIME_DERIVED_DATABASE_PATHS)) for (const suffix of ['', '-wal', '-shm'])
    await add(roots.runtime, path + suffix, derivedCaches, true);
  const objects = join(roots.runtime, 'data', 'conversation', 'attachments', 'v1', 'objects');
  let buckets: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    await assertOwnedPath(roots.runtime, objects); buckets = await opendir(objects);
  } catch (error) { if (!missing(error)) throw error; }
  if (buckets) {
    let count = 0;
    for await (const bucket of buckets) {
      if (++count > 256 || !bucket.isDirectory() || bucket.isSymbolicLink() || !/^[a-f0-9]{2}$/u.test(bucket.name))
        throw new Error('data_usage_attachment_bucket_invalid');
      const bucketPath = join(objects, bucket.name); await assertOwnedPath(roots.runtime, bucketPath);
      for await (const object of await opendir(bucketPath)) {
        const published = /^[a-f0-9]{64}$/u.test(object.name) && object.name.startsWith(bucket.name);
        const temporary = isUnpublishedConversationAttachmentObjectName(object.name, bucket.name);
        if (!object.isFile() || object.isSymbolicLink() || (!published && !temporary)) throw new Error('data_usage_attachment_object_invalid');
        await add(roots.runtime, relative(roots.runtime, join(bucketPath, object.name)), published ? attachments : unpublishedAttachments, false);
      }
    }
  }
  return dataUsageViewSchema.parse({ measuredAt: new Date().toISOString(), measurement: 'owned-file-logical-bytes',
    databases, attachments, privateFiles, unpublishedAttachments, derivedCaches,
    totalBytes: databases.bytes + attachments.bytes + privateFiles.bytes + unpublishedAttachments.bytes + derivedCaches.bytes });
}
async function directory(path: string): Promise<string> {
  if (!isAbsolute(path) || !(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new Error('data_usage_root_invalid');
  return realpath(path);
}
async function assertOwnedPath(root: string, path: string): Promise<void> {
  const distance = relative(root, path);
  if (!distance || isAbsolute(distance) || distance === '..' || distance.startsWith('..' + sep)) throw new Error('data_usage_path_invalid');
  let current = root;
  for (const segment of distance.split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('data_usage_path_alias');
  }
  if (await realpath(path) !== path) throw new Error('data_usage_path_alias');
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
