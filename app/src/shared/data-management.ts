import { z } from 'zod';
import { publicProjectionCanonicalIdSchema } from '@ariadne/protocol/public';
export const backupCreatedViewSchema = z.object({ backupId: z.uuid(), files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict();
export type BackupCreatedView = z.infer<typeof backupCreatedViewSchema>;
export const dataRestorePreviewSchema = z.object({ ticket: z.uuid(), backupId: z.uuid(), version: z.literal(1),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
  protectedArtifacts: z.number().int().nonnegative(), referencedAttachments: z.number().int().nonnegative(),
  recoveryScope: z.literal('same-machine-current-user') }).strict();
export type DataRestorePreview = z.infer<typeof dataRestorePreviewSchema>;
export const dataRestoreTicketSchema = z.object({ ticket: z.uuid() }).strict();
const usageCategory = z.object({ files: z.number().int().nonnegative().safe(), bytes: z.number().int().nonnegative().safe() }).strict();
export const dataUsageViewSchema = z.object({ measuredAt: z.iso.datetime(), measurement: z.literal('owned-file-logical-bytes'),
  databases: usageCategory, attachments: usageCategory, privateFiles: usageCategory,
  derivedCaches: usageCategory,
  unpublishedAttachments: usageCategory, totalBytes: z.number().int().nonnegative().safe() }).strict()
  .refine(value => value.totalBytes === value.databases.bytes + value.attachments.bytes + value.privateFiles.bytes
    + value.unpublishedAttachments.bytes + value.derivedCaches.bytes, 'Storage categories must sum to the measured total.');
export type DataUsageView = z.infer<typeof dataUsageViewSchema>;
export const sessionTextExportRequestSchema = z.object({ workspaceId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema, scope: z.literal('public-message-text'), format: z.literal('jsonl') }).strict();
export type SessionTextExportRequest = z.infer<typeof sessionTextExportRequestSchema>;
export const sessionTextExportResultSchema = z.object({ messages: z.number().int().nonnegative().max(100_000),
  bytes: z.number().int().nonnegative().safe(), attachmentReferences: z.number().int().nonnegative().safe() }).strict();
export type SessionTextExportResult = z.infer<typeof sessionTextExportResultSchema>;
export const dataCleanupCategorySchema = z.enum(['orphan-attachment', 'unpublished-attachment']);
export type DataCleanupCategory = z.infer<typeof dataCleanupCategorySchema>;
const cleanupCount = z.number().int().nonnegative().max(20_000), cleanupBytes = z.number().int().nonnegative().max(20_000 * 1536 * 1024);
export const dataCleanupPreviewSchema = z.object({ ticket: z.uuid(), version: z.string().regex(/^[a-f0-9]{64}$/u), expiresAt: z.iso.datetime(),
  referencedObjects: cleanupCount, orphanObjects: cleanupCount, orphanBytes: cleanupBytes,
  unpublishedObjects: cleanupCount, unpublishedBytes: cleanupBytes }).strict().refine(value =>
  value.referencedObjects + value.orphanObjects + value.unpublishedObjects <= 20_000
  && value.orphanBytes <= value.orphanObjects * 1536 * 1024 && value.unpublishedBytes <= value.unpublishedObjects * 1536 * 1024);
export type DataCleanupPreview = z.infer<typeof dataCleanupPreviewSchema>;
export const dataCleanupCommitSchema = z.object({ ticket: z.uuid(), version: z.string().regex(/^[a-f0-9]{64}$/u),
  selected: z.array(dataCleanupCategorySchema).min(1).max(2).refine(values => new Set(values).size === values.length) }).strict();
export type DataCleanupCommit = z.infer<typeof dataCleanupCommitSchema>;
export const dataCleanupResultSchema = z.object({ operationId: z.uuid(), status: z.enum(['completed', 'interrupted']),
  filesDeleted: cleanupCount, bytesDeleted: cleanupBytes, filesRetained: cleanupCount, auditRecorded: z.literal(true) }).strict()
  .refine(value => value.filesDeleted + value.filesRetained <= 20_000 && value.bytesDeleted <= value.filesDeleted * 1536 * 1024
    && (value.status !== 'completed' || value.filesRetained === 0));
export type DataCleanupResult = z.infer<typeof dataCleanupResultSchema>;
