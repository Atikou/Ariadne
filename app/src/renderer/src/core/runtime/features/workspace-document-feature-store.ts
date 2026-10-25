import { PUBLIC_PROJECTION_CONTRACT_VERSION, type WorkspaceDocumentCommand, type WorkspaceDocumentResult } from '@ariadne/protocol/public';
import { fileDraftOwnerKey, fileDraftRecordSchema, type FileDraftApi, type FileDraftRecord } from '@shared/file-drafts';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import { FileDraftProtection, type FileDraftProtectionState } from './file-draft-protection';
import { PublicResultError } from '../public-result';
import { shouldReconcileInput } from './input-delivery-outcome';

export interface WorkspaceDocumentDraft {
  readonly content: string; readonly originalContent: string; readonly version: string | null; readonly writable: boolean; readonly exists: boolean;
}
export type FileDraftRecovery = { readonly kind: 'matched' | 'changed'; readonly disk: Extract<WorkspaceDocumentResult,{kind:'workspace.document.read_result'}> }
  | { readonly kind: 'missing' | 'unavailable'; readonly error: string };

/** One editing owner and the existing versioned workspace mutation authority. */
export class WorkspaceDocumentFeatureStore {
  private readonly drafts = new Map<string, FileDraftRecord>();
  private readonly removed = new Set<string>();
  private readonly settling = new Set<string>();
  private readonly moving = new Map<string, FileDraftRecord>();
  private readonly recovered = new Set<string>();
  private readonly recovery = new Map<string, FileDraftRecovery>();
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly mutationEpochs = new Map<string, number>();
  private readonly readers = new Map<string, number>();
  private revision = 0;
  private closing = false;
  private quitGeneration = 0;
  private protection: FileDraftProtection | null = null;
  private privateApi: FileDraftApi | null = null;
  private readonly newPathAliases = new Map<string,string>();
  constructor(private readonly gateway: RuntimeFeatureCommandGateway) {}
  getSnapshot = (): number => this.revision;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(): void { this.revision++; for (const listener of this.listeners) listener(); }
  configureProtection(api: FileDraftApi): void {
    if (this.protection || this.drafts.size) throw new Error('file_draft_protection_already_bound');
    this.privateApi=api;
    this.protection = new FileDraftProtection(api, () => [...this.drafts].filter(([key]) => !this.removed.has(key))
      .map(([key, row]) => this.moving.get(key) ?? (this.settling.has(row.draftId) ? { ...row, pendingMutation: null } : row))
      .filter(row => row.pendingMutation || !row.exists || row.content !== row.originalContent), () => this.publish());
  }
  async initialize(): Promise<void> {
    await this.requireProtection().initialize(rows => {
      for (const row of rows) { this.drafts.set(fileDraftOwnerKey(row.workspaceId, row.path), row); this.recovered.add(row.draftId); }
    });
  }
  async resolvePath(workspaceId:string,path:string):Promise<string> {
    if(!this.privateApi)throw new Error('file_draft_protection_not_bound');
    const result=await this.privateApi.resolvePath({workspaceId,path});
    if(result.workspaceId!==workspaceId)throw new Error('file_draft_path_identity_invalid');
    if(result.exists)return result.path;
    const alias=fileDraftOwnerKey(workspaceId,result.comparisonPath),reserved=this.newPathAliases.get(alias);
    if(reserved&&!this.draft(workspaceId,reserved)?.exists)return reserved;
    this.newPathAliases.set(alias,result.path);return result.path;
  }
  protectionState(): FileDraftProtectionState {
    return this.protection?.getState() ?? { ready: false, error: 'file_draft_protection_not_bound', protectedAt: null, saving: false };
  }
  protectedRevision(draftId: string): number | null { return this.protection?.protectedRevision(draftId) ?? null; }
  recoveryEntries(): readonly FileDraftRecord[] { return [...this.drafts.values()].filter(row => this.recovered.has(row.draftId)); }
  isRecovered(workspaceId:string,path:string):boolean { const row=this.draft(workspaceId,path);return Boolean(row&&this.recovered.has(row.draftId)); }
  recoveryState(workspaceId:string,path:string):FileDraftRecovery|null { const row=this.draft(workspaceId,path);return row?this.recovery.get(row.draftId)??null:null; }
  async inspectRecovery(workspaceId:string,path:string):Promise<void> {
    const row=this.draft(workspaceId,path);if(!row||!this.recovered.has(row.draftId))return;
    let observation:FileDraftRecovery;
    try {const disk=await this.read(workspaceId,row.path);observation={kind:disk.version===row.version?'matched':'changed',disk};}
    catch(error){observation={kind:error instanceof PublicResultError&&error.publicError.code==='workspace_file_not_found'?'missing':'unavailable',error:error instanceof Error?error.message:'无法核对当前磁盘文件。'};}
    const current=this.draft(workspaceId,path);if(!current||current.draftId!==row.draftId||current.version!==row.version)return;
    this.recovery.set(row.draftId,observation);this.publish();
  }
  flush(): Promise<void> { return this.requireProtection().flush(); }
  flushAndClose(): Promise<void> { return this.requireProtection().flushAndClose(); }
  resumeAfterCancelledQuit(): void { this.quitGeneration++; this.closing = false; this.requireProtection().resumeAfterCancelledQuit(); }
  dispose(): void { this.protection?.dispose(); this.listeners.clear(); }
  isPending(workspaceId: string, path: string): boolean { return this.pending.has(fileDraftOwnerKey(workspaceId, path)); }
  draft(workspaceId: string, path: string): FileDraftRecord | undefined { return this.drafts.get(fileDraftOwnerKey(workspaceId, path)); }
  rememberDraft(workspaceId: string, path: string, draft: WorkspaceDocumentDraft, baseline: 'edit' | 'disk' = 'edit'): void {
    if (this.closing) throw new Error('正在处理退出，请先完成或取消退出。');
    const key = fileDraftOwnerKey(workspaceId, path), previous = this.drafts.get(key);
    if (this.pending.has(key) && previous?.pendingMutation?.command.kind !== 'workspace.document.save')
      throw new Error('文件正在移动、删除或丢弃，请等待结果。');
    if (previous?.pendingMutation && (baseline === 'disk' || previous.pendingMutation.command.kind !== 'workspace.document.save'))
      throw new Error('原文件操作尚未核对，不能覆盖基线或编辑移动／删除中的文件。');
    if (this.protection && !this.protection.getState().ready && !this.protection.getState().error) throw new Error('文件草稿尚未恢复，请稍候。');
    if (!previous && this.drafts.size >= 32) {
      const clean = [...this.drafts].find(([candidate, row]) => !this.pending.has(candidate) && !this.readers.has(candidate) && row.exists && row.content === row.originalContent && !row.pendingMutation);
      if (!clean) throw new Error('已有 32 个未保存文件，请先保存或关闭部分文件。');
      this.drafts.delete(clean[0]); this.pruneEpoch(clean[0]);
    }
    const base = previous && baseline === 'edit' ? previous : draft;
    const row = fileDraftRecordSchema.parse({ draftId: previous?.draftId ?? crypto.randomUUID(), workspaceId, path: previous?.path ?? path,
      revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), content: draft.content,
      originalContent: base.originalContent, version: base.version, writable: base.writable, exists: base.exists,
      pendingMutation: previous?.pendingMutation ?? null });
    this.protection?.changed(); this.drafts.set(key, row);
    if (baseline === 'disk') { this.recovered.delete(row.draftId); this.recovery.delete(row.draftId); }
    this.publish();
  }
  async discardDraft(workspaceId: string, path: string): Promise<void> {
    const key = fileDraftOwnerKey(workspaceId, path), row = this.drafts.get(key);
    if (!row) return;
    if (this.pending.has(key) || row.pendingMutation) throw new Error('文件操作尚未核对，不能丢弃原草稿。');
    await this.mutation(workspaceId, [path], () => this.removeProtected(key));
  }
  unsavedDrafts(): readonly FileDraftRecord[] { return [...this.drafts.values()].filter(row => row.pendingMutation || !row.exists || row.content !== row.originalContent); }
  async prepareQuit(choice: 'save' | 'retain' | 'discard', deadline = Date.now() + 30000): Promise<void> {
    const generation = ++this.quitGeneration;
    const current = (): void => { if (this.quitGeneration !== generation || Date.now() >= deadline) throw new Error('文件退出处理已取消；剩余草稿仍已保留。'); };
    this.closing = true;
    try {
      if (choice !== 'retain' && this.pending.size) throw new Error('文件操作仍在进行中，请等待结果。');
      const rows = this.unsavedDrafts();
      if (choice === 'save') for (const row of rows) {
        current();
        if (row.pendingMutation) await this.reconcileMutation(row.workspaceId, row.path);
        current(); const draft = this.draft(row.workspaceId, row.path);
        if (draft && (!draft.exists || draft.content !== draft.originalContent)) await this.save(draft.workspaceId, draft.path, draft.version, draft.content);
      }
      if (choice === 'discard') for (const row of rows) { current(); await this.discardDraft(row.workspaceId, row.path); }
      current();
      if (rows.length) await this.flush();
    } catch (error) { this.resumeAfterCancelledQuit(); throw error; }
  }
  private async removeProtected(key: string): Promise<void> {
    this.removed.add(key);
    try { this.protection?.changed(); if (this.protection) await this.protection.flush(); }
    catch (error) { this.removed.delete(key); throw error; }
    const row = this.drafts.get(key); this.drafts.delete(key); this.removed.delete(key);
    if(row)for(const [alias,path]of this.newPathAliases)if(path===row.path&&JSON.parse(alias)[0]===row.workspaceId)this.newPathAliases.delete(alias);
    if (row) { this.recovered.delete(row.draftId); this.recovery.delete(row.draftId); }
    this.publish();
  }
  private requireProtection(): FileDraftProtection { if (!this.protection) throw new Error('file_draft_protection_not_bound'); return this.protection; }
  private pruneEpoch(key: string): void { if (!this.drafts.has(key) && !this.pending.has(key) && !this.readers.has(key)) this.mutationEpochs.delete(key); }
  private async mutation<T>(workspaceId: string, paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const keys = paths.map(path => fileDraftOwnerKey(workspaceId, path));
    if (keys.some(key => this.pending.has(key))) throw new Error('此文件仍有操作进行中，请等待结果。');
    for (const key of keys) { this.pending.add(key); this.mutationEpochs.set(key, (this.mutationEpochs.get(key) ?? 0) + 1); } this.publish();
    try { return await operation(); } finally { for (const key of keys) { this.pending.delete(key); this.pruneEpoch(key); } this.publish(); }
  }
  private async request<K extends WorkspaceDocumentResult['kind']>(command: WorkspaceDocumentCommand, kind: K, commandId?: string): Promise<Extract<WorkspaceDocumentResult, { kind: K }>> {
    const result = await this.gateway.execute(command, commandId);
    if (result.kind !== kind || !('workspaceId' in result) || result.workspaceId !== command.workspaceId || !('path' in result) || result.path !== command.path)
      throw new Error('workspace_document_result_identity_invalid');
    return result as Extract<WorkspaceDocumentResult, { kind: K }>;
  }
  async read(workspaceId: string, path: string) {
    const key = fileDraftOwnerKey(workspaceId, path); if (this.pending.has(key)) throw new Error('文件操作尚未结束，请稍后重新读取。');
    const epoch = this.mutationEpochs.get(key) ?? 0; this.readers.set(key, (this.readers.get(key) ?? 0) + 1);
    try {
      const result = await this.request({ kind: 'workspace.document.read', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId, path }, 'workspace.document.read_result');
      if ((this.mutationEpochs.get(key) ?? 0) !== epoch) throw new Error('文件操作状态已变化，请重新读取。'); return result;
    } finally { const remaining = this.readers.get(key)! - 1; if (remaining) this.readers.set(key, remaining); else this.readers.delete(key); this.pruneEpoch(key); }
  }
  save(workspaceId: string, path: string, expectedVersion: string | null, content: string) {
    return this.saveVerified(workspaceId, path, expectedVersion, content);
  }
  private async saveVerified(workspaceId: string, path: string, expectedVersion: string | null, content: string) {
    const initial = this.draft(workspaceId, path);
    if (initial && this.recovered.has(initial.draftId) && !initial.pendingMutation) {
      await this.inspectRecovery(workspaceId, path);
      const observation = this.recovery.get(initial.draftId);
      if (!(observation?.kind === 'matched' && observation.disk.writable) && !(observation?.kind === 'missing' && !initial.exists))
        throw new Error('恢复草稿的磁盘基线尚未确认，请比较磁盘内容或保留副本。');
    }
    return this.mutation(workspaceId, [path], async () => {
      const row = this.draft(workspaceId, path); if (!row || row.version !== expectedVersion || row.content !== content) throw new Error('草稿已经更新，请重新确认要保存的内容。');
      const result = await this.performMutation(row, { kind: 'workspace.document.save', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId, path: row.path, expectedVersion, content });
      if (result.kind !== 'workspace.document.saved') throw new Error('workspace_document_result_identity_invalid'); return result;
    });
  }
  async move(workspaceId: string, path: string, expectedVersion: string, destination: string) {
    destination=await this.resolvePath(workspaceId,destination);
    const target = this.draft(workspaceId, destination);
    if (target && (!target.exists || target.content !== target.originalContent || target.pendingMutation)) return Promise.reject(new Error('目标路径还有未保存草稿，请先处理目标草稿。'));
    return this.mutation(workspaceId, [path, destination], async () => {
      const row = this.draft(workspaceId, path); if (!row || row.version !== expectedVersion) throw new Error('文件草稿版本已变化。');
      const result = await this.performMutation(row, { kind: 'workspace.document.move', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId, path: row.path, expectedVersion, destination });
      if (result.kind !== 'workspace.document.moved') throw new Error('workspace_document_result_identity_invalid'); return result;
    });
  }
  delete(workspaceId: string, path: string, expectedVersion: string) {
    return this.mutation(workspaceId, [path], async () => {
      const row = this.draft(workspaceId, path); if (!row || row.version !== expectedVersion) throw new Error('文件草稿版本已变化。');
      const result = await this.performMutation(row, { kind: 'workspace.document.delete', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId, path: row.path, expectedVersion });
      if (result.kind !== 'workspace.document.deleted') throw new Error('workspace_document_result_identity_invalid'); return result;
    });
  }
  reconcileMutation(workspaceId: string, path: string) {
    const row = this.draft(workspaceId, path), original = row?.pendingMutation;
    if (!row || !original) return Promise.reject(new Error('没有需要核对的原文件操作。'));
    const paths = original.command.kind === 'workspace.document.move' ? [path, original.command.destination] : [path];
    return this.mutation(workspaceId, paths, () => this.performMutation(row, original.command, original.commandId));
  }
  private update(row: FileDraftRecord, patch: Partial<FileDraftRecord>): FileDraftRecord {
    const next = fileDraftRecordSchema.parse({ ...row, ...patch, revision: row.revision + 1, updatedAt: new Date().toISOString() });
    this.requireProtection().changed(); this.drafts.set(fileDraftOwnerKey(next.workspaceId, next.path), next); this.publish(); return next;
  }
  private async performMutation(row: FileDraftRecord, command: WorkspaceDocumentCommand, originalId?: string): Promise<WorkspaceDocumentResult> {
    const protection = this.requireProtection(), key = fileDraftOwnerKey(row.workspaceId, row.path);
    if (row.pendingMutation && !originalId) throw new Error('原文件操作结果尚未确认，请先核对。');
    if (command.kind === 'workspace.document.read') throw new Error('file_draft_mutation_read_invalid');
    const commandId = originalId ?? crypto.randomUUID();
    if (!originalId) this.update(row, { pendingMutation: { commandId, capturedRevision: row.revision, command, state: 'staged' } });
    await protection.flush();
    let result: WorkspaceDocumentResult;
    try {
      const kind = command.kind === 'workspace.document.save' ? 'workspace.document.saved' : command.kind === 'workspace.document.move' ? 'workspace.document.moved' : 'workspace.document.deleted';
      result = await this.request(command, kind, commandId);
      if (command.kind === 'workspace.document.move' && (result.kind !== 'workspace.document.moved' || result.destination !== command.destination)) throw new Error('workspace_document_result_identity_invalid');
    } catch (error) {
      const current = this.drafts.get(key)!;
      const known = error instanceof PublicResultError && error.publicError.correlationId === commandId && !shouldReconcileInput(error, commandId, Boolean(originalId));
      this.update(current, { pendingMutation: known ? null : { ...current.pendingMutation!, state: 'unknown' } });
      await protection.flush(); throw error;
    }
    const current = this.drafts.get(key)!;
    if (result.kind === 'workspace.document.saved' && command.kind === 'workspace.document.save') {
      this.update(current, { originalContent: command.content, version: result.version, exists: true });
      this.settling.add(current.draftId);
      try { await protection.flush(); }
      finally { this.settling.delete(current.draftId); }
      // Retain the original envelope in memory until its outcome is durable.
      // Any B typed during the acknowledgement remains its own newer revision.
      this.drafts.set(key, { ...this.drafts.get(key)!, pendingMutation: null });
      this.recovered.delete(current.draftId); this.recovery.delete(current.draftId); this.publish();
    } else if (result.kind === 'workspace.document.moved') {
      const moved = fileDraftRecordSchema.parse({ ...current, path: result.destination, version: result.version, revision: current.revision + 1,
        updatedAt: new Date().toISOString(), pendingMutation: null });
      this.moving.set(key, moved); protection.changed();
      try { await protection.flush(); }
      finally { this.moving.delete(key); }
      this.drafts.delete(key); this.drafts.set(fileDraftOwnerKey(row.workspaceId, result.destination), moved);
      this.recovered.delete(current.draftId); this.recovery.delete(current.draftId); this.publish();
    } else if (result.kind === 'workspace.document.deleted') await this.removeProtected(key);
    else throw new Error('workspace_document_result_identity_invalid');
    return result;
  }
}
