import { z } from 'zod';
import { encodedImageAttachmentSchema, imageAttachmentMediaTypeSchema, publicProjectionCanonicalIdSchema,
  MAX_IMAGE_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES } from '@ariadne/protocol/public';

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const chatDraftOwnerSchema = z.object({ workspaceId: publicProjectionCanonicalIdSchema,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('session'), sessionId: publicProjectionCanonicalIdSchema }).strict(),
    z.object({ kind: z.literal('new'), draftId: z.string().uuid() }).strict()
  ]) }).strict();
export const chatDraftAttachmentSchema = z.object({ attachmentId: z.string().uuid(), mediaType: imageAttachmentMediaTypeSchema,
  bytes: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES), name: z.string().min(1).max(256).optional() }).strict();
const attachments = z.array(chatDraftAttachmentSchema).max(MAX_IMAGE_ATTACHMENTS_PER_MESSAGE)
  .refine(rows => new Set(rows.map(row => row.attachmentId)).size === rows.length)
  .refine(rows => rows.reduce((total, row) => total + row.bytes, 0) <= MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES);
export const chatDraftEditingSchema = z.object({ revision, generation: z.string().uuid(),
  imageEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), updatedAt: z.string().datetime(), text: z.string().max(256 * 1024), attachments }).strict();
export const chatDraftSubmissionSchema = z.object({ submissionId: z.string().uuid(), submittedRevision: revision,
  nextEditingRevision: revision, text: z.string().max(256 * 1024), attachments,
  status: z.enum(['submitted', 'recoverable', 'reconcile']), commandIds: z.array(publicProjectionCanonicalIdSchema).max(8) }).strict();
export const chatDraftRecordSchema = z.object({ owner: chatDraftOwnerSchema, storageRevision: revision,
  editing: chatDraftEditingSchema, submissions: z.array(chatDraftSubmissionSchema).max(16) }).strict()
  .refine(row => new Set(row.submissions.map(item => item.submissionId)).size === row.submissions.length);
export const chatDraftWriteSchema = z.object({ owner: chatDraftOwnerSchema, expectedStorageRevision: revision.nullable(),
  editing: chatDraftEditingSchema, submissions: z.array(chatDraftSubmissionSchema).max(16),
  // One atomic save can contain current editing and up to sixteen retained
  // submissions; each individual message keeps the Protocol attachment limits.
  uploads: z.array(z.object({ attachmentId: z.string().uuid(), attachment: encodedImageAttachmentSchema }).strict())
    .max(17 * MAX_IMAGE_ATTACHMENTS_PER_MESSAGE)
    .refine(rows => rows.reduce((total, row) => total + row.attachment.data.length, 0) <= Math.ceil(16 * 1024 * 1024 / 3) * 4) }).strict()
  .refine(row => new Set(row.submissions.map(item => item.submissionId)).size === row.submissions.length)
  .refine(row => new Set(row.uploads.map(item => item.attachmentId)).size === row.uploads.length);
export const chatDraftMoveSchema = z.object({ from: chatDraftOwnerSchema, to: chatDraftOwnerSchema,
  expectedFromRevision: revision, expectedToRevision: revision.nullable() }).strict();
export const chatDraftAttachmentReadSchema = z.object({ owner: chatDraftOwnerSchema, attachmentId: z.string().uuid() }).strict();
export type ChatDraftOwner = z.infer<typeof chatDraftOwnerSchema>;
export type ChatDraftAttachment = z.infer<typeof chatDraftAttachmentSchema>;
export type ChatDraftEditing = z.infer<typeof chatDraftEditingSchema>;
export type ChatDraftSubmission = z.infer<typeof chatDraftSubmissionSchema>;
export type ChatDraftRecord = z.infer<typeof chatDraftRecordSchema>;
export const chatDraftCatalogSchema = z.array(chatDraftRecordSchema).max(64);
export type ChatDraftWrite = z.infer<typeof chatDraftWriteSchema>;
export type ChatDraftMove = z.infer<typeof chatDraftMoveSchema>;
export interface ChatDraftApi {
  list(): Promise<ChatDraftRecord[]>;
  write(request: ChatDraftWrite): Promise<ChatDraftRecord>;
  move(request: ChatDraftMove): Promise<ChatDraftRecord>;
  readAttachment(request: z.infer<typeof chatDraftAttachmentReadSchema>): Promise<z.infer<typeof encodedImageAttachmentSchema>>;
}
export function chatDraftOwnerKey(owner: ChatDraftOwner): string { return JSON.stringify(chatDraftOwnerSchema.parse(owner)); }
