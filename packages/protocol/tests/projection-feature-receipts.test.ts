import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalPublicProjectionJson, PUBLIC_PROJECTION_GENESIS_DIGEST, PUBLIC_PROJECTION_HISTORY_DOMAIN,
  publicProjectionFeatureReceiptRequestSchema, verifyPublicProjectionFeatureReceipts,
  type PublicProjectionFeatureReceiptRequest } from '../src/public.js';
const at = '2032-01-01T00:00:00.000Z';
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function request(): PublicProjectionFeatureReceiptRequest {
  return { queryVersion: '1.0', manifest: { pageContractVersion: '2.0', projectionContractVersion: '5.0',
    streamId: 'stream-a', snapshotId: 'snapshot-a', boundaryCursor: 0, boundaryDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
    scope: { kind: 'directory' }, selectedFeatures: ['diagnostics'], capturedAt: at, expiresAt: '2032-01-01T00:05:00.000Z' },
    afterCursor: 0, afterDigest: PUBLIC_PROJECTION_GENESIS_DIGEST, limit: 1 };
}
function result(input = request()) {
  const payloadDigest = digest('original immutable commit');
  const cursorDigest = digest(`${PUBLIC_PROJECTION_HISTORY_DOMAIN}\0${input.afterDigest}\0${input.afterCursor + 1}\0${payloadDigest}`);
  const payload = { status: 'ok' as const, queryVersion: '1.0' as const, manifest: input.manifest,
    afterCursor: input.afterCursor, afterDigest: input.afterDigest, nextCursor: input.afterCursor + 1, nextDigest: cursorDigest, hasMore: false,
    entries: [{ cursor: input.afterCursor + 1, cursorDigest, payloadDigest, eventId: 'event-a', sourceId: 'source-a', sourceCursor: 1,
      occurredAt: at, receipts: [{ feature: 'diagnostics' as const, aggregateId: 'diagnostic-a', aggregateVersion: 1,
        projectedAt: at, operation: 'upsert' as const }] }] };
  return { ...payload, batchDigest: digest(canonicalPublicProjectionJson(payload)) };
}
it('requires continuous original history and exact request selection without accepting entity DTOs', async () => {
  const input = request(), value = result(input);
  expect(await verifyPublicProjectionFeatureReceipts(input, value)).toEqual(value);
  await expect(verifyPublicProjectionFeatureReceipts(input, { ...value, entries: [{ ...value.entries[0],
    receipts: [{ ...value.entries[0]!.receipts[0], dto: { message: 'unexpected body' } }] }] })).rejects.toThrow();
  await expect(verifyPublicProjectionFeatureReceipts(input, { ...value, entries: [{ ...value.entries[0],
    receipts: [{ ...value.entries[0]!.receipts[0], feature: 'models' }] }] })).rejects.toThrow();
  await expect(verifyPublicProjectionFeatureReceipts(input, { ...value, entries: [{ ...value.entries[0], cursor: 2 }] })).rejects.toThrow();
  const forged = { ...value, entries: [{ ...value.entries[0]!, payloadDigest: digest('changed original') }] };
  const { batchDigest: _old, ...payload } = forged;
  await expect(verifyPublicProjectionFeatureReceipts(input, { ...payload, batchDigest: digest(canonicalPublicProjectionJson(payload)) })).rejects.toThrow('history_mismatch');
});
it('binds negative results and transport digest to the complete snapshot and scan request', async () => {
  const input = request(), value = result(input);
  const reset = { status: 'reset_required', queryVersion: '1.0', manifest: input.manifest,
    afterCursor: input.afterCursor, afterDigest: input.afterDigest, reason: 'snapshot_expired' };
  expect(await verifyPublicProjectionFeatureReceipts(input, reset)).toEqual(reset);
  await expect(verifyPublicProjectionFeatureReceipts(input, { ...reset, manifest: { ...input.manifest, snapshotId: 'snapshot-b' } })).rejects.toThrow('request_mismatch');
  await expect(verifyPublicProjectionFeatureReceipts(input, { ...value, batchDigest: digest('wrong') })).rejects.toThrow('digest_mismatch');
  await expect(verifyPublicProjectionFeatureReceipts({ ...input, limit: 1, manifest: { ...input.manifest, selectedFeatures: ['models'] } }, value)).rejects.toThrow('request_mismatch');
});
it('restricts the manifest to bounded feature windows and rejects duplicate receipts or oversized results', async () => {
  const input = request(), value = result(input);
  expect(publicProjectionFeatureReceiptRequestSchema.safeParse({ ...input, manifest: { ...input.manifest, selectedFeatures: ['sessions'] } }).success).toBe(false);
  expect(publicProjectionFeatureReceiptRequestSchema.safeParse({ ...input, manifest: { ...input.manifest,
    scope: { kind: 'session', workspaceId: 'workspace-a', sessionId: 'session-a' }, selectedFeatures: ['runs'] } }).success).toBe(false);
  await expect(verifyPublicProjectionFeatureReceipts(input, { ...value, entries: [{ ...value.entries[0],
    receipts: [...value.entries[0]!.receipts, ...value.entries[0]!.receipts] }] })).rejects.toThrow();
  await expect(verifyPublicProjectionFeatureReceipts(input, { ...value, entries: Array.from({ length: 257 }, () => value.entries[0]) })).rejects.toThrow();
});
