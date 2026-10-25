import { fileDraftCatalogSchema, fileDraftRecordsSchema, type FileDraftApi, type FileDraftRecord } from '@shared/file-drafts';

export interface FileDraftProtectionState {
  readonly ready: boolean;
  readonly error: string | null;
  readonly protectedAt: string | null;
  readonly saving: boolean;
}
/** User-facing storage status never includes Electron IPC names or raw paths. */
export function fileDraftProtectionMessage(error:unknown):string {
  const text=error instanceof Error?error.message:'';
  if(text.includes('file_draft_capacity_exceeded'))return '文件草稿已达到保护容量上限，请先保存或处理已有草稿。';
  if(text.includes('file_draft_revision_conflict')||text.includes('file_draft_editing_revision_conflict'))return '草稿保护版本发生冲突，请保留当前修改并核对恢复副本。';
  return '文件草稿存储不可用，请复制当前修改并保留窗口。';
}

/** Private persistence adapter. It never reads or writes workspace files. */
export class FileDraftProtection {
  private state: FileDraftProtectionState = { ready: false, error: null, protectedAt: null, saving: false };
  private storageRevision = 0;
  private sequence = 0;
  private savedSequence = 0;
  private saving: Promise<void> | null = null;
  private initializing: Promise<readonly FileDraftRecord[]> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly protectedRevisions = new Map<string, number>();
  constructor(private readonly api: Pick<FileDraftApi,'list'|'replace'>, private readonly capture: () => readonly FileDraftRecord[], private readonly publish: () => void) {}
  getState(): FileDraftProtectionState { return this.state; }
  protectedRevision(draftId: string): number | null { return this.protectedRevisions.get(draftId) ?? null; }
  initialize(restore: (records: readonly FileDraftRecord[]) => void): Promise<readonly FileDraftRecord[]> {
    if (this.initializing) return this.initializing;
    this.initializing = this.api.list().then(value => {
      const catalog = fileDraftCatalogSchema.parse(value); this.storageRevision = catalog.revision;
      for (const row of catalog.records) this.protectedRevisions.set(row.draftId, row.revision);
      restore(catalog.records);
      this.state = { ...this.state, ready: true }; this.publish(); return catalog.records;
    }).catch(error => { this.fail(error); return []; });
    return this.initializing;
  }
  changed(): void {
    if (this.closed) throw new Error('file_drafts_closed');
    this.sequence++;
    if (!this.state.ready || this.state.error || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, 120);
  }
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (!this.state.ready || this.state.error) throw new Error(this.state.error ?? 'file_drafts_not_ready');
    const target = this.sequence;
    while (this.savedSequence < target) {
      if (this.saving) { await this.saving; continue; }
      let records: FileDraftRecord[];
      try { records = fileDraftRecordsSchema.parse(structuredClone(this.capture())); }
      catch (error) { this.fail(error); throw error; }
      const capturedSequence = this.sequence;
      this.state = { ...this.state, saving: true }; this.publish();
      this.saving = (async () => {
        const result = fileDraftCatalogSchema.parse(await this.api.replace({ expectedRevision: this.storageRevision, records }));
        if (result.revision !== this.storageRevision + 1 || JSON.stringify(result.records) !== JSON.stringify(records)) throw new Error('file_draft_ack_identity_invalid');
        this.storageRevision = result.revision; this.savedSequence = capturedSequence;
        this.protectedRevisions.clear(); for (const row of result.records) this.protectedRevisions.set(row.draftId, row.revision);
        this.state = { ...this.state, protectedAt: new Date().toISOString() };
      })().catch(error => { this.fail(error); throw error; }).finally(() => {
        this.saving = null; this.state = { ...this.state, saving: false }; this.publish();
      });
      await this.saving;
    }
  }
  async flushAndClose(): Promise<void> {
    this.closed = true;
    // An unreadable optional store does not block quitting an untouched file
    // editor. Its original disk file is preserved; no empty replace is sent.
    if ((!this.state.ready || this.state.error) && this.capture().length === 0) return;
    try { await this.flush(); } catch (error) { this.closed = false; throw error; }
  }
  resumeAfterCancelledQuit(): void { this.closed = false; this.publish(); }
  dispose(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; void this.flush().catch(() => undefined); }
  private fail(error: unknown): void {
    this.state = { ...this.state, error: fileDraftProtectionMessage(error) }; this.publish();
  }
}
