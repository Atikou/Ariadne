import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { dataRestorePreviewSchema, type DataRestorePreview } from '@shared/data-management';
import { removeOwnedBackupStage, unpackBackupBundle, type UnpackedBackup } from './backup-bundle';
import { archiveSettledDataRootSwitch, prepareDataRootSwitch, settleDataRootSwitch } from './data-root-switch-journal';
import { buildVerifiedRestoreCandidate } from './restore-candidate';
import { validateBackupInIsolatedElectron, type ElectronBackupValidationOptions } from '../runtime/electron-backup-validation-worker';
import { prepareDataRootSwitchWorker } from '../runtime/data-root-switch-worker';
import type { BackupKeyProtector } from '../runtime/windows-backup-key-protector';
import type { ElectronBackupValidationResponse } from '../runtime/electron-backup-validation-contract';

type Validation = Extract<ElectronBackupValidationResponse['outcome'], { ok: true }>;
interface PrivatePreview { view: DataRestorePreview; unpacked: UnpackedBackup; validation: Validation }
export class DataRestoreOwnersStillOpenError extends Error { constructor() { super('restore_source_owners_retained'); } }
export interface DataRestoreDependencies {
  userData: string; sessionData: string; stagingParent: string; protector: BackupKeyProtector;
  validation: Omit<ElectronBackupValidationOptions, 'restoreRoot' | 'stagingParent' | 'signal'>;
  switchEntry: string; stopMainOwners(): Promise<void>; exitMain(code: 0 | 1): void;
}

/** Main retains paths, decrypted-stage ownership and the one-use operation
 * ticket. Renderer receives bounded metadata only. A preview never modifies
 * the live root; commit preserves the old root and replaces it only after the
 * exact original Main process and all owners have exited cleanly. */
export class DataRestoreService {
  private active = false;
  private idle: Promise<void> = Promise.resolve();
  private preview: PrivatePreview | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  get busy(): boolean { return this.active; }
  waitForIdle(): Promise<void> { return this.idle; }
  constructor(private readonly dependencies: DataRestoreDependencies) {}

  async inspect(directory: string): Promise<DataRestorePreview> {
    return this.operation(async () => {
      if (this.preview) throw new Error('restore_preview_exists');
      const input = this.dependencies;
      if (await realpath(input.userData) !== await realpath(input.sessionData)) throw new Error('restore_profile_layout_unsupported');
      const unpacked = await unpackBackupBundle({ directory, stagingParent: input.stagingParent,
        forbiddenRoots: [input.userData, input.sessionData], protector: input.protector });
      try {
        const validation = await validateBackupInIsolatedElectron({ ...input.validation, restoreRoot: unpacked.stage, stagingParent: input.stagingParent });
        if (!('validation' in validation.runtime) || validation.runtime.validation !== 'current-recovery') throw new Error('restore_validation_incomplete');
        const view = dataRestorePreviewSchema.parse({ ticket: randomUUID(), backupId: unpacked.manifest.backupId, version: 1,
          createdAt: unpacked.manifest.createdAt, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          files: unpacked.manifest.files.length, bytes: unpacked.manifest.files.reduce((sum, file) => sum + file.bytes, 0),
          protectedArtifacts: validation.runtime.protectedArtifacts, referencedAttachments: validation.runtime.referencedAttachments,
          recoveryScope: 'same-machine-current-user' });
        this.preview = { view, unpacked, validation }; this.scheduleExpiry(view.ticket); return view;
      } catch (error) { await this.releaseStage(unpacked); throw error; }
    });
  }

  async discard(ticket: string): Promise<void> {
    return this.operation(async () => { const preview = this.requirePreview(ticket); await this.releaseStage(preview.unpacked);
      this.preview = null; clearTimeout(this.expiryTimer); });
  }

  async disposePreview(): Promise<void> {
    await this.waitForIdle();
    if (this.preview) await this.discard(this.preview.view.ticket);
    clearTimeout(this.expiryTimer);
  }

  async commit(ticket: string): Promise<void> {
    return this.operation(async () => {
      const preview = this.requirePreview(ticket), input = this.dependencies;
      if (Date.parse(preview.view.expiresAt) <= Date.now()) {
        await this.releaseStage(preview.unpacked);
        this.preview = null; clearTimeout(this.expiryTimer);
        throw new Error('restore_preview_expired');
      }
      const dataRoot = await realpath(input.userData), operationId = randomUUID();
      // A commit consumes its preview even when assembly fails. Any partially
      // assembled candidate stays as evidence; the validation stage is owned
      // only by this short-lived preview and is no longer needed afterwards.
      this.preview = null; clearTimeout(this.expiryTimer);
      let candidate: Awaited<ReturnType<typeof buildVerifiedRestoreCandidate>>;
      try { candidate = await buildVerifiedRestoreCandidate({ unpacked: preview.unpacked, validation: preview.validation, dataRoot, operationId }); }
      finally { await this.releaseStage(preview.unpacked); }
      await prepareDataRootSwitch({ dataRoot, operationId, backupId: preview.view.backupId, inventorySha256: candidate.inventorySha256 });
      let worker: Awaited<ReturnType<typeof prepareDataRootSwitchWorker>> | undefined, ownersStopped = false, shutdownAttempted = false;
      try {
        worker = await prepareDataRootSwitchWorker({ executable: input.validation.runtimeExecutable, entry: input.switchEntry,
          dataRoot, operationId, choice: 'replacement', relaunch: { executable: input.validation.electronExecutable,
            appPath: input.validation.appPath, packaged: input.validation.packaged } });
        shutdownAttempted = true; await input.stopMainOwners(); ownersStopped = true;
        await worker.arm(); input.exitMain(0);
      } catch (error) {
        await worker?.cancel();
        if (ownersStopped || (shutdownAttempted && !(error instanceof DataRestoreOwnersStillOpenError))) { input.exitMain(1); throw error; }
        // Before the original owners close, rollback only settles metadata:
        // the root is still original. The failed candidate remains evidence.
        await settleDataRootSwitch(dataRoot, 'original'); await archiveSettledDataRootSwitch(dataRoot);
        throw error;
      }
    });
  }

  private requirePreview(ticket: string): PrivatePreview {
    if (!this.preview || this.preview.view.ticket !== ticket) throw new Error('restore_preview_invalid'); return this.preview;
  }
  private scheduleExpiry(ticket: string, retry = false): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      void (async () => {
        await this.waitForIdle();
        if (this.preview?.view.ticket === ticket && Date.parse(this.preview.view.expiresAt) <= Date.now()) await this.discard(ticket);
      })().catch(() => { if (this.preview?.view.ticket === ticket) this.scheduleExpiry(ticket, true); });
    }, retry ? 10_000 : 15 * 60_000);
    this.expiryTimer.unref();
  }
  private async releaseStage(unpacked: UnpackedBackup): Promise<void> {
    const parent = await realpath(this.dependencies.stagingParent);
    await removeOwnedBackupStage(parent, unpacked.stage, basename(unpacked.stage));
  }
  private async operation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('data_restore_busy');
    this.active = true; let release!: () => void; this.idle = new Promise(resolve => { release = resolve; });
    try { return await operation(); } finally { this.active = false; release(); }
  }
}
