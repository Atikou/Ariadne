import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { assertRuntimeMessageSize } from '@ariadne/protocol/host';
import { copySnapshotFile } from '../data-management/snapshot-file';
import { removeOwnedBackupStage } from '../data-management/backup-bundle';
import { electronBackupValidationRequestSchema, electronBackupValidationResponseSchema,
  type ElectronBackupValidationResponse } from './electron-backup-validation-contract';

export interface ElectronBackupValidationOptions {
  electronExecutable: string; appPath: string; packaged: boolean; restoreRoot: string; stagingParent: string;
  runtimeEntry: string; runtimeExecutable: string; signal?: AbortSignal;
}

/** Main-owned auxiliary profile is separate from the authenticated restore
 * stage: Chromium startup/exit may write its own profile, never restore files. */
export async function validateBackupInIsolatedElectron(options: ElectronBackupValidationOptions): Promise<
  Extract<ElectronBackupValidationResponse['outcome'], { ok: true }>> {
  if (![options.electronExecutable, options.appPath, options.restoreRoot, options.stagingParent].every(isAbsolute))
    throw new Error('isolated_recovery_worker_path_invalid');
  const namedParent = await lstat(options.stagingParent), parent = await realpath(options.stagingParent);
  if (!namedParent.isDirectory() || namedParent.isSymbolicLink()) throw new Error('isolated_recovery_worker_path_invalid');
  const distance = relative(await realpath(options.restoreRoot), parent);
  if (!distance || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith('..' + sep))) throw new Error('isolated_recovery_profile_inside_restore');
  const profile = join(parent, '.ariadne-validation-' + randomUUID() + '.tmp');
  await mkdir(profile);
  try {
    await mkdir(join(profile, 'userData')); await mkdir(join(profile, 'sessionData'));
    await copySnapshotFile(join(options.restoreRoot, 'sessionData', 'Local State'), join(profile, 'sessionData', 'Local State'));
    if (options.signal?.aborted) throw new Error('isolated_recovery_cancelled');
    const request = electronBackupValidationRequestSchema.parse({ protocol: 'ariadne_electron_backup_validation.v1', requestId: randomUUID(),
      restoreRoot: options.restoreRoot, runtimeEntry: options.runtimeEntry, runtimeExecutable: options.runtimeExecutable });
    assertRuntimeMessageSize(request);
    return await new Promise((resolve, reject) => {
      const child = spawn(options.electronExecutable, options.packaged ? [] : [options.appPath], { cwd: profile, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined,
          ARIADNE_PRIVATE_BACKUP_VALIDATION: '1', ARIADNE_PRIVATE_BACKUP_VALIDATION_PROFILE: profile } });
      let response: ElectronBackupValidationResponse | null = null, fault: Error | null = null;
      const fail = (code: string): void => { fault ??= new Error(code); if (child.exitCode === null && child.signalCode === null) child.kill(); };
      const cancel = (): void => fail('isolated_recovery_cancelled');
      const timer = setTimeout(() => fail('isolated_recovery_timeout'), 10 * 60_000);
      options.signal?.addEventListener('abort', cancel, { once: true }); child.stdout?.resume(); child.stderr?.resume();
      child.on('error', () => fail('isolated_recovery_process_failed'));
      child.on('message', input => {
        try { assertRuntimeMessageSize(input); const value = electronBackupValidationResponseSchema.parse(input);
          if (response || value.requestId !== request.requestId) throw new Error('isolated_recovery_response_identity'); response = value; }
        catch { fail('isolated_recovery_response_invalid'); }
      });
      child.on('close', code => {
        clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
        if (fault) { reject(fault); return; }
        if (code !== 0 || !response?.outcome.ok || !('validation' in response.outcome.runtime)
          || response.outcome.runtime.validation !== 'current-recovery') {
          reject(new Error('isolated_recovery_validation_failed' + (response && !response.outcome.ok ? ':' + response.outcome.phase : ':process'))); return;
        }
        resolve(response.outcome);
      });
      child.send(request, error => { if (error) fail('isolated_recovery_request_failed'); });
    });
  } finally { await removeOwnedBackupStage(parent, profile, basename(profile)); }
}
