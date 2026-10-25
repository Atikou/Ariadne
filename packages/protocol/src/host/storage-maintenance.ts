import { z } from 'zod';
import { RUNTIME_DATABASE_PATHS } from './runtime-persistence-layout.js';
import { isCanonicalAbsoluteDataRoot } from './runtime-data-root.js';
import { agentPersistenceKeyRingSchema } from './agent-persistence-key-ring.js';

const roots = z.string().min(1).max(32_768).refine(isCanonicalAbsoluteDataRoot);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const file = z.object({
  path: z.string().max(256).refine(value => Object.values(RUNTIME_DATABASE_PATHS).some(path => path === value)
    || /^data\/conversation\/attachments\/v1\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})$/u.test(value)),
  bytes: z.number().int().nonnegative().max(128 * 1024 * 1024 * 1024), sha256: digest,
  sqlite: z.object({ userVersion: z.number().int().nonnegative(), schemaDigest: digest }).strict().nullable()
}).strict().superRefine((entry, context) => {
  const database = Object.values(RUNTIME_DATABASE_PATHS).some(path => path === entry.path);
  const attachment = /^data\/conversation\/attachments\/v1\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})$/u.exec(entry.path);
  if (database !== (entry.sqlite !== null) || (!database && (!attachment
    || attachment[1] !== attachment[2]!.slice(0, 2) || attachment[2] !== entry.sha256 || entry.bytes > 1536 * 1024)))
    context.addIssue({ code: 'custom', message: 'Storage snapshot metadata identity mismatch.' });
});
const snapshot = z.object({ files: z.array(file).min(7).max(20_000),
  unpublishedAttachmentFilesExcluded: z.number().int().nonnegative().max(20_000) }).strict().superRefine((result, context) => {
  const identities = new Set(result.files.map(entry => entry.path));
  if (identities.size !== result.files.length || Object.values(RUNTIME_DATABASE_PATHS).some(path => !identities.has(path)))
    context.addIssue({ code: 'custom', message: 'Current owner snapshot inventory is incomplete or duplicated.' });
});
/** Private child-process contract. Main owns the roots; Renderer cannot invoke it. */
const requestFields = { protocol: z.literal('ariadne_storage_maintenance.v1'), requestId: z.uuid(), dataRoot: roots };
export const attachmentCleanupCategorySchema = z.enum(['orphan-attachment', 'unpublished-attachment']);
const selectedCleanupCategories = z.array(attachmentCleanupCategorySchema).min(1).max(2).refine(values => new Set(values).size === values.length);
const recoveryFields = { ...requestFields, keyRing: agentPersistenceKeyRingSchema };
const bindRecoveryKeys = (request: { requestId: string; keyRing: { runtimeInstanceId: string } }, context: z.RefinementCtx): void => {
  if (request.keyRing.runtimeInstanceId !== request.requestId) context.addIssue({ code: 'custom', message: 'Recovery keys must belong to this private operation.' });
};
export const storageMaintenanceRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...requestFields, operation: z.literal('snapshot'), snapshotRoot: roots }).strict(),
  z.object({ ...requestFields, operation: z.literal('validate-layout') }).strict(),
  z.object({ ...recoveryFields, operation: z.literal('validate-recovery') }).strict().superRefine(bindRecoveryKeys),
  z.object({ ...recoveryFields, operation: z.literal('inspect-attachment-cleanup') }).strict().superRefine(bindRecoveryKeys),
  z.object({ ...recoveryFields, operation: z.literal('execute-attachment-cleanup'), expectedVersion: digest,
    selected: selectedCleanupCategories }).strict().superRefine(bindRecoveryKeys)
]);
const validation = z.object({ validation: z.literal('current-layout'), storageSchemas: z.object({
  agentControl: z.number().int().positive(), conversation: z.number().int().positive(), publicProjection: z.number().int().positive(),
  runtimeCommand: z.number().int().positive(), productivity: z.number().int().positive(), modelCapability: z.number().int().positive(), longMemory: z.number().int().positive()
}).strict() }).strict();
const recovery = validation.extend({ validation: z.literal('current-recovery'), protectedArtifacts: z.number().int().nonnegative().safe(),
  referencedAttachments: z.number().int().nonnegative().safe() });
const cleanupCount = z.number().int().nonnegative().max(20_000), cleanupBytes = z.number().int().nonnegative().max(20_000 * 1536 * 1024);
export const attachmentCleanupPreviewSchema = z.object({ maintenance: z.literal('attachment-cleanup-preview'), version: digest,
  referencedObjects: cleanupCount, orphanObjects: cleanupCount, orphanBytes: cleanupBytes,
  unpublishedObjects: cleanupCount, unpublishedBytes: cleanupBytes }).strict().superRefine((value, context) => {
  if (value.referencedObjects + value.orphanObjects + value.unpublishedObjects > 20_000
    || value.orphanBytes > value.orphanObjects * 1536 * 1024 || value.unpublishedBytes > value.unpublishedObjects * 1536 * 1024)
    context.addIssue({ code: 'custom', message: 'Attachment cleanup inventory counts are inconsistent.' });
});
export const attachmentCleanupResultSchema = z.object({ maintenance: z.literal('attachment-cleanup-result'), operationId: z.uuid(),
  status: z.enum(['completed', 'interrupted']), filesDeleted: cleanupCount, bytesDeleted: cleanupBytes,
  filesRetained: cleanupCount, auditRecorded: z.literal(true) }).strict().superRefine((value, context) => {
  if (value.filesDeleted + value.filesRetained > 20_000 || value.bytesDeleted > value.filesDeleted * 1536 * 1024
    || (value.status === 'completed' && value.filesRetained !== 0))
    context.addIssue({ code: 'custom', message: 'Attachment cleanup settlement counts are inconsistent.' });
});
export const storageMaintenanceResponseSchema = z.object({
  protocol: z.literal('ariadne_storage_maintenance.v1'), requestId: z.uuid(),
  outcome: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), result: z.union([snapshot, validation, recovery, attachmentCleanupPreviewSchema, attachmentCleanupResultSchema]) }).strict(),
    z.object({ ok: z.literal(false), code: z.enum(['offline_snapshot_failed', 'offline_validation_failed', 'offline_cleanup_failed',
      'attachment_cleanup_preview_changed', 'attachment_cleanup_selection_empty']),
      validationPhase: z.enum(['layout', 'key-anchor', 'agent-payloads', 'conversation']).optional() }).strict()
  ])
}).strict();
export type StorageMaintenanceRequest = z.infer<typeof storageMaintenanceRequestSchema>;
export type StorageMaintenanceResponse = z.infer<typeof storageMaintenanceResponseSchema>;
