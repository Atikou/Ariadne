import { auditStoredProjectionState as auditDocumentMigration } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicProjectionCommit, assertPublicRunDocumentCommit, canonicalPublicProjectionJson,
  RunDocumentItemAssembler, RunDocumentMetadataPageChain, MAX_RUN_DOCUMENT_QUERY_BYTES,
  verifyRunDocumentRootResult, verifyRunDocumentMetadataResult, verifyRunDocumentInboxResult, verifyRunDocumentChunkResult,
  type PublicProjectionChange, type PublicProjectionCatalogManifest, type PublicRunDocumentRootResult } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteRunDocumentPublication } from '../src/adapters/persistence/SqliteRunDocumentPublication.js';
import { SqliteRunDocumentPreparation } from '../src/adapters/persistence/SqliteRunDocumentPreparation.js';
import { upgradeRunDocumentSchema } from '../src/adapters/persistence/RunDocumentDbSchema.js';
import { RunDocumentPlan, type RunDocumentSource } from '../src/projection/RunDocumentPlan.js';

const at = '2032-01-01T00:00:00.000Z', resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const { root, store } of resources.splice(0)) {
  await store.close(); rmSync(root, { recursive: true, force: true });
} });
function create(now?: () => Date) {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-document-query-'));
  const store = new SqlitePublicProjectionStore(root, now === undefined ? undefined : { now });
  resources.push({ root, store });
  const database = (store as unknown as { database: DatabaseSync }).database;
  return { store, database };
}
function session(version = 1, workspaceId = 'workspace-a'): PublicProjectionChange {
  return { feature: 'sessions', operation: 'upsert', aggregateId: 'session-a', aggregateVersion: version, projectedAt: at,
    dto: { sessionId: 'session-a', workspaceId, version, title: '模拟会话', status: 'active', pinned: false, createdAt: at, updatedAt: at } };
}
function ordinary(cursor: number, changes: PublicProjectionChange[]) {
  return assertPublicProjectionCommit({ contractVersion: '5.0', sourceId: 'query-sessions', sourceCursor: cursor,
    eventId: `query-sessions-${cursor}`, occurredAt: at, changes });
}
function source(version = 1, count = 140, large = true): RunDocumentSource {
  return { summary: { runId: 'run-a', sessionId: 'session-a', version, title: '模拟文档', label: '模拟文档', status: 'running',
    updatedAt: at, toolActivityCount: 0, queuedInputCount: count, claimedInputCount: 0, interactionMessageCount: 1 },
    toolActivities: [], inbox: Array.from({ length: count }, (_, index) => ({ inputId: `input-${index}`, messageId: `input-message-${index}`,
      version: 1, delivery: 'next_turn', content: 'BODY_EXPLICIT_ONLY', state: 'queued', queuedAt: at, updatedAt: at,
      ...(index === 139 ? { source: { kind: 'user_question_answer' as const, decisionId: 'decision-a', questionDigest: `sha256:${'a'.repeat(64)}` as const } } : {}) })),
    interactionMessages: [{ messageId: 'message-a', sessionId: 'session-a', runId: 'run-a', version, role: 'assistant',
      content: large ? `BODY_VERSION_${version}🙂`.repeat(48_000) : `BODY_VERSION_${version}`, status: 'completed', createdAt: at, updatedAt: at }] };
}
function documentCommit(plan: RunDocumentPlan) {
  return assertPublicRunDocumentCommit({ contractVersion: '6.0', sourceId: 'query-run', sourceCursor: plan.header.summary.version,
    eventId: `query-run-${plan.header.summary.version}`, occurredAt: at, changes: [{ feature: 'runs', operation: 'upsert',
      aggregateId: 'run-a', aggregateVersion: plan.header.summary.version, projectedAt: at, dto: plan.header }] });
}
async function begin(store: SqlitePublicProjectionStore, workspaceId = 'workspace-a'): Promise<PublicProjectionCatalogManifest> {
  const result = await store.beginCatalogSnapshot({ pageContractVersion: '3.0', feature: 'runs', filter: 'all',
    scope: { kind: 'session', sessionId: 'session-a', workspaceId } });
  if ('status' in result) throw new Error(`fixture_manifest:${result.reason}`); return result;
}
async function root(store: SqlitePublicProjectionStore, manifest: PublicProjectionCatalogManifest) {
  const request = { queryContractVersion: '1.0', manifest, runId: 'run-a' };
  const result = await verifyRunDocumentRootResult(request, await store.readRunDocument(request));
  if (result.status !== 'ok') throw new Error(`fixture_root:${result.status}`); return result;
}
function request(manifest: PublicProjectionCatalogManifest, result: Extract<PublicRunDocumentRootResult, { status: 'ok' }>) {
  return { queryContractVersion: '1.0', manifest, document: result.document };
}
async function fixture(count = 140, large = true, now?: () => Date) {
  const owner = create(now); await owner.store.append(ordinary(1, [session()])); upgradeRunDocumentSchema(owner.database, auditDocumentMigration);
  const writer = new SqliteRunDocumentPublication(owner.database, owner.store.streamId, appendDocumentLedger), plan = new RunDocumentPlan(source(1, count, large));
  await writer.publish(documentCommit(plan), plan); const manifest = await begin(owner.store), result = await root(owner.store, manifest);
  return { ...owner, writer, plan, manifest, result };
}

describe('same-C Run document queries on the owning Store', () => {
  it('keeps old bodies at C after a later Run version and Session workspace move, including minimal catalog summaries', async () => {
    const f = await fixture(); const original = await f.store.readCatalogPage({ manifest: f.manifest, limit: 128 });
    expect(original).toMatchObject({ status: 'ok', totalRows: 1, rows: [{ dto: f.plan.header.summary }] });
    expect(JSON.stringify(original)).not.toContain('BODY_VERSION');
    const next = new RunDocumentPlan(source(2)); await f.writer.publish(documentCommit(next), next);
    await f.store.append(ordinary(2, [session(2, 'workspace-b')]));
    expect(await root(f.store, f.manifest)).toEqual(f.result);
    expect(await f.store.readCatalogPage({ manifest: f.manifest, limit: 128 })).toEqual(original);
    const fresh = await begin(f.store, 'workspace-b'), current = await root(f.store, fresh);
    expect(current.document).toMatchObject({ runVersion: 2, versionCommitCursor: 3 });
    expect(current.header.documentDigest).not.toBe(f.result.header.documentDigest);
    const assembler = new RunDocumentItemAssembler(f.result.header, 'interactionMessages', 0); let restored = null;
    for (let chunkOrdinal = 0; chunkOrdinal < 4; chunkOrdinal++) {
      const input = { ...request(f.manifest, f.result), collection: 'interactionMessages' as const, itemOrdinal: 0, chunkOrdinal };
      const result = await verifyRunDocumentChunkResult(input, await f.store.readRunDocumentChunk(input));
      if (result.status !== 'ok') throw new Error('fixture_chunk'); restored = await assembler.accept(result.leaf);
    }
    expect(restored?.value).toMatchObject({ content: source().interactionMessages[0]!.content });
    expect(await f.store.readRunDocumentChunk({ ...request(fresh, f.result), collection: 'inbox', itemOrdinal: 0, chunkOrdinal: 0 }))
      .toMatchObject({ status: 'reset_required', reason: 'page_cursor_invalid' });
  });
  it('paginates complete metadata with proofs and exact Inbox lookup without reading chunk BLOBs', async () => {
    const f = await fixture(), sql: string[] = [], original = f.database.prepare.bind(f.database);
    vi.spyOn(f.database, 'prepare').mockImplementation(statement => { sql.push(statement); return original(statement); });
    const firstRequest = { ...request(f.manifest, f.result), collection: 'inbox' as const, limit: 128 };
    const first = await f.store.readRunDocumentMetadataPage(firstRequest); if (first.status !== 'ok') throw new Error('fixture_page');
    expect(first).toMatchObject({ startOrdinal: 0, pageIndex: 0, hasMore: true }); expect(first.rows).toHaveLength(128);
    const secondRequest = { ...firstRequest, pageCursor: first.nextPageCursor };
    const second = await f.store.readRunDocumentMetadataPage(secondRequest);
    const chain = new RunDocumentMetadataPageChain(); await chain.accept(firstRequest, first); await chain.accept(secondRequest, second);
    expect(second).toMatchObject({ startOrdinal: 128, pageIndex: 1, hasMore: false });
    const lookup = { ...request(f.manifest, f.result), inputId: 'input-139' };
    const found = await verifyRunDocumentInboxResult(lookup, await f.store.readRunDocumentInboxInput(lookup));
    expect(found).toMatchObject({ proof: { metadata: { value: { inputId: 'input-139', delivery: 'next_turn', state: 'queued',
      source: { kind: 'user_question_answer', decisionId: 'decision-a' } } } } });
    expect(await f.store.readRunDocumentInboxInput({ ...lookup, inputId: 'absent' })).toMatchObject({ status: 'ok', proof: null });
    expect(sql.some(statement => /SELECT[^;]*chunk_bytes/iu.test(statement))).toBe(false);
    expect(JSON.stringify({ first, second, found })).not.toContain('BODY_EXPLICIT_ONLY');
    expect(Buffer.byteLength(canonicalPublicProjectionJson(first))).toBeLessThanOrEqual(MAX_RUN_DOCUMENT_QUERY_BYTES);
    const emptyRequest = { ...firstRequest, collection: 'toolActivities' as const };
    const empty = await verifyRunDocumentMetadataResult(emptyRequest, await f.store.readRunDocumentMetadataPage(emptyRequest));
    expect(empty).toMatchObject({ rows: [], hasMore: false });
  });
  it('rejects forged, cross-snapshot, cross-collection and expired tokens, while leaving other reads usable', async () => {
    let clock = Date.parse(at); const f = await fixture(3, false, () => new Date(clock));
    const input = { ...request(f.manifest, f.result), collection: 'inbox' as const, limit: 1 };
    const page = await f.store.readRunDocumentMetadataPage(input); if (page.status !== 'ok') throw new Error('fixture_page');
    const another = await begin(f.store);
    for (const changed of [{ ...input, manifest: another }, { ...input, document: { ...input.document, runId: 'foreign-run' } },
      { ...input, document: { ...input.document, bodyCursor: 'tampered.signature' } },
      { ...input, document: { ...input.document, versionCommitCursor: 1 } }]) {
      expect(await f.store.readRunDocumentMetadataPage(changed)).toMatchObject({ status: 'reset_required', reason: 'page_cursor_invalid' });
    }
    expect(await f.store.readRunDocumentMetadataPage({ ...input, collection: 'toolActivities', pageCursor: page.nextPageCursor }))
      .toMatchObject({ status: 'reset_required', reason: 'page_cursor_invalid' });
    expect(await f.store.readRunDocument({ queryContractVersion: '2.0', manifest: f.manifest, runId: 'run-a' }))
      .toMatchObject({ status: 'reset_required', reason: 'contract_mismatch' });
    expect(await f.store.readRunDocument({ queryContractVersion: '1.0', manifest: f.manifest, runId: 'run-a', expectedRunVersion: 2 }))
      .toMatchObject({ status: 'unavailable', reason: 'version_mismatch' });
    clock += 5 * 60_000;
    expect(await f.store.readRunDocumentMetadataPage(input)).toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
    await expect(f.store.readPublicProjectionSourceCheckpoint('query-run')).resolves.toBe(1);
  });
  it('rejects missing/reordered metadata ranges, tampered proofs and body chunks even when an envelope is rehashed', async () => {
    const f = await fixture(3, false), input = { ...request(f.manifest, f.result), collection: 'inbox' as const, limit: 1 };
    const first = await f.store.readRunDocumentMetadataPage(input); if (first.status !== 'ok') throw new Error('fixture_page');
    const nextInput = { ...input, pageCursor: first.nextPageCursor }, second = await f.store.readRunDocumentMetadataPage(nextInput);
    await expect(new RunDocumentMetadataPageChain().accept(nextInput, second)).rejects.toThrow('sequence_mismatch');
    const chain = new RunDocumentMetadataPageChain(); await chain.accept(input, first);
    await expect(chain.accept(input, first)).rejects.toThrow('sequence_mismatch');
    const changed = structuredClone(first); changed.rows[0]!.metadata.value.version = 2;
    const { pageDigest: _digest, nextPageCursor: _cursor, ...payload } = changed;
    const { projectionDigest } = await import('../src/adapters/persistence/StoredProjectionRecords.js');
    changed.pageDigest = projectionDigest(canonicalPublicProjectionJson(payload)) as typeof changed.pageDigest;
    await expect(verifyRunDocumentMetadataResult(input, changed)).rejects.toThrow('metadata_digest_mismatch');
    const chunkInput = { ...request(f.manifest, f.result), collection: 'interactionMessages' as const, itemOrdinal: 0, chunkOrdinal: 0 };
    const chunk = await f.store.readRunDocumentChunk(chunkInput); if (chunk.status !== 'ok') throw new Error('fixture_chunk');
    const badChunk = { ...chunk, leaf: { ...chunk.leaf, contentBase64: Buffer.alloc(chunk.leaf.descriptor.chunkBytes).toString('base64') } };
    const { resultDigest: _resultDigest, ...bodyPayload } = badChunk;
    badChunk.resultDigest = projectionDigest(canonicalPublicProjectionJson(bodyPayload)) as typeof badChunk.resultDigest;
    await expect(verifyRunDocumentChunkResult(chunkInput, badChunk)).rejects.toThrow('chunk_digest_mismatch');
    await f.store.append(ordinary(2, [{ ...session(), aggregateId: 'session-b', dto: { ...session().dto!, sessionId: 'session-b' } } as PublicProjectionChange]));
    const other = await f.store.beginCatalogSnapshot({ pageContractVersion: '3.0', feature: 'runs', filter: 'all',
      scope: { kind: 'session', sessionId: 'session-b', workspaceId: 'workspace-a' } });
    if ('status' in other) throw new Error('fixture_other_session');
    expect(await f.store.readRunDocument({ queryContractVersion: '1.0', manifest: other, runId: 'run-a' }))
      .toMatchObject({ status: 'unavailable', reason: 'not_found' });
    expect(await f.store.readRunDocumentMetadataPage({ ...input, manifest: other }))
      .toMatchObject({ status: 'reset_required', reason: 'page_cursor_invalid' });
  });
  it('derives the released 5.0 body at C without schema writes, staging or rewriting its history', async () => {
    const f = create(); const value = source(1, 2, false), { toolActivityCount: _t, queuedInputCount: _q, claimedInputCount: _c,
      interactionMessageCount: _m, ...summary } = value.summary;
    await f.store.append(ordinary(1, [session(), { feature: 'runs', operation: 'upsert', aggregateId: 'run-a', aggregateVersion: 1, projectedAt: at,
      dto: { ...summary, toolActivities: [], inbox: [...value.inbox], interactionMessages: value.interactionMessages.map(({ runId: _r, ...message }) => message) } }]));
    const before = f.database.prepare('SELECT * FROM projection_commits').all();
    const manifest = await begin(f.store), result = await root(f.store, manifest);
    expect(result.header).toEqual(new RunDocumentPlan(value).header);
    const input = { ...request(manifest, result), collection: 'interactionMessages' as const, itemOrdinal: 0, chunkOrdinal: 0 };
    const chunk = await verifyRunDocumentChunkResult(input, await f.store.readRunDocumentChunk(input));
    if (chunk.status !== 'ok') throw new Error('fixture_chunk');
    expect(await new RunDocumentItemAssembler(result.header, 'interactionMessages', 0).accept(chunk.leaf))
      .toMatchObject({ value: { content: 'BODY_VERSION_1', runId: 'run-a' } });
    expect(f.database.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
    expect(f.database.prepare('SELECT * FROM projection_run_documents').all()).toEqual([]);
    expect(f.database.prepare('SELECT * FROM projection_run_document_items').all()).toEqual([]);
    expect(f.database.prepare('SELECT * FROM projection_run_document_leaves').all()).toEqual([]);
    expect(f.database.prepare('SELECT * FROM projection_commits').all()).toEqual(before);
    await f.store.close(); const resource = resources.at(-1)!; resource.store = new SqlitePublicProjectionStore(resource.root);
    expect(await resource.store.readRunDocument({ queryContractVersion: '1.0', manifest, runId: 'run-a' }))
      .toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
  });
  it('distinguishes out-of-range absence from missing declared chunks and unpublished preparation', async () => {
    const f = await fixture(2, false), input = { ...request(f.manifest, f.result), collection: 'inbox' as const, itemOrdinal: 2, chunkOrdinal: 0 };
    expect(await verifyRunDocumentChunkResult(input, await f.store.readRunDocumentChunk(input))).toMatchObject({ status: 'item_unavailable' });
    expect(await f.store.readRunDocumentChunk({ ...input, itemOrdinal: 0, chunkOrdinal: 1 })).toMatchObject({ status: 'item_unavailable' });
    const next = new RunDocumentPlan(source(2, 2, false)); await new SqliteRunDocumentPreparation(f.database).prepare(next);
    expect((await root(f.store, await begin(f.store))).header.summary.version).toBe(1);
    f.database.exec("DELETE FROM projection_run_document_leaves WHERE collection='inbox' AND item_ordinal=0");
    await expect(f.store.readRunDocumentChunk({ ...input, itemOrdinal: 0 })).rejects.toThrow('metadata_proof_missing');
  });
  it('rejects a foreign body-only write before returning even a root or negative Inbox lookup', async () => {
    const f = await fixture(2, false), dbPath = (f.store as unknown as { databasePath: string }).databasePath;
    const foreign = new DatabaseSync(dbPath);
    try { foreign.exec("UPDATE projection_run_document_leaves SET chunk_bytes=zeroblob(length(chunk_bytes))"); } finally { foreign.close(); }
    await expect(f.store.readRunDocument({ queryContractVersion: '1.0', manifest: f.manifest, runId: 'run-a' })).rejects.toThrow('external_write');
    await expect(f.store.readRunDocumentInboxInput({ ...request(f.manifest, f.result), inputId: 'absent' })).rejects.toThrow('store_unhealthy');
  });
});
