import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { sealBackupFile, unsealBackupFile } from '../src/main/data-management/backup-object-seal';
import type { BackupFileEntry } from '../src/main/data-management/backup-manifest';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'AriadneBackupObject-'))) throw new Error('Unsafe fixture cleanup path.');
  await rm(root, { recursive: true, force: true });
} });
const backupId = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'AriadneBackupObject-')); roots.push(root);
  const bytes = randomBytes(300_123), source = join(root, 'source'); await writeFile(source, bytes);
  const entry: BackupFileEntry = { scope: 'userData', path: 'chat-drafts.json', kind: 'private-file', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), sqlite: null };
  return { root, source, bytes, entry, sealed: join(root, 'sealed'), restored: join(root, 'restored'), key: randomBytes(32) };
}
describe('authenticated streaming backup objects', () => {
  it('restores bytes from bounded encrypted chunks without replacing the source or an existing destination', async () => {
    const value = await fixture();
    try {
      const seal = await sealBackupFile(value.source, value.sealed, value.key, backupId, value.entry);
      expect((await readFile(value.sealed)).equals(value.bytes)).toBe(false);
      await unsealBackupFile(value.sealed, value.restored, value.key, backupId, value.entry, seal);
      expect((await readFile(value.restored)).equals(value.bytes)).toBe(true);
      expect((await readFile(value.source)).equals(value.bytes)).toBe(true);
      await expect(sealBackupFile(value.source, value.sealed, value.key, backupId, value.entry)).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(unsealBackupFile(value.sealed, value.restored, value.key, backupId, value.entry, seal)).rejects.toThrow('backup_object_validation_failed');
      expect((await readFile(value.restored)).equals(value.bytes)).toBe(true);
    } finally { value.key.fill(0); }
  });

  it('rejects changed ciphertext, wrong keys and swapped owned identities and removes only its failed output', async () => {
    const value = await fixture();
    try {
      const seal = await sealBackupFile(value.source, value.sealed, value.key, backupId, value.entry);
      for (const [key, entry] of [[randomBytes(32), value.entry], [value.key, { ...value.entry, path: 'file-drafts.json' }]] as const) {
        await expect(unsealBackupFile(value.sealed, value.restored, key, backupId, entry, seal)).rejects.toThrow('backup_object_validation_failed');
        await expect(stat(value.restored)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const damaged = await readFile(value.sealed); damaged[40]! ^= 1; await writeFile(value.sealed, damaged);
      await expect(unsealBackupFile(value.sealed, value.restored, value.key, backupId, value.entry, seal)).rejects.toThrow('backup_object_validation_failed');
      await expect(stat(value.restored)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readFile(value.source)).equals(value.bytes)).toBe(true);
    } finally { value.key.fill(0); }
  });

  it('refuses an unverified source digest and leaves the original bytes intact', async () => {
    const value = await fixture();
    try {
      await expect(sealBackupFile(value.source, value.sealed, value.key, backupId, { ...value.entry, sha256: '0'.repeat(64) }))
        .rejects.toThrow('backup_source_digest_changed');
      await expect(stat(value.sealed)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readFile(value.source)).equals(value.bytes)).toBe(true);
    } finally { value.key.fill(0); }
  });
});
