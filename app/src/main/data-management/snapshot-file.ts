import { createHash } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';

const MAX_BYTES = 128 * 1024 * 1024 * 1024;
/** Called only inside the Main owner freeze, with an exact catalog file. */
export async function copySnapshotFile(source: string, destination: string): Promise<{ bytes: number; sha256: string }> {
  const named = await lstat(source), input = await open(source, 'r'); let created = false;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  const buffer = Buffer.alloc(128 * 1024), hash = createHash('sha256');
  try {
    const opened = await input.stat();
    if (!named.isFile() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino
      || opened.size !== named.size || opened.mtimeMs !== named.mtimeMs || opened.size > MAX_BYTES) throw new Error('main_snapshot_source_invalid');
    output = await open(destination, 'wx', 0o600); created = true; let bytes = 0;
    for (;;) {
      const result = await input.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break;
      bytes += result.bytesRead; if (bytes > opened.size) throw new Error('main_snapshot_source_changed');
      const chunk = buffer.subarray(0, result.bytesRead); hash.update(chunk); await output.writeFile(chunk);
    }
    const after = await input.stat(), final = await lstat(source);
    if (bytes !== opened.size || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size || final.isSymbolicLink()
      || final.dev !== opened.dev || final.ino !== opened.ino) throw new Error('main_snapshot_source_changed');
    await output.sync(); await output.close(); output = undefined;
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    await output?.close(); output = undefined; if (created) await unlink(destination); throw error;
  } finally { buffer.fill(0); await input.close(); await output?.close(); }
}

export function snapshotSqliteMetadata(database: DatabaseSync): { userVersion: number; schemaDigest: string } {
  if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('main_snapshot_sqlite_integrity_failed');
  const userVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version);
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return { userVersion, schemaDigest: createHash('sha256').update(JSON.stringify(schema)).digest('hex') };
}

export async function digestSnapshotFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const named = await lstat(path), file = await open(path, 'r'), buffer = Buffer.alloc(128 * 1024), hash = createHash('sha256');
  try {
    const opened = await file.stat(); let bytes = 0;
    if (!named.isFile() || named.isSymbolicLink() || named.ino !== opened.ino || named.dev !== opened.dev
      || named.size !== opened.size || opened.size > MAX_BYTES) throw new Error('snapshot_file_invalid');
    for (;;) {
      const result = await file.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break;
      bytes += result.bytesRead; if (bytes > opened.size) throw new Error('snapshot_file_changed'); hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await file.stat(), final = await lstat(path);
    if (bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || final.isSymbolicLink()
      || final.ino !== opened.ino || final.dev !== opened.dev || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs)
      throw new Error('snapshot_file_changed');
    return { bytes, sha256: hash.digest('hex') };
  } finally { buffer.fill(0); await file.close(); }
}
