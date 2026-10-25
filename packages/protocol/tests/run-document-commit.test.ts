import { describe, expect, it } from 'vitest';
import { assertPublicProjectionCommit, assertPublicRunDocumentCommit, catalogSha256, runDocumentEmptyData,
  runDocumentHeaderData, RUN_DOCUMENT_COLLECTIONS, type PublicRunDocumentHeader } from '../src/public.js';

const at = '2032-01-01T00:00:00.000Z';
async function request() {
  const collections = {} as PublicRunDocumentHeader['collections'];
  for (const collection of RUN_DOCUMENT_COLLECTIONS) collections[collection] = {
    itemCount: 0, leafCount: 0, merkleRoot: await catalogSha256(runDocumentEmptyData('document-run', 1, collection)) };
  const data = { documentContractVersion: '1.0' as const, summary: { runId: 'document-run', sessionId: 'document-session', version: 1,
    title: '模拟协议', status: 'running' as const, label: '模拟协议', updatedAt: at,
    toolActivityCount: 0, queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: 0 }, collections };
  const dto = { ...data, documentDigest: await catalogSha256(runDocumentHeaderData(data)) };
  return { contractVersion: '6.0' as const, eventId: 'document-event', sourceId: 'document-source', sourceCursor: 1, occurredAt: at,
    changes: [{ feature: 'runs' as const, operation: 'upsert' as const, aggregateId: 'document-run', aggregateVersion: 1, projectedAt: at, dto }] };
}
describe('independent Run document Commit', () => {
  it('declares a new format without changing or impersonating released complete Run DTOs', async () => {
    const value = await request(); expect(assertPublicRunDocumentCommit(value)).toEqual(value);
    expect(() => assertPublicProjectionCommit(value)).toThrow();
    expect(() => assertPublicRunDocumentCommit({ ...value, contractVersion: '5.0' })).toThrow();
  });
  it('binds the root to aggregate, Source version and the same timestamp', async () => {
    const value = await request(), first = value.changes[0]!;
    for (const changed of [{ ...value, sourceCursor: 2 }, { ...value, occurredAt: '2032-01-02T00:00:00.000Z' },
      { ...value, changes: [{ ...first, aggregateId: 'foreign-run' }] }, { ...value, changes: [{ ...first, aggregateVersion: 2 }] }]) {
      expect(() => assertPublicRunDocumentCommit(changed)).toThrow();
    }
  });
  it('refuses a second Run, foreign feature or duplicate entity in one Commit', async () => {
    const value = await request(); expect(() => assertPublicRunDocumentCommit({ ...value, changes: [...value.changes, ...value.changes] })).toThrow();
    const deleted = { feature: 'decisions', operation: 'delete', aggregateId: 'decision-id', aggregateVersion: 1, projectedAt: at, dto: null };
    expect(() => assertPublicRunDocumentCommit({ ...value, changes: [...value.changes, deleted] })).not.toThrow();
    expect(() => assertPublicRunDocumentCommit({ ...value, changes: [...value.changes, deleted, deleted] })).toThrow();
    expect(() => assertPublicRunDocumentCommit({ ...value, changes: [...value.changes, { ...deleted, feature: 'sessions' }] })).toThrow();
  });
  it('applies public safety before a document Commit can be stored', async () => {
    const value = await request(), first = value.changes[0]!;
    expect(() => assertPublicRunDocumentCommit({ ...value, changes: [{ ...first, dto: { ...first.dto,
      summary: { ...first.dto.summary, label: 'password=private-value' } } }] })).toThrow('public_projection_secret_forbidden');
  });
});
