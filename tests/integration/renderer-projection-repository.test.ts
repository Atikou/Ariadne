import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, type ProjectionCommit, type PublicProjectionChange,
  type RuntimeCommand, type RuntimeResult, type RuntimeEventEnvelope, type PublicInferenceStreamProjection } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries.js';
import { RendererProjectionRepository } from '../../app/src/renderer/src/core/runtime/projection/renderer-projection-repository.js';
import { ProjectionRuntimeClient } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client.js';
import { RuntimeStore } from '../../app/src/renderer/src/core/runtime/runtime-store.js';
import { NOW, session, run, message, model, upsertChange } from '../../app/tests/projection-v3-fixture.js';
import { runtimeEnvelope } from '../../app/tests/runtime-event-fixture.js';

const roots: string[] = [], stores: SqlitePublicProjectionStore[] = [], renderers: RuntimeStore[] = [];
afterEach(async () => {
  for (const renderer of renderers.splice(0)) renderer.dispose();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

it.each([1_000, 10_000])('coalesces 100 live tokens over %i persisted messages without notifying unrelated features', async count => {
  const backend = database(); let cursor = 1;
  await backend.append(commit(cursor, [upsertChange('sessions', session('session-a'), 'session-a'), upsertChange('models', model('model-a'), 'model-a')]));
  for (let offset = 0; offset < count; offset += 256) await backend.append(commit(++cursor,
    Array.from({ length: Math.min(256, count - offset) }, (_, index) => {
      const dto = message(`history-${String(offset + index).padStart(5, '0')}`, 'session-a');
      return upsertChange('messages', dto, dto.messageId);
    })));
  let receive!: (event: RuntimeEventEnvelope) => void;
  const renderer = new RuntimeStore({ ...api(command => readAgentProjectionQuery(backend, command)),
    onEvent: listener => { receive = listener; return () => undefined; } });
  renderers.push(renderer); await renderer.initialize(); await renderer.sessions.select('session-a');
  expect(renderer.getSnapshot().lastError).toBeNull();
  expect(renderer.getSnapshot().messages).toHaveLength(64);
  const before = renderer.getSnapshot(), counts = { messages: 0, sessions: 0, models: 0, decisions: 0, runs: 0, diagnostics: 0 };
  const remove = (Object.keys(counts) as (keyof typeof counts)[]).map(feature => renderer[feature].view.subscribe(() => { counts[feature]++; }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  for (let sequence = 1; sequence <= 100; sequence++) receive(runtimeEnvelope({ contractVersion: '1.0', kind: 'inference.chunk.observed',
    sessionId: 'session-a', runId: 'live-run', turnId: 'live-turn', attemptId: 'live-attempt', sequence, channel: 'token', text: 'x', observedAt: NOW }, sequence));
  expect(counts.messages).toBe(0); await vi.advanceTimersByTimeAsync(16);
  expect(counts).toEqual({ messages: 1, sessions: 0, models: 0, decisions: 0, runs: 0, diagnostics: 0 });
  const after = renderer.getSnapshot();
  expect(after.messages).toHaveLength(65);
  expect(after.messages.find(item => item.runId === 'live-run')?.content).toBe('x'.repeat(100));
  expect(after.messages.find(item => item.messageId === before.messages[0]?.messageId)).toBe(before.messages[0]);
  expect(after.sessions).toBe(before.sessions); expect(after.models).toBe(before.models); expect(after.runs).toBe(before.runs);
  remove.forEach(unsubscribe => unsubscribe());
});

it('recovers a live sequence gap from the actual durable prefix and does not resurrect a terminated attempt', async () => {
  const backend = database();
  const identity = { sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a', attemptId: 'attempt-a' };
  const streamId = 'run-a:turn-a:attempt-a';
  const head = (sequence: number): PublicInferenceStreamProjection => ({ ...identity, inferenceStreamId: streamId, version: sequence,
    status: 'streaming', retainedFromSequence: 1, finalSequence: sequence, updatedAt: NOW,
    chunks: Array.from({ length: sequence }, (_, index) => ({ sequence: index + 1, channel: 'token', text: String(index + 1), observedAt: NOW })) });
  await backend.append(commit(1, [upsertChange('sessions', session('session-a'), 'session-a'), upsertChange('inference_streams', head(1), streamId)]));
  let receive!: (event: RuntimeEventEnvelope) => void;
  const renderer = new RuntimeStore({ ...api(command => readAgentProjectionQuery(backend, command)), onEvent: listener => { receive = listener; return () => undefined; } });
  renderers.push(renderer); await renderer.initialize(); await renderer.sessions.select('session-a');
  expect(renderer.getSnapshot().lastError).toBeNull();
  await backend.append(commit(2, [upsertChange('inference_streams', head(2), streamId)]));
  receive(runtimeEnvelope({ ...identity, contractVersion: '1.0', kind: 'inference.chunk.observed', sequence: 3, channel: 'token', text: '3', observedAt: NOW }, 3));
  await vi.waitFor(() => expect(renderer.getSnapshot().messages[0]?.content).toBe('123'));
  expect(renderer.getSnapshot().lastError).toBeNull();
  receive(runtimeEnvelope({ ...identity, contractVersion: '1.0', kind: 'inference.stream.terminated', finalSequence: 3, state: 'committed', occurredAt: NOW }, 4));
  expect(renderer.getSnapshot().messages.some(item => item.status === 'streaming')).toBe(false);
});

it('loads bounded directories and selected bodies through the actual Renderer store without global reads', async () => {
  const backend = database(), commands: RuntimeCommand[] = [];
  await backend.append(commit(1, Array.from({ length: 150 }, (_, index) => {
    const dto = session(`session-${String(index).padStart(3, '0')}`);
    return upsertChange('sessions', dto, dto.sessionId);
  })));
  const body = { ...run('run-selected', 'completed'), sessionId: 'session-149', interactionMessages: [
    { ...message('embedded-selected', 'session-149'), runId: 'run-selected' }
  ] };
  await backend.append(commit(2, [upsertChange('runs', body, body.runId)]));
  const renderer = new RuntimeStore(api(async command => { commands.push(command); return readAgentProjectionQuery(backend, command); }));
  renderers.push(renderer); await renderer.initialize();
  expect(renderer.getSnapshot()).toMatchObject({ lastError: null, projectionStreamId: backend.streamId, runs: [], messages: [] });
  expect(renderer.getSnapshot().sessions).toHaveLength(128);
  expect(renderer.getSnapshot().projectionWindows.sessions?.page).toMatchObject({ totalRows: 150, hasMore: true });
  await renderer.sessions.select('session-149');
  expect(renderer.getSnapshot()).toMatchObject({ lastError: null, selectedSessionId: 'session-149',
    runs: [{ runId: 'run-selected' }], messages: [{ messageId: 'embedded-selected' }] });
  expect(renderer.getSnapshot().sessions).toHaveLength(129);
  expect(commands.some(command => ['projection.snapshot.get', 'projection.commits.read', 'projection.view.page'].includes(command.kind))).toBe(false);
  expect(commands.filter(command => command.kind === 'projection.catalog.detail')).not.toHaveLength(0);
});

it('replaces embedded history after Run changes while retaining only one Message window', async () => {
  const backend = database();
  const first = { ...run('run-a', 'completed'), interactionMessages: Array.from({ length: 90 }, (_, index) => ({
    ...message(`message-${String(index).padStart(3, '0')}`, 'session-a'), runId: 'run-a'
  })) };
  await backend.append(commit(1, [upsertChange('sessions', session('session-a'), 'session-a'), upsertChange('runs', first, 'run-a')]));
  const repository = new RendererProjectionRepository(new ProjectionRuntimeClient(api(command => readAgentProjectionQuery(backend, command))));
  await repository.synchronize('session-a');
  expect(repository.getSnapshot().messages).toHaveLength(64);
  expect(repository.getSnapshot().messageWindow?.hasEarlier).toBe(true);
  await repository.messageWindow({ kind: 'before', anchorMessageId: repository.getSnapshot().messages[0]!.messageId, limit: 64 });
  expect(repository.getSnapshot().messages).toHaveLength(26);
  expect(repository.getSnapshot().messageWindow?.hasLater).toBe(true);
  const second = { ...first, version: 2, interactionMessages: first.interactionMessages.map(item => ({ ...item, content: 'revised history' })) };
  await backend.append(commit(2, [upsertChange('runs', second, 'run-a')]));
  await repository.synchronize('session-a');
  expect(repository.getSnapshot().messages).toHaveLength(26);
  expect(repository.getSnapshot().messages.every(item => item.bodyState === 'unloaded' && item.content === undefined)).toBe(true);
  for (const item of repository.getSnapshot().messages) await repository.loadMessageBody(item.messageId, item.sessionId, item.bodyReadToken!);
  expect(repository.getSnapshot().messages.every(item => item.content === 'revised history')).toBe(true);
  expect(repository.conversations.usage().entries).toBe(1);
});

it('rejects stale selected-session publication after a delayed read finishes', async () => {
  const backend = database();
  await backend.append(commit(1, ['session-a', 'session-b'].flatMap(id => [
    upsertChange('sessions', session(id), id), upsertChange('messages', message(`message-${id}`, id), `message-${id}`)
  ])));
  const gate = deferred(), received = deferred(); let delay = true;
  const repository = new RendererProjectionRepository(new ProjectionRuntimeClient(api(async command => {
    const result = await readAgentProjectionQuery(backend, command);
    if (command.kind === 'projection.messages.metadata' && command.request.manifest.scope.kind === 'session'
      && command.request.manifest.scope.sessionId === 'session-a' && delay) {
      delay = false; received.resolve(); await gate.promise;
    }
    return result;
  })));
  const older = repository.synchronize('session-a'); await received.promise;
  await repository.synchronize('session-b'); const selected = repository.getSnapshot();
  gate.resolve(); await older;
  expect(repository.getSnapshot()).toBe(selected);
  expect(selected.messages.map(item => item.sessionId)).toEqual(['session-b']);
});

it('preserves trusted presentation during a lease reset and fences a replacement Runtime stream', async () => {
  const first = database(), second = database();
  for (const backend of [first, second]) await backend.append(commit(1, [upsertChange('sessions', session('session-a'), 'session-a')]));
  let backend = first;
  const repository = new RendererProjectionRepository(new ProjectionRuntimeClient(api(command => readAgentProjectionQuery(backend, command))));
  await repository.synchronize(null); const trusted = repository.getSnapshot();
  repository.resetReadRanges(); expect(repository.getSnapshot()).toBe(trusted);
  await repository.synchronize(null, true); expect(repository.getSnapshot().resetEpoch).toBe(trusted.resetEpoch);
  backend = second; repository.resetReadRanges(); await repository.synchronize(null, true);
  expect(repository.getSnapshot().streamId).toBe(second.streamId);
  expect(repository.getSnapshot().resetEpoch).toBe(trusted.resetEpoch + 1);
});

it('paginates the actual current-session Run catalog without changing the global directory', async () => {
  const backend = database();
  const rows = Array.from({ length: 130 }, (_, index) => run(`page-run-${String(index).padStart(3, '0')}`, 'completed'));
  await backend.append(commit(1, [upsertChange('sessions', session('session-a'), 'session-a'), upsertChange('sessions', session('session-b'), 'session-b'),
    ...rows.map(dto => upsertChange('runs', dto, dto.runId)), upsertChange('runs', { ...run('other-session-run'), sessionId: 'session-b' }, 'other-session-run')]));
  const requests: RuntimeCommand[] = [];
  const repository = new RendererProjectionRepository(new ProjectionRuntimeClient(api(command => { requests.push(command); return readAgentProjectionQuery(backend, command); })));
  await repository.synchronize('session-a');
  const global = repository.getSnapshot().taskDirectory;
  expect(repository.getSnapshot().sessionRuns?.page.totalRows).toBe(130);
  expect(repository.getSnapshot().sessionRuns?.page.rows).toHaveLength(128);
  requests.length = 0;
  await repository.navigateSession('runs', 'next');
  const page = repository.getSnapshot().sessionRuns!.page;
  expect(page.pageIndex).toBe(1); expect(page.rows).toHaveLength(2);
  expect(page.rows.every(row => row.feature === 'runs' && row.dto.sessionId === 'session-a')).toBe(true);
  expect(repository.getSnapshot().taskDirectory).toBe(global);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ kind: 'projection.catalog.page', request: { limit: 128, manifest: { feature: 'runs', scope: { kind: 'session', sessionId: 'session-a' } } } });
  await repository.navigateSession('runs', 'previous');
  expect(repository.getSnapshot().sessionRuns?.page.pageIndex).toBe(0);
});

it('does not publish an old session page after a delayed navigation crosses selection', async () => {
  const backend = database();
  await backend.append(commit(1, [upsertChange('sessions', session('session-a'), 'session-a'), upsertChange('sessions', session('session-b'), 'session-b'),
    ...Array.from({ length: 129 }, (_, index) => { const dto = run(`late-page-${String(index).padStart(3, '0')}`, 'completed'); return upsertChange('runs', dto, dto.runId); })]));
  const gate = deferred(), received = deferred();
  const repository = new RendererProjectionRepository(new ProjectionRuntimeClient(api(async command => {
    const result = await readAgentProjectionQuery(backend, command);
    if (command.kind === 'projection.catalog.page' && command.request.pageCursor !== undefined && command.request.manifest.scope.kind === 'session'
      && command.request.manifest.scope.sessionId === 'session-a') { received.resolve(); await gate.promise; }
    return result;
  })));
  await repository.synchronize('session-a');
  const older = repository.navigateSession('runs', 'next'); await received.promise;
  await repository.synchronize('session-b'); const selected = repository.getSnapshot();
  gate.resolve(); await older;
  expect(repository.getSnapshot()).toBe(selected);
  expect(repository.getSnapshot().sessionRuns?.page.manifest.scope).toMatchObject({ sessionId: 'session-b' });
  expect(repository.getSnapshot().sessionRuns?.page.totalRows).toBe(0);
});

function database() { const root = mkdtempSync(path.join(tmpdir(), 'ariadne-renderer-range-'));
  const backend = new SqlitePublicProjectionStore(root); roots.push(root); stores.push(backend); return backend; }
function api(request: (command: RuntimeCommand) => Promise<RuntimeResult>) {
  return { request: async (command: RuntimeCommand) => ({ ok: true as const, value: await request(command) }),
    getStatus: async () => ({ ok: true as const, value: { availability: 'ready' as const, capabilities: [], observedAt: NOW } }),
    onStatus: () => () => undefined, onEvent: () => () => undefined };
}
function commit(cursor: number, changes: PublicProjectionChange[]): ProjectionCommit { return {
  contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, eventId: `event-${cursor}`, sourceId: 'source', sourceCursor: cursor, occurredAt: NOW, changes
}; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
