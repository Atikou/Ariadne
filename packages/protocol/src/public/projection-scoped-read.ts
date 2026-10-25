import { z } from 'zod';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION, PUBLIC_PROJECTION_GENESIS_DIGEST,
  PUBLIC_PROJECTION_HISTORY_DOMAIN, assertPublicProjectionPayloadSafe,
  canonicalPublicProjectionJson, publicProjectionCanonicalIdSchema,
  publicProjectionCanonicalTimestampSchema, publicProjectionChangeSchema,
  publicProjectionDigestSchema
} from './projection.js';
import { publicProjectionScopeSchema, publicProjectionScopeFeatures } from './projection-pages.js';

export const PUBLIC_PROJECTION_SCOPED_READ_VERSION = '1.0' as const;
export const MAX_PUBLIC_PROJECTION_SCOPED_READ_BYTES = 2 * 1024 * 1024;
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const publicProjectionScopedReadRequestSchema = z.object({
  readContractVersion: z.string().min(1).max(32),
  streamId: publicProjectionCanonicalIdSchema,
  scope: publicProjectionScopeSchema,
  afterCursor: cursor, afterDigest: publicProjectionDigestSchema,
  limit: z.number().int().min(1).max(256)
}).strict();
export type PublicProjectionScopedReadRequest = z.infer<typeof publicProjectionScopedReadRequestSchema>;

const entrySchema = z.object({
  cursor: cursor.refine(value => value > 0), cursorDigest: publicProjectionDigestSchema,
  // Digest of the original complete Commit, verified by the authoritative reader.
  payloadDigest: publicProjectionDigestSchema,
  eventId: publicProjectionCanonicalIdSchema, sourceId: publicProjectionCanonicalIdSchema,
  sourceCursor: cursor.refine(value => value > 0), occurredAt: publicProjectionCanonicalTimestampSchema,
  changes: z.array(publicProjectionChangeSchema).max(256)
}).strict();
export const publicProjectionScopedReadBatchSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), readContractVersion: z.literal(PUBLIC_PROJECTION_SCOPED_READ_VERSION),
    projectionContractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    streamId: publicProjectionCanonicalIdSchema, scope: publicProjectionScopeSchema,
    afterCursor: cursor, afterDigest: publicProjectionDigestSchema,
    nextCursor: cursor, nextDigest: publicProjectionDigestSchema, hasMore: z.boolean(),
    entries: z.array(entrySchema).max(256), batchDigest: publicProjectionDigestSchema
  }).strict(),
  z.object({ status: z.literal('reset_required'), readContractVersion: z.literal(PUBLIC_PROJECTION_SCOPED_READ_VERSION),
    streamId: publicProjectionCanonicalIdSchema, currentCursor: cursor,
    reason: z.enum(['contract_mismatch', 'stream_mismatch', 'cursor_gap', 'history_mismatch', 'scope_mismatch'])
  }).strict()
]).superRefine((batch, context) => {
  if (batch.status !== 'ok') return;
  const last = batch.entries.at(-1);
  if (batch.nextCursor !== (last?.cursor ?? batch.afterCursor)
    || batch.nextDigest !== (last?.cursorDigest ?? batch.afterDigest)
    || (batch.hasMore && batch.entries.length === 0)
    || ((batch.afterCursor === 0) !== (batch.afterDigest === PUBLIC_PROJECTION_GENESIS_DIGEST))) {
    context.addIssue({ code: 'custom', message: 'Scan boundary contradicts its entries.' });
  }
  let expected = batch.afterCursor + 1;
  const features = publicProjectionScopeFeatures(batch.scope);
  for (const entry of batch.entries) {
    if (entry.cursor !== expected++) context.addIssue({ code: 'custom', message: 'Scan cursors must be contiguous.' });
    for (const change of entry.changes) {
      if (!features.includes(change.feature)
        || (batch.scope.kind === 'session' && change.dto !== null
          && 'sessionId' in change.dto && change.dto.sessionId !== batch.scope.sessionId)) {
        context.addIssue({ code: 'custom', message: 'Change escaped its subscription scope.' });
      }
    }
  }
});
export type PublicProjectionScopedReadBatch = z.infer<typeof publicProjectionScopedReadBatchSchema>;
export type PublicProjectionScopedReadOk = Extract<PublicProjectionScopedReadBatch, { status: 'ok' }>;

export function publicProjectionScopedReadDigestPayload(batch: Omit<PublicProjectionScopedReadOk, 'batchDigest'>): string {
  return canonicalPublicProjectionJson(batch);
}
export function assertPublicProjectionScopedReadBatch(value: unknown): PublicProjectionScopedReadBatch {
  const batch = publicProjectionScopedReadBatchSchema.parse(value);
  assertPublicProjectionPayloadSafe(batch);
  if (new TextEncoder().encode(canonicalPublicProjectionJson(batch)).byteLength > MAX_PUBLIC_PROJECTION_SCOPED_READ_BYTES) {
    throw new Error('public_projection_scoped_read_byte_limit_exceeded');
  }
  return batch;
}

/**
 * Checks a response against the exact subscription and continuous global scan.
 * payloadDigest proves continuity with the original ledger. Scope filtering is
 * performed by the trusted Runtime reader; it is not a Merkle membership proof.
 * batchDigest checks transport/staging drift, including relevant entity bodies.
 */
export async function verifyPublicProjectionScopedReadBatch(
  request: PublicProjectionScopedReadRequest, value: unknown
): Promise<PublicProjectionScopedReadBatch> {
  const batch = assertPublicProjectionScopedReadBatch(value);
  if (batch.status !== 'ok') return batch;
  if (batch.streamId !== request.streamId || batch.afterCursor !== request.afterCursor
    || batch.afterDigest !== request.afterDigest
    || canonicalPublicProjectionJson(batch.scope) !== canonicalPublicProjectionJson(request.scope)
    || batch.entries.length > request.limit || request.readContractVersion !== PUBLIC_PROJECTION_SCOPED_READ_VERSION) {
    throw new Error('public_projection_scoped_read_request_mismatch');
  }
  let previous = request.afterDigest;
  for (const entry of batch.entries) {
    const expected = await sha256(`${PUBLIC_PROJECTION_HISTORY_DOMAIN}\u0000${previous}`
      + `\u0000${String(entry.cursor)}\u0000${entry.payloadDigest}`);
    if (expected !== entry.cursorDigest) throw new Error('public_projection_scoped_read_history_mismatch');
    previous = entry.cursorDigest;
  }
  const { batchDigest, ...payload } = batch;
  if (batchDigest !== await sha256(publicProjectionScopedReadDigestPayload(payload))) {
    throw new Error('public_projection_scoped_read_payload_mismatch');
  }
  return batch;
}
async function sha256(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
