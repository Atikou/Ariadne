import { auditStoredProjectionState as auditDocumentMigration } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { canonicalPublicProjectionJson, type RuntimeCommand, type RuntimeResult, type PublicMessageMetadataRow } from '@ariadne/protocol/public';
import { RunDocumentPlan } from '../../runtime/src/projection/RunDocumentPlan.js';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteRunDocumentPublication } from '../../runtime/src/adapters/persistence/SqliteRunDocumentPublication.js';
import { upgradeRunDocumentSchema } from '../../runtime/src/adapters/persistence/RunDocumentDbSchema.js';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries.js';
import { ProjectionRuntimeClient, ProjectionProtocolIntegrityError } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client.js';
import { ProjectionBodyRepository } from '../../app/src/renderer/src/core/runtime/projection/projection-body-repository.js';
const at = '2032-01-01T00:00:00.000Z', text = 'BODY🙂'.repeat(150_000);
const resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
afterEach(async () => { for (const { root, store } of resources.splice(0)) { await store.close(); rmSync(root, { recursive: true, force: true }); } });
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-body-repository-')), store = new SqlitePublicProjectionStore(root);
  resources.push({ root, store });
  const message = (id: string, version = 1) => ({ feature: 'messages' as const, aggregateId: id, aggregateVersion: version, operation: 'upsert' as const, projectedAt: at,
    dto: { messageId: id, sessionId: 'session-a', version, role: 'user' as const, content: `${id}-${version}:`.padEnd(32_000, 'x'), status: 'completed' as const, createdAt: at, updatedAt: at } });
  await store.append({ contractVersion: '5.0', sourceId: 'fixture', sourceCursor: 1, eventId: 'fixture-1', occurredAt: at, changes: [
    { feature: 'sessions', aggregateId: 'session-a', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
      dto: { sessionId: 'session-a', workspaceId: 'workspace-a', version: 1, title: '模拟会话', status: 'active', pinned: false, createdAt: at, updatedAt: at } },
    message('message-a'), message('message-b')
  ] });
  const database = (store as unknown as { database: DatabaseSync }).database; upgradeRunDocumentSchema(database, auditDocumentMigration);
  const writer = new SqliteRunDocumentPublication(database, store.streamId, appendDocumentLedger);
  async function publish(version: number, body: string) {
    const plan = new RunDocumentPlan({ summary: { runId: 'run-a', sessionId: 'session-a', version, title: '模拟文档', label: '模拟文档', status: 'completed',
      updatedAt: at, toolActivityCount: 0, queuedInputCount: 1, claimedInputCount: 0, interactionMessageCount: 1 }, toolActivities: [],
      inbox: [{ inputId: 'input-a', messageId: 'input-message-a', version: 1, content: 'INBOX_BODY', state: 'queued', delivery: 'next_turn', queuedAt: at, updatedAt: at }],
      interactionMessages: [{ messageId: 'interaction-a', sessionId: 'session-a', runId: 'run-a', version, role: 'assistant', content: body,
        status: 'completed', createdAt: at, updatedAt: at }] });
    await writer.publish({ contractVersion: '6.0', sourceId: 'document', sourceCursor: version, eventId: `document-${version}`, occurredAt: at,
      changes: [{ feature: 'runs', aggregateId: 'run-a', aggregateVersion: version, operation: 'upsert', projectedAt: at, dto: plan.header }] }, plan);
  }
  await publish(1, text);
  const commands: RuntimeCommand[] = [];
  let hook: (command: RuntimeCommand, result: RuntimeResult) => Promise<RuntimeResult> = async (_command, result) => result;
  const client = new ProjectionRuntimeClient({ request: async command => { commands.push(command); return { ok: true,
    value: await hook(command, await readAgentProjectionQuery(store, command)) }; },
    getStatus: async () => { throw new Error('unused_status'); }, onEvent: () => () => undefined, onStatus: () => () => undefined });
  const range = async () => {
    const manifest = await client.beginCatalog({ scope: { kind: 'session', sessionId: 'session-a', workspaceId: 'workspace-a' }, feature: 'runs', filter: 'all' });
    const document = await client.readRunDocument({ queryContractVersion: '1.0', manifest, runId: 'run-a' });
    const window = await client.readMessageMetadataWindow({ queryContractVersion: '1.0', manifest, window: { kind: 'latest', limit: 128 } });
    if (document.status !== 'ok' || window.status !== 'ok') throw new Error('range_required');
    const row = window.rows.find(value => value.kind === 'run_document'); if (row?.kind !== 'run_document') throw new Error('document_row_required');
    const standalone = window.rows.filter(value => value.kind === 'message');
    const inbox = await client.readRunDocumentMetadata({ queryContractVersion: '1.0', manifest, document: document.document, collection: 'inbox', limit: 128 });
    if (inbox.status !== 'ok' || inbox.rows[0] === undefined) throw new Error('inbox_required');
    return { manifest, row, standalone, address: { manifest, header: row.header, document: row.document, proof: row.proof },
      inboxAddress: { manifest, header: document.header, document: document.document, proof: inbox.rows[0] } };
  };
  return { store, commands, client, publish, message, range, current: await range(), hook: (next: typeof hook) => { hook = next; } };
}

it('coalesces message/item addresses, publishes only a complete multibyte body and caches the immutable item', async () => {
  const f = await fixture(), repository = new ProjectionBodyRepository(f.client), ready = deferred(), gate = deferred();
  f.hook(async (command, result) => {
    if (command.kind === 'projection.run_document.chunk' && command.request.chunkOrdinal === f.current.row.proof.descriptor.chunkCount - 1) {
      ready.resolve(); await gate.promise;
    } return result;
  });
  const operation = repository.loadMessage(f.current.manifest, f.current.row);
  expect(repository.loadDocumentItem(f.current.address)).toBe(operation);
  await ready.promise;
  expect(repository.readMessage(f.current.manifest, f.current.row)).toBeNull(); expect(repository.usage()).toMatchObject({ entries: 0, inFlight: 1 });
  gate.resolve(); const result = await operation;
  if (result.status !== 'loaded' || result.body.kind !== 'document_item' || result.body.item.collection !== 'interactionMessages') throw new Error('complete_body_required');
  expect(result.body.item.value.content).toBe(text); expect(Object.isFrozen(result.body.item.value)).toBe(true);
  const calls = f.commands.filter(command => command.kind === 'projection.run_document.chunk').length;
  expect(calls).toBe(f.current.row.proof.descriptor.chunkCount);
  expect(await repository.loadMessage(f.current.manifest, f.current.row)).toEqual(result);
  expect(repository.readDocumentItem(f.current.address)).toBe(result.body);
  expect(f.commands.filter(command => command.kind === 'projection.run_document.chunk')).toHaveLength(calls);
  expect(repository.usage()).toMatchObject({ entries: 1, inFlight: 0, inFlightBytes: 0 });
});

it('restores old-C Message and document bodies after later versions and retains exact address separation', async () => {
  const f = await fixture(), repository = new ProjectionBodyRepository(f.client);
  await f.publish(2, 'NEW_DOCUMENT_BODY');
  await f.store.append({ contractVersion: '5.0', sourceId: 'fixture', sourceCursor: 2, eventId: 'fixture-2', occurredAt: at, changes: [f.message('message-a', 2)] });
  const fresh = await f.range();
  const oldDocument = await repository.loadMessage(f.current.manifest, f.current.row), newDocument = await repository.loadMessage(fresh.manifest, fresh.row);
  expect(oldDocument).toMatchObject({ status: 'loaded', body: { kind: 'document_item', item: { value: { content: text, version: 1 } } } });
  expect(newDocument).toMatchObject({ status: 'loaded', body: { kind: 'document_item', item: { value: { content: 'NEW_DOCUMENT_BODY', version: 2 } } } });
  const oldMessage = f.current.standalone.find(row => row.kind === 'message' && row.metadata.messageId === 'message-a')!;
  const newMessage = fresh.standalone.find(row => row.kind === 'message' && row.metadata.messageId === 'message-a')!;
  expect(await repository.loadMessage(f.current.manifest, oldMessage)).toMatchObject({ status: 'loaded', body: { kind: 'message', message: { version: 1 } } });
  expect(await repository.loadMessage(fresh.manifest, newMessage)).toMatchObject({ status: 'loaded', body: { kind: 'message', message: { version: 2 } } });
  const inbox = await repository.loadDocumentItem(f.current.inboxAddress);
  expect(inbox).toMatchObject({ status: 'loaded', body: { kind: 'document_item', item: { collection: 'inbox', value: { content: 'INBOX_BODY' } } } });
  expect(repository.usage().entries).toBe(5);
});

it('rejects corrupted and falsely unavailable chunks without publishing partial data and permits a corrected retry', async () => {
  const f = await fixture(), repository = new ProjectionBodyRepository(f.client);
  f.hook(async (command, result) => command.kind === 'projection.run_document.chunk' && result.kind === 'projection.run_document.chunk_result' && result.chunk.status === 'ok'
    ? { ...result, chunk: { ...result.chunk, resultDigest: `sha256:${'0'.repeat(64)}` } } : result);
  await expect(repository.loadMessage(f.current.manifest, f.current.row)).rejects.toBeInstanceOf(ProjectionProtocolIntegrityError);
  expect(repository.usage()).toMatchObject({ entries: 0, bytes: 0, inFlight: 0 });
  f.hook(async (command, result) => command.kind === 'projection.run_document.chunk'
    ? { kind: 'projection.run_document.chunk_result', chunk: { ...command.request, status: 'item_unavailable', queryContractVersion: '1.0' } } : result);
  await expect(repository.loadMessage(f.current.manifest, f.current.row)).rejects.toThrow('declared_chunk_unavailable');
  expect(repository.readMessage(f.current.manifest, f.current.row)).toBeNull();
  f.hook(async (_command, result) => result);
  expect(await repository.loadMessage(f.current.manifest, f.current.row)).toMatchObject({ status: 'loaded' });
});

it('drops a late generation, stops further chunks and retains physical reservations until its live request settles', async () => {
  const f = await fixture(), repository = new ProjectionBodyRepository(f.client, { maxRequests: 1 }), ready = deferred(), gate = deferred();
  f.hook(async (command, result) => { if (command.kind === 'projection.run_document.chunk') { ready.resolve(); await gate.promise; } return result; });
  const old = repository.loadMessage(f.current.manifest, f.current.row); await ready.promise; repository.invalidate();
  expect(repository.usage()).toMatchObject({ entries: 0, inFlight: 1 });
  await expect(repository.loadMessage(f.current.manifest, f.current.standalone[0]!)).rejects.toThrow('request_capacity_exceeded');
  gate.resolve(); expect(await old).toEqual({ status: 'superseded' });
  expect(f.commands.filter(command => command.kind === 'projection.run_document.chunk')).toHaveLength(1);
  expect(repository.usage()).toEqual({ entries: 0, bytes: 0, inFlight: 0, inFlightBytes: 0, pinned: 0 });
  expect(await repository.loadMessage(f.current.manifest, f.current.standalone[0]!)).toMatchObject({ status: 'loaded' });
});

it('bounds LRU entries and bytes, preserves pins and leaves trusted bodies intact when no eviction is possible', async () => {
  const f = await fixture(), [a, b] = f.current.standalone;
  if (a === undefined || b === undefined) throw new Error('message_rows_required');
  const repository = new ProjectionBodyRepository(f.client, { maxEntries: 2 });
  repository.pinMessages(f.current.manifest, [a]); await repository.loadMessage(f.current.manifest, a); await repository.loadMessage(f.current.manifest, b);
  await repository.loadMessage(f.current.manifest, f.current.row);
  expect(repository.readMessage(f.current.manifest, a)).not.toBeNull(); expect(repository.readMessage(f.current.manifest, b)).toBeNull();
  expect(repository.usage()).toMatchObject({ entries: 2, pinned: 1 });
  const one = new ProjectionBodyRepository(f.client, { maxEntries: 1 });
  one.pinMessages(f.current.manifest, [a]); await one.loadMessage(f.current.manifest, a); const retained = one.readMessage(f.current.manifest, a);
  await expect(one.loadMessage(f.current.manifest, b)).rejects.toThrow('pinned_capacity_exceeded');
  expect(one.readMessage(f.current.manifest, a)).toBe(retained); expect(one.usage()).toMatchObject({ entries: 1, inFlight: 0 });
  const byteBound = new ProjectionBodyRepository(f.client, { maxBytes: 1_220_000, maxItemBytes: 1_210_000 });
  byteBound.pinMessages(f.current.manifest, [a]); await byteBound.loadMessage(f.current.manifest, a); const usage = byteBound.usage();
  await expect(byteBound.loadMessage(f.current.manifest, f.current.row)).rejects.toThrow('pinned_capacity_exceeded');
  expect(byteBound.usage()).toEqual(usage);
});

it('copies caller addresses and refuses crossed owner proofs or forged references even when a body is already cached', async () => {
  const f = await fixture(), repository = new ProjectionBodyRepository(f.client);
  const original = structuredClone(f.current.row), loading = repository.loadMessage(f.current.manifest, original);
  if (original.proof.metadata.collection !== 'interactionMessages') throw new Error('interaction_metadata_required');
  original.proof.metadata.value.version = 999;
  expect(await loading).toMatchObject({ status: 'loaded' });
  const crossed: PublicMessageMetadataRow = { ...f.current.row, document: { ...f.current.row.document, bodyCursor: 'forged-reference' } };
  await expect(repository.loadMessage(f.current.manifest, crossed)).rejects.toThrow();
  expect(() => repository.loadMessage({ ...f.current.manifest, scope: { kind: 'session', sessionId: 'foreign-session', workspaceId: 'workspace-a' } }, f.current.row))
    .toThrow('owner_mismatch');
  expect(canonicalPublicProjectionJson(repository.readMessage(f.current.manifest, f.current.row))).toContain('BODY');
  expect(repository.usage()).toMatchObject({ entries: 1, inFlight: 0 });
});
