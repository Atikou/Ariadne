import { auditStoredProjectionState as auditDocumentMigration } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, type ProjectionCommit, type PublicProjectionChange,
  type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries.js';
import { ProjectionRuntimeClient } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client.js';
import { ProjectionScopeRepository } from '../../app/src/renderer/src/core/runtime/projection/projection-scope-repository.js';
import { DatabaseSync } from 'node:sqlite';
import { RunDocumentPlan } from '../../runtime/src/projection/RunDocumentPlan.js';
import { SqliteRunDocumentPublication } from '../../runtime/src/adapters/persistence/SqliteRunDocumentPublication.js';
import { upgradeRunDocumentSchema } from '../../runtime/src/adapters/persistence/RunDocumentDbSchema.js';
import { model, upsertChange } from '../../app/tests/projection-v3-fixture.js';
import { RendererProjectionRepository } from '../../app/src/renderer/src/core/runtime/projection/renderer-projection-repository.js';

const NOW = '2026-10-05T00:00:00.000Z';
const roots: string[] = [];
const stores: SqlitePublicProjectionStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('bounds Session bodies by LRU and pins the selected view while keeping independent fixed boundaries', async () => {
  const store = createStore();
  await store.append(commit(1, [1, 2, 3].flatMap(index => session(index))));
  const repository = new ProjectionScopeRepository(client(command => readAgentProjectionQuery(store, command)), {
    maxSessionEntries: 2
  });
  repository.select(scope(1), ['runs']);
  await repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  const selected = repository.selected();
  expect(selected?.changes).toHaveLength(1);
  await repository.load(scope(2), ['runs'], { kind: 'latest', limit: 1 });
  await store.append(commit(2, [{ ...session(3)[1]!, aggregateVersion: 2,
    dto: { ...message(3), version: 2, content: 'updated third session' } }] as PublicProjectionChange[]));
  await repository.load(scope(3), ['runs'], { kind: 'latest', limit: 1 });
  expect(repository.read(scope(2), ['runs'])).toBeNull();
  expect(repository.selected()).toBe(selected);
  expect(repository.selected()?.manifest.boundaryCursor).toBe(1);
  expect(repository.read(scope(3), ['runs'])?.manifest.boundaryCursor).toBe(2);
  expect(repository.usage()).toMatchObject({ entries: 2, sessions: 2, inFlight: 0 });
  expect(repository.usage().bytes).toBe(selected!.bytes + repository.read(scope(3), ['runs'])!.bytes);
  expect(Object.isFrozen(selected?.changes[0]?.dto)).toBe(true);
});

it('discards late same-scope requests and lifecycle results without publishing or retaining their bodies', async () => {
  const store = createStore();
  await store.append(commit(1, session(1)));
  let release!: () => void;
  let captured!: () => void;
  const received = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let delay = true;
  const repository = new ProjectionScopeRepository(client(async command => {
    const result = await readAgentProjectionQuery(store, command);
    if (command.kind === 'projection.view.begin' && delay) {
      delay = false; captured(); await gate;
    }
    return result;
  }));
  repository.select(scope(1), ['runs']);
  let publications = 0;
  repository.subscribe(() => { publications += 1; });
  const old = repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  await received;
  await store.append(commit(2, [{ ...session(1)[1]!, aggregateVersion: 2,
    dto: { ...message(1), version: 2, content: 'new authoritative value' } }] as PublicProjectionChange[]));
  expect((await repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 })).status).toBe('published');
  release();
  expect(await old).toEqual({ status: 'superseded' });
  expect(publications).toBe(1);
  expect(repository.selected()?.changes[0]?.dto).toMatchObject({ content: 'new authoritative value' });

  let releasePage!: () => void;
  let pageReceived!: () => void;
  const pageReady = new Promise<void>(resolve => { pageReceived = resolve; });
  const pageGate = new Promise<void>(resolve => { releasePage = resolve; });
  const resetting = new ProjectionScopeRepository(client(async command => {
    const result = await readAgentProjectionQuery(store, command);
    if (command.kind === 'projection.view.page') { pageReceived(); await pageGate; }
    return result;
  }));
  const loading = resetting.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  await pageReady;
  resetting.invalidate();
  releasePage();
  expect(await loading).toEqual({ status: 'superseded' });
  expect(resetting.usage()).toEqual({ entries: 0, sessions: 0, bytes: 0, inFlight: 0 });
});

it('preserves a published view when later staging expires or pinned byte capacity is exhausted', async () => {
  const store = createStore();
  await store.append(commit(1, [1, 2].flatMap(index => session(index, 1_500))));
  let fail = false;
  const repository = new ProjectionScopeRepository(client(async command => {
    if (fail && command.kind === 'projection.view.page') return { kind: 'projection.view.page_result',
      page: { status: 'reset_required', streamId: store.streamId, reason: 'snapshot_expired' } };
    return readAgentProjectionQuery(store, command);
  }), { maxBytes: 2_500, maxEntryBytes: 2_400 });
  repository.select(scope(1), ['runs']);
  await repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  const before = repository.selected();
  const usage = repository.usage();
  fail = true;
  await expect(repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 })).rejects.toThrow('snapshot_expired');
  expect(repository.selected()).toBe(before);
  fail = false;
  await expect(repository.load(scope(2), ['runs'], { kind: 'latest', limit: 1 })).rejects.toThrow('pinned_capacity_exceeded');
  expect(repository.selected()).toBe(before);
  expect(repository.usage()).toEqual(usage);
  expect(repository.read(scope(2), ['runs'])).toBeNull();
});

it('requires an explicit lifecycle invalidation before accepting another Runtime stream', async () => {
  const first = createStore();
  const second = createStore();
  await first.append(commit(1, session(1)));
  await second.append(commit(1, session(1)));
  let backend = first;
  const repository = new ProjectionScopeRepository(client(command => readAgentProjectionQuery(backend, command)));
  repository.select(scope(1), ['runs']);
  await repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  const before = repository.selected();
  backend = second;
  await expect(repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 })).rejects.toThrow('stream_mismatch');
  expect(repository.selected()).toBe(before);
  repository.invalidate();
  await repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  expect(repository.selected()?.manifest.streamId).toBe(second.streamId);
});

it('bounds simultaneous staging allocations including superseded requests for the same scope', async () => {
  const store = createStore();
  await store.append(commit(1, session(1)));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const repository = new ProjectionScopeRepository(client(async command => {
    if (command.kind === 'projection.view.begin') { calls += 1; await gate; }
    return readAgentProjectionQuery(store, command);
  }), { maxEntries: 2, maxSessionEntries: 2 });
  const first = repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  const second = repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  await expect(repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 }))
    .rejects.toThrow('request_capacity_exceeded');
  expect(calls).toBe(2);
  repository.invalidate();
  expect(repository.usage().inFlight).toBe(2);
  release();
  expect(await Promise.all([first, second])).toEqual([{ status: 'superseded' }, { status: 'superseded' }]);
  expect(repository.usage()).toEqual({ entries: 0, sessions: 0, bytes: 0, inFlight: 0 });
});

it('advances independent scope watermarks through unrelated commits and replaces dirty views at a new complete boundary', async () => {
  const store = createStore();
  await store.append(commit(1, [1, 2].flatMap(index => session(index))));
  const repository = new ProjectionScopeRepository(client(command => readAgentProjectionQuery(store, command)));
  await repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  await repository.load(scope(2), ['runs'], { kind: 'latest', limit: 1 });
  const first = repository.read(scope(1), ['runs']);
  await store.append(commit(2, [{ ...session(2)[1]!, aggregateVersion: 2,
    dto: { ...message(2), version: 2, content: 'changed second' } }] as PublicProjectionChange[]));
  expect(await repository.scan(scope(1), ['runs'])).toMatchObject({ status: 'scanned', cursor: 2, dirty: false, hasMore: false });
  expect(repository.watermark(scope(2), ['runs'])?.cursor).toBe(1);
  expect(await repository.scan(scope(2), ['runs'])).toMatchObject({ status: 'scanned', cursor: 2, dirty: true });
  expect(repository.read(scope(1), ['runs'])).toBe(first);
  expect(repository.read(scope(2), ['runs'])?.manifest.boundaryCursor).toBe(1);
  await store.append(commit(3, [{ ...session(1)[1]!, aggregateVersion: 2,
    dto: { ...message(1), version: 2, content: 'changed first' } }] as PublicProjectionChange[]));
  const oldBytes = repository.usage().bytes;
  expect(await repository.scan(scope(1), ['runs'])).toMatchObject({ status: 'scanned', cursor: 3, dirty: true });
  expect(repository.read(scope(1), ['runs'])).toBe(first);
  expect(repository.usage().bytes).toBe(oldBytes);
  await repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  expect(repository.watermark(scope(1), ['runs'])).toMatchObject({ cursor: 3, dirty: false });
  expect(repository.read(scope(1), ['runs'])?.changes[0]?.dto).toMatchObject({ content: 'changed first' });
});

it('coalesces scope scans and ignores a late scan after replacement without poisoning the new watermark', async () => {
  const store = createStore();
  await store.append(commit(1, session(1)));
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { received = resolve; });
  let scans = 0;
  const repository = new ProjectionScopeRepository(client(async command => {
    const result = await readAgentProjectionQuery(store, command);
    if (command.kind === 'projection.scope.read') { scans += 1; received(); await gate; }
    return result;
  }));
  await repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  const first = repository.scan(scope(1), ['runs']);
  expect(repository.scan(scope(1), ['runs'])).toBe(first);
  await ready;
  await store.append(commit(2, [{ ...session(1)[1]!, aggregateVersion: 2,
    dto: { ...message(1), version: 2, content: 'changed' } }] as PublicProjectionChange[]));
  await repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  release();
  expect(await first).toEqual({ status: 'superseded' });
  expect(scans).toBe(1);
  expect(repository.watermark(scope(1), ['runs'])).toMatchObject({ cursor: 2, dirty: false });
});

it('keeps the last trusted scope watermark and view when a scan resets or its checksum is corrupted', async () => {
  const first = createStore();
  const second = createStore();
  await first.append(commit(1, session(1)));
  await second.append(commit(1, session(1)));
  let backend = first;
  let corrupt = false;
  const repository = new ProjectionScopeRepository(client(async command => {
    const result = await readAgentProjectionQuery(backend, command);
    return corrupt && result.kind === 'projection.scope.batch' && result.batch.status === 'ok'
      ? { ...result, batch: { ...result.batch, batchDigest: `sha256:${'0'.repeat(64)}` } } : result;
  }));
  await repository.load(scope(1), ['runs'], { kind: 'latest', limit: 1 });
  const before = repository.read(scope(1), ['runs']);
  const watermark = repository.watermark(scope(1), ['runs']);
  backend = second;
  await expect(repository.scan(scope(1), ['runs'])).rejects.toThrow('scoped_read_reset_required:stream_mismatch');
  expect(repository.watermark(scope(1), ['runs'])).toEqual(watermark);
  backend = first; corrupt = true;
  await expect(repository.scan(scope(1), ['runs'])).rejects.toThrow('public_projection_scoped_read_payload_mismatch');
  expect(repository.watermark(scope(1), ['runs'])).toEqual(watermark);
  expect(repository.read(scope(1), ['runs'])).toBe(before);
});

it('uses bounded feature receipts across document commits and reloads only after selected model or diagnostic invalidation', async () => {
  const store = createStore(); await store.append(commit(1, [...session(1), upsertChange('models', model('model-a'), 'model-a')]));
  const commands: RuntimeCommand[] = [], directory = { kind: 'directory' as const }, features = ['diagnostics', 'models'] as const;
  const repository = new ProjectionScopeRepository(client(async command => { commands.push(command); return readAgentProjectionQuery(store, command); }));
  await repository.loadBounded(directory, features); const before = repository.read(directory, features), beforeBytes = repository.usage().bytes;
  const database = (store as unknown as { database: DatabaseSync }).database; upgradeRunDocumentSchema(database, auditDocumentMigration);
  const plan = new RunDocumentPlan({ summary: { runId: 'run-document', sessionId: 'session-1', version: 1, title: '模拟', label: '模拟', status: 'completed',
    updatedAt: NOW, toolActivityCount: 0, queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: 1 }, toolActivities: [], inbox: [],
    interactionMessages: [{ messageId: 'document-message', sessionId: 'session-1', runId: 'run-document', version: 1, role: 'assistant',
      content: 'PRIVATE_DOCUMENT_BODY🙂'.repeat(40_000), status: 'completed', createdAt: NOW, updatedAt: NOW }] });
  await new SqliteRunDocumentPublication(database, store.streamId, appendDocumentLedger).publish({ contractVersion: '6.0', sourceId: 'document-source', sourceCursor: 1,
    eventId: 'document-source-1', occurredAt: NOW, changes: [{ feature: 'runs', aggregateId: 'run-document', aggregateVersion: 1,
      operation: 'upsert', projectedAt: NOW, dto: plan.header }] }, plan);
  expect(await repository.scan(directory, features)).toMatchObject({ status: 'scanned', cursor: 2, dirty: false });
  expect(repository.read(directory, features)).toBe(before); expect(repository.usage().bytes).toBe(beforeBytes);
  await store.append(commit(2, [upsertChange('models', { ...model('model-a', 2), label: 'Changed model' }, 'model-a')]));
  expect(await repository.scan(directory, features)).toMatchObject({ status: 'scanned', cursor: 3, dirty: true });
  expect(repository.read(directory, features)).toBe(before); await repository.loadBounded(directory, features);
  expect(repository.watermark(directory, features)).toMatchObject({ cursor: 3, dirty: false });
  expect(repository.read(directory, features)?.changes).toMatchObject([{ feature: 'models', dto: { label: 'Changed model' } }]);
  expect(commands.some(command => command.kind === 'projection.features.receipts')).toBe(true);
  expect(commands.some(command => command.kind === 'projection.scope.read' || command.kind === 'projection.run_document.chunk')).toBe(false);
});

it('coalesces receipt scans and ignores a stale response after the complete feature window is replaced', async () => {
  const store = createStore(); await store.append(commit(1, [upsertChange('models', model('model-a'), 'model-a')]));
  let received!: () => void, release!: () => void, scans = 0;
  const ready = new Promise<void>(done => { received = done; }), gate = new Promise<void>(done => { release = done; });
  const directory = { kind: 'directory' as const }, features = ['models'] as const;
  const repository = new ProjectionScopeRepository(client(async command => {
    const value = await readAgentProjectionQuery(store, command);
    if (command.kind === 'projection.features.receipts') { scans++; received(); await gate; } return value;
  }));
  await repository.loadBounded(directory, features); const first = repository.scan(directory, features);
  expect(repository.scan(directory, features)).toBe(first); await ready;
  await store.append(commit(2, [upsertChange('models', model('model-a', 2), 'model-a')])); await repository.loadBounded(directory, features);
  release(); expect(await first).toEqual({ status: 'superseded' }); expect(scans).toBe(1);
  expect(repository.watermark(directory, features)).toMatchObject({ cursor: 2, dirty: false });
});

it('retains trusted feature windows and scan boundaries on a bad receipt checksum or expired lease', async () => {
  let now = new Date(NOW); const store = createStore({ now: () => now });
  await store.append(commit(1, [upsertChange('models', model('model-a'), 'model-a')])); let corrupt = false;
  const directory = { kind: 'directory' as const }, features = ['models'] as const;
  const repository = new ProjectionScopeRepository(client(async command => {
    const value = await readAgentProjectionQuery(store, command);
    return corrupt && value.kind === 'projection.features.receipts_result' && value.batch.status === 'ok'
      ? { ...value, batch: { ...value.batch, batchDigest: `sha256:${'0'.repeat(64)}` } } : value;
  }));
  await repository.loadBounded(directory, features); const before = repository.read(directory, features), mark = repository.watermark(directory, features);
  corrupt = true; await expect(repository.scan(directory, features)).rejects.toThrow('projection_feature_receipt_digest_mismatch');
  expect(repository.watermark(directory, features)).toEqual(mark); expect(repository.read(directory, features)).toBe(before);
  corrupt = false; now = new Date(now.getTime() + 300_001);
  await expect(repository.scan(directory, features)).rejects.toThrow('snapshot_reset_required:snapshot_expired');
  expect(repository.watermark(directory, features)).toEqual(mark); expect(repository.read(directory, features)).toBe(before);
  await repository.loadBounded(directory, features); expect(repository.read(directory, features)).not.toBe(before);
});

it('renews an expired bounded feature lease in its own range during normal Renderer synchronization', async () => {
  let now = new Date(NOW); const store = createStore({ now: () => now });
  await store.append(commit(1, [upsertChange('models', model('model-a'), 'model-a')])); const commands: RuntimeCommand[] = [];
  const repository = new RendererProjectionRepository(client(async command => { commands.push(command); return readAgentProjectionQuery(store, command); }));
  await repository.synchronize(null); const previous = repository.getSnapshot();
  now = new Date(now.getTime() + 300_001);
  await store.append(commit(2, [upsertChange('models', { ...model('model-a', 2), label: 'Fresh window' }, 'model-a')]));
  await repository.synchronize(null);
  expect(repository.getSnapshot().models).toMatchObject([{ label: 'Fresh window', version: 2 }]);
  expect(repository.getSnapshot().resetEpoch).toBe(previous.resetEpoch);
  expect(commands.filter(command => command.kind === 'projection.view.begin')).toHaveLength(2);
  expect(commands.some(command => command.kind === 'projection.scope.read')).toBe(false);
});

function createStore(clock?: { now(): Date }) {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-scope-cache-'));
  const store = new SqlitePublicProjectionStore(root, clock);
  roots.push(root); stores.push(store);
  return store;
}
function client(request: (command: RuntimeCommand) => Promise<RuntimeResult>) {
  return new ProjectionRuntimeClient({ request: async command => ({ ok: true, value: await request(command) }),
    getStatus: async () => { throw new Error('unused_status'); }, onStatus: () => () => undefined, onEvent: () => () => undefined });
}
function scope(index: number) {
  return { kind: 'session' as const, workspaceId: 'workspace-1', sessionId: `session-${index}` };
}
function message(index: number, length = 10) {
  return { messageId: `message-${index}`, sessionId: `session-${index}`, version: 1, role: 'assistant' as const,
    content: 'x'.repeat(length), status: 'completed' as const, createdAt: NOW, updatedAt: NOW };
}
function session(index: number, length = 10): PublicProjectionChange[] {
  return [{ feature: 'sessions', aggregateId: `session-${index}`, aggregateVersion: 1, operation: 'upsert', projectedAt: NOW,
    dto: { sessionId: `session-${index}`, workspaceId: 'workspace-1', version: 1, title: `Session ${index}`,
      pinned: false, status: 'active', createdAt: NOW, updatedAt: NOW } },
  { feature: 'messages', aggregateId: `message-${index}`, aggregateVersion: 1, operation: 'upsert', projectedAt: NOW,
    dto: message(index, length) }];
}
function commit(cursor: number, changes: PublicProjectionChange[]): ProjectionCommit {
  return { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, eventId: `event-${cursor}`, sourceId: 'source',
    sourceCursor: cursor, occurredAt: NOW, changes };
}
