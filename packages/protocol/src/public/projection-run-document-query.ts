import { z } from 'zod';
import { assertPublicProjectionPayloadSafe, canonicalPublicProjectionJson, PUBLIC_PROJECTION_GENESIS_DIGEST,
  publicProjectionCanonicalIdSchema, publicProjectionDigestSchema } from './projection.js';
import { catalogSha256, publicProjectionCatalogManifestSchema, publicProjectionCatalogResetSchema } from './projection-catalog.js';
import { publicRunDocumentHeaderSchema, publicRunDocumentItemMetadataSchema, publicRunDocumentLeafDescriptorSchema,
  publicRunDocumentLeafSchema, RUN_DOCUMENT_COLLECTIONS, verifyRunDocumentHeader, verifyRunDocumentItemMetadata,
  verifyRunDocumentLeaf } from './projection-run-document.js';

export const RUN_DOCUMENT_QUERY_VERSION = '1.0' as const;
export const MAX_RUN_DOCUMENT_QUERY_BYTES = 2 * 1024 * 1024;
export const MAX_RUN_DOCUMENT_METADATA_ROWS = 128;
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_.-]+$/u);
const manifest = publicProjectionCatalogManifestSchema.refine(m => m.feature === 'runs' && m.filter === 'all' && m.scope.kind === 'session',
  'Run bodies require one exact Session and an unfiltered Run manifest.');
export const publicRunDocumentReferenceSchema = z.object({ runId: publicProjectionCanonicalIdSchema, runVersion: version,
  documentDigest: publicProjectionDigestSchema, versionCommitCursor: version, bodyCursor: cursor }).strict();
export type PublicRunDocumentReference = z.infer<typeof publicRunDocumentReferenceSchema>;
const request = { queryContractVersion: z.string().min(1).max(32), manifest };
const scopedRequest = { ...request, document: publicRunDocumentReferenceSchema };
export const publicRunDocumentRootRequestSchema = z.object({ ...request, runId: publicProjectionCanonicalIdSchema,
  expectedRunVersion: version.optional() }).strict();
export type PublicRunDocumentRootRequest = z.infer<typeof publicRunDocumentRootRequestSchema>;
export const publicRunDocumentMetadataRequestSchema = z.object({ ...scopedRequest, collection: z.enum(RUN_DOCUMENT_COLLECTIONS),
  limit: z.number().int().min(1).max(MAX_RUN_DOCUMENT_METADATA_ROWS), pageCursor: cursor.optional() }).strict();
export type PublicRunDocumentMetadataRequest = z.infer<typeof publicRunDocumentMetadataRequestSchema>;
export const publicRunDocumentInboxRequestSchema = z.object({ ...scopedRequest, inputId: publicProjectionCanonicalIdSchema }).strict();
export type PublicRunDocumentInboxRequest = z.infer<typeof publicRunDocumentInboxRequestSchema>;
export const publicRunDocumentChunkRequestSchema = z.object({ ...scopedRequest, collection: z.enum(RUN_DOCUMENT_COLLECTIONS),
  itemOrdinal: ordinal, chunkOrdinal: z.number().int().min(0).max(31) }).strict();
export type PublicRunDocumentChunkRequest = z.infer<typeof publicRunDocumentChunkRequestSchema>;
export const publicRunDocumentMetadataProofSchema = z.object({ descriptor: publicRunDocumentLeafDescriptorSchema,
  siblings: z.array(publicProjectionDigestSchema).max(53), metadata: publicRunDocumentItemMetadataSchema }).strict();
export type PublicRunDocumentMetadataProof = z.infer<typeof publicRunDocumentMetadataProofSchema>;
const response = { status: z.literal('ok'), queryContractVersion: z.literal(RUN_DOCUMENT_QUERY_VERSION), manifest,
  header: publicRunDocumentHeaderSchema, document: publicRunDocumentReferenceSchema };
function checkBinding(value: { manifest: z.infer<typeof manifest>; header: z.infer<typeof publicRunDocumentHeaderSchema>;
  document: PublicRunDocumentReference }, context: z.RefinementCtx) {
  if (value.manifest.scope.kind !== 'session' || value.header.summary.sessionId !== value.manifest.scope.sessionId
    || value.header.summary.runId !== value.document.runId || value.header.summary.version !== value.document.runVersion
    || value.header.documentDigest !== value.document.documentDigest || value.document.versionCommitCursor > value.manifest.boundaryCursor) {
    context.addIssue({ code: 'custom', message: 'Document escaped its immutable owner or boundary.' });
  }
}
export const publicRunDocumentRootResultSchema = z.union([
  z.object({ ...response, rootDigest: publicProjectionDigestSchema }).strict().superRefine(checkBinding),
  z.object({ status: z.literal('unavailable'), queryContractVersion: z.literal(RUN_DOCUMENT_QUERY_VERSION), manifest,
    runId: publicProjectionCanonicalIdSchema, reason: z.enum(['not_found', 'deleted', 'version_mismatch']) }).strict(),
  publicProjectionCatalogResetSchema
]);
export type PublicRunDocumentRootResult = z.infer<typeof publicRunDocumentRootResultSchema>;
export const publicRunDocumentMetadataResultSchema = z.union([
  z.object({ ...response, collection: z.enum(RUN_DOCUMENT_COLLECTIONS), startOrdinal: ordinal, pageIndex: ordinal,
    previousPageDigest: publicProjectionDigestSchema, pageDigest: publicProjectionDigestSchema,
    rows: z.array(publicRunDocumentMetadataProofSchema).max(MAX_RUN_DOCUMENT_METADATA_ROWS),
    hasMore: z.boolean(), nextPageCursor: cursor.optional() }).strict().superRefine((v, c) => {
    checkBinding(v, c); const end = v.startOrdinal + v.rows.length, count = v.header.collections[v.collection].itemCount;
    if (end > count || v.hasMore !== (end < count) || v.hasMore !== (v.nextPageCursor !== undefined)
      || (v.hasMore && v.rows.length === 0) || (v.pageIndex === 0) !== (v.previousPageDigest === PUBLIC_PROJECTION_GENESIS_DIGEST)
      || (v.pageIndex === 0 && v.startOrdinal !== 0)
      || v.rows.some((row, index) => row.descriptor.collection !== v.collection || row.metadata.collection !== v.collection
        || row.descriptor.itemOrdinal !== v.startOrdinal + index || row.descriptor.chunkOrdinal !== 0)) {
      c.addIssue({ code: 'custom', message: 'Metadata page contradicts its coverage.' });
    }
  }), publicProjectionCatalogResetSchema
]);
export type PublicRunDocumentMetadataResult = z.infer<typeof publicRunDocumentMetadataResultSchema>;
export const publicRunDocumentInboxResultSchema = z.union([
  z.object({ ...response, inputId: publicProjectionCanonicalIdSchema, proof: publicRunDocumentMetadataProofSchema.nullable(),
    resultDigest: publicProjectionDigestSchema }).strict().superRefine((v, c) => {
    checkBinding(v, c);
    if (v.proof !== null && (v.proof.metadata.collection !== 'inbox' || v.proof.descriptor.collection !== 'inbox'
      || v.proof.descriptor.chunkOrdinal !== 0 || v.proof.descriptor.itemId !== v.inputId)) c.addIssue({ code: 'custom', message: 'Inbox lookup identity mismatch.' });
  }), publicProjectionCatalogResetSchema
]);
export type PublicRunDocumentInboxResult = z.infer<typeof publicRunDocumentInboxResultSchema>;
export const publicRunDocumentChunkResultSchema = z.union([
  z.object({ ...response, collection: z.enum(RUN_DOCUMENT_COLLECTIONS), itemOrdinal: ordinal,
    chunkOrdinal: z.number().int().min(0).max(31), leaf: publicRunDocumentLeafSchema,
    resultDigest: publicProjectionDigestSchema }).strict().superRefine((v, c) => {
    checkBinding(v, c);
    if (v.leaf.descriptor.collection !== v.collection || v.leaf.descriptor.itemOrdinal !== v.itemOrdinal
      || v.leaf.descriptor.chunkOrdinal !== v.chunkOrdinal) c.addIssue({ code: 'custom', message: 'Chunk lookup identity mismatch.' });
  }),
  z.object({ status: z.literal('item_unavailable'), queryContractVersion: z.literal(RUN_DOCUMENT_QUERY_VERSION), manifest,
    document: publicRunDocumentReferenceSchema, collection: z.enum(RUN_DOCUMENT_COLLECTIONS), itemOrdinal: ordinal,
    chunkOrdinal: z.number().int().min(0).max(31) }).strict(), publicProjectionCatalogResetSchema
]);
export type PublicRunDocumentChunkResult = z.infer<typeof publicRunDocumentChunkResultSchema>;
export function assertRunDocumentQueryResult<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.parse(value); assertPublicProjectionPayloadSafe(result);
  if (new TextEncoder().encode(canonicalPublicProjectionJson(result)).length > MAX_RUN_DOCUMENT_QUERY_BYTES) throw new Error('run_document_query_byte_limit_exceeded');
  return result;
}
export function runDocumentMetadataPageDigestPayload(page: Extract<PublicRunDocumentMetadataResult, { status: 'ok' }>): string {
  const { pageDigest: _digest, nextPageCursor: _cursor, ...payload } = page; return canonicalPublicProjectionJson(payload);
}
async function checkResponseBinding(request: { manifest: z.infer<typeof manifest>; document?: PublicRunDocumentReference },
  response: { manifest: z.infer<typeof manifest>; document: PublicRunDocumentReference; header: z.infer<typeof publicRunDocumentHeaderSchema> }) {
  if (canonicalPublicProjectionJson(request.manifest) !== canonicalPublicProjectionJson(response.manifest)
    || (request.document !== undefined && canonicalPublicProjectionJson(request.document) !== canonicalPublicProjectionJson(response.document))) {
    throw new Error('run_document_query_request_mismatch');
  }
  await verifyRunDocumentHeader(response.header);
}
function checkNonBodyBinding(request: { manifest: z.infer<typeof manifest>; document?: PublicRunDocumentReference },
  result: { status: string; manifest?: z.infer<typeof manifest>; document?: PublicRunDocumentReference; streamId?: string; reason?: string }) {
  if ((result.manifest !== undefined && canonicalPublicProjectionJson(request.manifest) !== canonicalPublicProjectionJson(result.manifest))
    || (request.document !== undefined && result.document !== undefined && canonicalPublicProjectionJson(request.document) !== canonicalPublicProjectionJson(result.document))
    || (result.streamId !== undefined && result.reason !== 'stream_mismatch' && result.streamId !== request.manifest.streamId)) {
    throw new Error('run_document_query_request_mismatch');
  }
}
export async function verifyRunDocumentRootResult(request: PublicRunDocumentRootRequest, value: unknown) {
  const result = assertRunDocumentQueryResult(publicRunDocumentRootResultSchema, value);
  checkNonBodyBinding(request, result);
  if (result.status === 'unavailable' && result.runId !== request.runId) throw new Error('run_document_query_request_mismatch');
  if (result.status !== 'ok') return result;
  await checkResponseBinding(request, result);
  if (request.queryContractVersion !== RUN_DOCUMENT_QUERY_VERSION || result.document.runId !== request.runId
    || (request.expectedRunVersion !== undefined && result.document.runVersion !== request.expectedRunVersion)) throw new Error('run_document_query_request_mismatch');
  const { rootDigest, ...payload } = result;
  if (rootDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('run_document_query_digest_mismatch'); return result;
}
export async function verifyRunDocumentMetadataResult(request: PublicRunDocumentMetadataRequest, value: unknown) {
  const result = assertRunDocumentQueryResult(publicRunDocumentMetadataResultSchema, value); checkNonBodyBinding(request, result); if (result.status !== 'ok') return result;
  await checkResponseBinding(request, result);
  if (request.queryContractVersion !== RUN_DOCUMENT_QUERY_VERSION || result.collection !== request.collection || result.rows.length > request.limit) throw new Error('run_document_query_request_mismatch');
  for (const row of result.rows) await verifyRunDocumentItemMetadata(result.header, row.descriptor, row.siblings, row.metadata);
  if (result.pageDigest !== await catalogSha256(runDocumentMetadataPageDigestPayload(result))) throw new Error('run_document_query_digest_mismatch'); return result;
}
export async function verifyRunDocumentInboxResult(request: PublicRunDocumentInboxRequest, value: unknown) {
  const result = assertRunDocumentQueryResult(publicRunDocumentInboxResultSchema, value); checkNonBodyBinding(request, result); if (result.status !== 'ok') return result;
  await checkResponseBinding(request, result);
  if (request.queryContractVersion !== RUN_DOCUMENT_QUERY_VERSION || request.inputId !== result.inputId) throw new Error('run_document_query_request_mismatch');
  if (result.proof !== null) await verifyRunDocumentItemMetadata(result.header, result.proof.descriptor, result.proof.siblings, result.proof.metadata);
  const { resultDigest, ...payload } = result;
  if (resultDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('run_document_query_digest_mismatch'); return result;
}
export async function verifyRunDocumentChunkResult(request: PublicRunDocumentChunkRequest, value: unknown) {
  const result = assertRunDocumentQueryResult(publicRunDocumentChunkResultSchema, value); checkNonBodyBinding(request, result);
  if (result.status === 'item_unavailable' && (result.collection !== request.collection || result.itemOrdinal !== request.itemOrdinal
    || result.chunkOrdinal !== request.chunkOrdinal)) throw new Error('run_document_query_request_mismatch');
  if (result.status !== 'ok') return result;
  await checkResponseBinding(request, result);
  if (request.queryContractVersion !== RUN_DOCUMENT_QUERY_VERSION || result.collection !== request.collection
    || result.itemOrdinal !== request.itemOrdinal || result.chunkOrdinal !== request.chunkOrdinal) throw new Error('run_document_query_request_mismatch');
  await verifyRunDocumentLeaf(result.header, result.leaf);
  const { resultDigest, ...payload } = result;
  if (resultDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('run_document_query_digest_mismatch'); return result;
}
/** Verifies a complete metadata range without assuming unloaded items absent. */
export class RunDocumentMetadataPageChain {
  private ordinal = 0; private index = 0; private digest: string = PUBLIC_PROJECTION_GENESIS_DIGEST; private completed = false;
  private binding: string | null = null;
  async accept(request: PublicRunDocumentMetadataRequest, value: unknown) {
    if (this.completed) throw new Error('run_document_metadata_already_completed');
    const result = await verifyRunDocumentMetadataResult(request, value); if (result.status !== 'ok') return result;
    const binding = canonicalPublicProjectionJson({ manifest: request.manifest, document: request.document, collection: request.collection });
    if (this.binding !== null && this.binding !== binding) throw new Error('run_document_metadata_owner_mismatch');
    if (result.startOrdinal !== this.ordinal || result.pageIndex !== this.index || result.previousPageDigest !== this.digest) throw new Error('run_document_metadata_page_sequence_mismatch');
    this.binding = binding;
    this.ordinal += result.rows.length; this.index++; this.digest = result.pageDigest; this.completed = !result.hasMore; return result;
  }
}
