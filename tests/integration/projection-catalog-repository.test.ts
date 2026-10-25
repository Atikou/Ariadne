import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, type ProjectionCommit, type PublicProjectionChange,
  type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries.js';
import { ProjectionRuntimeClient } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client.js';
import { ProjectionCatalogRepository, type ProjectionCatalogSelection } from '../../app/src/renderer/src/core/runtime/projection/projection-catalog-repository.js';

const NOW = '2026-10-05T00:00:00.000Z';
const roots: string[] = [];
const stores: SqlitePublicProjectionStore[] = [];
const selection: ProjectionCatalogSelection = { scope: { kind: 'directory' }, feature: 'sessions', filter: 'active' };
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('keeps one immutable visible page and whole-catalog totals while navigating a fixed C during writes', async () => {
  const store = createStore();
  await store.append(commit(1, Array.from({ length: 6 }, (_, index) => session(index))));
  const repository = new ProjectionCatalogRepository(client(command => readAgentProjectionQuery(store, command)), { pageRows: 2 });
  await repository.load(selection);
  const first = repository.read(selection)!;
  expect(first.page).toMatchObject({ pageIndex: 0, totalRows: 6, statusCounts: { active: 6 } });
  expect(first.page.rows.map(row => row.dto)).toMatchObject([{ sessionId: 'session-0' }, { sessionId: 'session-1' }]);
  expect(Object.isFrozen(first.page.rows[0]?.dto)).toBe(true);
  await store.append(commit(2, [{ ...session(0), aggregateVersion: 2, dto: { ...sessionDto(0), version: 2, status: 'archived' } }, session(6)]));
  await repository.next(selection);
  expect(repository.read(selection)?.page).toMatchObject({ pageIndex: 1, totalRows: 6, manifest: { boundaryCursor: 1 } });
  expect(repository.usage()).toMatchObject({ entries: 1, rows: 2, bytes: repository.read(selection)!.bytes, inFlight: 0 });
  await repository.next(selection);
  expect(repository.read(selection)?.page).toMatchObject({ pageIndex: 2, hasMore: false, totalRows: 6 });
  const last = repository.read(selection);
  await repository.next(selection);
  expect(repository.read(selection)).toBe(last);
  await repository.previous(selection);
  expect(repository.read(selection)?.page).toMatchObject({ pageIndex: 1, totalRows: 6 });
  await repository.previous(selection);
  expect(repository.read(selection)?.page.rows).toEqual(first.page.rows);
  await repository.load(selection);
  expect(repository.read(selection)?.page).toMatchObject({ manifest: { boundaryCursor: 2 }, totalRows: 6 });
  expect(repository.read(selection)?.page.rows[0]?.dto).toMatchObject({ sessionId: 'session-1' });
});

it('retries a failed prospective page without poisoning the accepted page chain', async () => {
  const store = createStore();
  await store.append(commit(1, Array.from({ length: 4 }, (_, index) => session(index))));
  let corrupt = false, expire = false;
  const repository = new ProjectionCatalogRepository(client(async command => {
    const result = await readAgentProjectionQuery(store, command);
    if (result.kind === 'projection.catalog.page_result' && result.page.status === 'ok' && result.page.pageIndex === 1) {
      if (expire) return { kind: result.kind, page: { status: 'reset_required', streamId: store.streamId, reason: 'snapshot_expired' } };
      if (corrupt) return { ...result, page: { ...result.page, pageDigest: `sha256:${'0'.repeat(64)}` } };
    }
    return result;
  }), { pageRows: 2 });
  await repository.load(selection);
  const trusted = repository.read(selection), usage = repository.usage();
  corrupt = true;
  await expect(repository.next(selection)).rejects.toThrow('projection_catalog_page_digest_mismatch');
  expect(repository.read(selection)).toBe(trusted);
  expect(repository.usage()).toEqual(usage);
  corrupt = false; expire = true;
  await expect(repository.next(selection)).rejects.toThrow('snapshot_expired');
  expect(repository.read(selection)).toBe(trusted);
  expire = false;
  await repository.next(selection);
  expect(repository.read(selection)?.page.pageIndex).toBe(1);
});

it('pins a selected catalog, evicts other windows by LRU and rolls back when pinned capacity cannot fit', async () => {
  const store = createStore();
  await store.append(commit(1, [session(0), session(1)]));
  const second: ProjectionCatalogSelection = { ...selection, scope: { kind: 'directory', workspaceId: 'workspace-1' } };
  const third: ProjectionCatalogSelection = { ...selection, filter: 'all' };
  const repository = new ProjectionCatalogRepository(client(command => readAgentProjectionQuery(store, command)), { maxEntries: 2 });
  repository.select(selection); await repository.load(selection);
  const selected = repository.selected();
  await repository.load(second); await repository.load(third);
  expect(repository.read(second)).toBeNull();
  expect(repository.selected()).toBe(selected);
  expect(repository.usage()).toMatchObject({ entries: 2, rows: 4 });
  const tight = new ProjectionCatalogRepository(client(command => readAgentProjectionQuery(store, command)), {
    maxBytes: selected!.bytes + 1, maxEntryBytes: selected!.bytes + 1
  });
  tight.select(selection); await tight.load(selection);
  const before = tight.selected(), usage = tight.usage();
  await expect(tight.load(third)).rejects.toThrow('pinned_capacity_exceeded');
  expect(tight.selected()).toBe(before);
  expect(tight.usage()).toEqual(usage);
});

it('coalesces navigation and discards a late page after a new boundary replaces the catalog', async () => {
  const store = createStore(); await store.append(commit(1, [session(0), session(1)]));
  const gate = deferred(), received = deferred();
  let pages = 0;
  const repository = new ProjectionCatalogRepository(client(async command => {
    const result = await readAgentProjectionQuery(store, command);
    if (result.kind === 'projection.catalog.page_result' && result.page.status === 'ok' && result.page.pageIndex === 1) {
      pages += 1; received.resolve(); await gate.promise;
    }
    return result;
  }), { pageRows: 1 });
  await repository.load(selection);
  const old = repository.next(selection);
  expect(repository.next(selection)).toBe(old);
  await received.promise;
  await store.append(commit(2, [session(2)]));
  await repository.load(selection);
  const newest = repository.read(selection);
  gate.resolve();
  expect(await old).toEqual({ status: 'superseded' });
  expect(pages).toBe(1);
  expect(repository.read(selection)).toBe(newest);
  expect(newest?.page).toMatchObject({ pageIndex: 0, manifest: { boundaryCursor: 2 }, totalRows: 3 });
});

it('bounds physical in-flight allocations even after invalidation and protects captured selection inputs', async () => {
  const store = createStore(); await store.append(commit(1, [session(0)]));
  const gate = deferred(), received = deferred();
  let begins = 0;
  const repository = new ProjectionCatalogRepository(client(async command => {
    if (command.kind === 'projection.catalog.begin') { begins += 1; received.resolve(); await gate.promise; }
    return readAgentProjectionQuery(store, command);
  }), { maxRequests: 2 });
  const mutable = { scope: { kind: 'directory' as const, workspaceId: 'workspace-1' }, feature: 'sessions' as const, filter: 'active' as const };
  const old = repository.load(mutable); await received.promise;
  mutable.scope.workspaceId = 'foreign-workspace';
  const newest = repository.load(selection);
  await expect(repository.load(selection)).rejects.toThrow('request_capacity_exceeded');
  repository.invalidate();
  expect(repository.usage().inFlight).toBe(2);
  gate.resolve();
  expect(await Promise.all([old, newest])).toEqual([{ status: 'superseded' }, { status: 'superseded' }]);
  expect(begins).toBe(2);
  expect(repository.usage()).toEqual({ entries: 0, rows: 0, bytes: 0, inFlight: 0 });
  await repository.load(selection);
  expect(repository.read(selection)?.page.totalRows).toBe(1);
});

it('advances independent catalog watermarks through unrelated commits without materializing updated bodies', async () => {
  const store = createStore(); await store.append(commit(1, [session(0)]));
  const repository = new ProjectionCatalogRepository(client(command => readAgentProjectionQuery(store, command)));
  const empty: ProjectionCatalogSelection = { ...selection, scope: { kind: 'directory', workspaceId: 'foreign' } };
  await repository.load(selection); await repository.load(empty);
  const before = repository.read(selection), bytes = repository.usage().bytes;
  await store.append(commit(2, [{ feature: 'messages', aggregateId: 'message-0', aggregateVersion: 1,
    operation: 'upsert', projectedAt: NOW, dto: { messageId: 'message-0', sessionId: 'session-0', version: 1, role: 'assistant',
      status: 'completed', content: 'unrelated body must not enter directory cache', createdAt: NOW, updatedAt: NOW } }]));
  expect(await repository.scan(selection)).toMatchObject({ status: 'scanned', cursor: 2, dirty: false });
  expect(repository.watermark(empty)?.cursor).toBe(1);
  await store.append(commit(3, [{ ...session(0), aggregateVersion: 2, dto: { ...sessionDto(0), version: 2, status: 'archived' } }]));
  expect(await repository.scan(selection)).toMatchObject({ status: 'scanned', cursor: 3, dirty: true });
  expect(repository.read(selection)).toBe(before);
  expect(repository.usage().bytes).toBe(bytes);
  expect(await repository.scan(empty)).toMatchObject({ cursor: 3, dirty: false });
  await repository.load(selection);
  expect(repository.read(selection)?.page.totalRows).toBe(0);
  expect(repository.watermark(selection)).toMatchObject({ cursor: 3, dirty: false });
});

it('coalesces scans and rejects late/reset/corrupted scans without changing a trusted watermark', async () => {
  const store = createStore(); await store.append(commit(1, [session(0)]));
  const gate = deferred(), received = deferred();
  let delay = true, corrupt = false, reset = false;
  const repository = new ProjectionCatalogRepository(client(async command => {
    const result = await readAgentProjectionQuery(store, command);
    if (result.kind === 'projection.catalog.batch' && result.batch.status === 'ok') {
      if (reset) return { kind: result.kind, batch: { status: 'reset_required', streamId: store.streamId, reason: 'snapshot_expired' } };
      if (corrupt) return { ...result, batch: { ...result.batch, batchDigest: `sha256:${'0'.repeat(64)}` } };
      if (delay) { delay = false; received.resolve(); await gate.promise; }
    }
    return result;
  }));
  await repository.load(selection);
  const scan = repository.scan(selection);
  expect(repository.scan(selection)).toBe(scan);
  await received.promise;
  await store.append(commit(2, [session(1)]));
  await repository.load(selection);
  const watermark = repository.watermark(selection), before = repository.read(selection);
  gate.resolve(); expect(await scan).toEqual({ status: 'superseded' });
  expect(repository.watermark(selection)).toEqual(watermark);
  corrupt = true;
  await expect(repository.scan(selection)).rejects.toThrow('projection_catalog_batch_digest_mismatch');
  corrupt = false; reset = true;
  await expect(repository.scan(selection)).rejects.toThrow('snapshot_expired');
  expect(repository.watermark(selection)).toEqual(watermark);
  expect(repository.read(selection)).toBe(before);
});

it('requires explicit lifecycle invalidation before accepting another Runtime stream', async () => {
  const first = createStore(), second = createStore();
  await first.append(commit(1, [session(0)])); await second.append(commit(1, [session(0)]));
  let backend = first;
  const repository = new ProjectionCatalogRepository(client(command => readAgentProjectionQuery(backend, command)));
  await repository.load(selection);
  const before = repository.read(selection);
  backend = second;
  await expect(repository.load(selection)).rejects.toThrow('stream_mismatch');
  expect(repository.read(selection)).toBe(before);
  repository.invalidate(); await repository.load(selection);
  expect(repository.read(selection)?.page.manifest.streamId).toBe(second.streamId);
});

function createStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-catalog-cache-'));
  const store = new SqlitePublicProjectionStore(root); roots.push(root); stores.push(store); return store;
}
function client(request: (command: RuntimeCommand) => Promise<RuntimeResult>) {
  return new ProjectionRuntimeClient({ request: async command => ({ ok: true, value: await request(command) }),
    getStatus: async () => { throw new Error('unused_status'); }, onStatus: () => () => undefined, onEvent: () => () => undefined });
}
function sessionDto(index: number) {
  return { sessionId: `session-${index}`, workspaceId: 'workspace-1', version: 1, title: `Session ${index}`,
    pinned: false, status: 'active' as const, createdAt: NOW, updatedAt: NOW };
}
function session(index: number): Extract<PublicProjectionChange, { feature: 'sessions' }> {
  return { feature: 'sessions', aggregateId: `session-${index}`, aggregateVersion: 1, operation: 'upsert', projectedAt: NOW, dto: sessionDto(index) };
}
function commit(cursor: number, changes: PublicProjectionChange[]): ProjectionCommit {
  return { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, eventId: `event-${cursor}`, sourceId: 'source', sourceCursor: cursor, occurredAt: NOW, changes };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
