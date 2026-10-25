import { randomUUID } from 'node:crypto';
import { dataCleanupPreviewSchema, dataCleanupResultSchema, type DataCleanupCommit, type DataCleanupPreview,
  type DataCleanupResult } from '@shared/data-management';
import { MainOfflineDataMaintenance } from './main-offline-data-maintenance';
import { inspectRuntimeAttachmentCleanupWithWorker, executeRuntimeAttachmentCleanupWithWorker,
  type RuntimeSnapshotWorkerOptions } from '../runtime/runtime-storage-maintenance-worker';
import type { RuntimeAgentPersistenceKeyRing } from '../persistence/agent-persistence-keyring';

export interface DataAttachmentCleanupDependencies {
  maintenance: MainOfflineDataMaintenance;
  worker: Omit<RuntimeSnapshotWorkerOptions, 'snapshotRoot' | 'signal'>;
  loadKeys(): Promise<RuntimeAgentPersistenceKeyRing>;
}
/** Main owns a one-use metadata ticket, never candidate paths. The worker
 * recomputes the authority/inventory version under all original owner leases
 * before any deletion; an interrupted claim stays durable recovery evidence. */
export class DataAttachmentCleanupService {
  private preview: DataCleanupPreview | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly dependencies: DataAttachmentCleanupDependencies) {}
  disposePreview(): void { this.preview = null; clearTimeout(this.expiryTimer); }

  async inspect(): Promise<DataCleanupPreview> {
    return this.dependencies.maintenance.withOperation(async capture => {
      if (this.preview && Date.parse(this.preview.expiresAt) <= Date.now()) this.disposePreview();
      if (this.preview) throw new Error('data_cleanup_preview_exists');
      const result = await capture(async () => inspectRuntimeAttachmentCleanupWithWorker(this.dependencies.worker, await this.dependencies.loadKeys()));
      const { maintenance: _maintenance, ...metadata } = result;
      const view = dataCleanupPreviewSchema.parse({ ...metadata, ticket: randomUUID(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      this.preview = view;
      this.expiryTimer = setTimeout(() => { if (this.preview?.ticket === view.ticket) this.disposePreview(); }, 15 * 60_000);
      this.expiryTimer.unref();
      return view;
    });
  }
  discard(ticket: string): void {
    if (this.dependencies.maintenance.busy) throw new Error('data_management_busy');
    this.requirePreview(ticket); this.disposePreview();
  }
  async commit(request: DataCleanupCommit): Promise<DataCleanupResult> {
    return this.dependencies.maintenance.withOperation(async capture => {
      const preview = this.requirePreview(request.ticket);
      if (Date.parse(preview.expiresAt) <= Date.now()) { this.disposePreview(); throw new Error('data_cleanup_preview_expired'); }
      if (request.version !== preview.version) throw new Error('data_cleanup_preview_changed');
      this.disposePreview();
      const result = await capture(async () => executeRuntimeAttachmentCleanupWithWorker(this.dependencies.worker,
        await this.dependencies.loadKeys(), preview.version, request.selected));
      const { maintenance: _maintenance, ...metadata } = result;
      return dataCleanupResultSchema.parse(metadata);
    });
  }
  private requirePreview(ticket: string): DataCleanupPreview {
    if (!this.preview || this.preview.ticket !== ticket) throw new Error('data_cleanup_preview_missing');
    return this.preview;
  }
}
