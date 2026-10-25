import { auditStoredProjectionState as auditDocumentMigration } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicProjectionCommit, assertPublicRunDocumentCommit, canonicalPublicProjectionJson, messageMetadataOf,
  verifyMessageMetadataWindow, verifyMessageBody, verifyRunDocumentChunkResult, RunDocumentItemAssembler,
  MAX_RUN_DOCUMENT_QUERY_BYTES, type PublicProjectionChange, type PublicProjectionCatalogManifest,
  type PublicProjectionMessageWindow, type PublicMessageMetadataRow } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteRunDocumentPublication } from '../src/adapters/persistence/SqliteRunDocumentPublication.js';
import { RunDocumentPlan, type RunDocumentSource } from '../src/projection/RunDocumentPlan.js';
import { upgradeRunDocumentSchema } from '../src/adapters/persistence/RunDocumentDbSchema.js';
import { projectionDigest } from '../src/adapters/persistence/StoredProjectionRecords.js';
const at = '2032-01-01T00:00:00.000Z', resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const { root, store } of resources.splice(0)) {
  await store.close(); rmSync(root, { recursive: true, force: true });
} });
function create(now?: () => Date) {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-message-metadata-'));
  const store = new SqlitePublicProjectionStore(root, now === undefined ? undefined : { now }); resources.push({ root, store });
  return { store, database: (store as unknown as { database: DatabaseSync }).database };
}
function session(id = 'a'): PublicProjectionChange {
  return { feature: 'sessions', aggregateId: `session-${id}`, aggregateVersion: 1, operation: 'upsert', projectedAt: at,
    dto: { sessionId: `session-${id}`, workspaceId: 'workspace-a', version: 1, title: '模拟消息', status: 'active', pinned: false, createdAt: at, updatedAt: at } };
}
function ordinary(version: number, changes: PublicProjectionChange[], sourceId = 'message-fixture') {
  return assertPublicProjectionCommit({ contractVersion: '5.0', sourceId, sourceCursor: version, eventId: `${sourceId}-${version}`, occurredAt: at, changes });
}
function message(id: string, version = 1, owner = 'a', role: 'user' | 'assistant' | 'system' = 'user'): PublicProjectionChange {
  return { feature: 'messages', aggregateId: id, aggregateVersion: version, operation: 'upsert', projectedAt: at,
    dto: { messageId: id, sessionId: `session-${owner}`, version, role, content: `BODY_MESSAGE_${version}`, status: 'completed', createdAt: at, updatedAt: at } };
}
function source(count = 140, version = 1, runId = 'run-doc', owner = 'a', large = true): RunDocumentSource {
  return { summary: { runId, sessionId: `session-${owner}`, version, title: '模拟窗口', label: '模拟窗口', status: 'running', updatedAt: at,
    toolActivityCount: 0, queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: count }, toolActivities: [], inbox: [],
    interactionMessages: Array.from({ length: count }, (_, index) => ({ messageId: `${runId}-${String(index).padStart(3, '0')}`,
      sessionId: `session-${owner}`, runId, version, role: 'assistant', content: index === 0 && large ? 'BODY_BIG🙂'.repeat(90_000) : `BODY_DOCUMENT_${version}`,
      status: 'completed', createdAt: at, updatedAt: at })) };
}
function documentCommit(plan: RunDocumentPlan) {
  const { runId, version } = plan.header.summary;
  return assertPublicRunDocumentCommit({ contractVersion: '6.0', sourceId: `${runId}-source`, sourceCursor: version, eventId: `${runId}-event-${version}`,
    occurredAt: at, changes: [{ feature: 'runs', aggregateId: runId, aggregateVersion: version, operation: 'upsert', projectedAt: at, dto: plan.header }] });
}
async function begin(store: SqlitePublicProjectionStore, owner = 'a'): Promise<PublicProjectionCatalogManifest> {
  const result = await store.beginCatalogSnapshot({ pageContractVersion: '3.0', feature: 'runs', filter: 'all',
    scope: { kind: 'session', sessionId: `session-${owner}`, workspaceId: 'workspace-a' } });
  if ('status' in result) throw new Error(`fixture_manifest:${result.reason}`); return result;
}
async function window(store: SqlitePublicProjectionStore, manifest: PublicProjectionCatalogManifest, descriptor: PublicProjectionMessageWindow = { kind: 'latest', limit: 128 }) {
  const request = { queryContractVersion: '1.0', manifest, window: descriptor };
  const result = await verifyMessageMetadataWindow(request, await store.readMessageMetadataWindow(request));
  if (result.status !== 'ok') throw new Error(`fixture_window:${result.status}`); return result;
}
async function fixture(count = 140, now?: () => Date) {
  const f = create(now); await f.store.append(ordinary(1, [session(), session('b'), message('message-head')])); upgradeRunDocumentSchema(f.database, auditDocumentMigration);
  const writer = new SqliteRunDocumentPublication(f.database, f.store.streamId, appendDocumentLedger), plan = new RunDocumentPlan(source(count));
  await writer.publish(documentCommit(plan), plan); return { ...f, writer, plan, manifest: await begin(f.store) };
}
describe('body-free merged message windows at the same Catalog C', () => {
  it('pages 140 interactions with exact anchors, reads no BLOBs, then restores one oversized body explicitly', async () => {
    const f = await fixture(), statements: string[] = [], prepare = f.database.prepare.bind(f.database);
    vi.spyOn(f.database, 'prepare').mockImplementation(sql => { statements.push(sql); return prepare(sql); });
    const latest = await window(f.store, f.manifest);
    expect(latest.rows).toHaveLength(128); expect(latest.hasEarlier).toBe(true); expect(latest.hasLater).toBe(false);
    expect(messageMetadataOf(latest.rows[0]!).messageId).toBe('run-doc-012');
    const earlier = await window(f.store, f.manifest, { kind: 'before', anchorMessageId: 'run-doc-012', limit: 128 });
    expect(earlier.rows).toHaveLength(13); expect(earlier.hasEarlier).toBe(false); expect(earlier.hasLater).toBe(true);
    expect(earlier.rows[0]?.kind).toBe('message');
    expect(JSON.stringify({ latest, earlier })).not.toMatch(/BODY_|contentBase64/u);
    expect(statements.some(sql => /SELECT[^;]*chunk_bytes/iu.test(sql))).toBe(false);
    const chosen = earlier.rows.find(row => messageMetadataOf(row).messageId === 'run-doc-000')!;
    if (chosen.kind !== 'run_document') throw new Error('fixture_document');
    const assembler = new RunDocumentItemAssembler(chosen.header, 'interactionMessages', chosen.proof.descriptor.itemOrdinal);
    let restored = null;
    for (let chunkOrdinal = 0; chunkOrdinal < chosen.proof.descriptor.chunkCount; chunkOrdinal++) {
      const request = { queryContractVersion: '1.0', manifest: f.manifest, document: chosen.document, collection: 'interactionMessages' as const,
        itemOrdinal: chosen.proof.descriptor.itemOrdinal, chunkOrdinal };
      const chunk = await verifyRunDocumentChunkResult(request, await f.store.readRunDocumentChunk(request));
      if (chunk.status !== 'ok') throw new Error('fixture_chunk'); restored = await assembler.accept(chunk.leaf);
    }
    expect(restored?.value).toMatchObject({ content: source().interactionMessages[0]!.content });
    const standalone = earlier.rows[0]!; if (standalone.kind !== 'message') throw new Error('fixture_standalone');
    const bodyRequest = { queryContractVersion: '1.0', manifest: f.manifest, body: standalone.body };
    expect(await verifyMessageBody(bodyRequest, await f.store.readMessageBody(bodyRequest))).toMatchObject({ status: 'ok', message: { content: 'BODY_MESSAGE_1' } });
    expect(Buffer.byteLength(canonicalPublicProjectionJson(latest))).toBeLessThanOrEqual(MAX_RUN_DOCUMENT_QUERY_BYTES);
    const old = await f.store.beginViewSnapshot({ pageContractVersion: '2.0', scope: f.manifest.scope, features: ['inference_streams'] });
    if ('status' in old) throw new Error('fixture_view');
    expect(await f.store.readMessageWindow({ manifest: old, window: { kind: 'latest', limit: 128 } }))
      .toMatchObject({ status: 'reset_required', reason: 'contract_mismatch' });
    await expect(f.store.readModelProjectionHeads()).resolves.toEqual([]);
  });
  it('preserves old C for both sources after later Run/Message updates and tombstones', async () => {
    const f = await fixture(2), captured = await window(f.store, f.manifest);
    const standalone = captured.rows.find(row => row.kind === 'message')!;
    if (standalone.kind !== 'message') throw new Error('fixture_body');
    const next = new RunDocumentPlan(source(3, 2)); await f.writer.publish(documentCommit(next), next);
    await f.store.append(ordinary(2, [message('message-head', 2)]));
    expect(await window(f.store, f.manifest)).toEqual(captured);
    const fresh = await window(f.store, await begin(f.store));
    expect(fresh.rows.map(row => messageMetadataOf(row).version)).toEqual([2, 2, 2, 2]);
    const request = { queryContractVersion: '1.0', manifest: f.manifest, body: standalone.body };
    expect(await verifyMessageBody(request, await f.store.readMessageBody(request))).toMatchObject({ message: { version: 1, content: 'BODY_MESSAGE_1' } });
    await f.store.append(ordinary(3, [{ feature: 'messages', aggregateId: 'message-head', aggregateVersion: 3, operation: 'delete', projectedAt: at, dto: null }]));
    expect(await window(f.store, f.manifest)).toEqual(captured);
    expect((await window(f.store, await begin(f.store))).rows).toHaveLength(3);
  });
  it('gives independent Message authority precedence even over newer interactions, including tombstones and foreign owners', async () => {
    const f = await fixture(1), old = await window(f.store, f.manifest);
    await f.store.append(ordinary(2, [message('run-doc-000')]));
    const next = new RunDocumentPlan(source(1, 2)); await f.writer.publish(documentCommit(next), next);
    const authority = await window(f.store, await begin(f.store));
    expect(authority.rows.find(row => messageMetadataOf(row).messageId === 'run-doc-000')).toMatchObject({ kind: 'message', metadata: { version: 1 } });
    await f.store.append(ordinary(3, [message('run-doc-000', 2, 'b')]));
    expect((await window(f.store, await begin(f.store))).rows.map(row => messageMetadataOf(row).messageId)).toEqual(['message-head']);
    expect((await window(f.store, await begin(f.store, 'b'))).rows).toMatchObject([{ kind: 'message', metadata: { messageId: 'run-doc-000', sessionId: 'session-b' } }]);
    await f.store.append(ordinary(4, [{ feature: 'messages', aggregateId: 'run-doc-000', aggregateVersion: 3, operation: 'delete', projectedAt: at, dto: null }]));
    const manifest = await begin(f.store);
    expect(await f.store.readMessageMetadataWindow({ queryContractVersion: '1.0', manifest, window: { kind: 'around', anchorMessageId: 'run-doc-000', limit: 1 } }))
      .toMatchObject({ status: 'anchor_unavailable' });
    expect(await window(f.store, f.manifest)).toEqual(old);
  });
  it('shares time/role/ID order and proves before/around boundaries without inventing absent anchors', async () => {
    const f = create(); await f.store.append(ordinary(1, [session(), session('b'), message('message-Z'), message('message-a'),
      message('message-A', 1, 'a', 'assistant'), message('message-0', 1, 'a', 'system'), message('foreign', 1, 'b')]));
    const manifest = await begin(f.store);
    expect((await window(f.store, manifest)).rows.map(row => messageMetadataOf(row).messageId)).toEqual(['message-Z', 'message-a', 'message-A', 'message-0']);
    const around = await window(f.store, manifest, { kind: 'around', anchorMessageId: 'message-A', limit: 3 });
    expect(around.rows.map(row => messageMetadataOf(row).messageId)).toEqual(['message-a', 'message-A', 'message-0']);
    expect(around.hasEarlier).toBe(true); expect(around.hasLater).toBe(false);
    expect(await window(f.store, manifest, { kind: 'before', anchorMessageId: 'message-Z', limit: 3 }))
      .toMatchObject({ rows: [], hasEarlier: false, hasLater: true });
    for (const anchorMessageId of ['absent', 'foreign']) {
      const request = { queryContractVersion: '1.0', manifest, window: { kind: 'around' as const, anchorMessageId, limit: 3 } };
      expect(await verifyMessageMetadataWindow(request, await f.store.readMessageMetadataWindow(request))).toMatchObject({ status: 'anchor_unavailable' });
    }
    expect(f.database.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
  });
  it('rejects proof/body drift even with a rehashed envelope and rejects crossed body references', async () => {
    const f = await fixture(1), captured = await window(f.store, f.manifest), bad = structuredClone(captured);
    const document = bad.rows.find(row => row.kind === 'run_document')!;
    if (document.kind !== 'run_document' || document.proof.metadata.collection !== 'interactionMessages') throw new Error('fixture_document');
    document.proof.metadata.value.version++;
    const { windowDigest: _digest, ...payload } = bad; bad.windowDigest = projectionDigest(canonicalPublicProjectionJson(payload));
    await expect(verifyMessageMetadataWindow({ queryContractVersion: '1.0', manifest: f.manifest, window: captured.window }, bad)).rejects.toThrow('metadata_digest_mismatch');
    const standalone = captured.rows.find(row => row.kind === 'message')!; if (standalone.kind !== 'message') throw new Error('fixture_body');
    const request = { queryContractVersion: '1.0', manifest: f.manifest, body: standalone.body }, body = await f.store.readMessageBody(request);
    if (body.status !== 'ok') throw new Error('fixture_body');
    const altered = { ...body, message: { ...body.message, content: 'CHANGED_BODY' } };
    const { bodyDigest: _bodyDigest, ...bodyPayload } = altered; altered.bodyDigest = projectionDigest(canonicalPublicProjectionJson(bodyPayload));
    await expect(verifyMessageBody(request, altered)).rejects.toThrow('payload_digest_mismatch');
    for (const changed of [{ ...request, manifest: await begin(f.store) }, { ...request, manifest: await begin(f.store, 'b') },
      { ...request, body: { ...request.body, messageVersion: 2 } }, { ...request, body: { ...request.body, bodyCursor: 'tampered.signature' } }]) {
      expect(await f.store.readMessageBody(changed)).toMatchObject({ status: 'reset_required', reason: 'page_cursor_invalid' });
    }
  });
  it('rejects expired/altered manifests and foreign body-only writes even for empty windows', async () => {
    let clock = Date.parse(at); const f = await fixture(1, () => new Date(clock));
    const captured = await window(f.store, f.manifest), standalone = captured.rows.find(row => row.kind === 'message')!;
    if (standalone.kind !== 'message') throw new Error('fixture_body');
    expect(await f.store.readMessageMetadataWindow({ queryContractVersion: '2.0', manifest: f.manifest, window: { kind: 'latest', limit: 1 } }))
      .toMatchObject({ status: 'reset_required', reason: 'contract_mismatch' });
    const input = { queryContractVersion: '1.0', manifest: f.manifest, window: { kind: 'latest', limit: 1 } };
    expect(await f.store.readMessageMetadataWindow({ ...input, manifest: { ...f.manifest, capturedAt: '2031-12-31T23:59:59.000Z' } }))
      .toMatchObject({ status: 'reset_required', reason: 'scope_mismatch' });
    clock += 5 * 60_000;
    expect(await f.store.readMessageMetadataWindow(input)).toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
    expect(await f.store.readMessageBody({ queryContractVersion: '1.0', manifest: f.manifest, body: standalone.body }))
      .toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
    const fresh = await begin(f.store, 'b'), dbPath = (f.store as unknown as { databasePath: string }).databasePath, external = new DatabaseSync(dbPath);
    try { external.exec('UPDATE projection_run_document_leaves SET chunk_bytes=zeroblob(length(chunk_bytes))'); } finally { external.close(); }
    await expect(f.store.readMessageMetadataWindow({ ...input, manifest: fresh })).rejects.toThrow('external_write');
    await expect(f.store.readModelProjectionHeads()).rejects.toThrow('store_unhealthy');
  });
  it('derives legacy Run metadata at C without schema/history changes and deduces optional parent Run ownership', async () => {
    const f = create(), value = source(2, 1, 'run-old', 'a', false);
    const { toolActivityCount: _t, queuedInputCount: _q, claimedInputCount: _c, interactionMessageCount: _m, ...metadata } = value.summary;
    await f.store.append(ordinary(1, [session(), { feature: 'runs', aggregateId: 'run-old', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
      dto: { ...metadata, toolActivities: [], inbox: [], interactionMessages: value.interactionMessages.map(({ runId: _id, ...item }) => item) } }]));
    const before = f.database.prepare('SELECT * FROM projection_commits').all(), manifest = await begin(f.store), result = await window(f.store, manifest);
    expect(result.rows).toHaveLength(2); expect(result.rows.every(row => messageMetadataOf(row).runId === 'run-old')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('BODY_DOCUMENT');
    expect(f.database.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
    expect(f.database.prepare('SELECT * FROM projection_run_documents').all()).toEqual([]);
    expect(f.database.prepare('SELECT * FROM projection_run_document_items').all()).toEqual([]);
    expect(f.database.prepare('SELECT * FROM projection_run_document_leaves').all()).toEqual([]);
    expect(f.database.prepare('SELECT * FROM projection_commits').all()).toEqual(before);
    await f.store.close(); const resource = resources.at(-1)!; resource.store = new SqlitePublicProjectionStore(resource.root);
    expect(await resource.store.readMessageMetadataWindow({ queryContractVersion: '1.0', manifest, window: { kind: 'latest', limit: 128 } }))
      .toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
  });
  it('rejects missing declared document metadata instead of reporting an absent anchor', async () => {
    const f = await fixture(1);
    f.database.exec("DELETE FROM projection_run_document_leaves WHERE collection='interactionMessages'; DELETE FROM projection_run_document_items WHERE collection='interactionMessages'");
    await expect(f.store.readMessageMetadataWindow({ queryContractVersion: '1.0', manifest: f.manifest,
      window: { kind: 'around', anchorMessageId: 'run-doc-000', limit: 1 } })).rejects.toThrow('document_coverage_missing');
    await expect(f.store.readModelProjectionHeads()).rejects.toThrow('store_unhealthy');
  });
  it('rejects ambiguous interaction identities across live Run parents', async () => {
    const f = await fixture(1), other = source(1, 1, 'run-other', 'a', false);
    (other.interactionMessages[0] as { messageId: string }).messageId = 'run-doc-000';
    const plan = new RunDocumentPlan(other); await f.writer.publish(documentCommit(plan), plan);
    await expect(f.store.readMessageMetadataWindow({ queryContractVersion: '1.0', manifest: await begin(f.store), window: { kind: 'latest', limit: 128 } }))
      .rejects.toThrow('duplicate_identity');
  });
  it('latches a selected item proof failure as storage corruption rather than an empty window', async () => {
    const f = await fixture(1);
    f.database.exec("DELETE FROM projection_run_document_leaves WHERE collection='interactionMessages' AND chunk_ordinal=0");
    await expect(f.store.readMessageMetadataWindow({ queryContractVersion: '1.0', manifest: f.manifest, window: { kind: 'latest', limit: 1 } }))
      .rejects.toThrow('document_proof_invalid');
    await expect(f.store.readModelProjectionHeads()).rejects.toThrow('store_unhealthy');
  });
});
