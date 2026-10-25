import { auditStoredProjectionState as auditDocumentMigration } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { canonicalPublicProjectionJson, catalogSha256, runDocumentMetadataPageDigestPayload, PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteRunDocumentPublication } from '../../runtime/src/adapters/persistence/SqliteRunDocumentPublication.js';
import { upgradeRunDocumentSchema } from '../../runtime/src/adapters/persistence/RunDocumentDbSchema.js';
import { RunDocumentPlan } from '../../runtime/src/projection/RunDocumentPlan.js';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries.js';
import { ProjectionRuntimeClient, ProjectionProtocolIntegrityError, ProjectionCatalogResetSignal } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client.js';
import { ProjectionBodyRepository } from '../../app/src/renderer/src/core/runtime/projection/projection-body-repository.js';
import { ProjectionRunDocumentRepository } from '../../app/src/renderer/src/core/runtime/projection/projection-run-document-repository.js';
import { observeProjectionInboxProofs } from '../../app/src/renderer/src/core/runtime/projection/projection-inbox-proof-reader.js';
import { AgentInputDeliveryTracker } from '../../app/src/renderer/src/core/runtime/agent-input-delivery.js';
import { RendererProjectionRepository } from '../../app/src/renderer/src/core/runtime/projection/renderer-projection-repository.js';
import { createProjectionProbe } from '../../scripts/smoke/projection-probe.js';
import { PublicResultError } from '../../app/src/renderer/src/core/runtime/public-result.js';
const at = '2032-01-01T00:00:00.000Z', text = 'PRIVATE_BODY🙂'.repeat(70_000);
const resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
afterEach(async () => { for (const { root, store } of resources.splice(0)) { await store.close(); rmSync(root, { recursive: true, force: true }); } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  let now = new Date(at);
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-run-range-')), store = new SqlitePublicProjectionStore(root, { now: () => now });
  resources.push({ root, store });
  await store.append({ contractVersion: '5.0', sourceId: 'fixture', sourceCursor: 1, eventId: 'fixture-1', occurredAt: at, changes: [
    { feature: 'sessions', aggregateId: 'session-a', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
      dto: { sessionId: 'session-a', workspaceId: 'workspace-a', version: 1, title: '模拟会话', status: 'active', pinned: false, createdAt: at, updatedAt: at } }
  ] });
  const database = (store as unknown as { database: DatabaseSync }).database; upgradeRunDocumentSchema(database, auditDocumentMigration);
  const writer = new SqliteRunDocumentPublication(database, store.streamId, appendDocumentLedger);
  async function publish(version: number, runId = 'run-a', sessionId = 'session-a', large = true) {
    const plan = new RunDocumentPlan({ summary: { runId, sessionId, version, title: '模拟文档', label: '模拟文档', status: 'running',
      updatedAt: at, toolActivityCount: 0, queuedInputCount: 150, claimedInputCount: 0, interactionMessageCount: 1 }, toolActivities: [],
      inbox: Array.from({ length: 150 }, (_, index) => ({ inputId: `input-${index}`, messageId: `input-message-${index}`, version,
        content: `PRIVATE_INBOX_${index}_V${version}`, state: 'queued' as const, delivery: version === 1 ? 'next_turn' as const : 'next_step' as const,
        queuedAt: at, updatedAt: at })),
      interactionMessages: [{ messageId: 'interaction-a', sessionId, runId, version, role: 'assistant',
        content: version === 1 && large ? text : 'NEW_BODY', status: 'completed', createdAt: at, updatedAt: at }] });
    await writer.publish({ contractVersion: '6.0', sourceId: `document-${runId}`, sourceCursor: version, eventId: `${runId}-document-${version}`, occurredAt: at,
      changes: [{ feature: 'runs', aggregateId: runId, aggregateVersion: version, operation: 'upsert', projectedAt: at, dto: plan.header }] }, plan);
  }
  await publish(1);
  const commands: RuntimeCommand[] = [];
  let hook: (command: RuntimeCommand, result: RuntimeResult) => Promise<RuntimeResult> = async (_command, result) => result;
  const api: ConstructorParameters<typeof ProjectionRuntimeClient>[0] = { request: async command => { commands.push(command); return { ok: true,
    value: await hook(command, await readAgentProjectionQuery(store, command)) }; }, getStatus: async () => { throw new Error('unused'); },
    onEvent: () => () => undefined, onStatus: () => () => undefined };
  const client = new ProjectionRuntimeClient(api);
  const begin = () => client.beginCatalog({ scope: { kind: 'session', workspaceId: 'workspace-a', sessionId: 'session-a' }, feature: 'runs', filter: 'all' });
  const bodies = new ProjectionBodyRepository(client), repository = new ProjectionRunDocumentRepository(client, bodies);
  return { store, client, api, commands, begin, publish, bodies, repository, hook: (next: typeof hook) => { hook = next; }, expire: () => { now = new Date(now.getTime() + 300_001); } };
}
it('native probe uses verified bounded modern windows, never invents unloaded Run collections, and proves off-page Inbox absence', async () => {
  const f = await fixture(), probe = createProjectionProbe(f.api);
  await f.store.append({ contractVersion: '5.0', sourceId: 'deleted-model-fixture', sourceCursor: 1,
    eventId: 'deleted-model-fixture-1', occurredAt: at, changes: [{ feature: 'models', aggregateId: 'deleted-model',
      aggregateVersion: 1, operation: 'delete', projectedAt: at, dto: null }] });
  await f.store.append({ contractVersion: '5.0', sourceId: 'diagnostic-fixture', sourceCursor: 1,
    eventId: 'diagnostic-fixture-1', occurredAt: at, changes: Array.from({ length: 150 }, (_, index) => ({
      feature: 'diagnostics' as const, aggregateId: `diagnostic-${index}`, aggregateVersion: 1, operation: 'upsert' as const,
      projectedAt: at, dto: { diagnosticId: `diagnostic-${index}`, version: 1, severity: 'info' as const,
        code: 'FIXTURE_DIAGNOSTIC', message: 'Fixture diagnostic', observedAt: at } })) });
  const window = await probe.readFixtureWindow('workspace-a');
  expect(window.models).toEqual([]);
  expect(window.diagnostics).toHaveLength(32);
  expect(window.diagnosticCoverage).toMatchObject({ state: 'partial', hasEarlier: true });
  expect(window.runs).toHaveLength(1);
  expect(window.runs[0]).not.toHaveProperty('inbox');
  expect(window.runs[0]).not.toHaveProperty('interactionMessages');
  expect(window.messages[0]?.content).toBe(text);
  expect(await probe.inboxAbsent('workspace-a', 'session-a', 'run-a', 'input-149')).toBe(false);
  expect(await probe.inboxAbsent('workspace-a', 'session-a', 'run-a', 'missing-input')).toBe(true);
  const tools = await probe.readFixtureWindow('workspace-a', { toolRunIds: ['run-a'] });
  expect(tools.runs[0]?.toolActivities).toEqual([]);
  await expect(probe.readFixtureWindow('workspace-a', { runCollections: { 'run-a': ['inbox'] } }))
    .rejects.toThrow('smoke_fixture_collection_limit:inbox');
  expect(f.commands.some(command => command.kind === 'projection.snapshot.get' || command.kind === 'projection.commits.read')).toBe(false);
});
it('native probe rejects tampered body bytes instead of accepting a plausible fixture transcript', async () => {
  const f = await fixture(), probe = createProjectionProbe(f.api);
  f.hook(async (command, result) => {
    if (command.kind === 'projection.run_document.chunk' && result.kind === 'projection.run_document.chunk_result'
      && result.chunk.status === 'ok') return { ...result, chunk: { ...result.chunk,
        leaf: { ...result.chunk.leaf, contentBase64: (result.chunk.leaf.contentBase64[0] === 'A' ? 'B' : 'A')
          + result.chunk.leaf.contentBase64.slice(1) } } } as RuntimeResult;
    return result;
  });
  await expect(probe.readFixtureWindow('workspace-a')).rejects.toBeInstanceOf(ProjectionProtocolIntegrityError);
});
it('native probe preserves an observed read disconnect and can restart the whole window without publishing partial results', async () => {
  const f = await fixture(); let disconnected = false;
  const probe = createProjectionProbe({ ...f.api, request: async (command, options) => {
    if (!disconnected && command.kind === 'projection.run_document.chunk') {
      disconnected = true;
      return { ok: false, error: { code: 'command_outcome_uncertain', message: 'Fixture Runtime disconnected.',
        retryable: false, correlationId: options!.commandId! } };
    }
    return f.api.request(command, options);
  } });
  await expect(probe.readFixtureWindow('workspace-a')).rejects.toBeInstanceOf(PublicResultError);
  const next = await probe.readFixtureWindow('workspace-a');
  expect(next.messages[0]?.content).toBe(text);
  expect(next.boundaries).toHaveLength(1);
});
it('production body owner preserves bridge errors, releases physical reservations and permits verified same-C retry', async () => {
  const f = await fixture(); let fail = true;
  const client = new ProjectionRuntimeClient({ ...f.api, request: async (command, options) => {
    if (fail && command.kind === 'projection.run_document.chunk') {
      fail = false;
      return { ok: false, error: { code: 'runtime_unavailable', message: 'Fixture Runtime unavailable.', retryable: true,
        correlationId: options!.commandId! } };
    }
    return f.api.request(command, options);
  } });
  const manifest = await client.beginCatalog({ scope: { kind: 'session', workspaceId: 'workspace-a', sessionId: 'session-a' }, feature: 'runs', filter: 'all' });
  const window = await client.readMessageMetadataWindow({ queryContractVersion: '1.0', manifest, window: { kind: 'latest', limit: 64 } });
  if (window.status !== 'ok' || !window.rows[0]) throw new Error('fixture_message_missing');
  const bodies = new ProjectionBodyRepository(client);
  await expect(bodies.loadMessage(manifest, window.rows[0])).rejects.toMatchObject({ name: 'PublicResultError', publicError: { code: 'runtime_unavailable' } });
  expect(bodies.usage()).toMatchObject({ entries: 0, bytes: 0, inFlight: 0, inFlightBytes: 0 });
  expect(await bodies.loadMessage(manifest, window.rows[0])).toMatchObject({ status: 'loaded', body: { item: { value: { content: text } } } });
  expect(bodies.usage()).toMatchObject({ entries: 1, inFlight: 0, inFlightBytes: 0 });
});
it('keeps honest bounded coverage, exact off-page Inbox identity and a shared complete-item body budget', async () => {
  const f = await fixture(), manifest = await f.begin();
  expect(await f.repository.load(manifest, 'run-a', 1)).toMatchObject({ status: 'published' });
  const root = f.repository.read(manifest, 'run-a')!;
  expect(root.windows).toEqual({}); expect(root.exactInbox).toEqual([]);
  expect(root.root.header.collections.inbox.itemCount).toBe(150);
  await f.repository.loadCollection(manifest, 'run-a', 'inbox');
  const first = f.repository.read(manifest, 'run-a')!;
  expect(first.windows.inbox).toMatchObject({ startOrdinal: 0, pageIndex: 0, hasMore: true });
  expect(first.windows.inbox!.rows).toHaveLength(128);
  expect(first.windows.interactionMessages).toBeUndefined();
  expect(canonicalPublicProjectionJson(first)).not.toMatch(/PRIVATE_INBOX|PRIVATE_BODY/u);
  await f.repository.lookupInbox(manifest, 'run-a', 'input-149');
  const exact = f.repository.read(manifest, 'run-a')!.exactInbox[0]!;
  expect(exact.proof!.metadata).toMatchObject({ collection: 'inbox', value: { inputId: 'input-149', version: 1, delivery: 'next_turn' } });
  expect(f.bodies.usage().entries).toBe(0);
  expect(await f.repository.loadBody(manifest, 'run-a', 'inbox', 'input-149')).toMatchObject({ status: 'loaded', body: { item: { value: { content: 'PRIVATE_INBOX_149_V1' } } } });
  await f.repository.nextCollectionPage(manifest, 'run-a', 'inbox');
  expect(f.repository.read(manifest, 'run-a')!.windows.inbox).toMatchObject({ startOrdinal: 128, pageIndex: 1, hasMore: false });
  expect(f.repository.read(manifest, 'run-a')!.windows.inbox!.rows).toHaveLength(22);
  expect(() => f.repository.readBody(manifest, 'run-a', 'inbox', 'input-0')).toThrow('item_outside_range');
  await f.repository.lookupInbox(manifest, 'run-a', 'missing-input');
  expect(f.repository.read(manifest, 'run-a')!.exactInbox.at(-1)!.proof).toBeNull();
  await f.repository.loadCollection(manifest, 'run-a', 'toolActivities');
  expect(f.repository.read(manifest, 'run-a')!.windows.toolActivities).toMatchObject({ startOrdinal: 0, rows: [], hasMore: false });
  await f.repository.loadCollection(manifest, 'run-a', 'interactionMessages');
  const chunkStart = f.commands.filter(command => command.kind === 'projection.run_document.chunk').length;
  expect(await f.repository.loadBody(manifest, 'run-a', 'interactionMessages', 'interaction-a')).toMatchObject({ status: 'loaded', body: { item: { value: { content: text } } } });
  expect(f.commands.filter(command => command.kind === 'projection.run_document.chunk').length - chunkStart).toBeGreaterThan(1);
  expect(f.bodies.usage()).toMatchObject({ entries: 2, inFlight: 0 });
  expect(f.commands.some(command => ['projection.snapshot', 'projection.commits', 'projection.catalog.detail'].includes(command.kind))).toBe(false);
});
it('retains an old C through newer writes, verifies new exact identities and preserves trusted roots on unavailable or expired requests', async () => {
  const f = await fixture(), old = await f.begin(); await f.repository.load(old, 'run-a', 1);
  await f.publish(2); await f.repository.lookupInbox(old, 'run-a', 'input-149');
  expect(f.repository.read(old, 'run-a')!.exactInbox[0]!.proof!.metadata.value).toMatchObject({ version: 1, delivery: 'next_turn' });
  const trusted = f.repository.read(old, 'run-a');
  expect(await f.repository.load(old, 'run-a', 2)).toEqual({ status: 'unavailable', reason: 'version_mismatch' });
  expect(f.repository.read(old, 'run-a')).toBe(trusted);
  const next = await f.begin(); await f.repository.load(next, 'run-a', 2);
  expect(f.repository.read(old, 'run-a')).toBe(trusted); expect(f.repository.read(next, 'run-a')!.exactInbox).toEqual([]);
  await f.repository.lookupInbox(next, 'run-a', 'input-149');
  expect(f.repository.read(next, 'run-a')!.exactInbox[0]!.proof!.metadata.value).toMatchObject({ version: 2, delivery: 'next_step' });
  const latest = f.repository.read(next, 'run-a'); f.expire();
  await expect(f.repository.loadCollection(next, 'run-a', 'inbox')).rejects.toBeInstanceOf(ProjectionCatalogResetSignal);
  expect(f.repository.read(next, 'run-a')).toBe(latest);
});
it('coalesces requests, keeps live reservations after invalidation and drops old root/page results', async () => {
  const f = await fixture(), manifest = await f.begin(), ready = gate(), released = gate();
  const repository = new ProjectionRunDocumentRepository(f.client, f.bodies, { maxRequests: 1 });
  f.hook(async (command, result) => { if (command.kind === 'projection.run_document.root') { ready.resolve(); await released.promise; } return result; });
  const first = repository.load(manifest, 'run-a', 1); expect(repository.load(manifest, 'run-a', 1)).toBe(first);
  await ready.promise; repository.invalidate(); expect(repository.usage().inFlight).toBe(1);
  await expect(repository.load(manifest, 'run-a', 1)).rejects.toThrow('request_capacity_exceeded');
  released.resolve(); expect(await first).toEqual({ status: 'superseded' }); expect(repository.read(manifest, 'run-a')).toBeNull();
  f.hook(async (_command, result) => result); await repository.load(manifest, 'run-a', 1);
  const pageReady = gate(), pageReleased = gate();
  f.hook(async (command, result) => { if (command.kind === 'projection.run_document.metadata') { pageReady.resolve(); await pageReleased.promise; } return result; });
  const page = repository.loadCollection(manifest, 'run-a', 'inbox'); await pageReady.promise; repository.invalidate(); pageReleased.resolve();
  expect(await page).toEqual({ status: 'superseded' }); expect(repository.usage()).toEqual({ entries: 0, bytes: 0, inFlight: 0 });
});
it('rejects proof corruption and a self-consistent but skipped page without losing the proved window', async () => {
  const f = await fixture(), manifest = await f.begin(); await f.repository.load(manifest, 'run-a', 1);
  await f.repository.loadCollection(manifest, 'run-a', 'inbox'); const trusted = f.repository.read(manifest, 'run-a');
  f.hook(async (_command, result) => {
    if (result.kind === 'projection.run_document.inbox_result' && result.input.status === 'ok' && result.input.proof !== null) {
      const input = structuredClone(result.input); input.proof!.descriptor.itemMetadataDigest = `sha256:${'0'.repeat(64)}`;
      return { ...result, input };
    }
    if (result.kind === 'projection.run_document.metadata_result' && result.page.status === 'ok') {
      const page = { ...result.page, pageIndex: result.page.pageIndex + 1 };
      page.pageDigest = await catalogSha256(runDocumentMetadataPageDigestPayload(page)); return { ...result, page };
    }
    return result;
  });
  await expect(f.repository.lookupInbox(manifest, 'run-a', 'input-149')).rejects.toBeInstanceOf(ProjectionProtocolIntegrityError);
  expect(f.repository.read(manifest, 'run-a')).toBe(trusted);
  await expect(f.repository.nextCollectionPage(manifest, 'run-a', 'inbox')).rejects.toThrow('page_sequence_mismatch');
  expect(f.repository.read(manifest, 'run-a')).toBe(trusted);
});
it('bounds exact lookups and memory atomically, and rejects global or filtered manifests', async () => {
  const f = await fixture(), manifest = await f.begin();
  const repository = new ProjectionRunDocumentRepository(f.client, f.bodies, { maxExactInputs: 2, maxBytes: 32_000, maxEntryBytes: 32_000 });
  await repository.load(manifest, 'run-a');
  for (const input of ['input-0', 'input-1', 'input-149']) await repository.lookupInbox(manifest, 'run-a', input);
  expect(repository.read(manifest, 'run-a')!.exactInbox.map(row => row.inputId)).toEqual(['input-1', 'input-149']);
  const trusted = repository.read(manifest, 'run-a'), usage = repository.usage();
  await expect(repository.loadCollection(manifest, 'run-a', 'inbox')).rejects.toThrow('entry_capacity_exceeded');
  expect(repository.read(manifest, 'run-a')).toBe(trusted); expect(repository.usage()).toEqual(usage);
  expect(() => repository.load({ ...manifest, scope: { kind: 'tasks' } }, 'run-a')).toThrow();
  expect(() => repository.load({ ...manifest, filter: 'active' }, 'run-a')).toThrow();
  expect(f.bodies.usage().entries).toBe(0);
});
it('settles an off-page delivery only from its exact proved metadata, sharing one Session C without reading any body', async () => {
  const f = await fixture(), tracker = new AgentInputDeliveryTracker(), command = { kind: 'agent.inbox.enqueue' as const, contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    runId: 'run-a', sessionId: 'session-a', inputId: 'input-149', delivery: 'next_turn' as const, content: 'private sender receipt' };
  tracker.begin('command-a', command, at); tracker.requireReconciliation('command-a', 'unknown', at);
  const refs = [{ ...command, inputId: 'missing-input' }, command, command];
  const accepted: string[] = []; let sessions = 0;
  await observeProjectionInboxProofs(f.client, f.repository, refs, async id => {
    sessions++; const manifest = await f.client.beginCatalog({ scope: { kind: 'directory' }, feature: 'sessions', filter: 'all' });
    const result = await f.client.readCatalogDetail(manifest, id);
    return result.status === 'ok' && result.change?.feature === 'sessions' && result.change.operation === 'upsert' ? result.change.dto : null;
  }, () => true, () => f.store.streamId, identity => { accepted.push(...tracker.observeInboxIdentities([identity])); });
  expect(accepted).toEqual(['command-a']); expect(tracker.snapshot()[0]!.state).toBe('accepted'); expect(sessions).toBe(1);
  expect(f.commands.filter(request => request.kind === 'projection.run_document.root')).toHaveLength(1);
  const exact = f.commands.filter(request => request.kind === 'projection.run_document.inbox'); expect(exact).toHaveLength(2);
  if (exact[0]?.kind !== 'projection.run_document.inbox' || exact[1]?.kind !== 'projection.run_document.inbox') throw new Error('exact_queries_required');
  expect(exact[0].request.manifest).toEqual(exact[1].request.manifest);
  expect(f.commands.some(request => ['projection.run_document.metadata', 'projection.run_document.chunk'].includes(request.kind))).toBe(false);
  expect(f.bodies.usage().entries).toBe(0);
});
it('does not settle a superseded identity, and rejects a new stream or excessive proof references', async () => {
  const f = await fixture(), reference = { runId: 'run-a', sessionId: 'session-a', inputId: 'input-149' };
  const readSession = async () => ({ sessionId: 'session-a', workspaceId: 'workspace-a', version: 1, title: '模拟会话', status: 'active' as const,
    pinned: false, createdAt: at, updatedAt: at });
  let current = true; const identities: unknown[] = [], ready = gate(), released = gate();
  f.hook(async (command, result) => { if (command.kind === 'projection.run_document.inbox') { ready.resolve(); await released.promise; } return result; });
  const pending = observeProjectionInboxProofs(f.client, f.repository, [reference], readSession, () => current, () => f.store.streamId, value => identities.push(value));
  await ready.promise; current = false; f.repository.invalidate(); released.resolve(); await pending; expect(identities).toEqual([]);
  await expect(observeProjectionInboxProofs(f.client, f.repository, [reference], readSession, () => true, () => 'other-stream', value => identities.push(value)))
    .rejects.toThrow('stream_mismatch');
  await expect(observeProjectionInboxProofs(f.client, f.repository, Array(101).fill(reference), readSession, () => true, () => f.store.streamId, value => identities.push(value)))
    .rejects.toThrow('reference_capacity_exceeded');
  expect(identities).toEqual([]);
});
it('finishes interleaved Session deliveries before advancing leases beyond the real 64-lease owner', async () => {
  const f = await fixture(), owners = Array.from({ length: 36 }, (_, index) => ({ sessionId: `session-group-${index}`, runId: `run-group-${index}` }));
  await f.store.append({ contractVersion: '5.0', sourceId: 'fixture', sourceCursor: 2, eventId: 'fixture-2', occurredAt: at,
    changes: owners.map(owner => ({ feature: 'sessions', aggregateId: owner.sessionId, aggregateVersion: 1, operation: 'upsert', projectedAt: at,
      dto: { sessionId: owner.sessionId, workspaceId: 'workspace-a', version: 1, title: '模拟会话', status: 'active', pinned: false, createdAt: at, updatedAt: at } })) });
  for (const owner of owners) await f.publish(1, owner.runId, owner.sessionId, false);
  const references = ['input-0', 'input-149'].flatMap(inputId => owners.map(owner => ({ ...owner, inputId }))), observed: string[] = [];
  await observeProjectionInboxProofs(f.client, f.repository, references, async id => {
    const manifest = await f.client.beginCatalog({ scope: { kind: 'directory' }, feature: 'sessions', filter: 'all' });
    const result = await f.client.readCatalogDetail(manifest, id);
    return result.status === 'ok' && result.change?.feature === 'sessions' && result.change.operation === 'upsert' ? result.change.dto : null;
  }, () => true, () => f.store.streamId, identity => observed.push(`${identity.sessionId}/${identity.input!.inputId}`));
  expect(observed).toHaveLength(72);
  for (const owner of owners) expect(observed).toContain(`${owner.sessionId}/input-149`);
  expect(f.commands.filter(command => command.kind === 'projection.run_document.root')).toHaveLength(36);
  expect(f.commands.filter(command => command.kind === 'projection.run_document.inbox')).toHaveLength(72);
  expect(f.repository.usage().entries).toBe(16); expect(f.bodies.usage().entries).toBe(0);
}, 20_000);
it('pins the selected immutable C and rejects replacement atomically when all root entries are pinned', async () => {
  const f = await fixture(), old = await f.begin(), repository = new ProjectionRunDocumentRepository(f.client, f.bodies, { maxEntries: 1 });
  repository.pin(old, ['run-a']); await repository.load(old, 'run-a'); const trusted = repository.read(old, 'run-a');
  await f.publish(2); const fresh = await f.begin();
  await expect(repository.load(fresh, 'run-a')).rejects.toThrow('entry_capacity_exceeded');
  expect(repository.read(old, 'run-a')).toBe(trusted); expect(repository.read(fresh, 'run-a')).toBeNull();
  expect(repository.usage().entries).toBe(1);
  repository.unpin(); await repository.load(fresh, 'run-a');
  expect(repository.read(old, 'run-a')).toBeNull(); expect(repository.read(fresh, 'run-a')!.root.document.runVersion).toBe(2);
});
it('presents a candidate document through the actual Renderer as partial pages, explicit shared bodies and independent foreground/background C', async () => {
  const f = await fixture(), renderer = new RendererProjectionRepository(f.client); await renderer.synchronize('session-a');
  let snapshot = renderer.getSnapshot(), run = snapshot.runs[0]!;
  expect(run).toMatchObject({ runId: 'run-a', version: 1, queuedInputCount: 150, collections: {
    inbox: { state: 'partial', count: 128, total: 150, hasMore: true, hasEarlier: false },
    toolActivities: { state: 'complete', total: 0 }, interactionMessages: { state: 'unloaded', total: 1 } } });
  expect(run.inbox.every(input => input.content === undefined && input.bodyState === 'unloaded')).toBe(true);
  expect(run).not.toHaveProperty('interactionMessages');
  expect(f.commands.some(command => command.kind === 'projection.catalog.detail' && command.request.manifest.feature === 'runs')).toBe(false);
  expect(f.commands.some(command => command.kind === 'projection.run_document.chunk')).toBe(false);
  await renderer.readRunCollection(run.runId, 'session-a', run.documentToken, 'inbox', 'next');
  run = renderer.getSnapshot().runs[0]!;
  expect(run.collections.inbox).toMatchObject({ state: 'partial', startOrdinal: 128, count: 22, total: 150, hasEarlier: true, hasMore: false });
  const token = run.documentToken;
  await f.publish(2); const identities: unknown[] = [];
  await renderer.observeInboxProofs([{ runId: 'run-a', sessionId: 'session-a', inputId: 'input-149' }], identity => identities.push(identity));
  expect(identities).toMatchObject([{ runVersion: 2, input: { version: 2, delivery: 'next_step' } }]);
  expect(renderer.getSnapshot().runs[0]!.documentToken).toBe(token);
  await renderer.loadInboxBody('run-a', 'session-a', 'input-149', token);
  snapshot = renderer.getSnapshot();
  expect(snapshot.runs[0]!.inbox.at(-1)).toMatchObject({ inputId: 'input-149', content: 'PRIVATE_INBOX_149_V1', bodyState: 'loaded' });
  const interaction = snapshot.messages.find(message => message.messageId === 'interaction-a')!;
  await renderer.loadMessageBody(interaction.messageId, interaction.sessionId, interaction.bodyReadToken!);
  expect(renderer.conversations.bodies.usage()).toMatchObject({ entries: 2, inFlight: 0 });
  expect(renderer.runDocuments.bodies).toBe(renderer.conversations.bodies);
  expect(renderer.getSnapshot().messages.find(message => message.messageId === 'interaction-a')!.content).toBe(text);
  await renderer.synchronize('session-a'); run = renderer.getSnapshot().runs[0]!;
  expect(run.version).toBe(2); expect(run.documentToken).not.toBe(token); expect(run.inbox[0]!.content).toBeUndefined();
  const chunks = f.commands.filter(command => command.kind === 'projection.run_document.chunk').length;
  await renderer.loadInboxBody('run-a', 'session-a', 'input-149', token);
  expect(f.commands.filter(command => command.kind === 'projection.run_document.chunk')).toHaveLength(chunks);
});
it('reserves published and candidate ranges in one bounded cache until a fenced pin transition commits', async () => {
  const f = await fixture(), old = await f.begin(), repository = new ProjectionRunDocumentRepository(f.client, f.bodies, { maxEntries: 2 });
  repository.pin(old, ['run-a']); await repository.load(old, 'run-a'); await repository.loadCollection(old, 'run-a', 'inbox');
  const trusted = repository.read(old, 'run-a');
  await f.publish(2); const fresh = await f.begin(), first = repository.stagePins(fresh, ['run-a']);
  await repository.load(fresh, 'run-a');
  await f.publish(1, 'background-run', 'session-a', false); const background = await f.begin();
  await expect(repository.load(background, 'background-run')).rejects.toThrow('entry_capacity_exceeded');
  expect(repository.read(old, 'run-a')).toBe(trusted); expect(repository.read(fresh, 'run-a')!.root.document.runVersion).toBe(2);
  expect(repository.usage().entries).toBe(2);
  const second = repository.stagePins(fresh, ['run-a']); first.release(); expect(first.commit()).toBe(false);
  await expect(repository.load(background, 'background-run')).rejects.toThrow('entry_capacity_exceeded');
  expect(second.commit()).toBe(true); second.release();
  await repository.load(background, 'background-run');
  expect(repository.read(old, 'run-a')).toBeNull(); expect(repository.read(fresh, 'run-a')!.root.document.runVersion).toBe(2);
  expect(repository.usage().entries).toBe(2);
});
it('rejects a candidate that cannot coexist with the published range and releases only its own stage', async () => {
  const f = await fixture(), old = await f.begin(), repository = new ProjectionRunDocumentRepository(f.client, f.bodies, { maxEntries: 1 });
  repository.pin(old, ['run-a']); await repository.load(old, 'run-a'); const trusted = repository.read(old, 'run-a');
  await f.publish(2); const fresh = await f.begin(), stage = repository.stagePins(fresh, ['run-a']);
  await expect(repository.load(fresh, 'run-a')).rejects.toThrow('entry_capacity_exceeded'); stage.release();
  expect(stage.commit()).toBe(false); expect(repository.read(old, 'run-a')).toBe(trusted);
  await expect(repository.load(fresh, 'run-a')).rejects.toThrow('entry_capacity_exceeded');
  const later = repository.stagePins(fresh, ['run-a']); repository.invalidate();
  expect(later.commit()).toBe(false); later.release(); expect(repository.usage()).toMatchObject({ entries: 0, bytes: 0 });
});
