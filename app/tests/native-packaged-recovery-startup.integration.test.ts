import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { unpackBackupBundle, removeOwnedBackupStage } from '../src/main/data-management/backup-bundle';
import { buildVerifiedRestoreCandidate } from '../src/main/data-management/restore-candidate';
import { archiveSettledDataRootSwitch, dataRootCandidateName, inspectDataRootSwitch, prepareDataRootSwitch, settleDataRootSwitch } from '../src/main/data-management/data-root-switch-journal';
import { validateBackupInIsolatedElectron } from '../src/main/runtime/electron-backup-validation-worker';
import { WindowsBackupKeyProtector } from '../src/main/runtime/windows-backup-key-protector';
import { observeWindowsParentExit, type ObservedParentExit } from '../src/main/runtime/windows-parent-exit-observer';

const bundle = process.env.ARIADNE_BACKUP_NATIVE_BUNDLE, executable = process.env.ARIADNE_BACKUP_PACKAGED_APP;
const workspaceId = process.env.ARIADNE_BACKUP_NATIVE_WORKSPACE_ID, workspaceRoot = process.env.ARIADNE_BACKUP_NATIVE_WORKSPACE_ROOT;
for (const choice of ['original', 'replacement', 'cancel'] as const) {
  it.skipIf(!bundle || !executable || !workspaceId || !workspaceRoot)('runs original pre-owner packaged recovery startup choice: ' + choice, async () => {
    if (![bundle!, executable!, workspaceRoot!].every(isAbsolute)) throw new Error('native_startup_paths_invalid');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'AriadneRecoveryColdStart-'))), profile = join(root, 'profile'), output = join(root, 'evidence');
    await mkdir(profile); await mkdir(output);
    let stage: string | undefined, recoveryProfile: string | undefined, observer: ObservedParentExit | undefined, passed = false;
    try {
      const unpacked = await unpackBackupBundle({ directory: bundle!, stagingParent: root, forbiddenRoots: [], protector: new WindowsBackupKeyProtector() });
      stage = unpacked.stage;
      const validation = await validateBackupInIsolatedElectron({ electronExecutable: resolve('..', 'node_modules/electron/dist/electron.exe'),
        appPath: resolve('.'), packaged: false, restoreRoot: stage, stagingParent: root,
        runtimeEntry: resolve('..', 'runtime/dist/entry/storage-maintenance-process.js'), runtimeExecutable: process.execPath });
      const initialize = randomUUID(), first = await buildVerifiedRestoreCandidate({ unpacked, validation, dataRoot: profile, operationId: initialize });
      await prepareDataRootSwitch({ dataRoot: profile, operationId: initialize, backupId: unpacked.manifest.backupId, inventorySha256: first.inventorySha256 });
      await settleDataRootSwitch(profile, 'replacement'); await archiveSettledDataRootSwitch(profile);
      await writeFile(join(profile, 'original-root-sentinel.txt'), 'Original isolated root sentinel');
      const operationId = randomUUID(), candidate = await buildVerifiedRestoreCandidate({ unpacked, validation, dataRoot: profile, operationId });
      const candidateRoot = join(root, dataRootCandidateName('profile', operationId));
      await prepareDataRootSwitch({ dataRoot: profile, operationId, backupId: unpacked.manifest.backupId, inventorySha256: candidate.inventorySha256 });
      const journal = join(root, '.profile.ariadne-restore-journal.json'), originalJournal = await readFile(journal);
      const sourceCore = await readFile(join(profile, 'runtime', 'data/agent-control/agent-control.db'));
      const candidateCore = await readFile(join(candidateRoot, 'runtime', 'data/agent-control/agent-control.db'));
      const deadline = Date.now() + 90_000;
      const restart = choice === 'cancel' ? undefined : (async () => {
        while (Date.now() < deadline) {
          try { await readFile(join(output, 'data-recovery-cold-start.json')); break; }
          catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const evidence = JSON.parse(await readFile(join(output, 'data-recovery-cold-start.json'), 'utf8'));
        expect(evidence).toMatchObject({ passed: true, originalPackagedApplication: true, physicalInteraction: false });
        observer = await observeWindowsParentExit(evidence.mainPid, undefined, { expectedExecutable: await realpath(executable!) });
        await writeFile(join(output, 'observe-relaunched-main.ack'), String(evidence.mainPid));
        const code = await observer.exited; expect(code).toBe(0); await observer.release(); observer = undefined; return evidence;
      })();
      void restart?.catch(() => undefined);
      const firstExit = await new Promise<number | null>((yes, no) => {
        const child = spawn(executable!, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined,
          ARIADNE_SMOKE_TEST: '1', ARIADNE_SMOKE_USER_DATA: profile, ARIADNE_SMOKE_TEST_OUTPUT: output,
          ARIADNE_SMOKE_WORKSPACE_ID: workspaceId!, ARIADNE_SMOKE_WORKSPACE_ROOT: workspaceRoot!, ARIADNE_SMOKE_DATA_RECOVERY: '1',
          ARIADNE_SMOKE_DATA_RECOVERY_LIFECYCLE: undefined, ARIADNE_SMOKE_DATA_RECOVERY_CHOICE: choice, ARIADNE_SMOKE_DATA_RECOVERY_OBSERVE_EXIT: '1' } });
        const timer = setTimeout(() => { child.kill(); no(new Error('native_startup_timeout')); }, 90_000);
        child.once('error', error => { clearTimeout(timer); no(error); }); child.once('close', code => { clearTimeout(timer); yes(code); });
      });
      expect(firstExit).toBe(0);
      const selected = JSON.parse(await readFile(join(output, 'startup-recovery-choice.json'), 'utf8')); recoveryProfile = selected.recoveryChoiceProfile;
      expect(selected).toMatchObject({ choice, originalStartupRecoveryPath: true, originalApplicationOwnersStarted: false, physicalInteraction: false });
      const restarted = await restart;
      if (choice === 'cancel') {
        expect(await readFile(journal)).toEqual(originalJournal);
        expect(await readFile(join(profile, 'runtime', 'data/agent-control/agent-control.db'))).toEqual(sourceCore);
        expect(await readFile(join(candidateRoot, 'runtime', 'data/agent-control/agent-control.db'))).toEqual(candidateCore);
        expect((await inspectDataRootSwitch(profile))?.journal.phase).toBe('prepared');
        expect(await readdir(output)).toEqual(['startup-recovery-choice.json']);
      } else {
        expect(await inspectDataRootSwitch(profile)).toBeNull();
        if (choice === 'original') {
          expect(await readFile(join(profile, 'original-root-sentinel.txt'), 'utf8')).toBe('Original isolated root sentinel');
          expect(await readFile(join(candidateRoot, 'runtime', 'data/agent-control/agent-control.db'))).toEqual(candidateCore);
        } else {
          await expect(readFile(join(profile, 'original-root-sentinel.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(join(root, '.profile.ariadne-retained-' + operationId, 'original-root-sentinel.txt'), 'utf8')).toBe('Original isolated root sentinel');
        }
      }
      const external = process.env.ARIADNE_BACKUP_STARTUP_EVIDENCE;
      if (external) {
        if (!isAbsolute(external)) throw new Error('native_startup_evidence_invalid');
        await writeFile(external + '.' + choice + '.json', JSON.stringify({ passed: true, choice, firstMainCleanExit: true,
          originalPreOwnerRecoveryPath: true, ...(restarted ? { relaunchedMainCleanExit: true, observations: restarted.observations } : { bothRootsAndJournalByteUnchanged: true }),
          originalRootRetained: true, nativeDialogSelection: 'isolated fixture', physicalInteraction: false,
          authenticatedSourceCoreDigest: createHash('sha256').update(sourceCore).digest('hex') }, null, 2));
      }
      passed = true;
    } finally {
      await observer?.release();
      if (stage) await removeOwnedBackupStage(root, stage, basename(stage));
      if (recoveryProfile) {
        const canonical = await realpath(recoveryProfile);
        // Electron may return the user's 8.3 TEMP spelling. Delete only the
        // resolved physical sibling, with both parent and final entry checked.
        if (dirname(canonical) !== await realpath(tmpdir()) || !basename(canonical).startsWith('AriadneRecoveryChoice-')
          || await realpath(dirname(recoveryProfile)) !== await realpath(tmpdir()) || basename(canonical) !== basename(recoveryProfile)
          || (await lstat(recoveryProfile)).isSymbolicLink())
          throw new Error('Unsafe recovery choice fixture cleanup.');
        if (passed) await rm(canonical, { recursive: true, force: true });
      }
      if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('AriadneRecoveryColdStart-') || await realpath(root) !== root)
        throw new Error('Unsafe startup fixture cleanup.');
      if (passed) await rm(root, { recursive: true, force: true });
      else {
        const external = process.env.ARIADNE_BACKUP_STARTUP_EVIDENCE;
        if (external && isAbsolute(external)) await writeFile(external + '.' + choice + '.json', JSON.stringify({ passed: false, choice, root,
          failedProfileRetained: true, physicalInteraction: false }, null, 2));
      }
    }
  }, 120_000);
}
