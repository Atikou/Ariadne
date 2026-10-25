import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, PublicProjectionCatalogPageChain, verifyCatalogBatch,
  PUBLIC_PROJECTION_GENESIS_DIGEST, MAX_PUBLIC_PROJECTION_PAGE_BYTES, canonicalPublicProjectionJson,
  type PublicProjectionCatalogBeginRequest, type PublicProjectionCatalogManifest,
  type PublicProjectionChange, type ProjectionCommit, type PublicRunProjection } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { resolvePublicProjectionDatabasePath } from '../src/adapters/persistence/PublicProjectionDbSchema.js';
import { CATALOG_METADATA_MAX_BYTES, CATALOG_METADATA_MAX_ENTRIES } from '../src/adapters/persistence/SqliteProjectionCatalogMetadataCache.js';

const NOW = '2032-01-01T00:00:00.000Z';
const resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
afterEach(async () => { for (const { root, store } of resources.splice(0)) {
  await store.close(); rmSync(root, { recursive: true, force: true });
} });

it('returns only Run metadata and stable totals across concurrent writes, with explicit scoped detail access', async () => {
  const store = createStore();
  await store.append(commit(1, [session('a'), session('b'), run('A'), run('B', 'b'), run('Z', 'a', 1, 'completed')]));
  const manifest = await begin(store);
  const first = await store.readCatalogPage({ manifest, limit: 1 });
  if (first.status !== 'ok') throw new Error('page_reset');
  expect(first.totalRows).toBe(2);
  expect(first.statusCounts).toEqual({ running: 1, completed: 1 });
  expect(first.rows[0]).toMatchObject({ feature: 'runs', dto: { runId: 'run-A', queuedInputCount: 1, interactionMessageCount: 1 } });
  expect(JSON.stringify(first)).not.toContain('PROTECTED_FIXTURE_BODY');
  expect(Object.keys(first.rows[0]!.dto)).not.toContain('inbox');
  await store.append(commit(2, [run('Z', 'a', 2, 'running'), run('C')]));
  const second = await store.readCatalogPage({ manifest, limit: 1, pageCursor: first.nextPageCursor });
  const chain = new PublicProjectionCatalogPageChain(manifest);
  await chain.accept(first);
  expect((await chain.accept(second)).rows[0]?.dto).toMatchObject({ runId: 'run-Z', status: 'completed', version: 1 });
  expect(second).toMatchObject({ totalRows: 2, statusCounts: first.statusCounts, hasMore: false });
  const detail = await store.readCatalogDetail({ manifest, aggregateId: 'run-A' });
  expect(detail).toMatchObject({ status: 'ok', change: { dto: { inbox: [{ content: 'PROTECTED_FIXTURE_BODY' }] } } });
  expect(await store.readCatalogDetail({ manifest, aggregateId: 'run-B' })).toMatchObject({ status: 'ok', change: null });
  const fresh = await begin(store);
  expect(await store.readCatalogPage({ manifest: fresh, limit: 128 })).toMatchObject({ totalRows: 3, statusCounts: { running: 3 } });
});

it('uses pinned/active/time/binary-ID order and filters Session and Run catalogs without returning tombstones', async () => {
  const store = createStore();
  const pinned = session('z');
  if (pinned.feature !== 'sessions' || pinned.dto === null) throw new Error('session_fixture');
  await store.append(commit(1, [session('a'), { ...pinned, dto: { ...pinned.dto, pinned: true } },
    run('a'), run('A'), run('0', 'a', 1, 'completed')]));
  const directory = await begin(store, { scope: { kind: 'directory' }, feature: 'sessions', filter: 'active' });
  const page = await store.readCatalogPage({ manifest: directory, limit: 128 });
  if (page.status !== 'ok') throw new Error('page_reset');
  expect(page.rows.map(row => 'sessionId' in row.dto ? row.dto.sessionId : '')).toEqual(['session-z', 'session-a']);
  const active = await begin(store, { filter: 'active' });
  const activePage = await store.readCatalogPage({ manifest: active, limit: 128 });
  if (activePage.status !== 'ok') throw new Error('page_reset');
  expect(activePage.rows.map(row => 'runId' in row.dto ? row.dto.runId : '')).toEqual(['run-A', 'run-a']);
});

it('advances through unrelated commits and emits removals when a Run leaves the captured catalog filter', async () => {
  const store = createStore();
  await store.append(commit(1, [session('a'), session('b'), run('A')]));
  const manifest = await begin(store, { filter: 'active' });
  await store.append(commit(2, [run('B', 'b')]));
  await store.append(commit(3, [run('A', 'a', 2, 'completed')]));
  await store.append(commit(4, [{ feature: 'runs', aggregateId: 'run-A', aggregateVersion: 3, operation: 'delete', projectedAt: NOW, dto: null }]));
  const request = { manifest, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit: 128 };
  const batch = await verifyCatalogBatch(request, await store.readCatalogCommits(request));
  if (batch.status !== 'ok') throw new Error('read_reset');
  expect(batch.nextCursor).toBe(4);
  expect(batch.entries.map(entry => entry.changes.length)).toEqual([0, 1, 1]);
  expect(batch.entries[1]?.changes[0]).toMatchObject({ operation: 'remove', aggregateVersion: 2, row: null });
  expect(batch.entries[2]?.changes[0]).toMatchObject({ operation: 'remove', aggregateVersion: 3, row: null });
  expect(JSON.stringify(batch)).not.toContain('PROTECTED_FIXTURE_BODY');
  await expect(verifyCatalogBatch(request, { ...batch, batchDigest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow('batch_digest_mismatch');
  expect(await store.readCatalogCommits({ ...request, afterCursor: 0, afterDigest: `sha256:${'0'.repeat(64)}` }))
    .toMatchObject({ status: 'reset_required', reason: 'boundary_mismatch' });
});

it('paginates user questions without question text or action tokens and observes their settlement through minimal changes', async () => {
  const store = createStore();
  await store.append(commit(1, [session('a')]));
  for (let offset = 0; offset < 130; offset += 50) {
    await store.append(commit(2 + offset / 50, Array.from({ length: Math.min(50, 130 - offset) }, (_, index) => decision(offset + index))));
  }
  const manifest = await begin(store, { scope: { kind: 'decisions', workspaceId: 'workspace-a' }, feature: 'decisions', filter: 'pending' });
  const first = await store.readCatalogPage({ manifest, limit: 128 });
  if (first.status !== 'ok') throw new Error('page_reset');
  expect(first).toMatchObject({ totalRows: 130, statusCounts: { pending: 130 }, hasMore: true });
  expect(JSON.stringify(first)).not.toContain('decision-action');
  expect(JSON.stringify(first)).not.toContain('PRIVATE_QUESTION');
  const second = await store.readCatalogPage({ manifest, limit: 128, pageCursor: first.nextPageCursor });
  const chain = new PublicProjectionCatalogPageChain(manifest);
  await chain.accept(first); await chain.accept(second);
  const original = decision(0);
  if (original.feature !== 'decisions' || original.dto === null) throw new Error('decision_fixture');
  const { action: _action, ...dto } = original.dto;
  await store.append(commit(5, [{ ...original, aggregateVersion: 2, dto: { ...dto, version: 2, status: 'approved', resolvedAt: NOW } }]));
  const batch = await store.readCatalogCommits({ manifest, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit: 128 });
  expect(batch).toMatchObject({ status: 'ok', entries: [{ changes: [{ operation: 'remove', aggregateId: 'decision-000' }] }] });
});

it('rejects cross-generation cursors, altered manifests, replayed pages and expired generation requests', async () => {
  let clock = Date.parse(NOW);
  const store = createStore(() => new Date(clock));
  await store.append(commit(1, [session('a'), run('A'), run('B')]));
  const manifest = await begin(store);
  const first = await store.readCatalogPage({ manifest, limit: 1 });
  if (first.status !== 'ok') throw new Error('page_reset');
  const other = await begin(store);
  expect(await store.readCatalogPage({ manifest: other, limit: 1, pageCursor: first.nextPageCursor }))
    .toMatchObject({ status: 'reset_required', reason: 'page_cursor_invalid' });
  expect(await store.readCatalogPage({ manifest: { ...manifest, filter: 'active' }, limit: 1 }))
    .toMatchObject({ status: 'reset_required', reason: 'scope_mismatch' });
  const chain = new PublicProjectionCatalogPageChain(manifest);
  await chain.accept(first);
  await expect(chain.accept(first)).rejects.toThrow('page_chain_mismatch');
  const second = await store.readCatalogPage({ manifest, limit: 1, pageCursor: first.nextPageCursor });
  if (second.status !== 'ok') throw new Error('page_reset');
  await expect(chain.accept({ ...second, pageDigest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow('page_digest_mismatch');
  clock += 5 * 60_000;
  expect(await store.readCatalogDetail({ manifest, aggregateId: 'run-A' })).toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
});

it('rejects corrupted persisted rows on catalog reads and starts a new generation after reopen', async () => {
  let store = createStore();
  const resource = resources.at(-1)!;
  await store.append(commit(1, [session('a'), run('A')]));
  const manifest = await begin(store);
  await store.close();
  store = new SqlitePublicProjectionStore(resource.root); resource.store = store;
  expect(await store.readCatalogPage({ manifest, limit: 128 })).toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
  const fresh = await begin(store);
  const database = new DatabaseSync(resolvePublicProjectionDatabasePath(resource.root));
  database.prepare("UPDATE projection_versions SET payload_digest=? WHERE aggregate_id='run-A'").run(`sha256:${'f'.repeat(64)}`);
  database.close();
  await expect(store.readCatalogPage({ manifest: fresh, limit: 128 })).rejects.toThrow('row_mismatch');
  await expect(store.beginCatalogSnapshot({ pageContractVersion: '3.0', scope: fresh.scope, feature: fresh.feature, filter: fresh.filter }))
    .rejects.toThrow('public_projection_store_unhealthy');
});

it('serves bounded metadata after writes and restart without rereading historical Run bodies', async () => {
  let store = createStore(); const resource = resources.at(-1)!;
  await store.append(commit(1, [session('a'), run('A'), run('B')]));
  const manifest = await begin(store), before = store.catalogMetadataCacheStats();
  const first = await store.readCatalogPage({ manifest, limit: 1 });
  if (first.status !== 'ok') throw new Error('page_reset');
  await store.append(commit(2, [run('A', 'a', 2, 'completed')]));
  const second = await store.readCatalogPage({ manifest, limit: 1, pageCursor: first.nextPageCursor });
  expect(second).toMatchObject({ totalRows: 2, statusCounts: { running: 2 } });
  expect(store.catalogMetadataCacheStats().misses).toBe(before.misses);
  if (first.rows[0]?.feature !== 'runs') throw new Error('run_summary_required');
  first.rows[0].dto.title = 'mutated_response';
  expect(await store.readCatalogPage({ manifest, limit: 1 })).toMatchObject({ rows: [{ dto: { title: 'Run A' } }] });
  await store.close(); store = new SqlitePublicProjectionStore(resource.root); resource.store = store;
  const fresh = await begin(store), reopened = store.catalogMetadataCacheStats();
  expect(await store.readCatalogPage({ manifest: fresh, limit: 128 })).toMatchObject({ statusCounts: { completed: 1, running: 1 } });
  expect(store.catalogMetadataCacheStats().misses).toBe(reopened.misses);
});

it('does not cache an uncommitted catalog row and retains the old boundary after a retry', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-catalog-rollback-')); let reject = true;
  const store = new SqlitePublicProjectionStore(root, undefined, { beforeCommit: () => { if (reject) throw new Error('fixture_rollback'); } });
  resources.push({ root, store });
  await expect(store.append(commit(1, [session('a'), run('A')]))).rejects.toThrow('fixture_rollback');
  expect(store.catalogMetadataCacheStats().entries).toBe(0);
  const old = await begin(store, { scope: { kind: 'tasks' } });
  expect(await store.readCatalogPage({ manifest: old, limit: 128 })).toMatchObject({ totalRows: 0 });
  reject = false; await store.append(commit(1, [session('a'), run('A')]));
  expect(await store.readCatalogPage({ manifest: old, limit: 128 })).toMatchObject({ totalRows: 0 });
  expect(await store.readCatalogPage({ manifest: await begin(store), limit: 128 })).toMatchObject({ totalRows: 1 });
});

it('fences hot metadata after an external body-only write and never publishes a stale healthy page', async () => {
  const store = createStore(), root = resources.at(-1)!.root;
  await store.append(commit(1, [session('a'), run('A')]));
  const manifest = await begin(store);
  await store.readCatalogPage({ manifest, limit: 128 });
  const database = new DatabaseSync(resolvePublicProjectionDatabasePath(root));
  try { database.exec("UPDATE projection_versions SET dto_json=json_set(dto_json, '$.interactionMessages[0].content', 'body-drift') WHERE feature='runs'"); }
  finally { database.close(); }
  await expect(store.readCatalogPage({ manifest, limit: 128 })).rejects.toThrow('external_write:row_mismatch');
  await expect(store.readCatalogDetail({ manifest, aggregateId: 'run-A' })).rejects.toThrow('public_projection_store_unhealthy');
});

it.each([false, true])('evicts catalog metadata under both count and byte limits (wide identities: %s)', async wide => {
  const store = createStore(), count = wide ? 2200 : 4300, prefix = wide ? 'x'.repeat(195) : '';
  for (let offset = 0; offset < count; offset += 200) {
    const changes = Array.from({ length: Math.min(200, count - offset) }, (_, index) => {
      const change = session(`${prefix}${String(offset + index).padStart(5, '0')}`);
      if (change.feature !== 'sessions' || change.dto === null) throw new Error('session_fixture');
      return wide ? { ...change, dto: { ...change.dto, title: '界'.repeat(256) } } : change;
    });
    await store.append(commit(1 + offset / 200, changes));
  }
  const usage = store.catalogMetadataCacheStats();
  expect(usage.entries).toBeLessThanOrEqual(CATALOG_METADATA_MAX_ENTRIES);
  expect(usage.bytes).toBeLessThanOrEqual(CATALOG_METADATA_MAX_BYTES);
  expect(usage.evictions).toBeGreaterThan(0);
  const manifest = await begin(store, { scope: { kind: 'directory' }, feature: 'sessions' });
  expect(await store.readCatalogPage({ manifest, limit: 128 })).toMatchObject({ totalRows: count, hasMore: true });
  expect(store.catalogMetadataCacheStats().bytes).toBeLessThanOrEqual(CATALOG_METADATA_MAX_BYTES);
}, 15000);

it('truncates catalog scans at their own byte boundary and continues from the last returned global cursor', async () => {
  const store = createStore();
  const manifest = await begin(store, { scope: { kind: 'directory' }, feature: 'sessions', filter: 'all' });
  const largeSession = (index: number): PublicProjectionChange => {
    const id = `session-${index}`.padEnd(256, 'x');
    return { feature: 'sessions', operation: 'upsert', aggregateId: id, aggregateVersion: 1, projectedAt: NOW,
      dto: { sessionId: id, workspaceId: 'workspace'.padEnd(256, 'x'), version: 1, title: '字'.repeat(512),
        pinned: false, status: 'active', createdAt: NOW, updatedAt: NOW } };
  };
  for (let offset = 0; offset < 768; offset += 256) {
    await store.append(commit(1 + offset / 256, Array.from({ length: 256 }, (_, index) => largeSession(offset + index))));
  }
  const scopeRequest = { readContractVersion: '1.0', streamId: manifest.streamId, scope: manifest.scope,
    afterCursor: 0, afterDigest: PUBLIC_PROJECTION_GENESIS_DIGEST, limit: 128 };
  const base = await store.readScope(scopeRequest);
  if (base.status !== 'ok' || base.hasMore) throw new Error('byte_fixture_initial_scan_incomplete');
  const changes: PublicProjectionChange[] = [];
  for (let index = 0; index < 256; index += 1) {
    changes.push(largeSession(768 + index));
    const candidate = { ...base, nextCursor: 4, nextDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
      entries: [...base.entries, { ...base.entries[0]!, cursor: 4, sourceCursor: 4, eventId: 'event-4', changes }] };
    if (Buffer.byteLength(canonicalPublicProjectionJson(candidate)) > MAX_PUBLIC_PROJECTION_PAGE_BYTES - 4096) { changes.pop(); break; }
  }
  expect(changes.length).toBeGreaterThan(0);
  await store.append(commit(4, changes));
  expect(await store.readScope(scopeRequest)).toMatchObject({ status: 'ok', nextCursor: 4, hasMore: false });
  const request = { manifest, afterCursor: 0, afterDigest: PUBLIC_PROJECTION_GENESIS_DIGEST, limit: 128 };
  const first = await verifyCatalogBatch(request, await store.readCatalogCommits(request));
  expect(first).toMatchObject({ status: 'ok', nextCursor: 3, hasMore: true });
  if (first.status !== 'ok') throw new Error('byte_fixture_catalog_reset');
  expect(Buffer.byteLength(canonicalPublicProjectionJson(first))).toBeLessThanOrEqual(MAX_PUBLIC_PROJECTION_PAGE_BYTES);
  const nextRequest = { ...request, afterCursor: first.nextCursor, afterDigest: first.nextDigest };
  expect(await verifyCatalogBatch(nextRequest, await store.readCatalogCommits(nextRequest)))
    .toMatchObject({ status: 'ok', nextCursor: 4, hasMore: false, entries: [{ cursor: 4 }] });
});

function createStore(now?: () => Date) {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-catalog-'));
  const store = new SqlitePublicProjectionStore(root, now === undefined ? undefined : { now });
  resources.push({ root, store }); return store;
}
async function begin(store: SqlitePublicProjectionStore, options: Partial<PublicProjectionCatalogBeginRequest> = {}): Promise<PublicProjectionCatalogManifest> {
  const result = await store.beginCatalogSnapshot({ pageContractVersion: '3.0', scope: { kind: 'tasks', workspaceId: 'workspace-a' },
    feature: 'runs', filter: 'all', ...options });
  if ('status' in result) throw new Error(`begin_reset:${result.reason}`);
  return result;
}
function commit(sourceCursor: number, changes: PublicProjectionChange[]): ProjectionCommit {
  return { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, eventId: `event-${sourceCursor}`, sourceId: 'source', sourceCursor, occurredAt: NOW, changes };
}
function session(owner: string): PublicProjectionChange {
  return { feature: 'sessions', operation: 'upsert', aggregateId: `session-${owner}`, aggregateVersion: 1, projectedAt: NOW,
    dto: { sessionId: `session-${owner}`, workspaceId: `workspace-${owner}`, version: 1, title: `Session ${owner}`, status: 'active', pinned: false, createdAt: NOW, updatedAt: NOW } };
}
function run(id: string, owner = 'a', version = 1, status: PublicRunProjection['status'] = 'running'): PublicProjectionChange {
  return { feature: 'runs', operation: 'upsert', aggregateId: `run-${id}`, aggregateVersion: version, projectedAt: NOW,
    dto: { runId: `run-${id}`, sessionId: `session-${owner}`, version, title: `Run ${id}`, status, label: 'Working',
      toolActivities: [], inbox: [{ inputId: `input-${id}`, messageId: `input-message-${id}`, version: 1, delivery: 'next_turn',
        content: 'PROTECTED_FIXTURE_BODY', state: 'queued', queuedAt: NOW, updatedAt: NOW }],
      interactionMessages: [{ messageId: `message-${id}`, sessionId: `session-${owner}`, version: 1, role: 'assistant',
        content: 'PROTECTED_FIXTURE_BODY'.repeat(200), status: 'completed', createdAt: NOW, updatedAt: NOW }], updatedAt: NOW } };
}
function decision(index: number): PublicProjectionChange {
  const id = `decision-${String(index).padStart(3, '0')}`;
  return { feature: 'decisions', operation: 'upsert', aggregateId: id, aggregateVersion: 1, projectedAt: NOW,
    dto: { decisionId: id, sessionId: 'session-a', runId: 'run-A', version: 1, kind: 'user_question', status: 'pending', requestedAt: NOW,
      presentation: { contractVersion: '1.0', kind: 'user_question', headline: `Question ${index}`, question: 'PRIVATE_QUESTION'.repeat(500), allowsFreeText: true },
      action: { contractVersion: '1.0', actionToken: `decision-action.v1:${'a'.repeat(64)}`, choices: ['answer'] } } };
}
