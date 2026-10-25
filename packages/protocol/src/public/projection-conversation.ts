import { z } from 'zod';
import { canonicalPublicProjectionJson, PUBLIC_PROJECTION_GENESIS_DIGEST, PUBLIC_PROJECTION_HISTORY_DOMAIN,
  publicProjectionCanonicalIdSchema, publicProjectionCanonicalTimestampSchema, publicProjectionDigestSchema,
  publicProjectionChangeSchema } from './projection.js';
import { publicRunDocumentRootRequestSchema } from './projection-run-document-query.js';
import { publicProjectionFeatureWindowSchema, comparePublicProjectionFeatureWindowRows } from './projection-feature-window.js';
import { assertProjectionCatalogResult, catalogSha256 } from './projection-catalog.js';

/** Message metadata, document items and inference prefixes share this exact C.
 * Receipt filtering is performed by the trusted owner, not a membership proof. */
const manifest = publicRunDocumentRootRequestSchema.shape.manifest;
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const query = { queryVersion: z.literal('1.0'), manifest };
const reason = z.enum(['stream_mismatch', 'snapshot_expired', 'contract_mismatch', 'scope_mismatch',
  'history_unavailable', 'boundary_mismatch', 'cursor_gap', 'history_mismatch']);
export const publicConversationReceiptRequestSchema = z.object({ ...query, afterCursor: cursor,
  afterDigest: publicProjectionDigestSchema, limit: z.number().int().min(1).max(256) }).strict();
export type PublicConversationReceiptRequest = z.infer<typeof publicConversationReceiptRequestSchema>;
const receipt = z.object({ feature: z.enum(['messages', 'runs', 'inference_streams']), aggregateId: publicProjectionCanonicalIdSchema,
  aggregateVersion: cursor.refine(value => value > 0), projectedAt: publicProjectionCanonicalTimestampSchema,
  operation: z.enum(['upsert', 'remove']) }).strict();
const entry = z.object({ cursor: cursor.refine(value => value > 0), cursorDigest: publicProjectionDigestSchema,
  payloadDigest: publicProjectionDigestSchema, eventId: publicProjectionCanonicalIdSchema, sourceId: publicProjectionCanonicalIdSchema,
  sourceCursor: cursor.refine(value => value > 0), occurredAt: publicProjectionCanonicalTimestampSchema, receipts: z.array(receipt).max(256) }).strict();
const scan = { ...query, afterCursor: cursor, afterDigest: publicProjectionDigestSchema };
export const publicConversationReceiptResultSchema = z.discriminatedUnion('status', [
  z.object({ ...scan, status: z.literal('ok'), nextCursor: cursor, nextDigest: publicProjectionDigestSchema,
    hasMore: z.boolean(), entries: z.array(entry).max(256), batchDigest: publicProjectionDigestSchema }).strict(),
  z.object({ ...scan, status: z.literal('reset_required'), reason }).strict()
]).superRefine((value, context) => {
  if (value.status !== 'ok') return;
  const last = value.entries.at(-1);
  if (value.afterCursor < value.manifest.boundaryCursor || value.nextCursor !== (last?.cursor ?? value.afterCursor)
    || value.nextDigest !== (last?.cursorDigest ?? value.afterDigest) || (value.hasMore && value.entries.length === 0)
    || ((value.afterCursor === 0) !== (value.afterDigest === PUBLIC_PROJECTION_GENESIS_DIGEST))) context.addIssue({ code: 'custom', message: 'Conversation scan boundary is invalid.' });
  for (const [index, item] of value.entries.entries()) if (item.cursor !== value.afterCursor + index + 1
    || new Set(item.receipts.map(row => `${row.feature}\0${row.aggregateId}`)).size !== item.receipts.length) {
    context.addIssue({ code: 'custom', message: 'Conversation scan continuity or identities are invalid.' });
  }
});
export type PublicConversationReceiptResult = z.infer<typeof publicConversationReceiptResultSchema>;
export async function verifyConversationReceipts(request: PublicConversationReceiptRequest, value: unknown): Promise<PublicConversationReceiptResult> {
  publicConversationReceiptRequestSchema.parse(request);
  const result = assertProjectionCatalogResult(publicConversationReceiptResultSchema, value);
  if (canonicalPublicProjectionJson(result.manifest) !== canonicalPublicProjectionJson(request.manifest)
    || result.afterCursor !== request.afterCursor || result.afterDigest !== request.afterDigest) throw new Error('conversation_receipt_request_mismatch');
  if (result.status !== 'ok') return result;
  if (result.entries.length > request.limit) throw new Error('conversation_receipt_request_limit');
  let previous = request.afterDigest;
  for (const item of result.entries) {
    if (item.cursorDigest !== await catalogSha256(`${PUBLIC_PROJECTION_HISTORY_DOMAIN}\0${previous}\0${item.cursor}\0${item.payloadDigest}`)) throw new Error('conversation_receipt_history_mismatch');
    previous = item.cursorDigest;
  }
  const { batchDigest, ...payload } = result;
  if (batchDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('conversation_receipt_digest_mismatch');
  return result;
}

const window = publicProjectionFeatureWindowSchema.refine(value => value.feature === 'inference_streams', 'Conversation windows contain inference prefixes only.');
export const publicConversationInferenceRequestSchema = z.object({ ...query, window }).strict();
export type PublicConversationInferenceRequest = z.infer<typeof publicConversationInferenceRequestSchema>;
export const publicConversationInferenceResultSchema = z.discriminatedUnion('status', [
  z.object({ ...query, status: z.literal('ok'), window, changes: z.array(publicProjectionChangeSchema).max(128),
    hasEarlier: z.boolean(), windowDigest: publicProjectionDigestSchema }).strict(),
  z.object({ ...query, status: z.literal('anchor_unavailable'), window }).strict(),
  z.object({ ...query, status: z.literal('reset_required'), window, reason }).strict()
]).superRefine((value, context) => {
  if (value.status === 'anchor_unavailable' && value.window.beforeAggregateId === undefined) context.addIssue({ code: 'custom', message: 'Unanchored inference window cannot be unavailable.' });
  if (value.status !== 'ok') return;
  if (value.changes.length > value.window.limit || (value.hasEarlier && value.changes.length === 0)
    || value.changes.some((change, index) => change.feature !== 'inference_streams' || change.dto === null || change.operation !== 'upsert'
      || value.manifest.scope.kind !== 'session' || change.dto.sessionId !== value.manifest.scope.sessionId
      || (value.window.filter === 'streaming' && change.dto.status !== 'streaming')
      || (value.window.runIds !== undefined && !value.window.runIds.includes(change.dto.runId))
      || (index > 0 && comparePublicProjectionFeatureWindowRows(value.changes[index - 1]!, change) >= 0))) {
    context.addIssue({ code: 'custom', message: 'Inference prefix window escaped its owner, filter, order or bound.' });
  }
});
export type PublicConversationInferenceResult = z.infer<typeof publicConversationInferenceResultSchema>;
export async function verifyConversationInferenceWindow(request: PublicConversationInferenceRequest, value: unknown): Promise<PublicConversationInferenceResult> {
  publicConversationInferenceRequestSchema.parse(request);
  const result = assertProjectionCatalogResult(publicConversationInferenceResultSchema, value);
  if (canonicalPublicProjectionJson(result.manifest) !== canonicalPublicProjectionJson(request.manifest)
    || canonicalPublicProjectionJson(result.window) !== canonicalPublicProjectionJson(request.window)) throw new Error('conversation_inference_request_mismatch');
  if (result.status !== 'ok') return result;
  const { windowDigest, ...payload } = result;
  if (windowDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('conversation_inference_digest_mismatch');
  return result;
}
