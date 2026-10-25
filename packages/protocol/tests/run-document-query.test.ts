import { describe, expect, it } from 'vitest';
import { catalogSha256, canonicalPublicProjectionJson, PUBLIC_PROJECTION_GENESIS_DIGEST,
  runDocumentEmptyData, runDocumentHeaderData, RUN_DOCUMENT_COLLECTIONS,
  verifyRunDocumentRootResult, verifyRunDocumentChunkResult, verifyRunDocumentMetadataResult,
  RunDocumentMetadataPageChain, publicRunDocumentRootRequestSchema,
  type PublicRunDocumentHeader, type PublicProjectionCatalogManifest } from '../src/public.js';
const at = '2032-01-01T00:00:00.000Z', digest = `sha256:${'a'.repeat(64)}` as const;
const manifest: PublicProjectionCatalogManifest = { pageContractVersion: '3.0', projectionContractVersion: '5.0',
  snapshotId: 'snapshot-a', streamId: 'stream-a', boundaryCursor: 1, boundaryDigest: digest,
  scope: { kind: 'session', sessionId: 'session-a', workspaceId: 'workspace-a' }, feature: 'runs', filter: 'all',
  capturedAt: at, expiresAt: '2032-01-01T00:05:00.000Z' };
async function empty() {
  const collections = {} as PublicRunDocumentHeader['collections'];
  for (const kind of RUN_DOCUMENT_COLLECTIONS) collections[kind] = { itemCount: 0, leafCount: 0,
    merkleRoot: await catalogSha256(runDocumentEmptyData('run-a', 1, kind)) };
  const data = { documentContractVersion: '1.0' as const, collections, summary: { runId: 'run-a', sessionId: 'session-a', version: 1,
    title: '模拟查询', label: '模拟查询', status: 'running' as const, updatedAt: at, toolActivityCount: 0,
    queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: 0 } };
  const header = { ...data, documentDigest: await catalogSha256(runDocumentHeaderData(data)) };
  const document = { runId: 'run-a', runVersion: 1, documentDigest: header.documentDigest, versionCommitCursor: 1, bodyCursor: 'opaque.signature' };
  return { status: 'ok' as const, queryContractVersion: '1.0' as const, manifest, header, document };
}
describe('explicit Run body query contract', () => {
  it('verifies a root envelope, owner, expected version and root hash independently', async () => {
    const payload = await empty(), result = { ...payload, rootDigest: await catalogSha256(canonicalPublicProjectionJson(payload)) };
    const request = { queryContractVersion: '1.0', manifest, runId: 'run-a', expectedRunVersion: 1 };
    expect(await verifyRunDocumentRootResult(request, result)).toEqual(result);
    await expect(verifyRunDocumentRootResult({ ...request, expectedRunVersion: 2 }, result)).rejects.toThrow('request_mismatch');
    await expect(verifyRunDocumentRootResult(request, { ...result, rootDigest: digest })).rejects.toThrow('digest_mismatch');
    await expect(verifyRunDocumentRootResult(request, { ...result, document: { ...result.document, versionCommitCursor: 2 } })).rejects.toThrow();
    expect(() => publicRunDocumentRootRequestSchema.parse({ ...request, manifest: { ...manifest, scope: { kind: 'tasks' } } })).toThrow();
    expect(() => publicRunDocumentRootRequestSchema.parse({ ...request, manifest: { ...manifest, filter: 'active' } })).toThrow();
  });
  it('binds negative results to the exact request so absent data cannot erase a different owner or item', async () => {
    const base = await empty(), request = { queryContractVersion: '1.0', manifest, runId: 'run-a' };
    const unavailable = { status: 'unavailable', queryContractVersion: '1.0', manifest, runId: 'run-a', reason: 'not_found' };
    expect(await verifyRunDocumentRootResult(request, unavailable)).toEqual(unavailable);
    await expect(verifyRunDocumentRootResult(request, { ...unavailable, runId: 'run-b' })).rejects.toThrow('request_mismatch');
    await expect(verifyRunDocumentRootResult(request, { ...unavailable, manifest: { ...manifest, snapshotId: 'snapshot-b' } })).rejects.toThrow('request_mismatch');
    const chunkRequest = { queryContractVersion: '1.0', manifest, document: base.document, collection: 'inbox' as const, itemOrdinal: 1, chunkOrdinal: 0 };
    const absent = { ...chunkRequest, status: 'item_unavailable' };
    expect(await verifyRunDocumentChunkResult(chunkRequest, absent)).toEqual(absent);
    for (const altered of [{ ...absent, itemOrdinal: 2 }, { ...absent, document: { ...base.document, runId: 'run-b' } }]) {
      await expect(verifyRunDocumentChunkResult(chunkRequest, altered)).rejects.toThrow('request_mismatch');
    }
    await expect(verifyRunDocumentRootResult(request, { status: 'reset_required', reason: 'snapshot_expired', streamId: 'foreign-stream' }))
      .rejects.toThrow('request_mismatch');
  });
  it('verifies zero-item completion, rejects duplicate completion and altered coverage', async () => {
    const base = await empty(), request = { queryContractVersion: '1.0', manifest, document: base.document, collection: 'inbox' as const, limit: 128 };
    const payload = { ...base, collection: 'inbox' as const, startOrdinal: 0, pageIndex: 0, previousPageDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
      rows: [], hasMore: false };
    const result = { ...payload, pageDigest: await catalogSha256(canonicalPublicProjectionJson(payload)) };
    expect(await verifyRunDocumentMetadataResult(request, result)).toEqual(result);
    const chain = new RunDocumentMetadataPageChain(); await chain.accept(request, result);
    await expect(chain.accept(request, result)).rejects.toThrow('already_completed');
    await expect(verifyRunDocumentMetadataResult(request, { ...result, startOrdinal: 1 })).rejects.toThrow();
    await expect(verifyRunDocumentMetadataResult(request, { ...result, hasMore: true, nextPageCursor: 'opaque.cursor' })).rejects.toThrow();
  });
});
