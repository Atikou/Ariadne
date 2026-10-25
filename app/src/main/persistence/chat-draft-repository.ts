import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { encodedImageAttachmentSchema, imageAttachmentMediaTypeSchema } from '@ariadne/protocol/public';
import { chatDraftAttachmentReadSchema, chatDraftMoveSchema, chatDraftOwnerKey, chatDraftRecordSchema, chatDraftWriteSchema,
  type ChatDraftRecord, type ChatDraftOwner, type ChatDraftWrite, type ChatDraftMove } from '@shared/chat-drafts';
import type { SecretCipher } from './secret-cipher';
import { writeAtomicPrivateFile } from './atomic-private-file';
import { unrestrictedMainWrites, type MainWriteAdmission } from '../data-management/main-maintenance-gate';

const MAX_FILE_BYTES = 64 * 1024 * 1024, MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024, MAX_TEXT_BYTES = 4 * 1024 * 1024;
const sealed = z.string().min(1).max(8 * 1024 * 1024);
const attachmentStorageSchema = z.object({ ownerKey: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.number().int().positive().max(2 * 1024 * 1024),
  mediaType: imageAttachmentMediaTypeSchema, ciphertext: sealed }).strict();
const fileSchema = z.object({ format: z.literal('ariadne-chat-drafts.v1'),
  owners: z.record(z.string().regex(/^[a-f0-9]{64}$/u), sealed).refine(rows => Object.keys(rows).length <= 64),
  attachments: z.record(z.string().uuid(), attachmentStorageSchema).refine(rows => Object.keys(rows).length <= 256) }).strict();
type DraftFile = z.infer<typeof fileSchema>;

/** Main owns private draft metadata and separately sealed attachment bodies.
 * One atomic file commits both ownership maps; no draft dispatches a command. */
export class ChatDraftRepository {
  private file: DraftFile = { format: 'ariadne-chat-drafts.v1', owners: {}, attachments: {} };
  private ready = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string, private readonly cipher: SecretCipher,
    private readonly writes: MainWriteAdmission = unrestrictedMainWrites) {}
  async initialize(): Promise<void> {
    this.ready = false;
    try {
      if ((await stat(this.filePath)).size > MAX_FILE_BYTES) throw new Error('draft_file_too_large');
      const file = fileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
      this.validate(file); this.file = file; this.ready = true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') this.ready = true;
      else console.warn('Chat draft storage is unavailable; original files are retained and draft writes are disabled.');
    }
  }
  list(): ChatDraftRecord[] { this.assertReady(); return this.readRecords(this.file); }
  async write(input: ChatDraftWrite): Promise<ChatDraftRecord> {
    const request = chatDraftWriteSchema.parse(input);
    return this.mutate(file => {
      const key = storageKey(request.owner), previous = this.readOwner(file, request.owner);
      if ((previous?.storageRevision ?? null) !== request.expectedStorageRevision) throw new Error('chat_draft_revision_conflict');
      const record = chatDraftRecordSchema.parse({ owner: request.owner, storageRevision: (previous?.storageRevision ?? 0) + 1,
        editing: request.editing, submissions: request.submissions });
      if (previous && (record.editing.revision < previous.editing.revision
        || (record.editing.revision === previous.editing.revision && JSON.stringify(record.editing) !== JSON.stringify(previous.editing))))
        throw new Error('chat_draft_editing_revision_conflict');
      for (const submission of record.submissions) {
        const old = previous?.submissions.find(row => row.submissionId === submission.submissionId);
        if (old && (JSON.stringify({ ...old, status: undefined, commandIds: undefined })
          !== JSON.stringify({ ...submission, status: undefined, commandIds: undefined })
          || old.commandIds.some((id, index) => submission.commandIds[index] !== id))) throw new Error('chat_draft_submission_identity_conflict');
      }
      const references = referencedAttachments(record), attachments = { ...file.attachments };
      for (const upload of request.uploads) {
        const reference = references.find(row => row.attachmentId === upload.attachmentId);
        const attachment = encodedImageAttachmentSchema.parse(upload.attachment), bytes = Buffer.from(attachment.data, 'base64').length;
        if (!reference || reference.bytes !== bytes || reference.mediaType !== attachment.mediaType) throw new Error('chat_draft_attachment_reference_mismatch');
        const existing = attachments[upload.attachmentId];
        if (existing && (existing.ownerKey !== key || this.cipher.decrypt(existing.ciphertext) !== JSON.stringify(attachment)))
          throw new Error('chat_draft_attachment_identity_conflict');
        attachments[upload.attachmentId] = existing ?? { ownerKey: key, bytes, mediaType: attachment.mediaType,
          ciphertext: this.cipher.encrypt(JSON.stringify(attachment)) };
      }
      for (const reference of references) {
        const attachment = attachments[reference.attachmentId];
        if (!attachment || attachment.ownerKey !== key || attachment.bytes !== reference.bytes || attachment.mediaType !== reference.mediaType)
          throw new Error('chat_draft_attachment_not_owned');
      }
      // Removed/sent attachments are deleted only from this exact draft owner,
      // after all editing and recovery snapshots stop referencing them.
      const retained = new Set(references.map(row => row.attachmentId));
      for (const [id, attachment] of Object.entries(attachments)) if (attachment.ownerKey === key && !retained.has(id)) delete attachments[id];
      return { file: { ...file, owners: { ...file.owners, [key]: this.cipher.encrypt(JSON.stringify(record)) }, attachments }, record };
    });
  }
  async move(input: ChatDraftMove): Promise<ChatDraftRecord> {
    const request = chatDraftMoveSchema.parse(input);
    return this.mutate(file => {
      const from = storageKey(request.from), to = storageKey(request.to);
      if (from === to || request.from.workspaceId !== request.to.workspaceId || request.from.target.kind !== 'new' || request.to.target.kind !== 'session')
        throw new Error('chat_draft_move_invalid');
      const source = this.readOwner(file, request.from), target = this.readOwner(file, request.to);
      if (!source || source.storageRevision !== request.expectedFromRevision || (target?.storageRevision ?? null) !== request.expectedToRevision)
        throw new Error('chat_draft_revision_conflict');
      if (target && (target.editing.text || target.editing.attachments.length || target.submissions.length)) throw new Error('chat_draft_target_not_empty');
      const record = chatDraftRecordSchema.parse({ ...source, owner: request.to, storageRevision: (target?.storageRevision ?? 0) + 1 });
      const owners = { ...file.owners, [to]: this.cipher.encrypt(JSON.stringify(record)) }; delete owners[from];
      const attachments = Object.fromEntries(Object.entries(file.attachments).map(([id, attachment]) => [id,
        attachment.ownerKey === from ? { ...attachment, ownerKey: to } : attachment]));
      return { file: { ...file, owners, attachments }, record };
    });
  }
  readAttachment(input: z.infer<typeof chatDraftAttachmentReadSchema>): z.infer<typeof encodedImageAttachmentSchema> {
    this.assertReady(); const request = chatDraftAttachmentReadSchema.parse(input), owner = this.readOwner(this.file, request.owner);
    const reference = owner && referencedAttachments(owner).find(row => row.attachmentId === request.attachmentId);
    const stored = this.file.attachments[request.attachmentId];
    if (!reference || !stored || stored.ownerKey !== storageKey(request.owner)) throw new Error('chat_draft_attachment_not_owned');
    const attachment = encodedImageAttachmentSchema.parse(JSON.parse(this.cipher.decrypt(stored.ciphertext)));
    if (Buffer.from(attachment.data, 'base64').length !== reference.bytes || attachment.mediaType !== reference.mediaType)
      throw new Error('chat_draft_attachment_reference_mismatch');
    return attachment;
  }
  flush(): Promise<void> { return this.queue; }
  validateBackup(raw: string): void {
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error('draft_file_too_large');
    this.validate(fileSchema.parse(JSON.parse(raw)));
  }
  private async mutate(operation: (file: DraftFile) => { file: DraftFile; record: ChatDraftRecord }): Promise<ChatDraftRecord> {
    return this.writes.write(async () => {
    this.assertReady();
    const task = this.queue.catch(() => undefined).then(async () => {
      this.assertReady(); const next = operation(this.file); this.validate(next.file);
      const raw = JSON.stringify(fileSchema.parse(next.file)) + '\n';
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error('chat_draft_capacity_exceeded');
      try {
        await writeAtomicPrivateFile(this.filePath, raw);
      } catch {
        // An unknown disk outcome cannot authorize another overwrite from the
        // previous in-memory revision. Preserve the source until reopened.
        this.ready = false; throw new Error('chat_draft_storage_unavailable');
      }
      this.file = next.file; return structuredClone(next.record);
    });
    this.queue = task.then(() => undefined, () => undefined); return task;
    });
  }
  private validate(file: DraftFile): void {
    const rows = this.readRecords(file);
    const textBytes = rows.reduce((total, row) => total + Buffer.byteLength(row.editing.text)
      + row.submissions.reduce((sum, submission) => sum + Buffer.byteLength(submission.text), 0), 0);
    if (textBytes > MAX_TEXT_BYTES || Object.values(file.attachments).reduce((sum, attachment) => sum + attachment.bytes, 0) > MAX_ATTACHMENT_BYTES)
      throw new Error('chat_draft_capacity_exceeded');
    const known = new Set<string>();
    for (const row of rows) for (const reference of referencedAttachments(row)) {
      const stored = file.attachments[reference.attachmentId];
      if (!stored || stored.ownerKey !== storageKey(row.owner) || stored.bytes !== reference.bytes || stored.mediaType !== reference.mediaType)
        throw new Error('chat_draft_attachment_not_owned');
      known.add(reference.attachmentId);
    }
    if (Object.keys(file.attachments).some(id => !known.has(id))) throw new Error('chat_draft_unowned_attachment');
  }
  private readRecords(file: DraftFile): ChatDraftRecord[] {
    return Object.entries(file.owners).map(([key, ciphertext]) => {
      const record = chatDraftRecordSchema.parse(JSON.parse(this.cipher.decrypt(ciphertext)));
      if (storageKey(record.owner) !== key) throw new Error('chat_draft_owner_mismatch'); return record;
    });
  }
  private readOwner(file: DraftFile, owner: ChatDraftOwner): ChatDraftRecord | null {
    const ciphertext = file.owners[storageKey(owner)];
    if (!ciphertext) return null;
    const record = chatDraftRecordSchema.parse(JSON.parse(this.cipher.decrypt(ciphertext)));
    if (chatDraftOwnerKey(record.owner) !== chatDraftOwnerKey(owner)) throw new Error('chat_draft_owner_mismatch'); return record;
  }
  private assertReady(): void { if (!this.ready) throw new Error('chat_draft_storage_unavailable'); }
}
function storageKey(owner: ChatDraftOwner): string { return createHash('sha256').update(chatDraftOwnerKey(owner)).digest('hex'); }
function referencedAttachments(row: ChatDraftRecord) { return [row.editing, ...row.submissions].flatMap(item => item.attachments); }
