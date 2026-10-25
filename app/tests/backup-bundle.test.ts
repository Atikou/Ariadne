import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_FIXED_FILES, type BackupManifest } from '../src/main/data-management/backup-manifest';
import { publishBackupBundle, unpackBackupBundle, type BackupSnapshotRoots } from '../src/main/data-management/backup-bundle';
import { WindowsBackupKeyProtector } from '../src/main/runtime/windows-backup-key-protector';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'AriadneBackupBundle-'))) throw new Error('Unsafe fixture cleanup.');
  await rm(root, { recursive: true, force: true });
} });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'AriadneBackupBundle-')); roots.push(root);
  const snapshotRoots: BackupSnapshotRoots = { userData: join(root, 'user'), runtime: join(root, 'runtime'), sessionData: join(root, 'session') };
  for (const path of Object.values(snapshotRoots)) await mkdir(path);
  const parent = join(root, 'backups'); await mkdir(parent);
  const manifest: BackupManifest = { format: 'ariadne.same-machine-backup', version: 1, backupId: randomUUID(), appVersion: '0.1.0',
    runtimeProtocol: '3.0', publicContract: '5.0', createdAt: new Date().toISOString(), platform: 'win32', recoveryScope: 'same-machine-current-user', unpublishedAttachmentFilesExcluded: 0,
    boundary: { runtimeInstanceId: randomUUID(), quiescedAt: new Date().toISOString(), shutdownAcknowledged: true, mainStoresFlushed: true,
      storageSchemas: { agentControl: 7 } }, files: [], absent: [],
    exclusions: ['model-weights', 'workspace-original-files', 'derived-search-and-task-indexes'] };
  const original = new Map<string, Buffer>();
  // This fixture validates container integrity. Its database bytes deliberately
  // do not claim acceptance by the original SQLite/Runtime recovery owners.
  for (const item of BACKUP_FIXED_FILES) {
    if (!item.required) { manifest.absent.push({ scope: item.scope, path: item.path }); continue; }
    const bytes = Buffer.concat([Buffer.from('private fixture body'), randomBytes(300_123)]), path = join(snapshotRoots[item.scope], item.path);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); original.set(item.scope + ':' + item.path, bytes);
    manifest.files.push({ scope: item.scope, path: item.path, kind: item.kind, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), sqlite: item.kind === 'database' ? { userVersion: 1, schemaDigest: 'a'.repeat(64) } : null });
  }
  return { root, snapshotRoots, parent, manifest, original, protector: new WindowsBackupKeyProtector(), forbiddenRoots: Object.values(snapshotRoots) };
}
describe('authenticated backup directory publication and isolated extraction', () => {
  it('uses actual Windows key protection and restores every authenticated byte to a fresh private root', async () => {
    const f = await fixture(), published = await publishBackupBundle({ ...f, destinationParent: f.parent });
    expect((await readdir(f.parent))).toEqual(['Ariadne-backup-' + f.manifest.backupId]);
    const header = await readFile(join(published.directory, 'header.json'), 'utf8');
    expect(header).not.toContain('agent-control.db'); expect(header).not.toContain('private fixture body');
    const restored = await unpackBackupBundle({ ...f, directory: published.directory, stagingParent: f.parent, protector: new WindowsBackupKeyProtector() });
    expect(restored.manifest).toEqual(f.manifest);
    for (const file of restored.manifest.files) {
      expect(await readFile(join(restored.roots[file.scope], file.path))).toEqual(f.original.get(file.scope + ':' + file.path));
      expect(await readFile(join(f.snapshotRoots[file.scope], file.path))).toEqual(f.original.get(file.scope + ':' + file.path));
    }
    await expect(publishBackupBundle({ ...f, destinationParent: f.parent })).rejects.toThrow('backup_destination_exists');
    expect(await readFile(join(published.directory, 'header.json'), 'utf8')).toBe(header);
  }, 30_000);

  it('rejects metadata or ciphertext damage, extra objects and wrong OS keys without touching any live source', async () => {
    const f = await fixture(), published = await publishBackupBundle({ ...f, destinationParent: f.parent });
    const headerPath = join(published.directory, 'header.json'), originalHeader = await readFile(headerPath, 'utf8');
    const changed = JSON.parse(originalHeader); changed.backupId = randomUUID(); await writeFile(headerPath, JSON.stringify(changed));
    await expect(unpackBackupBundle({ ...f, directory: published.directory, stagingParent: f.parent })).rejects.toBeInstanceOf(Error);
    await writeFile(headerPath, originalHeader);
    await expect(unpackBackupBundle({ ...f, directory: published.directory, stagingParent: f.parent,
      protector: { protect: async () => '', unprotect: async () => randomBytes(32) } })).rejects.toBeInstanceOf(Error);
    const extra = join(published.directory, 'objects', 'unexpected.bin'); await writeFile(extra, 'unowned');
    await expect(unpackBackupBundle({ ...f, directory: published.directory, stagingParent: f.parent })).rejects.toThrow('backup_inventory_invalid');
    await rm(extra);
    const object = join(published.directory, 'objects', '00000.bin'), damaged = await readFile(object); damaged[40]! ^= 1; await writeFile(object, damaged);
    await expect(unpackBackupBundle({ ...f, directory: published.directory, stagingParent: f.parent })).rejects.toThrow('backup_object_validation_failed');
    expect((await readdir(f.parent)).filter(path => path.startsWith('.ariadne-restore-'))).toEqual([]);
    for (const file of f.manifest.files) expect(await readFile(join(f.snapshotRoots[file.scope], file.path))).toEqual(f.original.get(file.scope + ':' + file.path));
  }, 30_000);

  it('cleans only its own incomplete publication after changed source or cancellation and refuses source destinations', async () => {
    const f = await fixture();
    await expect(publishBackupBundle({ ...f, destinationParent: f.snapshotRoots.userData })).rejects.toThrow('backup_destination_inside_source');
    const file = f.manifest.files[1]!, path = join(f.snapshotRoots[file.scope], file.path), original = await readFile(path);
    const damaged = Buffer.from(original); damaged[10]! ^= 1; await writeFile(path, damaged);
    await expect(publishBackupBundle({ ...f, destinationParent: f.parent })).rejects.toThrow('backup_source_digest_changed');
    expect(await readdir(f.parent)).toEqual([]); expect(await readFile(path)).toEqual(damaged);
    const controller = new AbortController(); controller.abort();
    await expect(publishBackupBundle({ ...f, destinationParent: f.parent, signal: controller.signal })).rejects.toThrow('backup_cancelled');
    expect(await readdir(f.parent)).toEqual([]);
    await expect(stat(join(f.parent, 'Ariadne-backup-' + f.manifest.backupId))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);
});
