import { z } from 'zod';
import { canonicalPublicProjectionJson, publicMessageProjectionSchema, publicProjectionCanonicalIdSchema,
  publicProjectionCanonicalTimestampSchema, publicProjectionDigestSchema } from './projection.js';
import { catalogSha256, publicProjectionCatalogResetSchema } from './projection-catalog.js';
import { comparePublicProjectionMessages, publicProjectionMessageWindowSchema } from './projection-views.js';
import { publicRunDocumentHeaderSchema, publicRunDocumentItemMetadataSchema, verifyRunDocumentHeader,
  verifyRunDocumentItemMetadata } from './projection-run-document.js';
import { assertRunDocumentQueryResult, publicRunDocumentRootRequestSchema, publicRunDocumentReferenceSchema,
  publicRunDocumentMetadataProofSchema } from './projection-run-document-query.js';

export const MESSAGE_METADATA_QUERY_VERSION = '1.0' as const;
const manifest = publicRunDocumentRootRequestSchema.shape.manifest;
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const publicMessageMetadataSchema = publicRunDocumentItemMetadataSchema.options[2].shape.value;
export type PublicMessageMetadata = z.infer<typeof publicMessageMetadataSchema>;
export const publicMessageBodyReferenceSchema = z.object({ messageId: publicProjectionCanonicalIdSchema,
  messageVersion: positive, versionCommitCursor: positive, projectedAt: publicProjectionCanonicalTimestampSchema,
  payloadDigest: publicProjectionDigestSchema, metadataDigest: publicProjectionDigestSchema,
  bodyCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_.-]+$/u) }).strict();
export type PublicMessageBodyReference = z.infer<typeof publicMessageBodyReferenceSchema>;
export const publicMessageMetadataRowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), metadata: publicMessageMetadataSchema, body: publicMessageBodyReferenceSchema }).strict()
    .refine(v => v.metadata.messageId === v.body.messageId && v.metadata.version === v.body.messageVersion, 'Message identity mismatch.'),
  z.object({ kind: z.literal('run_document'), header: publicRunDocumentHeaderSchema, document: publicRunDocumentReferenceSchema,
    proof: publicRunDocumentMetadataProofSchema }).strict().superRefine((v, c) => {
    if (v.proof.metadata.collection !== 'interactionMessages' || v.proof.descriptor.collection !== 'interactionMessages'
      || v.proof.descriptor.chunkOrdinal !== 0 || v.proof.metadata.value.runId !== v.header.summary.runId
      || v.header.summary.runId !== v.document.runId || v.header.summary.version !== v.document.runVersion
      || v.header.documentDigest !== v.document.documentDigest) c.addIssue({ code: 'custom', message: 'Document message binding mismatch.' });
  })
]);
export type PublicMessageMetadataRow = z.infer<typeof publicMessageMetadataRowSchema>;
export function messageMetadataOf(row: PublicMessageMetadataRow): PublicMessageMetadata {
  if (row.kind === 'message') return row.metadata;
  if (row.proof.metadata.collection !== 'interactionMessages') throw new Error('message_metadata_collection_invalid');
  return row.proof.metadata.value;
}
export function messageMetadataDigestData(metadata: PublicMessageMetadata): string {
  return `ariadne.message-metadata.v1\0${canonicalPublicProjectionJson(metadata)}`;
}
const request = { queryContractVersion: z.string().min(1).max(32), manifest };
export const publicMessageMetadataWindowRequestSchema = z.object({ ...request, window: publicProjectionMessageWindowSchema }).strict();
export type PublicMessageMetadataWindowRequest = z.infer<typeof publicMessageMetadataWindowRequestSchema>;
export const publicMessageMetadataWindowResultSchema = z.union([
  z.object({ status: z.literal('ok'), queryContractVersion: z.literal(MESSAGE_METADATA_QUERY_VERSION), manifest,
    window: publicProjectionMessageWindowSchema, anchor: publicMessageMetadataRowSchema.nullable(),
    rows: z.array(publicMessageMetadataRowSchema).max(128), hasEarlier: z.boolean(), hasLater: z.boolean(),
    windowDigest: publicProjectionDigestSchema }).strict().superRefine((v, c) => {
    const seen = new Set<string>(); let previous: PublicMessageMetadata | undefined;
    for (const row of [...v.rows, ...(v.anchor === null ? [] : [v.anchor])]) {
      const metadata = messageMetadataOf(row);
      const cursor = row.kind === 'message' ? row.body.versionCommitCursor : row.document.versionCommitCursor;
      if (v.manifest.scope.kind !== 'session' || metadata.sessionId !== v.manifest.scope.sessionId || cursor > v.manifest.boundaryCursor
        || (row.kind === 'run_document' && row.header.summary.sessionId !== metadata.sessionId)) {
        c.addIssue({ code: 'custom', message: 'Message escaped its owner or C.' });
      }
    }
    for (const row of v.rows) {
      const metadata = messageMetadataOf(row);
      if (seen.has(metadata.messageId) || (previous !== undefined && comparePublicProjectionMessages(previous, metadata) >= 0)) {
        c.addIssue({ code: 'custom', message: 'Message metadata order or identity mismatch.' });
      }
      seen.add(metadata.messageId); previous = metadata;
    }
    if (v.rows.length > v.window.limit || (v.window.kind === 'latest' && (v.anchor !== null || v.hasLater))
      || (v.window.kind !== 'latest' && (v.anchor === null || messageMetadataOf(v.anchor).messageId !== v.window.anchorMessageId))
      || (v.window.kind === 'around' && (v.anchor === null || !v.rows.some(row => canonicalPublicProjectionJson(row) === canonicalPublicProjectionJson(v.anchor))))
      || (v.window.kind === 'before' && v.anchor !== null && (!v.hasLater || v.rows.some(row => comparePublicProjectionMessages(messageMetadataOf(row), messageMetadataOf(v.anchor!)) >= 0)))) {
      c.addIssue({ code: 'custom', message: 'Message window range contradicts its anchor.' });
    }
  }),
  z.object({ status: z.literal('anchor_unavailable'), queryContractVersion: z.literal(MESSAGE_METADATA_QUERY_VERSION), manifest,
    window: publicProjectionMessageWindowSchema }).strict().refine(v => v.window.kind !== 'latest', 'Latest has no anchor.'),
  publicProjectionCatalogResetSchema
]);
export type PublicMessageMetadataWindowResult = z.infer<typeof publicMessageMetadataWindowResultSchema>;
export const publicMessageBodyRequestSchema = z.object({ ...request, body: publicMessageBodyReferenceSchema }).strict();
export type PublicMessageBodyRequest = z.infer<typeof publicMessageBodyRequestSchema>;
export const publicMessageBodyResultSchema = z.union([
  z.object({ status: z.literal('ok'), queryContractVersion: z.literal(MESSAGE_METADATA_QUERY_VERSION), manifest,
    body: publicMessageBodyReferenceSchema, message: publicMessageProjectionSchema, bodyDigest: publicProjectionDigestSchema }).strict()
    .refine(v => v.manifest.scope.kind === 'session' && v.message.sessionId === v.manifest.scope.sessionId
      && v.message.messageId === v.body.messageId && v.message.version === v.body.messageVersion
      && v.body.versionCommitCursor <= v.manifest.boundaryCursor, 'Message body binding mismatch.'),
  z.object({ status: z.literal('message_unavailable'), queryContractVersion: z.literal(MESSAGE_METADATA_QUERY_VERSION), manifest,
    body: publicMessageBodyReferenceSchema }).strict(), publicProjectionCatalogResetSchema
]);
export type PublicMessageBodyResult = z.infer<typeof publicMessageBodyResultSchema>;
export async function verifyMessageMetadataRow(row: PublicMessageMetadataRow) {
  if (row.kind === 'message') {
    if (row.body.metadataDigest !== await catalogSha256(messageMetadataDigestData(row.metadata))) throw new Error('message_metadata_digest_mismatch');
  } else {
    await verifyRunDocumentHeader(row.header);
    await verifyRunDocumentItemMetadata(row.header, row.proof.descriptor, row.proof.siblings, row.proof.metadata);
  }
}
function checkManifest(request: { manifest: z.infer<typeof manifest> }, result: { manifest?: z.infer<typeof manifest>; streamId?: string; reason?: string }) {
  if ((result.manifest !== undefined && canonicalPublicProjectionJson(request.manifest) !== canonicalPublicProjectionJson(result.manifest))
    || (result.streamId !== undefined && result.reason !== 'stream_mismatch' && result.streamId !== request.manifest.streamId)) throw new Error('message_metadata_request_mismatch');
}
export async function verifyMessageMetadataWindow(request: PublicMessageMetadataWindowRequest, value: unknown) {
  request = publicMessageMetadataWindowRequestSchema.parse(request);
  const result = assertRunDocumentQueryResult(publicMessageMetadataWindowResultSchema, value); checkManifest(request, result);
  if (result.status === 'reset_required') return result;
  if (request.queryContractVersion !== MESSAGE_METADATA_QUERY_VERSION || canonicalPublicProjectionJson(result.window) !== canonicalPublicProjectionJson(request.window)) throw new Error('message_metadata_request_mismatch');
  if (result.status !== 'ok') return result;
  for (const row of result.rows) await verifyMessageMetadataRow(row);
  if (result.anchor !== null) await verifyMessageMetadataRow(result.anchor);
  const { windowDigest, ...payload } = result;
  if (windowDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('message_metadata_window_digest_mismatch'); return result;
}
export async function verifyMessageBody(request: PublicMessageBodyRequest, value: unknown) {
  request = publicMessageBodyRequestSchema.parse(request);
  const result = assertRunDocumentQueryResult(publicMessageBodyResultSchema, value); checkManifest(request, result);
  if (result.status === 'reset_required') return result;
  if (request.queryContractVersion !== MESSAGE_METADATA_QUERY_VERSION || canonicalPublicProjectionJson(request.body) !== canonicalPublicProjectionJson(result.body)) throw new Error('message_body_request_mismatch');
  if (result.status !== 'ok') return result;
  const { content: _content, ...metadata } = result.message;
  if (result.body.metadataDigest !== await catalogSha256(messageMetadataDigestData(metadata))) throw new Error('message_metadata_digest_mismatch');
  const change = { feature: 'messages', operation: 'upsert', aggregateId: result.message.messageId, aggregateVersion: result.message.version,
    projectedAt: result.body.projectedAt, dto: result.message };
  if (result.body.payloadDigest !== await catalogSha256(canonicalPublicProjectionJson(change))) throw new Error('message_body_payload_digest_mismatch');
  const { bodyDigest, ...payload } = result;
  if (bodyDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('message_body_digest_mismatch'); return result;
}
