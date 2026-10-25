import { z } from 'zod';
import { publicProjectionCanonicalIdSchema, workspaceDocumentCommandSchema, workspaceDocumentPathSchema,
  workspaceDocumentVersionSchema, WORKSPACE_DOCUMENT_MAX_BYTES } from '@ariadne/protocol/public';

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(WORKSPACE_DOCUMENT_MAX_BYTES).refine(value => new TextEncoder().encode(value).byteLength <= WORKSPACE_DOCUMENT_MAX_BYTES);
export const fileDraftMutationSchema = z.object({ commandId: z.string().uuid(), capturedRevision: revision,
  command: workspaceDocumentCommandSchema.refine(command => command.kind !== 'workspace.document.read'),
  state: z.enum(['staged', 'unknown']) }).strict();
export const fileDraftRecordSchema = z.object({ draftId: z.string().uuid(), workspaceId: publicProjectionCanonicalIdSchema,
  path: workspaceDocumentPathSchema, revision, updatedAt: z.string().datetime(),
  content: text, originalContent: text, version: workspaceDocumentVersionSchema.nullable(),
  writable: z.boolean(), exists: z.boolean(), pendingMutation: fileDraftMutationSchema.nullable() }).strict()
  .refine(row => row.exists === (row.version !== null))
  .refine(row => !row.pendingMutation || (row.pendingMutation.command.workspaceId === row.workspaceId && row.pendingMutation.command.path === row.path
    && row.pendingMutation.capturedRevision <= row.revision));
export function fileDraftOwnerKey(workspaceId: string, path: string): string {
  return JSON.stringify([publicProjectionCanonicalIdSchema.parse(workspaceId), workspaceDocumentPathSchema.parse(path)]);
}
export const fileDraftRecordsSchema = z.array(fileDraftRecordSchema).max(32)
  .refine(rows => new Set(rows.map(row => row.draftId)).size === rows.length)
  .refine(rows => new Set(rows.map(row => JSON.stringify([row.workspaceId, row.path]))).size === rows.length);
export const fileDraftPathRequestSchema = z.object({workspaceId:publicProjectionCanonicalIdSchema,path:workspaceDocumentPathSchema}).strict();
export const fileDraftPathResultSchema = fileDraftPathRequestSchema.extend({exists:z.boolean(),comparisonPath:workspaceDocumentPathSchema}).strict();
export const fileDraftCatalogSchema = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), records: fileDraftRecordsSchema }).strict();
export const fileDraftReplaceSchema = z.object({ expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), records: fileDraftRecordsSchema }).strict();
export type FileDraftRecord = z.infer<typeof fileDraftRecordSchema>;
export type FileDraftMutation = z.infer<typeof fileDraftMutationSchema>;
export type FileDraftCatalog = z.infer<typeof fileDraftCatalogSchema>;
export type FileDraftReplace = z.infer<typeof fileDraftReplaceSchema>;
export interface FileDraftApi {
  list(): Promise<FileDraftCatalog>; replace(request: FileDraftReplace): Promise<FileDraftCatalog>;
  resolvePath(request: z.infer<typeof fileDraftPathRequestSchema>): Promise<z.infer<typeof fileDraftPathResultSchema>>;
}
