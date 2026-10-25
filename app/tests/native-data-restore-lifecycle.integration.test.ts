import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DataRestoreService } from '../src/main/data-management/data-restore-service';
import { WindowsBackupKeyProtector } from '../src/main/runtime/windows-backup-key-protector';

const nativeBundle = process.env.ARIADNE_BACKUP_NATIVE_BUNDLE;
// Original authenticated container, OS key protection, Main readers and
// Runtime read-only payload validation. The live root here is an independent
// sentinel fixture: this gate never shuts down the user's Main or switches it.
it.skipIf(!nativeBundle)('owns native restore previews through cancellation, expiry and failed candidate assembly', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'AriadneRestoreLifecycle-')));
  const live = join(root, 'profile'); await mkdir(live);
  const sentinel = join(live, 'original.txt'); await writeFile(sentinel, 'original directory sentinel');
  const header = join(nativeBundle!, 'header.json'), originalHeader = await readFile(header);
  let ownersStopped = 0, exits = 0;
  const service = new DataRestoreService({ userData: live, sessionData: live, stagingParent: root,
    protector: new WindowsBackupKeyProtector(), switchEntry: resolve('out', 'main', 'data-root-switch-process.cjs'),
    validation: { electronExecutable: resolve('..', 'node_modules', 'electron', 'dist', 'electron.exe'),
      appPath: resolve('.'), packaged: false, runtimeExecutable: process.execPath,
      runtimeEntry: resolve('..', 'runtime', 'dist', 'entry', 'storage-maintenance-process.js') },
    stopMainOwners: async () => { ownersStopped++; }, exitMain: () => { exits++; } });
  const stages = async () => (await readdir(root)).filter(name => name.startsWith('.ariadne-restore-'));
  try {
    const first = await service.inspect(nativeBundle!);
    expect(first.files).toBe(18); expect(first.protectedArtifacts).toBeGreaterThan(0);
    expect(first.referencedAttachments).toBeGreaterThan(0);
    expect(Object.keys(first)).not.toContain('directory');
    await expect(service.inspect(nativeBundle!)).rejects.toThrow('restore_preview_exists');
    await expect(service.discard('00000000-0000-4000-8000-000000000000')).rejects.toThrow('restore_preview_invalid');
    expect(await stages()).toHaveLength(1);
    await service.discard(first.ticket); expect(await stages()).toEqual([]);
    await expect(service.commit(first.ticket)).rejects.toThrow('restore_preview_invalid');

    const expired = await service.inspect(nativeBundle!);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(expired.expiresAt) + 1);
    await expect(service.commit(expired.ticket)).rejects.toThrow('restore_preview_expired');
    vi.useRealTimers(); expect(await stages()).toEqual([]);
    await expect(service.commit(expired.ticket)).rejects.toThrow('restore_preview_invalid');

    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    const idleExpiry = await service.inspect(nativeBundle!);
    const expiryCallback = scheduled.mock.calls.find(call => call[1] === 15 * 60_000)?.[0];
    scheduled.mockRestore(); expect(typeof expiryCallback).toBe('function');
    // Invoke the callback registered on the actual timer, with only Date moved
    // to its expiry. Native process timers always run on the real clock.
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(idleExpiry.expiresAt) + 1);
    (expiryCallback as () => void)(); await Promise.resolve(); await service.waitForIdle();
    vi.useRealTimers(); expect(await stages()).toEqual([]);
    await expect(service.discard(idleExpiry.ticket)).rejects.toThrow('restore_preview_invalid');

    const changed = await service.inspect(nativeBundle!);
    const stage = join(root, (await stages())[0]!);
    const payload = join(stage, 'userData', 'agent-persistence-keyring.json');
    await writeFile(payload, 'changed after successful isolated validation');
    await expect(service.commit(changed.ticket)).rejects.toThrow('restore_candidate_digest_mismatch');
    expect(await stages()).toEqual([]);
    await expect(service.commit(changed.ticket)).rejects.toThrow('restore_preview_invalid');
    expect((await readdir(root)).some(name => name.startsWith('.profile.ariadne-candidate-'))).toBe(true);
    expect((await readdir(root)).some(name => name.endsWith('ariadne-restore-journal.json'))).toBe(false);
    const closing = await service.inspect(nativeBundle!); await service.disposePreview();
    expect(await stages()).toEqual([]);
    await expect(service.discard(closing.ticket)).rejects.toThrow('restore_preview_invalid');
    expect(ownersStopped).toBe(0); expect(exits).toBe(0);
    expect(await readFile(sentinel, 'utf8')).toBe('original directory sentinel');
    expect(createHash('sha256').update(await readFile(header)).digest('hex'))
      .toBe(createHash('sha256').update(originalHeader).digest('hex'));
  } finally {
    vi.restoreAllMocks(); vi.useRealTimers(); await service.disposePreview();
    if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('AriadneRestoreLifecycle-')
      || await realpath(root) !== root) throw new Error('Unsafe fixture cleanup.');
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
