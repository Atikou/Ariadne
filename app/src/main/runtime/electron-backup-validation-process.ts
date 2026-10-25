import { app } from 'electron';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { assertRuntimeMessageSize } from '@ariadne/protocol/host';
import { ElectronSafeStorageCipher } from '../persistence/secret-cipher';
import { hasProtectedWindowsStorageKey } from '../persistence/safe-storage-bootstrap';
import { readBoundedPrivateFile, validateMainRecoveryFiles } from '../data-management/main-recovery-validation';
import { validateRuntimeRecoveryWithWorker, RuntimeStorageValidationError } from './runtime-storage-maintenance-worker';
import { electronBackupValidationRequestSchema, electronBackupValidationResponseSchema,
  type ElectronBackupValidationResponse } from './electron-backup-validation-contract';

export function isElectronBackupValidationProcess(): boolean { return process.env.ARIADNE_PRIVATE_BACKUP_VALIDATION === '1'; }

/** Runs inside an IPC-owned Electron child. No application controller, window,
 * Runtime actor, notification consumer or original store initializer starts. */
export function startElectronBackupValidationProcess(): void {
  if (!process.send || process.platform !== 'win32') throw new Error('isolated_recovery_private_process_required');
  const profile = process.env.ARIADNE_PRIVATE_BACKUP_VALIDATION_PROFILE;
  if (!profile || !/^\.ariadne-validation-[0-9a-f-]{36}\.tmp$/u.test(basename(profile))) throw new Error('isolated_recovery_profile_invalid');
  const value = lstatSync(profile);
  if (!value.isDirectory() || value.isSymbolicLink() || realpathSync(profile) !== profile) throw new Error('isolated_recovery_profile_invalid');
  app.setPath('userData', join(profile, 'userData')); app.setPath('sessionData', join(profile, 'sessionData'));
  let handled = false;
  const timeout = setTimeout(() => app.exit(1), 10 * 60_000);
  process.on('disconnect', () => app.exit(1));
  process.on('message', async input => {
    if (handled || !process.send) { app.exit(1); return; } handled = true;
    let response: ElectronBackupValidationResponse;
    let phase: Extract<ElectronBackupValidationResponse['outcome'], { ok: false }>['phase'] = 'request';
    try {
      assertRuntimeMessageSize(input);
      const request = electronBackupValidationRequestSchema.parse(input);
      const restored = lstatSync(request.restoreRoot);
      if (!/^\.ariadne-restore-[0-9a-f-]{36}\.tmp$/u.test(basename(request.restoreRoot)) || !restored.isDirectory()
        || restored.isSymbolicLink() || realpathSync(request.restoreRoot) !== request.restoreRoot) throw new Error('isolated_recovery_root_invalid');
      for (const name of ['userData', 'runtime', 'sessionData']) {
        const path = join(request.restoreRoot, name), dir = lstatSync(path);
        if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(path) !== path) throw new Error('isolated_recovery_root_alias');
      }
      phase = 'profile';
      const sourceKey = profileKey(await readBoundedPrivateFile(join(request.restoreRoot, 'sessionData', 'Local State'), 1024 * 1024));
      if (profileKey(await readBoundedPrivateFile(join(profile, 'sessionData', 'Local State'), 1024 * 1024)) !== sourceKey)
        throw new Error('isolated_recovery_profile_key_changed');
      await app.whenReady();
      const cipher = new ElectronSafeStorageCipher(); await cipher.initialize();
      phase = 'main-files';
      const main = await validateMainRecoveryFiles(join(request.restoreRoot, 'userData'), cipher);
      phase = 'runtime-files';
      const runtime = await validateRuntimeRecoveryWithWorker({ entry: request.runtimeEntry, executablePath: request.runtimeExecutable,
        dataRoot: join(request.restoreRoot, 'runtime') }, main.keyRing);
      phase = 'profile-retained';
      if (profileKey(await readBoundedPrivateFile(join(profile, 'sessionData', 'Local State'), 1024 * 1024)) !== sourceKey)
        throw new Error('isolated_recovery_profile_key_changed');
      response = electronBackupValidationResponseSchema.parse({ protocol: request.protocol, requestId: request.requestId,
        outcome: { ok: true, checkedPrivateFiles: main.checkedPrivateFiles, runtime } });
    } catch (error) {
      if (error instanceof RuntimeStorageValidationError) phase = ('runtime-' + error.phase) as typeof phase;
      const request = electronBackupValidationRequestSchema.safeParse(input);
      if (!request.success) { clearTimeout(timeout); app.exit(1); return; }
      response = electronBackupValidationResponseSchema.parse({ protocol: request.data.protocol, requestId: request.data.requestId,
        outcome: { ok: false, code: 'isolated_recovery_validation_failed', phase } });
    }
    assertRuntimeMessageSize(response); clearTimeout(timeout);
    const code = response.outcome.ok ? 0 : 1;
    process.send(response, error => app.exit(error ? 1 : code));
  });
}

function profileKey(raw: string): string {
  const value: unknown = JSON.parse(raw); if (!hasProtectedWindowsStorageKey(value)) throw new Error('isolated_recovery_profile_key_invalid');
  return (value as { os_crypt: { encrypted_key: string } }).os_crypt.encrypted_key;
}
