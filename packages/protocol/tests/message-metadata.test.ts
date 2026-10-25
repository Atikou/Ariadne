import { describe, expect, it } from 'vitest';
import { catalogSha256, canonicalPublicProjectionJson, messageMetadataDigestData, publicMessageMetadataWindowRequestSchema,
  verifyMessageMetadataWindow, verifyMessageBody, type PublicProjectionCatalogManifest, type PublicMessageMetadataRow } from '../src/public.js';
const at = '2032-01-01T00:00:00.000Z', hash = `sha256:${'a'.repeat(64)}` as const;
const manifest: PublicProjectionCatalogManifest = { pageContractVersion: '3.0', projectionContractVersion: '5.0', snapshotId: 'snapshot-a', streamId: 'stream-a',
  boundaryCursor: 2, boundaryDigest: hash, scope: { kind: 'session', sessionId: 'session-a', workspaceId: 'workspace-a' }, feature: 'runs', filter: 'all',
  capturedAt: at, expiresAt: '2032-01-01T00:05:00.000Z' };
async function row(id = 'message-a', role: 'user' | 'assistant' | 'system' = 'user'): Promise<Extract<PublicMessageMetadataRow, { kind: 'message' }>> {
  const metadata = { messageId: id, sessionId: 'session-a', version: 1, role, status: 'completed' as const, createdAt: at, updatedAt: at };
  return { kind: 'message', metadata, body: { messageId: id, messageVersion: 1, versionCommitCursor: 2, projectedAt: at, payloadDigest: hash,
    metadataDigest: await catalogSha256(messageMetadataDigestData(metadata)), bodyCursor: 'opaque.signature' } };
}
async function result(rows: PublicMessageMetadataRow[], window: { kind: 'latest'; limit: number } | { kind: 'before' | 'around'; anchorMessageId: string; limit: number },
  anchor: PublicMessageMetadataRow | null = null) {
  const payload = { status: 'ok' as const, queryContractVersion: '1.0' as const, manifest, window, anchor, rows, hasEarlier: false, hasLater: window.kind === 'before' };
  return { ...payload, windowDigest: await catalogSha256(canonicalPublicProjectionJson(payload)) };
}
describe('independent message metadata/body contracts', () => {
  it('rejects body fields, duplicate/order drift and wrong owner/C in a metadata window', async () => {
    const a = await row(), b = await row('message-b', 'assistant'), window = { kind: 'latest' as const, limit: 128 }, value = await result([a, b], window);
    const request = { queryContractVersion: '1.0', manifest, window };
    expect(await verifyMessageMetadataWindow(request, value)).toEqual(value);
    for (const changed of [{ ...value, rows: [b, a] }, { ...value, rows: [a, a] },
      { ...value, rows: [{ ...a, metadata: { ...a.metadata, content: 'HIDDEN_BODY' } }] },
      { ...value, rows: [{ ...a, metadata: { ...a.metadata, sessionId: 'session-b' } }] },
      { ...value, rows: [{ ...a, body: { ...a.body, versionCommitCursor: 3 } }] }]) {
      await expect(verifyMessageMetadataWindow(request, changed)).rejects.toThrow();
    }
    await expect(verifyMessageMetadataWindow(request, { ...value, windowDigest: hash })).rejects.toThrow('window_digest_mismatch');
    expect(() => publicMessageMetadataWindowRequestSchema.parse({ ...request, manifest: { ...manifest, filter: 'active' } })).toThrow();
  });
  it('binds empty/negative windows and requires the exact anchor and strict before range', async () => {
    const a = await row(), b = await row('message-b'), descriptor = { kind: 'before' as const, anchorMessageId: 'message-b', limit: 3 }, request = { queryContractVersion: '1.0', manifest, window: descriptor };
    expect(await verifyMessageMetadataWindow(request, await result([a], descriptor, b))).toMatchObject({ status: 'ok' });
    for (const value of [await result([b], descriptor, b), await result([a], descriptor, a), await result([a], descriptor, null)]) {
      await expect(verifyMessageMetadataWindow(request, value)).rejects.toThrow();
    }
    const negative = { status: 'anchor_unavailable', queryContractVersion: '1.0', manifest, window: descriptor };
    expect(await verifyMessageMetadataWindow(request, negative)).toEqual(negative);
    await expect(verifyMessageMetadataWindow(request, { ...negative, manifest: { ...manifest, snapshotId: 'snapshot-b' } })).rejects.toThrow('request_mismatch');
    await expect(verifyMessageMetadataWindow(request, { ...negative, window: { ...descriptor, anchorMessageId: 'other' } })).rejects.toThrow('request_mismatch');
    const around = { kind: 'around' as const, anchorMessageId: 'message-b', limit: 3 };
    await expect(verifyMessageMetadataWindow({ ...request, window: around }, await result([a], around, b))).rejects.toThrow();
    expect(await verifyMessageMetadataWindow({ ...request, window: { kind: 'latest', limit: 3 } }, await result([], { kind: 'latest', limit: 3 })))
      .toMatchObject({ rows: [], anchor: null });
  });
  it('checks standalone metadata independently of the response digest', async () => {
    const a = await row(), altered = { ...a, metadata: { ...a.metadata, version: 2 }, body: { ...a.body, messageVersion: 2 } };
    const window = { kind: 'latest' as const, limit: 1 }, value = await result([altered], window);
    await expect(verifyMessageMetadataWindow({ queryContractVersion: '1.0', manifest, window }, value)).rejects.toThrow('metadata_digest_mismatch');
  });
  it('verifies the original Message change digest, body digest, metadata and exact body reference', async () => {
    const metadataRow = await row(), message = { ...metadataRow.metadata, content: '模拟正文' };
    const change = { feature: 'messages', operation: 'upsert', aggregateId: message.messageId, aggregateVersion: message.version, projectedAt: at, dto: message };
    const body = { ...metadataRow.body, payloadDigest: await catalogSha256(canonicalPublicProjectionJson(change)) };
    const payload = { status: 'ok' as const, queryContractVersion: '1.0' as const, manifest, body, message }, request = { queryContractVersion: '1.0', manifest, body };
    const value = { ...payload, bodyDigest: await catalogSha256(canonicalPublicProjectionJson(payload)) };
    expect(await verifyMessageBody(request, value)).toEqual(value);
    const changed = { ...payload, message: { ...message, content: '修改正文' } };
    await expect(verifyMessageBody(request, { ...changed, bodyDigest: await catalogSha256(canonicalPublicProjectionJson(changed)) })).rejects.toThrow('payload_digest_mismatch');
    await expect(verifyMessageBody(request, { ...value, body: { ...body, messageId: 'foreign' } })).rejects.toThrow();
    await expect(verifyMessageBody(request, { ...value, bodyDigest: hash })).rejects.toThrow('body_digest_mismatch');
  });
});
