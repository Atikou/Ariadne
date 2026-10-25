import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BACKUP_FIXED_FILES } from '../src/main/data-management/backup-manifest';
import { RUNTIME_DERIVED_DATABASE_PATHS } from '../src/main/runtime/runtime-storage-layout';
import { measureOwnedDataUsage } from '../src/main/data-management/data-usage';

const owned: string[] = [];
afterEach(async () => { for (const root of owned.splice(0)) {
  if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('AriadneUsageFixture-') || await realpath(root) !== root)
    throw new Error('Unsafe fixture cleanup.');
  await rm(root, { recursive: true, force: true });
} });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'AriadneUsageFixture-'))); owned.push(root);
  const input = { userData: join(root, 'profile'), sessionData: join(root, 'profile'), runtime: join(root, 'profile', 'runtime') };
  await mkdir(input.runtime, { recursive: true });
  // Logical sizes only. These explicit bytes do not claim valid databases or
  // cryptographic payloads; the measurement never opens or decodes either.
  for (const item of BACKUP_FIXED_FILES.filter(item => item.required)) {
    const path = join(input[item.scope], item.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, '0123456789');
  }
  const objects = join(input.runtime, 'data', 'conversation', 'attachments', 'v1', 'objects', 'aa'); await mkdir(objects, { recursive: true });
  return { root, input, objects };
}
it('counts only original fixed owners, SQLite sidecars and exact attachment objects, leaving unrelated data alone', async () => {
  const f = await fixture(), db = BACKUP_FIXED_FILES.find(item => item.scope === 'runtime' && item.kind === 'database')!;
  await writeFile(join(f.input.runtime, db.path + '-wal'), 'wal'); await writeFile(join(f.input.runtime, db.path + '-shm'), 'shm!');
  const indexPath = join(f.input.runtime, RUNTIME_DERIVED_DATABASE_PATHS.taskQuery); await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, 'index'); await writeFile(indexPath + '-wal', 'indexwal');
  const hash = 'aa' + '0'.repeat(62); await writeFile(join(f.objects, hash), 'image');
  await writeFile(join(f.objects, hash + '.00000000-0000-4000-8000-000000000001.tmp'), 'partial');
  await writeFile(join(f.input.userData, 'unowned.txt'), 'unrelated source sentinel');
  await mkdir(join(f.root, '.profile.ariadne-retained-fixture')); await writeFile(join(f.root, '.profile.ariadne-retained-fixture', 'huge'), Buffer.alloc(500));
  const result = await measureOwnedDataUsage(f.input);
  expect(result.databases).toEqual({ files: 9, bytes: 77 });
  expect(result.privateFiles).toEqual({ files: 2, bytes: 20 });
  expect(result.attachments).toEqual({ files: 1, bytes: 5 });
  expect(result.unpublishedAttachments).toEqual({ files: 1, bytes: 7 }); expect(result.totalBytes).toBe(122);
  expect(result.derivedCaches).toEqual({ files: 2, bytes: 13 });
  expect(JSON.stringify(result)).not.toContain(f.root);
  expect(await readFile(join(f.input.userData, 'unowned.txt'), 'utf8')).toBe('unrelated source sentinel');
});
it('rejects incomplete required inventories and unrecognized attachment entries', async () => {
  const f = await fixture(); await writeFile(join(f.objects, 'unexpected.txt'), 'unowned');
  await expect(measureOwnedDataUsage(f.input)).rejects.toThrow('data_usage_attachment_object_invalid');
  await rm(join(f.objects, 'unexpected.txt'));
  const required = BACKUP_FIXED_FILES.find(item => item.scope === 'runtime')!; await rm(join(f.input.runtime, required.path));
  await expect(measureOwnedDataUsage(f.input)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refuses an aliased attachment subtree rather than measuring files outside its owner', async () => {
  const f = await fixture(), external = join(f.root, 'external'); await mkdir(external);
  await writeFile(join(external, 'aa' + '0'.repeat(62)), 'outside'); await rmdir(f.objects);
  await symlink(external, f.objects, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(measureOwnedDataUsage(f.input)).rejects.toThrow('data_usage_attachment_bucket_invalid');
  expect(await readFile(join(external, 'aa' + '0'.repeat(62)), 'utf8')).toBe('outside');
});
it('rejects malformed unpublished names and wrong buckets without changing their bytes', async () => {
  const f = await fixture(), hash = 'aa' + '0'.repeat(62);
  for (const name of [hash + '.' + '-'.repeat(36) + '.tmp',
    hash + '.00000000-0000-1000-8000-000000000001.tmp',
    'bb' + hash.slice(2) + '.00000000-0000-4000-8000-000000000001.tmp']) {
    const target = join(f.objects, name); await writeFile(target, 'Unowned staging sentinel');
    await expect(measureOwnedDataUsage(f.input)).rejects.toThrow('data_usage_attachment_object_invalid');
    expect(await readFile(target, 'utf8')).toBe('Unowned staging sentinel'); await rm(target);
  }
});
