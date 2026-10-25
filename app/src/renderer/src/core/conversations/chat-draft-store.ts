import { chatDraftEditingSchema, chatDraftOwnerKey, type ChatDraftApi, type ChatDraftAttachment,
  type ChatDraftEditing, type ChatDraftOwner, type ChatDraftRecord, type ChatDraftSubmission } from '@shared/chat-drafts';
import { encodedImageAttachmentSchema, type EncodedImageAttachment } from '@ariadne/protocol/public';

export interface LocalChatDraft {
  /** Window-private editing element identity, stable through owner migration. */
  readonly editorId: string;
  readonly owner: ChatDraftOwner;
  readonly editing: ChatDraftEditing;
  readonly submissions: readonly ChatDraftSubmission[];
  readonly storageRevision: number | null;
  readonly dirty: boolean;
}
export interface ChatDraftSnapshot { readonly ready: boolean; readonly error: string | null; readonly drafts: readonly LocalChatDraft[] }
export interface DraftImageReadToken { readonly owner: ChatDraftOwner; readonly generation: string; readonly imageEpoch: number }
export interface DraftSubmissionToken { readonly owner: ChatDraftOwner; readonly submissionId: string; readonly editingRevision: number;
  readonly text: string; readonly attachments: readonly ChatDraftAttachment[] }
interface Entry { editorId: string; owner: ChatDraftOwner; editing: ChatDraftEditing; submissions: ChatDraftSubmission[]; storageRevision: number | null;
  sequence: number; savedSequence: number; saving: Promise<void> | null; moving: Promise<void> | null }

/** Window-owned editing/recovery snapshots. Command dispatch and outcome
 * reconciliation belong to the existing delivery owner, never this store. */
export class ChatDraftStore {
  private readonly entries = new Map<string, Entry>();
  private readonly newOwners = new Map<string, ChatDraftOwner>();
  private readonly movedOwners = new Map<string, ChatDraftOwner>();
  private readonly bodies = new Map<string, EncodedImageAttachment>();
  private readonly uploaded = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private error: string | null = null;
  private selected: ChatDraftOwner | null = null;
  private snapshot: ChatDraftSnapshot = { ready: false, error: null, drafts: [] };
  constructor(private readonly api: ChatDraftApi, private readonly now: () => string = () => new Date().toISOString()) {}
  getSnapshot = (): ChatDraftSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;
    this.initializing = this.loadPersisted().finally(() => { this.initializing = null; });
    return this.initializing;
  }
  private async loadPersisted(): Promise<void> {
    try {
      const records = await this.api.list();
      for (const row of records) {
        const key = chatDraftOwnerKey(row.owner), local = this.entries.get(key);
        if (local && local.sequence > 0) throw new Error('chat_draft_restore_conflict');
        this.entries.set(key, this.entryOf(row));
        for (const reference of [...row.editing.attachments, ...row.submissions.flatMap(item => item.attachments)]) this.uploaded.add(reference.attachmentId);
        if (row.owner.target.kind === 'new') {
          const current = this.newOwners.get(row.owner.workspaceId), existing = current && this.entries.get(chatDraftOwnerKey(current));
          if (!existing || (existing.sequence === 0 && !existing.editing.text && !existing.editing.attachments.length)
            || (existing.storageRevision !== null && existing.editing.updatedAt < row.editing.updatedAt)) {
            this.newOwners.set(row.owner.workspaceId, row.owner);
          }
        }
      }
      this.initialized = true; this.error = null; this.publish(); this.schedule();
    } catch { this.error = '草稿安全存储不可用，内容已保留在当前窗口；暂不能发送。'; this.publish(); }
  }
  ownerFor(workspaceId: string, sessionId: string | null): ChatDraftOwner {
    if (sessionId) return { workspaceId, target: { kind: 'session', sessionId } };
    let owner = this.newOwners.get(workspaceId);
    if (!owner) { owner = { workspaceId, target: { kind: 'new', draftId: crypto.randomUUID() } }; this.newOwners.set(workspaceId, owner); }
    return owner;
  }
  newDraft(workspaceId: string): ChatDraftOwner {
    const owner: ChatDraftOwner = { workspaceId, target: { kind: 'new', draftId: crypto.randomUUID() } };
    this.newOwners.set(workspaceId, owner); this.select(owner); return owner;
  }
  select(owner: ChatDraftOwner): void {
    const next = this.resolve(owner), changed = !this.selected || chatDraftOwnerKey(this.selected) !== chatDraftOwnerKey(next);
    this.selected = next; this.ensure(owner); if (changed) this.publish();
  }
  isSelected(owner: ChatDraftOwner): boolean { return this.selected !== null && chatDraftOwnerKey(this.selected) === chatDraftOwnerKey(this.resolve(owner)); }
  draft(owner: ChatDraftOwner): LocalChatDraft { const entry = this.ensure(owner);
    return { editorId: entry.editorId, owner: entry.owner, editing: entry.editing, submissions: entry.submissions, storageRevision: entry.storageRevision, dirty: entry.sequence !== entry.savedSequence }; }
  edit(owner: ChatDraftOwner, text: string): void {
    const entry = this.ensure(owner); this.replaceEditing(entry, { ...entry.editing, text });
  }
  captureImageRead(owner: ChatDraftOwner): DraftImageReadToken {
    const entry = this.ensure(owner); return { owner: entry.owner, generation: entry.editing.generation, imageEpoch: entry.editing.imageEpoch };
  }
  appendImages(token: DraftImageReadToken, images: readonly { clientId: string; bytes: number; mediaType: EncodedImageAttachment['mediaType']; data: string; name?: string | undefined }[]): boolean {
    const entry = this.ensure(token.owner);
    if (entry.editing.generation !== token.generation || entry.editing.imageEpoch !== token.imageEpoch || this.closed) return false;
    const references = images.map(image => ({ attachmentId: image.clientId, bytes: image.bytes, mediaType: image.mediaType,
      ...(image.name ? { name: image.name } : {}) }));
    const editing = chatDraftEditingSchema.parse({ ...entry.editing, attachments: [...entry.editing.attachments, ...references] });
    const bodies = images.map(image => ({ id: image.clientId, body: encodedImageAttachmentSchema.parse({ mediaType: image.mediaType,
      data: image.data, ...(image.name ? { name: image.name } : {}) }) }));
    if (bodies.some(row => this.uploaded.has(row.id) || this.bodies.has(row.id))) throw new Error('chat_draft_attachment_identity_conflict');
    this.cacheBodies(bodies);
    this.replaceEditing(entry, editing); return true;
  }
  removeImage(owner: ChatDraftOwner, attachmentId: string): void {
    const entry = this.ensure(owner); this.replaceEditing(entry, { ...entry.editing, imageEpoch: entry.editing.imageEpoch + 1,
      attachments: entry.editing.attachments.filter(row => row.attachmentId !== attachmentId) });
  }
  async attachment(owner: ChatDraftOwner, reference: ChatDraftAttachment): Promise<EncodedImageAttachment> {
    const entry = this.ensure(owner), owns = () => [...entry.editing.attachments, ...entry.submissions.flatMap(row => row.attachments)]
      .some(row => row.attachmentId === reference.attachmentId);
    if (!owns()) throw new Error('chat_draft_attachment_not_owned');
    const cached = this.bodies.get(reference.attachmentId); if (cached) return cached;
    const body = await this.api.readAttachment({ owner: entry.owner, attachmentId: reference.attachmentId });
    if (!owns()) throw new Error('chat_draft_attachment_no_longer_owned');
    this.cacheBodies([{ id: reference.attachmentId, body }]); return body;
  }
  async beginSubmission(owner: ChatDraftOwner): Promise<DraftSubmissionToken> {
    if (!this.initialized || this.error || this.closed) throw new Error('chat_draft_storage_unavailable');
    const entry = this.ensure(owner), captured = entry.editing;
    if ((!captured.text.trim() && !captured.attachments.length) || entry.submissions.some(row => row.status !== 'recoverable'))
      throw new Error('chat_draft_submission_unavailable');
    const submission: ChatDraftSubmission = { submissionId: crypto.randomUUID(), submittedRevision: captured.revision,
      nextEditingRevision: captured.revision + 1, text: captured.text, attachments: captured.attachments.map(row => ({ ...row })),
      status: 'submitted', commandIds: [] };
    if (entry.submissions.length >= 16) throw new Error('chat_draft_recovery_capacity_exceeded');
    entry.submissions = [...entry.submissions, submission];
    this.replaceEditing(entry, { ...captured, text: '', attachments: [], generation: crypto.randomUUID(), imageEpoch: 0 });
    const token: DraftSubmissionToken = { owner: entry.owner, submissionId: submission.submissionId,
      editingRevision: submission.nextEditingRevision, text: submission.text, attachments: submission.attachments };
    try { await this.flushThrough(entry, entry.sequence); return token; }
    catch (error) { this.fail(token); throw error; }
  }
  async attachCommand(token: DraftSubmissionToken, commandId: string): Promise<void> {
    const entry = this.ensure(token.owner), submission = entry.submissions.find(row => row.submissionId === token.submissionId);
    if (!submission) throw new Error('chat_draft_submission_missing');
    if (!submission.commandIds.includes(commandId)) submission.commandIds = [...submission.commandIds, commandId];
    this.changed(entry); await this.flushThrough(entry, entry.sequence);
  }
  complete(token: DraftSubmissionToken): void {
    const entry = this.ensure(token.owner); entry.submissions = entry.submissions.filter(row => row.submissionId !== token.submissionId); this.changed(entry);
  }
  fail(token: DraftSubmissionToken, uncertain = false): void {
    const entry = this.ensure(token.owner), submission = entry.submissions.find(row => row.submissionId === token.submissionId); if (!submission) return;
    if (uncertain) { submission.status = 'reconcile'; this.changed(entry); return; }
    if (entry.editing.revision === token.editingRevision && !entry.editing.text && !entry.editing.attachments.length) {
      entry.submissions = entry.submissions.filter(row => row.submissionId !== token.submissionId);
      this.replaceEditing(entry, { ...entry.editing, text: submission.text, attachments: submission.attachments,
        generation: crypto.randomUUID(), imageEpoch: 0 });
    } else { submission.status = 'recoverable'; this.changed(entry); }
  }
  restore(owner: ChatDraftOwner, submissionId: string): void {
    const entry = this.ensure(owner), submission = entry.submissions.find(row => row.submissionId === submissionId && row.status === 'recoverable');
    if (!submission) throw new Error('chat_draft_recovery_not_available');
    const text = entry.editing.text ? `${entry.editing.text}\n${submission.text}` : submission.text;
    const attachments = [...entry.editing.attachments, ...submission.attachments.filter(row => !entry.editing.attachments.some(existing => existing.attachmentId === row.attachmentId))];
    const editing = chatDraftEditingSchema.parse({ ...entry.editing, text, attachments, generation: crypto.randomUUID(), imageEpoch: 0 });
    entry.submissions = entry.submissions.filter(row => row.submissionId !== submissionId); this.replaceEditing(entry, editing);
  }
  async moveToSession(owner: ChatDraftOwner, sessionId: string, afterMove?: () => void): Promise<void> {
    const entry = this.ensure(owner); if (entry.moving) { await entry.moving; afterMove?.(); return; } if (entry.owner.target.kind !== 'new') { afterMove?.(); return; }
    await this.flushThrough(entry, entry.sequence);
    const sourceOwner = entry.owner, sourceKey = chatDraftOwnerKey(sourceOwner), target: ChatDraftOwner = { workspaceId: sourceOwner.workspaceId, target: { kind: 'session', sessionId } };
    const targetKey = chatDraftOwnerKey(target), existing = this.entries.get(targetKey);
    if (existing && (existing.editing.text || existing.editing.attachments.length || existing.submissions.length)) throw new Error('chat_draft_target_not_empty');
    const move = (async () => {
    const migrated = await this.api.move({ from: sourceOwner, to: target, expectedFromRevision: entry.storageRevision!, expectedToRevision: existing?.storageRevision ?? null });
    // Keep edits entered while migration was in flight. The new storage key is
    // published atomically; all later callbacks resolve their captured owner.
    this.entries.delete(sourceKey); entry.owner = target; entry.storageRevision = migrated.storageRevision; this.entries.set(targetKey, entry);
    this.movedOwners.set(sourceKey, target); if (this.selected && chatDraftOwnerKey(this.selected) === sourceKey) this.selected = target;
    if (this.newOwners.get(sourceOwner.workspaceId) && chatDraftOwnerKey(this.newOwners.get(sourceOwner.workspaceId)!) === sourceKey) this.newOwners.delete(sourceOwner.workspaceId);
    // Let the delivery owner update session selection while the captured
    // editing selection is still authoritative. Publishing first would make
    // React materialize the next empty new draft and falsely count as a switch.
    try { afterMove?.(); } finally { this.publish(); this.schedule(); }
    })();
    entry.moving = move;
    try { await move; } finally { entry.moving = null; }
  }
  async flush(): Promise<void> { if (this.timer) clearTimeout(this.timer); this.timer = null;
    await Promise.all([...this.entries.values()].map(entry => this.flushThrough(entry, entry.sequence))); }
  async flushAndClose(): Promise<void> { this.closed = true; try { await this.flush(); } catch (error) { this.closed = false; throw error; } }
  resumeAfterCancelledQuit(): void { this.closed = false; this.publish(); this.schedule(); }
  dispose(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; void this.flush().catch(() => undefined); this.listeners.clear(); }
  private resolve(owner: ChatDraftOwner): ChatDraftOwner { return this.movedOwners.get(chatDraftOwnerKey(owner)) ?? owner; }
  private ensure(owner: ChatDraftOwner): Entry {
    owner = this.resolve(owner); const key = chatDraftOwnerKey(owner); let entry = this.entries.get(key);
    if (!entry) { entry = { editorId: crypto.randomUUID(), owner, editing: { revision: 1, generation: crypto.randomUUID(), imageEpoch: 0, updatedAt: this.now(), text: '', attachments: [] },
      submissions: [], storageRevision: null, sequence: 0, savedSequence: 0, saving: null, moving: null }; this.entries.set(key, entry); }
    return entry;
  }
  private entryOf(row: ChatDraftRecord): Entry { return { ...structuredClone(row), editorId: crypto.randomUUID(), sequence: 0, savedSequence: 0, saving: null, moving: null }; }
  private replaceEditing(entry: Entry, editing: ChatDraftEditing): void {
    if (this.closed) throw new Error('chat_draft_store_closing');
    entry.editing = chatDraftEditingSchema.parse({ ...editing, revision: entry.editing.revision + 1, updatedAt: this.now() }); this.changed(entry);
  }
  private changed(entry: Entry): void { entry.sequence++; this.publish(); this.schedule(); }
  private schedule(): void {
    if (!this.initialized || this.error || this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, 120);
  }
  private async flushThrough(entry: Entry, sequence: number): Promise<void> {
    if (entry.savedSequence >= sequence) return;
    if (!this.initialized || this.error) throw new Error('chat_draft_storage_unavailable');
    while (entry.savedSequence < sequence) {
      if (!entry.saving) entry.saving = this.save(entry).finally(() => { entry.saving = null; });
      await entry.saving;
    }
  }
  private async save(entry: Entry): Promise<void> {
    if (entry.moving) await entry.moving;
    const sequence = entry.sequence, editing = structuredClone(entry.editing), submissions = structuredClone(entry.submissions);
    try {
      const references = [...editing.attachments, ...submissions.flatMap(row => row.attachments)];
      const uploads = [...new Set(references.map(row => row.attachmentId))].filter(id => !this.uploaded.has(id))
        .map(attachmentId => { const attachment = this.bodies.get(attachmentId); if (!attachment) throw new Error('chat_draft_attachment_body_missing'); return { attachmentId, attachment }; });
      const saved = await this.api.write({ owner: entry.owner, expectedStorageRevision: entry.storageRevision, editing, submissions, uploads });
      entry.storageRevision = saved.storageRevision; entry.savedSequence = sequence;
      for (const upload of uploads) this.uploaded.add(upload.attachmentId); this.publish();
      const retained = new Set([...this.entries.values()].flatMap(row => [...row.editing.attachments, ...row.submissions.flatMap(item => item.attachments)])
        .map(row => row.attachmentId));
      for (const id of this.uploaded) if (!retained.has(id)) { this.uploaded.delete(id); this.bodies.delete(id); }
      if (entry.sequence > sequence) this.schedule();
    } catch { this.error = '草稿未能安全保存，当前窗口内容保留；请先处理存储错误再发送。'; this.publish(); throw new Error('chat_draft_persistence_failed'); }
  }
  private cacheBodies(bodies: readonly { id: string; body: EncodedImageAttachment }[]): void {
    const retained = new Map(this.bodies); for (const row of bodies) retained.set(row.id, row.body);
    const size = () => [...retained.values()].reduce((total, body) => total + body.data.length / 4 * 3, 0);
    const incoming = new Set(bodies.map(row => row.id));
    for (const id of retained.keys()) if (size() > 16 * 1024 * 1024 && this.uploaded.has(id) && !incoming.has(id)) retained.delete(id);
    if (size() > 16 * 1024 * 1024) throw new Error('chat_draft_attachment_cache_capacity_exceeded');
    this.bodies.clear(); for (const [id, body] of retained) this.bodies.set(id, body);
  }
  private publish(): void {
    this.snapshot = { ready: this.initialized, error: this.error, drafts: [...this.entries.values()].map(entry => ({ editorId: entry.editorId, owner: entry.owner,
      editing: entry.editing, submissions: entry.submissions.map(row => ({ ...row })), storageRevision: entry.storageRevision, dirty: entry.sequence !== entry.savedSequence })) };
    for (const listener of this.listeners) listener();
  }
}
