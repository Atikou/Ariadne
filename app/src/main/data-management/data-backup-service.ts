import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { backupManifestSchema } from './backup-manifest';
import { publishBackupBundle, removeOwnedBackupStage, type PublishedBackup } from './backup-bundle';
import { captureMainSnapshot } from './main-snapshot';
import { captureRuntimeSnapshotWithWorker, type RuntimeSnapshotWorkerOptions } from '../runtime/runtime-storage-maintenance-worker';
import type { BackupKeyProtector } from '../runtime/windows-backup-key-protector';
import type { MainMaintenanceGate } from './main-maintenance-gate';
import type { RuntimeSupervisor } from '../runtime/runtime-supervisor';
import type { TaskNotificationReceipts } from '../persistence/task-notification-receipts';
import { RUNTIME_DATABASE_PATHS } from '../runtime/runtime-storage-layout';
import { MainOfflineDataMaintenance } from './main-offline-data-maintenance';

export interface DataBackupDependencies {
  maintenance?: MainOfflineDataMaintenance;
  userData: string; sessionData: string; stagingParent: string; appVersion: string;
  runtimeWorker: Omit<RuntimeSnapshotWorkerOptions, 'snapshotRoot' | 'signal'>;
  gate: MainMaintenanceGate;
  runtime: Pick<RuntimeSupervisor, 'withOfflineMaintenance'>;
  taskNotificationReceipts: Pick<TaskNotificationReceipts, 'captureSnapshot'>;
  protector: BackupKeyProtector;
  prepareRendererDrafts(): Promise<void>;
  resumeRendererDrafts(): Promise<void>;
  pauseNotifications(): Promise<void>;
  resumeNotifications(): Promise<void>;
  beforeFreeze(): Promise<void>;
  stopMainRuntimeProducers(): Promise<void>;
  flushMainOwners(): Promise<void>;
}

/** One operation around the original Main and Runtime owners. A caller must
 * select the destination in Main; Renderer never grants a snapshot source path. */
export class DataBackupService {
  private readonly maintenance: MainOfflineDataMaintenance;
  get busy(): boolean { return this.maintenance.busy; }
  waitForIdle(): Promise<void> { return this.maintenance.waitForIdle(); }
  constructor(private readonly dependencies: DataBackupDependencies) {
    this.maintenance = dependencies.maintenance ?? new MainOfflineDataMaintenance(dependencies);
  }

  async create(destinationParent: string, signal?: AbortSignal): Promise<PublishedBackup> {
    if (this.busy) throw new Error('data_backup_busy');
    return this.maintenance.withOperation(async capture => {
    const source = this.dependencies;
    let stage: string | undefined;
    try {
      const parent = await canonicalDirectory(destinationParent), stagingParent = await canonicalDirectory(source.stagingParent);
      const forbiddenRoots = [source.userData, source.sessionData, source.runtimeWorker.dataRoot];
      for (const rawRoot of forbiddenRoots) {
        const root = await canonicalDirectory(rawRoot);
        if (within(root, parent) || within(root, stagingParent)) throw new Error('backup_destination_inside_source');
      }
      if (signal?.aborted) throw new Error('backup_cancelled');
      const proposed = join(stagingParent, '.ariadne-backup-' + randomUUID() + '.tmp');
      await mkdir(proposed); stage = proposed;
      const roots = { userData: join(stage, 'userData'), runtime: join(stage, 'runtime'), sessionData: join(stage, 'sessionData') };
      const manifest = await capture(async runtimeBoundary => {
          const runtimeFiles = await captureRuntimeSnapshotWithWorker({ ...source.runtimeWorker, snapshotRoot: roots.runtime,
            ...(signal ? { signal } : {}) });
          for (const [owner, path] of Object.entries(RUNTIME_DATABASE_PATHS)) {
            if (runtimeFiles.files.find(file => file.path === path)?.sqlite?.userVersion !== runtimeBoundary.storageSchemas[owner])
              throw new Error('backup_owner_schema_boundary_mismatch');
          }
          const mainFiles = await captureMainSnapshot({ userData: source.userData, sessionData: source.sessionData,
            stage: proposed, taskNotificationReceipts: source.taskNotificationReceipts });
          return backupManifestSchema.parse({ format: 'ariadne.same-machine-backup', version: 1, backupId: randomUUID(),
            appVersion: source.appVersion, runtimeProtocol: '3.0', publicContract: '5.0', createdAt: new Date().toISOString(),
            platform: 'win32', recoveryScope: 'same-machine-current-user', boundary: { ...runtimeBoundary, mainStoresFlushed: true },
            unpublishedAttachmentFilesExcluded: runtimeFiles.unpublishedAttachmentFilesExcluded,
            files: [...runtimeFiles.files.map(file => ({ ...file, scope: 'runtime', kind: file.sqlite ? 'database' : 'attachment' })),
              ...mainFiles.files], absent: mainFiles.absent,
            exclusions: ['model-weights', 'workspace-original-files', 'derived-search-and-task-indexes'] });
      });
      // Runtime is already resumed. Encrypt only the private copies; no live
      // owner stays frozen while writing the potentially large final backup.
      return await publishBackupBundle({ manifest, snapshotRoots: roots, destinationParent: parent, forbiddenRoots,
        protector: source.protector, ...(signal ? { signal } : {}) });
    } finally {
      if (stage) await removeOwnedBackupStage(await canonicalDirectory(source.stagingParent), stage, basename(stage));
    }
    }, signal);
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('backup_root_invalid');
  const named = await lstat(path);
  if (!named.isDirectory() || named.isSymbolicLink()) throw new Error('backup_root_invalid');
  return realpath(path);
}
function within(root: string, path: string): boolean {
  const value = relative(root, path); return !value || (!isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep));
}
