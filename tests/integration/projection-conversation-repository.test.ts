import { auditStoredProjectionState as auditDocumentMigration } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { canonicalPublicProjectionJson, messageMetadataOf, type RuntimeCommand, type RuntimeResult,
  type PublicProjectionChange } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteRunDocumentPublication } from '../../runtime/src/adapters/persistence/SqliteRunDocumentPublication.js';
import { upgradeRunDocumentSchema } from '../../runtime/src/adapters/persistence/RunDocumentDbSchema.js';
import { RunDocumentPlan } from '../../runtime/src/projection/RunDocumentPlan.js';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries.js';
import { ProjectionRuntimeClient, ProjectionCatalogResetSignal, ProjectionProtocolIntegrityError } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client.js';
import { ProjectionConversationRepository } from '../../app/src/renderer/src/core/runtime/projection/projection-conversation-repository.js';
const at = '2032-01-01T00:00:00.000Z', later = '2032-01-02T00:00:00.000Z', body = 'BODY🙂'.repeat(150_000);
const scope = (id = 'a') => ({ kind: 'session' as const, workspaceId: 'workspace-a', sessionId: `session-${id}` });
const resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
afterEach(async () => { for (const { root, store } of resources.splice(0)) { await store.close(); rmSync(root, { recursive: true, force: true }); } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  let now = new Date(at), sourceCursor = 0;
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-conversation-repository-')), store = new SqlitePublicProjectionStore(root, { now: () => now });
  resources.push({ root, store });
  const append = (changes: PublicProjectionChange[]) => { sourceCursor++; return store.append({ contractVersion: '5.0', sourceId: 'fixture',
    sourceCursor, eventId: `fixture-${sourceCursor}`, occurredAt: at, changes }); };
  const message = (id: number, version = 1): PublicProjectionChange => ({ feature: 'messages', aggregateId: `message-${id}`, aggregateVersion: version,
    operation: 'upsert', projectedAt: at, dto: { messageId: `message-${id}`, sessionId: 'session-a', version, role: 'user', content: `PRIVATE_MESSAGE_${id}_V${version}`,
      status: 'completed', createdAt: new Date(new Date(at).getTime() + id * 1000).toISOString(), updatedAt: later } });
  const stream = (id: string, status: 'streaming' | 'committed', version = 1, owner = 'a', length = 20): PublicProjectionChange => ({ feature: 'inference_streams', aggregateId: id,
    aggregateVersion: version, operation: 'upsert', projectedAt: at, dto: { inferenceStreamId: id, runId: 'run-a', sessionId: `session-${owner}`,
      turnId: id, attemptId: id, version, status, retainedFromSequence: 1, finalSequence: Math.ceil(length / 32768),
      chunks: Array.from({ length: Math.ceil(length / 32768) }, (_, index) => ({ sequence: index + 1, channel: 'reasoning' as const,
        text: `PREFIX_${id}_V${version}`.padEnd(Math.min(32768, length - index * 32768), 'x'), observedAt: at })), updatedAt: at } });
  await append(['a', 'b', 'c', 'd'].map(id => ({ feature: 'sessions', aggregateId: `session-${id}`, aggregateVersion: 1, operation: 'upsert', projectedAt: at,
    dto: { sessionId: `session-${id}`, workspaceId: 'workspace-a', version: 1, title: '模拟会话', status: 'active', pinned: false, createdAt: at, updatedAt: at } })));
  await append([1, 2, 3, 4, 5].map(id => message(id)));
  await append([stream('active', 'streaming'), stream('committed', 'committed'), stream('foreign', 'streaming', 1, 'b')]);
  const database = (store as unknown as { database: DatabaseSync }).database; upgradeRunDocumentSchema(database, auditDocumentMigration);
  const writer = new SqliteRunDocumentPublication(database, store.streamId, appendDocumentLedger);
  const publish = async (version: number) => {
    const plan = new RunDocumentPlan({ summary: { runId: 'run-a', sessionId: 'session-a', version, title: '模拟文档', label: '模拟文档', status: 'completed', updatedAt: later,
      toolActivityCount: 0, queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: 1 }, toolActivities: [], inbox: [],
      interactionMessages: [{ messageId: 'interaction-a', sessionId: 'session-a', runId: 'run-a', version, role: 'assistant', content: version === 1 ? body : 'NEW_DOCUMENT',
        status: 'completed', createdAt: later, updatedAt: later }] });
    await writer.publish({ contractVersion: '6.0', sourceId: 'document', sourceCursor: version, eventId: `document-${version}`, occurredAt: later,
      changes: [{ feature: 'runs', aggregateId: 'run-a', aggregateVersion: version, operation: 'upsert', projectedAt: later, dto: plan.header }] }, plan);
  };
  await publish(1);
  const commands: RuntimeCommand[] = [];
  let hook: (command: RuntimeCommand, result: RuntimeResult) => Promise<RuntimeResult> = async (_command, result) => result;
  const client = new ProjectionRuntimeClient({ request: async command => { commands.push(command); return { ok: true,
    value: await hook(command, await readAgentProjectionQuery(store, command)) }; }, getStatus: async () => { throw new Error('unused'); },
    onEvent: () => () => undefined, onStatus: () => () => undefined });
  return { store, client, commands, append, message, stream, publish, hook: (next: typeof hook) => { hook = next; }, expire: () => { now = new Date(now.getTime() + 300_001); } };
}
it('publishes only bounded metadata and prefix coverage at one C and loads a complete large body only on request', async () => {
  const f = await fixture(), repository = new ProjectionConversationRepository(f.client); repository.select(scope());
  const result = await repository.load(scope(), { kind: 'latest', limit: 2 });
  if (result.status !== 'published') throw new Error('range_required');
  expect(result.snapshot.messages.rows.map(row => messageMetadataOf(row).messageId)).toEqual(['message-5', 'interaction-a']);
  expect(result.snapshot.messages).toMatchObject({ hasEarlier: true, hasLater: false });
  expect(result.snapshot.inferencePrefixes.map(window => window.changes.map(change => change.aggregateId))).toEqual([['active'], ['active', 'committed']]);
  for (const window of result.snapshot.inferencePrefixes) expect(window.manifest).toEqual(result.snapshot.manifest);
  expect(canonicalPublicProjectionJson(result.snapshot)).not.toMatch(/PRIVATE_MESSAGE|BODY/u);
  expect(repository.bodies.usage().entries).toBe(0); expect(repository.readBody(scope(), 'interaction-a')).toBeNull();
  expect(f.commands.map(command => command.kind)).not.toContain('projection.run_document.chunk');
  expect(f.commands.map(command => command.kind)).not.toContain('projection.view.begin');
  repository.pinBodies(scope(), ['interaction-a']);
  expect(await repository.loadBody(scope(), 'interaction-a')).toMatchObject({ status: 'loaded', body: { kind: 'document_item', item: { value: { content: body } } } });
  expect(f.commands.filter(command => command.kind === 'projection.run_document.chunk')).toHaveLength(5);
  expect(Object.isFrozen(result.snapshot.messages.rows)).toBe(true); expect(repository.usage()).toMatchObject({ entries: 1, inFlight: 0 });
  await expect(repository.loadBody(scope(), 'message-1')).rejects.toThrow('outside_range');
});
it('navigates at old C after newer Message/Run/stream commits while invalidations retain original positions', async () => {
  const f = await fixture(), repository = new ProjectionConversationRepository(f.client);
  const first = await repository.load(scope(), { kind: 'latest', limit: 2 }); if (first.status !== 'published') throw new Error('range_required');
  await f.publish(2); await f.append([f.message(5, 2), f.stream('active', 'committed', 2)]);
  await f.append([{ feature: 'diagnostics', aggregateId: 'info', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
    dto: { diagnosticId: 'info', version: 1, severity: 'info', code: 'TEST', message: 'PRIVATE_UNRELATED', observedAt: at } }]);
  const scan = await repository.scan(scope()); expect(scan).toMatchObject({ status: 'scanned', dirty: true, cursor: first.snapshot.manifest.boundaryCursor + 3 });
  expect(repository.read(scope())).toBe(first.snapshot);
  const around = await repository.navigate(scope(), { kind: 'around', anchorMessageId: 'interaction-a', limit: 2 });
  if (around.status !== 'published') throw new Error('range_required');
  expect(around.snapshot.manifest).toEqual(first.snapshot.manifest);
  expect(messageMetadataOf(around.snapshot.messages.rows.find(row => messageMetadataOf(row).messageId === 'interaction-a')!).version).toBe(1);
  expect(around.snapshot.inferencePrefixes[0]?.changes[0]?.aggregateVersion).toBe(1);
  expect(await repository.loadBody(scope(), 'interaction-a')).toMatchObject({ status: 'loaded', body: { item: { value: { content: body, version: 1 } } } });
  expect(repository.watermark(scope())?.dirty).toBe(false); // scan restarts at the newly published old C; no future receipt is consumed
  expect(await repository.scan(scope())).toMatchObject({ status: 'scanned', dirty: true });
  expect(await repository.navigate(scope(), { kind: 'before', anchorMessageId: 'message-5', limit: 2 })).toMatchObject({ status: 'published', snapshot: {
    messages: { rows: [{ metadata: { messageId: 'message-3' } }, { metadata: { messageId: 'message-4' } }], hasEarlier: true, hasLater: true } } });
});
it('retains the trusted range on missing anchors, invalid prefix proofs and expired leases', async () => {
  const f = await fixture(), repository = new ProjectionConversationRepository(f.client);
  const first = await repository.load(scope()); if (first.status !== 'published') throw new Error('range_required');
  expect(await repository.navigate(scope(), { kind: 'around', anchorMessageId: 'missing', limit: 4 })).toEqual({ status: 'anchor_unavailable' });
  expect(repository.read(scope())).toBe(first.snapshot);
  f.hook(async (command, result) => command.kind === 'projection.conversation.inference_window' && result.kind === 'projection.conversation.inference_window_result' && result.window.status === 'ok'
    ? { ...result, window: { ...result.window, windowDigest: `sha256:${'0'.repeat(64)}` } } : result);
  await expect(repository.load(scope())).rejects.toBeInstanceOf(ProjectionProtocolIntegrityError); expect(repository.read(scope())).toBe(first.snapshot);
  f.hook(async (_command, result) => result); f.expire();
  await expect(repository.scan(scope())).rejects.toBeInstanceOf(ProjectionCatalogResetSignal);
  expect(repository.read(scope())).toBe(first.snapshot); expect(await repository.load(scope())).toMatchObject({ status: 'published' });
});
it('coalesces identical range and scan requests and keeps physical reservations through invalidation', async () => {
  const f = await fixture(), repository = new ProjectionConversationRepository(f.client, { maxRequests: 1 }), started = gate(), release = gate();
  f.hook(async (command, result) => { if (command.kind === 'projection.messages.metadata') { started.resolve(); await release.promise; } return result; });
  const operation = repository.load(scope()); expect(repository.load(scope())).toBe(operation); await started.promise;
  repository.invalidate(); expect(repository.usage()).toMatchObject({ entries: 0, inFlight: 1 });
  expect(() => repository.load(scope())).toThrow('request_capacity_exceeded'); release.resolve(); expect(await operation).toEqual({ status: 'superseded' });
  expect(f.commands.filter(command => command.kind === 'projection.conversation.inference_window')).toHaveLength(0);
  f.hook(async (_command, result) => result); await repository.load(scope());
  const scanStarted = gate(), scanRelease = gate();
  f.hook(async (command, result) => { if (command.kind === 'projection.conversation.receipts') { scanStarted.resolve(); await scanRelease.promise; } return result; });
  const scan = repository.scan(scope()); expect(repository.scan(scope())).toBe(scan); await scanStarted.promise;
  repository.invalidate(); scanRelease.resolve(); expect(await scan).toEqual({ status: 'superseded' });
  expect(repository.usage()).toEqual({ entries: 0, bytes: 0, inFlight: 0, reservedBytes: 0 });
});
it('discards a late body result after navigation without publishing it into the replacement window', async () => {
  const f = await fixture(), repository = new ProjectionConversationRepository(f.client), started = gate(), release = gate();
  await repository.load(scope(), { kind: 'latest', limit: 2 }); let notifications = 0; repository.subscribe(() => { notifications++; });
  f.hook(async (command, result) => { if (command.kind === 'projection.run_document.chunk' && command.request.chunkOrdinal === 4) { started.resolve(); await release.promise; } return result; });
  const operation = repository.loadBody(scope(), 'interaction-a'); await started.promise;
  await repository.navigate(scope(), { kind: 'before', anchorMessageId: 'message-5', limit: 2 }); const published = notifications;
  release.resolve(); expect(await operation).toEqual({ status: 'superseded' }); expect(notifications).toBe(published);
  expect(() => repository.readBody(scope(), 'interaction-a')).toThrow('outside_range');
  expect(repository.bodies.usage()).toMatchObject({ entries: 1, inFlight: 0 }); // immutable old-C item stays bounded and reusable
});
it('bounds cached Session ranges, protects the selection and rejects staging beyond its byte budget', async () => {
  const f = await fixture(), repository = new ProjectionConversationRepository(f.client, { maxEntries: 2 });
  await repository.load(scope()); repository.select(scope()); await repository.load(scope('b')); await repository.load(scope('c'));
  expect(repository.read(scope('b'))).toBeNull(); expect(repository.selected()).not.toBeNull(); expect(repository.usage().entries).toBe(2);
  const tiny = new ProjectionConversationRepository(f.client, { maxEntryBytes: 2000 });
  await expect(tiny.load(scope())).rejects.toThrow('entry_capacity_exceeded'); expect(tiny.usage()).toMatchObject({ entries: 0, bytes: 0, inFlight: 0 });
  expect(() => repository.pinBodies(scope('c'), [])).toThrow('selected_range_required');
});
it('copies caller selectors and prevents late loads from replacing a newer navigation', async () => {
  const f = await fixture(), repository = new ProjectionConversationRepository(f.client, { maxRequests: 2 });
  await repository.load(scope()); const started = gate(), release = gate();
  f.hook(async (command, result) => { if (command.kind === 'projection.messages.metadata' && command.request.window.kind === 'before') { started.resolve(); await release.promise; } return result; });
  const selector = scope(), descriptor = { kind: 'before' as const, anchorMessageId: 'message-5', limit: 2 };
  const old = repository.navigate(selector, descriptor); selector.sessionId = 'session-b'; descriptor.anchorMessageId = 'missing'; await started.promise;
  const latest = await repository.navigate(scope(), { kind: 'around', anchorMessageId: 'interaction-a', limit: 2 });
  if (latest.status !== 'published') throw new Error('range_required'); release.resolve(); expect(await old).toEqual({ status: 'superseded' });
  expect(repository.read(scope())).toBe(latest.snapshot); expect(latest.snapshot.messages.window).toEqual({ kind: 'around', anchorMessageId: 'interaction-a', limit: 2 });
});
it('keeps inference prefix byte truncation explicit and independent from complete message bodies', async () => {
  const f = await fixture(), repository = new ProjectionConversationRepository(f.client);
  for (let index = 0; index < 10; index++) await f.append([f.stream(`large-${index}`, 'streaming', 1, 'a', 262144)]);
  const result = await repository.load(scope(), { kind: 'latest', limit: 2 }); if (result.status !== 'published') throw new Error('range_required');
  expect(result.snapshot.inferencePrefixes).toHaveLength(2);
  for (const window of result.snapshot.inferencePrefixes) {
    expect(window.hasEarlier).toBe(true); expect(window.changes.length).toBeLessThan(12);
    expect(Buffer.byteLength(canonicalPublicProjectionJson(window), 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024);
  }
  expect(result.snapshot.bytes).toBeLessThan(8 * 1024 * 1024); expect(repository.bodies.usage().entries).toBe(0);
});
it('does not mix a newer inference or document version when authority changes between range reads', async () => {
  const f = await fixture(), repository = new ProjectionConversationRepository(f.client); let updated = false;
  f.hook(async (command, result) => {
    if (command.kind === 'projection.messages.metadata' && !updated) { updated = true; await f.publish(2); await f.append([f.stream('active', 'committed', 2)]); }
    return result;
  });
  const result = await repository.load(scope(), { kind: 'latest', limit: 2 }); if (result.status !== 'published') throw new Error('range_required');
  expect(messageMetadataOf(result.snapshot.messages.rows.at(-1)!).version).toBe(1);
  expect(result.snapshot.inferencePrefixes[0]?.changes).toMatchObject([{ aggregateId: 'active', aggregateVersion: 1, dto: { status: 'streaming' } }]);
  expect(await repository.loadBody(scope(), 'interaction-a')).toMatchObject({ status: 'loaded', body: { item: { value: { version: 1, content: body } } } });
  expect(await repository.scan(scope())).toMatchObject({ status: 'scanned', dirty: true });
});
