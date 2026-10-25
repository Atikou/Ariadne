import { z } from 'zod';
import { canonicalPublicProjectionJson, PUBLIC_PROJECTION_GENESIS_DIGEST, PUBLIC_PROJECTION_HISTORY_DOMAIN,
  publicProjectionCanonicalIdSchema, publicProjectionCanonicalTimestampSchema, publicProjectionDigestSchema } from './projection.js';
import { publicProjectionViewManifestSchema } from './projection-views.js';
import { assertProjectionCatalogResult, catalogSha256 } from './projection-catalog.js';

/** Invalidation receipts for bounded feature windows, never complete entity DTOs. */
export const publicProjectionFeatureReceiptManifestSchema = publicProjectionViewManifestSchema.superRefine((value, context) => {
  const allowed = value.scope.kind === 'directory' ? ['models', 'diagnostics'] : value.scope.kind === 'session' ? ['inference_streams'] : [];
  if (value.selectedFeatures.some(feature => !allowed.includes(feature))) context.addIssue({ code: 'custom', message: 'Receipt selection requires bounded feature windows.' });
});
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const publicProjectionFeatureReceiptRequestSchema = z.object({ queryVersion: z.literal('1.0'),
  manifest: publicProjectionFeatureReceiptManifestSchema, afterCursor: cursor, afterDigest: publicProjectionDigestSchema,
  limit: z.number().int().min(1).max(256) }).strict();
export type PublicProjectionFeatureReceiptRequest = z.infer<typeof publicProjectionFeatureReceiptRequestSchema>;
const receipt = z.object({ feature: z.enum(['models', 'diagnostics', 'inference_streams']),
  aggregateId: publicProjectionCanonicalIdSchema, aggregateVersion: cursor.refine(value => value > 0),
  projectedAt: publicProjectionCanonicalTimestampSchema, operation: z.enum(['upsert', 'remove']) }).strict();
const entry = z.object({ cursor: cursor.refine(value => value > 0), cursorDigest: publicProjectionDigestSchema,
  payloadDigest: publicProjectionDigestSchema, eventId: publicProjectionCanonicalIdSchema, sourceId: publicProjectionCanonicalIdSchema,
  sourceCursor: cursor.refine(value => value > 0), occurredAt: publicProjectionCanonicalTimestampSchema,
  receipts: z.array(receipt).max(256) }).strict();
const envelope = { queryVersion: z.literal('1.0'), manifest: publicProjectionFeatureReceiptManifestSchema,
  afterCursor: cursor, afterDigest: publicProjectionDigestSchema };
export const publicProjectionFeatureReceiptResultSchema = z.discriminatedUnion('status', [
  z.object({ ...envelope, status: z.literal('ok'), nextCursor: cursor, nextDigest: publicProjectionDigestSchema,
    hasMore: z.boolean(), entries: z.array(entry).max(256), batchDigest: publicProjectionDigestSchema }).strict(),
  z.object({ ...envelope, status: z.literal('reset_required'), reason: z.enum(['stream_mismatch', 'snapshot_expired',
    'contract_mismatch', 'scope_mismatch', 'history_unavailable', 'boundary_mismatch', 'cursor_gap', 'history_mismatch']) }).strict()
]).superRefine((value, context) => {
  if (value.status !== 'ok') return;
  const last = value.entries.at(-1);
  if (value.afterCursor < value.manifest.boundaryCursor || value.nextCursor !== (last?.cursor ?? value.afterCursor)
    || value.nextDigest !== (last?.cursorDigest ?? value.afterDigest) || (value.hasMore && value.entries.length === 0)
    || ((value.afterCursor === 0) !== (value.afterDigest === PUBLIC_PROJECTION_GENESIS_DIGEST))) context.addIssue({ code: 'custom', message: 'Receipt scan boundary is invalid.' });
  for (const [index, item] of value.entries.entries()) {
    if (item.cursor !== value.afterCursor + index + 1 || item.receipts.some(row => !value.manifest.selectedFeatures.includes(row.feature))
      || new Set(item.receipts.map(row => `${row.feature}\0${row.aggregateId}`)).size !== item.receipts.length) {
      context.addIssue({ code: 'custom', message: 'Receipt scan escaped its selection or continuity.' });
    }
  }
});
export type PublicProjectionFeatureReceiptResult = z.infer<typeof publicProjectionFeatureReceiptResultSchema>;
export async function verifyPublicProjectionFeatureReceipts(request: PublicProjectionFeatureReceiptRequest, value: unknown): Promise<PublicProjectionFeatureReceiptResult> {
  publicProjectionFeatureReceiptRequestSchema.parse(request);
  const result = assertProjectionCatalogResult(publicProjectionFeatureReceiptResultSchema, value);
  if (result.afterCursor !== request.afterCursor || result.afterDigest !== request.afterDigest
    || canonicalPublicProjectionJson(result.manifest) !== canonicalPublicProjectionJson(request.manifest)) throw new Error('projection_feature_receipt_request_mismatch');
  if (result.status !== 'ok') return result;
  if (result.entries.length > request.limit) throw new Error('projection_feature_receipt_request_limit');
  let previous = request.afterDigest;
  for (const item of result.entries) {
    if (item.cursorDigest !== await catalogSha256(`${PUBLIC_PROJECTION_HISTORY_DOMAIN}\0${previous}\0${item.cursor}\0${item.payloadDigest}`)) throw new Error('projection_feature_receipt_history_mismatch');
    previous = item.cursorDigest;
  }
  const { batchDigest, ...payload } = result;
  if (batchDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('projection_feature_receipt_digest_mismatch');
  return result;
}
