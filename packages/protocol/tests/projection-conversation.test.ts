import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalPublicProjectionJson, PUBLIC_PROJECTION_GENESIS_DIGEST, PUBLIC_PROJECTION_HISTORY_DOMAIN,
  publicConversationInferenceRequestSchema, verifyConversationReceipts, verifyConversationInferenceWindow,
  type PublicConversationReceiptRequest, type PublicProjectionChange } from '../src/public.js';
const at = '2032-01-01T00:00:00.000Z', digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
function request(): PublicConversationReceiptRequest { return { queryVersion: '1.0', manifest: { pageContractVersion: '3.0', projectionContractVersion: '5.0',
  streamId: 'stream-a', snapshotId: 'snapshot-a', boundaryCursor: 0, boundaryDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
  scope: { kind: 'session', sessionId: 'session-a', workspaceId: 'workspace-a' }, feature: 'runs', filter: 'all', capturedAt: at, expiresAt: '2032-01-01T00:05:00.000Z' },
  afterCursor: 0, afterDigest: PUBLIC_PROJECTION_GENESIS_DIGEST, limit: 128 }; }
it('verifies all conversation dependencies and original history, and rejects changed receipts or crossed negative replies', async () => {
  const input = request(), payloadDigest = digest('original receipt'), cursorDigest = digest(`${PUBLIC_PROJECTION_HISTORY_DOMAIN}\0${input.afterDigest}\0${String(1)}\0${payloadDigest}`);
  const payload = { status: 'ok', queryVersion: '1.0', manifest: input.manifest, afterCursor: 0, afterDigest: input.afterDigest,
    nextCursor: 1, nextDigest: cursorDigest, hasMore: false, entries: [{ cursor: 1, cursorDigest, payloadDigest, eventId: 'event-a', sourceId: 'source-a', sourceCursor: 1, occurredAt: at,
      receipts: ['messages', 'runs', 'inference_streams'].map(feature => ({ feature, aggregateId: `${feature}-a`, aggregateVersion: 1, projectedAt: at, operation: 'upsert' })) }] };
  const value = { ...payload, batchDigest: digest(canonicalPublicProjectionJson(payload)) };
  expect(await verifyConversationReceipts(input, value)).toEqual(value);
  await expect(verifyConversationReceipts(input, { ...value, batchDigest: digest('wrong') })).rejects.toThrow('digest_mismatch');
  const changed = { ...payload, entries: [{ ...payload.entries[0]!, payloadDigest: digest('changed') }] };
  await expect(verifyConversationReceipts(input, { ...changed, batchDigest: digest(canonicalPublicProjectionJson(changed)) })).rejects.toThrow('history_mismatch');
  const reset = { status: 'reset_required', queryVersion: '1.0', manifest: input.manifest, afterCursor: 0, afterDigest: input.afterDigest, reason: 'snapshot_expired' };
  expect(await verifyConversationReceipts(input, reset)).toEqual(reset);
  await expect(verifyConversationReceipts(input, { ...reset, manifest: { ...input.manifest, snapshotId: 'snapshot-b' } })).rejects.toThrow('request_mismatch');
});
function stream(): PublicProjectionChange { return { feature: 'inference_streams', aggregateId: 'stream-a', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
  dto: { inferenceStreamId: 'stream-a', sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a', attemptId: 'attempt-a', version: 1, status: 'streaming', retainedFromSequence: 1,
    finalSequence: 1, chunks: [{ sequence: 1, channel: 'reasoning', text: 'private public prefix', observedAt: at }], updatedAt: at } }; }
it('binds inference windows to an exact Catalog C, filters, owner and checksum without accepting View manifests', async () => {
  const input = { queryVersion: '1.0' as const, manifest: request().manifest, window: { feature: 'inference_streams' as const, filter: 'streaming' as const, limit: 128, runIds: ['run-a'] } };
  const payload = { ...input, status: 'ok', changes: [stream()], hasEarlier: false }, value = { ...payload, windowDigest: digest(canonicalPublicProjectionJson(payload)) };
  expect(await verifyConversationInferenceWindow(input, value)).toEqual(value);
  expect(publicConversationInferenceRequestSchema.safeParse({ ...input, manifest: { ...input.manifest, pageContractVersion: '2.0' } }).success).toBe(false);
  expect(publicConversationInferenceRequestSchema.safeParse({ ...input, window: { ...input.window, feature: 'models' } }).success).toBe(false);
  await expect(verifyConversationInferenceWindow(input, { ...value, manifest: { ...input.manifest, snapshotId: 'snapshot-b' } })).rejects.toThrow('request_mismatch');
  const original = stream(); if (original.feature !== 'inference_streams' || original.dto === null) throw new Error('stream_required');
  await expect(verifyConversationInferenceWindow(input, { ...value, changes: [{ ...original, dto: { ...original.dto, sessionId: 'foreign-session' } }] })).rejects.toThrow();
  await expect(verifyConversationInferenceWindow(input, { ...value, windowDigest: digest('wrong') })).rejects.toThrow('digest_mismatch');
});
it('rejects duplicate/out-of-order prefixes and binds empty/negative windows to the exact request', async () => {
  const input = { queryVersion: '1.0' as const, manifest: request().manifest, window: { feature: 'inference_streams' as const, filter: 'all' as const, limit: 128 } };
  await expect(verifyConversationInferenceWindow(input, { ...input, status: 'anchor_unavailable' })).rejects.toThrow();
  const anchored = { ...input, window: { ...input.window, beforeAggregateId: 'stream-a' } };
  expect(await verifyConversationInferenceWindow(anchored, { ...anchored, status: 'anchor_unavailable' })).toMatchObject({ status: 'anchor_unavailable' });
  await expect(verifyConversationInferenceWindow(anchored, { ...anchored, status: 'anchor_unavailable', window: { ...anchored.window, beforeAggregateId: 'other-anchor' } })).rejects.toThrow('request_mismatch');
  const payload = { ...input, status: 'ok', changes: [], hasEarlier: false };
  expect(await verifyConversationInferenceWindow(input, { ...payload, windowDigest: digest(canonicalPublicProjectionJson(payload)) })).toMatchObject({ status: 'ok', changes: [] });
  await expect(verifyConversationInferenceWindow(input, { ...payload, changes: [stream(), stream()], windowDigest: digest('irrelevant') })).rejects.toThrow();
});
