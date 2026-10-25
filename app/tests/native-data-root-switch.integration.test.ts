import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { unpackBackupBundle, removeOwnedBackupStage } from '../src/main/data-management/backup-bundle';
import { buildVerifiedRestoreCandidate, verifyRestoreCandidate } from '../src/main/data-management/restore-candidate';
import { archiveSettledDataRootSwitch, inspectDataRootSwitch, prepareDataRootSwitch, settleDataRootSwitch } from '../src/main/data-management/data-root-switch-journal';
import { validateBackupInIsolatedElectron } from '../src/main/runtime/electron-backup-validation-worker';
import { WindowsBackupKeyProtector } from '../src/main/runtime/windows-backup-key-protector';
import { observeWindowsParentExit } from '../src/main/runtime/windows-parent-exit-observer';

const nativeBundle = process.env.ARIADNE_BACKUP_NATIVE_BUNDLE;
it.skipIf(!nativeBundle)('switches authenticated protected data only after an armed clean Electron exit and preserves both roots on failure', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'AriadneRootSwitchNative-')));
  const electron = resolve('..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const entry = resolve('out', 'main', 'data-root-switch-process.cjs'), fixture = join(root, 'parent.cjs');
  await build({ entryPoints: [resolve('tests', 'fixtures', 'electron-data-root-switch-parent.ts')], outfile: fixture,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'silent' });
  let stage: string | undefined;
  try {
    const unpacked = await unpackBackupBundle({ directory: nativeBundle!, stagingParent: root, forbiddenRoots: [], protector: new WindowsBackupKeyProtector() });
    stage = unpacked.stage;
    const accepted = await validateBackupInIsolatedElectron({ electronExecutable: electron, appPath: resolve('.'), packaged: false,
      restoreRoot: stage, stagingParent: root, runtimeEntry: resolve('..', 'runtime', 'dist', 'entry', 'storage-maintenance-process.js'), runtimeExecutable: process.execPath });
    expect(accepted.checkedPrivateFiles).toBe(unpacked.manifest.files.filter(file => file.scope === 'userData').length);
    expect('storageSchemas' in accepted.runtime && accepted.runtime.storageSchemas).toEqual(unpacked.manifest.boundary.storageSchemas);
    const evidence: { mainExit: number; helperExit: number; originalPreserved: boolean; restoredFiles: number }[] = [];
    for (const mainExit of [7, 0]) {
      const dataRoot = join(root, mainExit === 7 ? 'failed-profile' : 'profile'), operationId = randomUUID();
      await mkdir(dataRoot); await writeFile(join(dataRoot, 'original.txt'), 'original directory sentinel');
      const candidate = await buildVerifiedRestoreCandidate({ unpacked, validation: accepted, dataRoot, operationId });
      await prepareDataRootSwitch({ dataRoot, operationId, backupId: unpacked.manifest.backupId, inventorySha256: candidate.inventorySha256 });
      const parent = spawn(electron, [fixture, dataRoot, operationId, process.execPath, entry], { windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
      try {
        const helperPid = await new Promise<number>((yes, no) => {
          const timer = setTimeout(() => no(new Error('Native parent readiness timed out.')), 15_000);
          parent.once('error', no); parent.once('close', () => no(new Error('Native parent closed before ready.')));
          parent.once('message', input => { clearTimeout(timer);
            if (!input || typeof input !== 'object' || !('helperPid' in input) || !Number.isSafeInteger(input.helperPid)) { no(new Error('Invalid native readiness.')); return; }
            yes(Number(input.helperPid)); });
        });
        const helper = await observeWindowsParentExit(helperPid);
        expect((await inspectDataRootSwitch(dataRoot))?.current).toBe('original');
        expect(await readFile(join(dataRoot, 'original.txt'), 'utf8')).toBe('original directory sentinel');
        const parentClosed = new Promise<number | null>(yes => parent.once('close', yes)); parent.send(mainExit);
        expect(await parentClosed).toBe(mainExit);
        const helperExit = await helper.exited; helper.dispose();
        if (mainExit === 7) {
          expect({ helperExit, current: (await inspectDataRootSwitch(dataRoot))?.current ?? 'settled' }).toEqual({ helperExit: 1, current: 'original' });
          await verifyRestoreCandidate(candidate.candidate, unpacked.manifest.backupId, candidate.inventorySha256);
          await settleDataRootSwitch(dataRoot, 'original'); await archiveSettledDataRootSwitch(dataRoot);
        } else {
          expect(helperExit).toBe(0); expect(await inspectDataRootSwitch(dataRoot)).toBeNull();
          await verifyRestoreCandidate(dataRoot, unpacked.manifest.backupId, candidate.inventorySha256, candidate.candidate);
          for (const file of unpacked.manifest.files) {
            const path = file.scope === 'runtime' ? join(dataRoot, 'runtime', file.path) : join(dataRoot, file.path);
            expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(file.sha256);
          }
          expect(await readFile(join(root, '.profile.ariadne-retained-' + operationId, 'original.txt'), 'utf8')).toBe('original directory sentinel');
        }
        evidence.push({ mainExit, helperExit, originalPreserved: true, restoredFiles: unpacked.manifest.files.length });
      } finally { if (parent.exitCode === null && parent.signalCode === null) parent.kill(); }
    }
    const output = process.env.ARIADNE_ROOT_SWITCH_NATIVE_EVIDENCE;
    if (output) { if (!isAbsolute(output)) throw new Error('Evidence output must be absolute.');
      await writeFile(output, JSON.stringify({ evidence, actualElectronExit: true, authenticatedBackup: true,
        originalApplicationOwnerShutdown: 'separate Runtime/owner integration gates', rendererInteraction: false }, null, 2)); }
  } finally {
    if (stage) await removeOwnedBackupStage(root, stage, basename(stage));
    if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('AriadneRootSwitchNative-') || await realpath(root) !== root)
      throw new Error('Unsafe fixture cleanup.');
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
