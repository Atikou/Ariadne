import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { captureRuntimeSnapshotWithWorker } from '../src/main/runtime/runtime-storage-maintenance-worker';
import { validateBackupInIsolatedElectron } from '../src/main/runtime/electron-backup-validation-worker';
import { captureMainSnapshot } from '../src/main/data-management/main-snapshot';
import { TaskNotificationReceipts } from '../src/main/persistence/task-notification-receipts';
import { removeOwnedBackupStage, unpackBackupBundle } from '../src/main/data-management/backup-bundle';
import { WindowsBackupKeyProtector } from '../src/main/runtime/windows-backup-key-protector';

// Explicitly opted-in native gate reuses a retained, cleanly stopped original
// Electron/Core fixture. No source credential, payload or key is logged.
// This validates real profile recovery, not a new backup maintenance window.
const nativeSource = process.env.ARIADNE_BACKUP_NATIVE_FIXTURE_ROOT;
const nativeBundle = process.env.ARIADNE_BACKUP_NATIVE_BUNDLE;
it.skipIf(!nativeSource)('validates original Electron-sealed Main and Core recovery copies without actors or source mutation', async () => {
  const source = resolve(nativeSource!), temporary = resolve(tmpdir());
  // Windows TEMP may use an 8.3 account directory. Check the actual direct
  // parent's filesystem identity, rather than treating its spelling as scope.
  const sourceParent = await stat(dirname(source), { bigint: true }), tempParent = await stat(temporary, { bigint: true });
  if (!sourceParent.isDirectory() || sourceParent.ino === 0n || sourceParent.ino !== tempParent.ino
    || sourceParent.dev !== tempParent.dev || !basename(source).startsWith('AriadneDomainHealth-')) throw new Error('native_fixture_outside_scope');
  const root = await realpath(await mkdtemp(join(temporary, 'AriadneNativeRecovery-')));
  let stage: string | undefined;
  const runtimeEntry = resolve('..', 'runtime', 'dist', 'entry', 'storage-maintenance-process.js');
  const receipts = new TaskNotificationReceipts(join(source, 'notification-delivery.db')); await receipts.initialize();
  try {
    let files: { scope: 'runtime' | 'userData' | 'sessionData'; path: string }[];
    if (nativeBundle) {
      const unpacked = await unpackBackupBundle({ directory: nativeBundle, stagingParent: root,
        forbiddenRoots: [source, join(source, 'runtime')], protector: new WindowsBackupKeyProtector() });
      stage = unpacked.stage; files = unpacked.manifest.files;
    } else {
      stage = join(root, '.ariadne-restore-' + randomUUID() + '.tmp'); await mkdir(stage);
      const runtime = await captureRuntimeSnapshotWithWorker({ entry: runtimeEntry, executablePath: process.execPath,
        dataRoot: join(source, 'runtime'), snapshotRoot: join(stage, 'runtime') });
      const main = await captureMainSnapshot({ userData: source, sessionData: source, stage, taskNotificationReceipts: receipts });
      files = [...runtime.files.map(file => ({ scope: 'runtime' as const, ...file })), ...main.files];
    }
    const restoredStage = stage;
    const originalDigests = await Promise.all(files.map(async file => {
      const path = file.scope === 'runtime' ? join(source, 'runtime', file.path) : join(source, file.path);
      return createHash('sha256').update(await readFile(path)).digest('hex');
    }));
    const stageDigests = await Promise.all(files.map(async file => createHash('sha256').update(await readFile(join(restoredStage, file.scope, file.path))).digest('hex')));
    const options = { electronExecutable: resolve('..', 'node_modules', 'electron', 'dist', 'electron.exe'), appPath: resolve('.'), packaged: false,
      restoreRoot: stage, stagingParent: root, runtimeEntry, runtimeExecutable: process.execPath };
    const accepted = await validateBackupInIsolatedElectron(options);
    expect(accepted.ok).toBe(true); expect(accepted.checkedPrivateFiles).toBeGreaterThan(3);
    expect('protectedArtifacts' in accepted.runtime && accepted.runtime.protectedArtifacts).toBeGreaterThan(0);
    expect('referencedAttachments' in accepted.runtime && accepted.runtime.referencedAttachments).toBeGreaterThan(0);
    expect(await Promise.all(files.map(async file => createHash('sha256').update(await readFile(join(restoredStage, file.scope, file.path))).digest('hex')))).toEqual(stageDigests);
    const keyFile = join(stage, 'userData', 'agent-persistence-keyring.json'), originalKey = await readFile(keyFile);
    const damaged = JSON.parse(originalKey.toString('utf8')) as { sealedManifest: string };
    const sealed = Buffer.from(damaged.sealedManifest, 'base64'); sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
    damaged.sealedManifest = sealed.toString('base64'); await writeFile(keyFile, JSON.stringify(damaged));
    await expect(validateBackupInIsolatedElectron(options)).rejects.toThrow('isolated_recovery_validation_failed');
    await writeFile(keyFile, originalKey);
    const stalePath = join(stage, 'runtime', 'data', 'agent-control', 'agent-control.db'), stale = new DatabaseSync(stalePath);
    stale.exec('PRAGMA user_version=7'); stale.close(); const oldBytes = await readFile(stalePath);
    await expect(validateBackupInIsolatedElectron(options)).rejects.toThrow('isolated_recovery_validation_failed');
    expect(await readFile(stalePath)).toEqual(oldBytes);
    expect(await Promise.all(files.map(async file => {
      const path = file.scope === 'runtime' ? join(source, 'runtime', file.path) : join(source, file.path);
      return createHash('sha256').update(await readFile(path)).digest('hex');
    }))).toEqual(originalDigests);
    const evidence = process.env.ARIADNE_BACKUP_NATIVE_EVIDENCE;
    if (evidence) { if (!isAbsolute(evidence)) throw new Error('native_evidence_path_not_absolute'); await mkdir(dirname(evidence), { recursive: true });
      await writeFile(evidence, JSON.stringify({ accepted, sourceFilesUnchanged: true, validStageFilesUnchanged: true,
        corruptedSealedKeyRejected: true, retiredAgentSchemaRejectedAndPreserved: true,
        source: 'original native OS-storage / production Runtime / synthetic Core-command fixture', encryptedBundleUnpacked: Boolean(nativeBundle),
        validatedFiles: files.length, actorsStartedDuringValidation: false, physicalInteraction: false }, null, 2)); }
  } finally {
    receipts.close(); if (stage) await removeOwnedBackupStage(root, stage, basename(stage));
    const cleanup = relative(await realpath(temporary), root);
    if (!cleanup || cleanup.startsWith('..') || isAbsolute(cleanup) || !basename(root).startsWith('AriadneNativeRecovery-')) throw new Error('native_cleanup_outside_scope');
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
