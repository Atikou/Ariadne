import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, type PublicProjectionChange, type PublicRunProjection,
  type TaskCenterFilter, type TaskCenterNavigation } from '@ariadne/protocol/public';
import type { AgentRun } from '@ariadne/agent-core';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { SqliteTaskQuerySnapshotStore } from '../src/adapters/persistence/SqliteTaskQuerySnapshotStore.js';
import { TaskCenterSourceCollector } from '../src/composition/TaskCenterSourceCollector.js';
import { TaskCenterNavigationResolver } from '../src/composition/TaskCenterNavigationResolver.js';
import { TaskCenterRelationReader } from '../src/composition/TaskCenterRelationReader.js';
import { TaskCenterRuntimeService } from '../src/composition/TaskCenterRuntimeService.js';
import { createTaskCenterCommandOwners } from '../src/composition/TaskCenterPublicCommandOwner.js';
import { runtimeResultSchema } from '@ariadne/protocol/public';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const timestamp = new Date().toISOString();
const filter: TaskCenterFilter = { reference: null, workspaceId: null, sessionId: null, includeArchived: false,
  sources: ['run', 'goal', 'workflow', 'schedule', 'occurrence'], states: [], updatedFrom: null, updatedThrough: null };
type Fixture = Awaited<ReturnType<typeof open>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    const context = createShutdownContext(Date.now() + 5_000);
    try { for (const service of fixture.services) await service.stop(context);
      fixture.index.close(); await fixture.projection.close(context); await fixture.productivity.close(context); await fixture.conversation.close(context); }
    finally { context.dispose(); }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
async function open(authorized = ['workspace-a']) {
  const root = mkdtempSync(join(tmpdir(), 'ariadne-task-sources-'));
  const projection = new SqlitePublicProjectionStore(root), productivity = new SqliteProductivityStore(root);
  const conversation = new SqliteConversationRunHandoffUnitOfWork(root), index = new SqliteTaskQuerySnapshotStore(root);
  const service = new ConversationAuthorityService(conversation);
  for (const owner of ['a', 'b']) await service.createSession({ kind: 'conversation.create_session', commandId: 'create-' + owner,
    eventId: 'create-event-' + owner, sessionId: 'session-' + owner, workspaceId: 'workspace-' + owner, expectedVersion: null, occurredAt: timestamp });
  // These tests use structural Core observations; original Projection/Productivity/Conversation owners are actual SQLite.
  const runs = new Map<string, AgentRun>();
  const sources = { projection, productivity, conversation, index,
    authorizedWorkspaceIds: authorized, loadRun: async (id: string) => runs.get(id) ?? null };
  const collector = new TaskCenterSourceCollector(sources), navigation = new TaskCenterNavigationResolver(sources);
  const fixture = { root, projection, productivity, conversation, index, collector, authorized, runs, navigation,
    sources, services: [] as TaskCenterRuntimeService[] };
  fixtures.push(fixture); return fixture;
}
function session(owner: string): PublicProjectionChange {
  return { feature: 'sessions', operation: 'upsert', aggregateId: 'session-' + owner, aggregateVersion: 1, projectedAt: timestamp,
    dto: { sessionId: 'session-' + owner, workspaceId: 'workspace-' + owner, title: '会话 ' + owner, version: 1, pinned: false,
      status: 'active', createdAt: timestamp, updatedAt: timestamp } };
}
function run(id: string, owner = 'a', version = 1, status: PublicRunProjection['status'] = 'running', parent?: string): PublicProjectionChange {
  return { feature: 'runs', operation: 'upsert', aggregateId: id, aggregateVersion: version, projectedAt: timestamp,
    dto: { runId: id, sessionId: 'session-' + owner, title: '运行 ' + id, version, status, label: '实际状态', updatedAt: timestamp,
      toolActivities: [], inbox: [], interactionMessages: [], ...(parent ? { parentRunId: parent, delegationId: 'delegation-' + id,
        subagentMode: 'one_shot' as const, subagentProviderId: 'fixture' } : {}) } };
}
function decision(): PublicProjectionChange {
  return { feature: 'decisions', operation: 'upsert', aggregateId: 'decision-a', aggregateVersion: 1, projectedAt: timestamp,
    dto: { decisionId: 'decision-a', sessionId: 'session-a', runId: 'run-000', version: 1, kind: 'user_question', status: 'pending',
      requestedAt: timestamp, presentation: { contractVersion: '1.0', kind: 'user_question', headline: '请确认',
        question: 'PRIVATE_QUESTION', allowsFreeText: true },
      action: { contractVersion: '1.0', actionToken: 'decision-action.v1:' + 'a'.repeat(64), choices: ['answer'] } } };
}
async function append(fixture: Fixture, cursor: number, changes: PublicProjectionChange[]) {
  await fixture.projection.append({ contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, eventId: 'event-' + cursor,
    sourceId: 'fixture', sourceCursor: cursor, occurredAt: timestamp, changes });
}
function page(fixture: Fixture) {
  const id = fixture.index.captureCurrent('scope', filter, fixture.collector.watermarks(), fixture.authorized.length ? fixture.authorized : null);
  return fixture.index.page('scope', filter, id, null, 128);
}

describe('task center joins original authorized SQLite source metadata', () => {
  it('scans 130 Runs in bounded batches, preserves Source versions, links parents and excludes foreign workspaces', async () => {
    const fixture = await open();
    await append(fixture, 1, [session('a'), session('b'), decision(), run('foreign', 'b'),
      ...Array.from({ length: 130 }, (_, index) => run('run-' + String(index).padStart(3, '0'), 'a', 1,
        index === 0 ? 'waiting_decision' : 'running', index === 1 ? 'run-000' : undefined))]);
    const sourceBodies = vi.spyOn(fixture.conversation, 'readMessageVersion');
    const sourcePages = vi.spyOn(fixture.projection, 'readCatalogPage');
    await fixture.collector.collect(new AbortController().signal);
    const first = page(fixture);
    expect(first).toMatchObject({ complete: true, indexedTotal: 130, consistency: 'eventual' });
    expect(first.rows.some(row => row.metadata.workspaceId !== 'workspace-a')).toBe(false);
    expect(fixture.index.currentItem({ source: 'run', sourceId: 'run-000' })).toMatchObject({
      metadata: { state: 'waiting_confirmation', version: 1 }, decisions: [{ decisionId: 'decision-a', version: 1 }] });
    expect(fixture.index.currentItem({ source: 'run', sourceId: 'run-001' })?.metadata.relations).toEqual([
      { kind: 'parent', reference: { source: 'run', sourceId: 'run-000' }, owner: { workspaceId: 'workspace-a', sessionId: 'session-a' } }]);
    expect(sourcePages.mock.calls.every(call => call[0].limit === 32)).toBe(true);
    expect(sourceBodies).not.toHaveBeenCalled(); expect(JSON.stringify(first)).not.toMatch(/PRIVATE_QUESTION|decision-action/);
    await append(fixture, 2, [run('run-000', 'a', 2, 'cancelled'), run('inserted-low-key', 'a')]);
    await fixture.collector.collect(new AbortController().signal);
    expect(page(fixture).indexedTotal).toBe(131);
    expect(fixture.index.currentItem({ source: 'run', sourceId: 'run-000' })).toMatchObject({ metadata: { version: 2, state: 'cancelled' }, result: 'unavailable' });
    const second = fixture.index.page('scope', filter, null, first.nextCursor, 128);
    expect([...first.rows, ...second.rows]).toHaveLength(130);
    expect(first.rows.find(row => row.metadata.reference.sourceId === 'run-000')?.metadata.version).toBe(1);
  });
  it('reads actual Productivity and unsubmitted occurrences without copying prompts or inventing execution', async () => {
    const fixture = await open(); await append(fixture, 1, [session('a')]);
    const command = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-a', sessionId: 'session-a' } as const;
    await fixture.productivity.execute('goal', { ...command, kind: 'goal.put', goalId: 'same-id', title: '公开目标',
      expectedVersion: null, phase: 'implementation', status: 'active', roundCap: 8 });
    await fixture.productivity.execute('schedule', { ...command, kind: 'schedule.create', scheduleId: 'same-id',
      prompt: 'PRIVATE_PROMPT', timing: { kind: 'once', at: timestamp, missPolicy: 'run_once' } }, new Date(timestamp));
    await fixture.productivity.materializeDue(new Date(timestamp));
    const bodyRead = vi.spyOn(fixture.conversation, 'readMessageVersion');
    await fixture.collector.collect(new AbortController().signal);
    const result = page(fixture);
    expect(result.indexedTotal).toBe(3); expect(result.complete).toBe(true);
    expect(result.rows.find(row => row.metadata.reference.source === 'occurrence')).toMatchObject({ metadata: { state: 'queued', attempts: 0 }, result: 'none' });
    expect(new Set(result.rows.map(row => row.metadata.reference.source)).size).toBe(3);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROMPT'); expect(bodyRead).not.toHaveBeenCalled();
  });
  it('keeps stale observations visibly partial on Source failure and refresh removes actual projection tombstones', async () => {
    const fixture = await open(); await append(fixture, 1, [session('a'), run('run-000')]);
    await fixture.collector.collect(new AbortController().signal);
    const fail = vi.spyOn(fixture.projection, 'beginCatalogSnapshot').mockRejectedValue(new Error('PRIVATE_PATH'));
    await fixture.collector.collect(new AbortController().signal);
    expect(page(fixture)).toMatchObject({ complete: false, indexedTotal: 1 });
    expect(page(fixture).watermarks.find(mark => mark.source === 'projection')).toMatchObject({
      status: 'unavailable', diagnosticCode: 'task_projection_read_failed' });
    expect(JSON.stringify(page(fixture))).not.toContain('PRIVATE_PATH'); fail.mockRestore();
    await append(fixture, 2, [{ feature: 'runs', operation: 'delete', aggregateId: 'run-000', aggregateVersion: 2, projectedAt: timestamp, dto: null }]);
    await fixture.collector.collect(new AbortController().signal);
    expect(page(fixture)).toMatchObject({ complete: true, indexedTotal: 0 });
  });
  it('keeps a real submitted occurrence with missing Conversation proof visible as unknown and opens only its original recovery owner', async () => {
    const fixture = await open(); await append(fixture, 1, [session('a')]);
    await fixture.productivity.execute('schedule-unknown', { kind: 'schedule.create', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: 'workspace-a', sessionId: 'session-a', scheduleId: 'unknown-schedule', prompt: 'PRIVATE_PROMPT',
      timing: { kind: 'once', at: timestamp, missPolicy: 'run_once' } }, new Date(timestamp));
    await fixture.productivity.materializeDue(new Date(timestamp));
    const occurrence = (await fixture.productivity.pendingOccurrences())[0]!;
    const claimed = await fixture.productivity.claimOccurrence(occurrence.occurrenceId);
    if (!claimed) throw new Error('fixture_claim_missing');
    await fixture.productivity.settleOccurrence(occurrence.occurrenceId, true);
    await fixture.collector.collect(new AbortController().signal);
    const result = page(fixture), row = result.rows.find(row => row.metadata.reference.source === 'occurrence')!;
    expect(result.complete).toBe(false);
    expect(row).toMatchObject({ metadata: { sourceStatus: 'submitted', attempts: 1, state: 'unknown', runReferences: [] }, result: 'unavailable' });
    expect(result.watermarks.find(mark => mark.source === 'productivity')?.diagnosticCode).toBe('task_execution_join_incomplete');
    const mutations = vi.spyOn(fixture.productivity, 'execute');
    expect(await fixture.navigation.resolve({ kind: 'tasks.navigate', contractVersion: '1.0', reference: row.metadata.reference,
      workspaceId: row.metadata.workspaceId, sessionId: row.metadata.sessionId, expectedVersion: null, expectedAttempts: 1,
      expectedSourceStatus: 'submitted', destination: 'recovery', decisionId: null, expectedDecisionVersion: null }, new AbortController().signal))
      .toMatchObject({ status: 'ok', target: { moduleId: 'productivity.control', runId: null } });
    expect(mutations).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('PRIVATE_PROMPT');
  });
  it('publishes initial building coverage, obeys explicit query scope and stops on cancellation without sealing a false success', async () => {
    const fixture = await open([]); await append(fixture, 1, [session('a'), session('b'), run('a'), run('b', 'b')]);
    expect(page(fixture)).toMatchObject({ complete: false, indexedTotal: 0 });
    await fixture.collector.collect(new AbortController().signal);
    const id = fixture.index.captureCurrent('restricted', filter, fixture.collector.watermarks(), ['workspace-a']);
    expect(fixture.index.page('restricted', filter, id, null, 128).indexedTotal).toBe(1);
    const denied = fixture.index.captureCurrent('none', filter, fixture.collector.watermarks(), []);
    expect(fixture.index.page('none', filter, denied, null, 128).indexedTotal).toBe(0);
    const abort = new AbortController(); abort.abort();
    await expect(fixture.collector.collect(abort.signal)).rejects.toThrow();
    expect(fixture.collector.watermarks().every(mark => mark.status === 'building')).toBe(true);
  });
});

describe('versioned task Source relation navigation', () => {
  it('reaches every authorized real SQLite association while omitting an unowned synthetic Core reference', async () => {
    const fixture = await open(), now = new Date(timestamp);
    const owner = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-a', sessionId: 'session-a' } as const;
    await fixture.productivity.execute('relations-goal', { ...owner, kind: 'goal.put', goalId: 'relations-goal', expectedVersion: null,
      title: '关联目标', phase: 'implementation', status: 'active', roundCap: 8 }, now);
    const todoIds = Array.from({ length: 40 }, (_, index) => 'relations-todo-' + index);
    await fixture.productivity.execute('relations-todos', { ...owner, kind: 'todo.snapshot.replace', goalId: 'relations-goal',
      expectedGoalVersion: 1, expectedRevision: null, items: todoIds.map(todoId => ({ todoId, title: todoId, status: 'pending' as const })) }, now);
    await fixture.productivity.execute('relations-workflow', { ...owner, kind: 'workflow.start', workflowId: 'relations-workflow', goalId: 'relations-goal',
      expectedGoalVersion: 1, expectedTodoRevision: 1, todoIds, maxConcurrency: 1, maxTransitions: 40,
      deadlineAt: '2099-01-01T00:00:00.000Z', executionMode: 'agent' }, now, { sourceSessionId: 'session-a', sourceSessionVersion: 1 });
    for (const [index, todoId] of todoIds.entries()) {
      const runId = 'synthetic-relations-run-' + index;
      expect(await fixture.productivity.claimWorkflowAgentTask('relations-workflow', todoId, now)).not.toBeNull();
      await fixture.productivity.recordWorkflowAgentSubmission('relations-workflow', todoId, runId, now);
      await fixture.productivity.settleWorkflowAgentTask('relations-workflow', todoId, 'completed', 'PRIVATE_RESULT_BODY', now, { runId, runVersion: 3 });
    }
    const reference = { source: 'workflow', sourceId: 'relations-workflow' } as const;
    const metadata = (await fixture.productivity.readTaskCatalogItem({ workspaceIds: ['workspace-a'], session: null }, reference))!;
    const sourceLinks = await fixture.productivity.readTaskRelations({ workspaceIds: ['workspace-a'], session: null }, reference,
      { version: metadata.version, attempts: null }, 0, 128);
    if (sourceLinks.status !== 'ok') throw new Error('fixture_source_relations_missing');
    const authority = new ConversationAuthorityService(fixture.conversation);
    for (const [index, link] of sourceLinks.rows.filter(link => link.reference.source === 'run').entries()) {
      await authority.createSession({ kind: 'conversation.create_session', commandId: 'relation-owner-' + index,
        eventId: 'relation-owner-event-' + index, sessionId: link.owner.sessionId, workspaceId: link.owner.workspaceId,
        expectedVersion: null, occurredAt: timestamp });
      fixture.runs.set(link.reference.sourceId, { runId: link.reference.sourceId,
        binding: { workspace: { workspaceId: link.reference.sourceId.endsWith('-39') ? 'workspace-b' : link.owner.workspaceId }, sessionId: link.owner.sessionId } } as unknown as AgentRun);
    }
    const reader = new TaskCenterRelationReader(fixture.sources), body = vi.spyOn(fixture.conversation, 'readMessageVersion');
    let offset: number | null = 0; const seen: string[] = [];
    do {
      const response = await reader.read({ kind: 'tasks.relations', contractVersion: '1.0', reference, workspaceId: 'workspace-a', sessionId: 'session-a',
        expectedVersion: metadata.version, expectedAttempts: null, expectedSourceStatus: metadata.sourceStatus, afterIndex: offset, limit: 13 }, new AbortController().signal);
      runtimeResultSchema.parse(response); expect(response.status).toBe('ok'); expect(response.sourceTotal).toBe(41);
      seen.push(...response.rows.map(link => link.reference.sourceId)); offset = response.nextIndex;
      expect(JSON.stringify(response)).not.toContain('PRIVATE_RESULT_BODY');
    } while (offset !== null);
    expect(seen).toHaveLength(40); expect(new Set(seen).size).toBe(40);
    expect(seen).not.toContain('synthetic-relations-run-39'); expect(body).not.toHaveBeenCalled();
  });
  it('rejects a real Source version change during relation reading and checks authorization before Source reads', async () => {
    const fixture = await open(), now = new Date(timestamp);
    const owner = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-a', sessionId: 'session-a' } as const;
    await fixture.productivity.execute('relations-change-goal', { ...owner, kind: 'goal.put', goalId: 'relations-change-goal', expectedVersion: null,
      title: '原目标', phase: 'implementation', status: 'active', roundCap: 8 }, now);
    const request = { kind: 'tasks.relations' as const, contractVersion: '1.0' as const, reference: { source: 'goal' as const, sourceId: 'relations-change-goal' },
      workspaceId: 'workspace-a', sessionId: 'session-a', expectedVersion: 1, expectedAttempts: null, expectedSourceStatus: 'active', afterIndex: 0, limit: 13 };
    const original = fixture.productivity.readTaskRelations.bind(fixture.productivity);
    const read = vi.spyOn(fixture.productivity, 'readTaskRelations').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await fixture.productivity.execute('relations-source-update', { ...owner, kind: 'goal.put', goalId: 'relations-change-goal', expectedVersion: 1,
        title: '已更新目标', phase: 'implementation', status: 'active', roundCap: 8 }, now); return result;
    });
    const reader = new TaskCenterRelationReader(fixture.sources), signal = new AbortController().signal;
    expect(await reader.read(request, signal)).toMatchObject({ status: 'stale', rows: [], sourceTotal: null, nextIndex: null });
    read.mockClear(); expect(await reader.read({ ...request, workspaceId: 'workspace-b' }, signal)).toMatchObject({ status: 'unauthorized', rows: [] });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('production task read owners and background lifecycle', () => {
  it('returns a bounded initial building snapshot while one Source scan is pending, then publishes current metadata', async () => {
    const fixture = await open(); await append(fixture, 1, [session('a'), run('run-000')]);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { entered = resolve; });
    const original = fixture.projection.readCatalogPage.bind(fixture.projection);
    let calls = 0;
    vi.spyOn(fixture.projection, 'readCatalogPage').mockImplementation(async request => {
      calls++; if (calls === 1) { entered(); await gate; } return original(request);
    });
    const service = new TaskCenterRuntimeService(fixture.sources); fixture.services.push(service); service.start();
    await seen;
    const query = { kind: 'tasks.query' as const, contractVersion: '1.0' as const, filter, cursor: null, limit: 32, refresh: false };
    const pending = await service.query(query, new AbortController().signal);
    expect(pending).toMatchObject({ kind: 'tasks.query_result', complete: false, indexedTotal: 0 });
    service.refresh(); service.refresh(); expect(calls).toBe(1);
    release();
    let current = pending;
    for (let attempt = 0; attempt < 200; attempt++) {
      current = await service.query(query, new AbortController().signal);
      if (current.kind === 'tasks.query_result' && current.complete) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(current).toMatchObject({ kind: 'tasks.query_result', complete: true, indexedTotal: 1 });
    expect(runtimeResultSchema.safeParse(current).success).toBe(true);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(service.query(query, cancelled.signal)).rejects.toThrow();
    expect(await service.query({ ...query, cursor: 'a.b' }, new AbortController().signal)).toMatchObject({
      kind: 'tasks.query_reset', reason: 'invalid_cursor' });
    const context = createShutdownContext(Date.now() + 5_000);
    try { await service.stop(context); } finally { context.dispose(); }
    expect(await service.query(query, new AbortController().signal)).toMatchObject({ kind: 'tasks.query_reset', reason: 'unavailable' });
  });
  it('routes query/nav as read-only owners, reports a missing observer, and does not reconcile a business commit', async () => {
    const fixture = await open(), service = new TaskCenterRuntimeService(fixture.sources); fixture.services.push(service);
    const owners = createTaskCenterCommandOwners(service);
    const command = { kind: 'tasks.query' as const, contractVersion: '1.0' as const, filter, cursor: null, limit: 32, refresh: false };
    const envelope = { commandId: 'query', correlationId: 'query', deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      signal: new AbortController().signal, command };
    expect(await owners[0]!.execute(envelope)).toMatchObject({ settlement: 'completed', outcome: { ok: true,
      result: { kind: 'tasks.query_result', complete: false } } });
    expect(await owners[0]!.reconcile(envelope)).toEqual({ kind: 'not_committed' });
    expect(await createTaskCenterCommandOwners(undefined)[0]!.execute(envelope)).toMatchObject({ outcome: { ok: true,
      result: { kind: 'tasks.query_reset', reason: 'unavailable' } } });
  });
});

describe('task navigation revalidates original owners without mutation', () => {
  const request: TaskCenterNavigation = { kind: 'tasks.navigate', contractVersion: '1.0',
    reference: { source: 'goal', sourceId: 'goal-a' }, workspaceId: 'workspace-a', sessionId: 'session-a',
    expectedVersion: 1, expectedAttempts: null, expectedSourceStatus: 'active', destination: 'details',
    decisionId: null, expectedDecisionVersion: null };
  async function goal(fixture: Fixture) {
    await fixture.productivity.execute('goal-a', { kind: 'goal.put', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: 'workspace-a', sessionId: 'session-a', goalId: 'goal-a', expectedVersion: null,
      title: '公开目标', phase: 'implementation', status: 'active', roundCap: 8 });
  }
  it('returns an exact original module route, detects Source CAS changes and exports no inaccessible metadata', async () => {
    const fixture = await open(); await goal(fixture);
    const mutations = vi.spyOn(fixture.productivity, 'execute');
    const signal = new AbortController().signal;
    expect(await fixture.navigation.resolve(request, signal)).toMatchObject({ status: 'ok', current: { version: 1 },
      target: { moduleId: 'productivity.control', workspaceId: 'workspace-a', sessionId: 'session-a', runId: null } });
    expect(mutations).not.toHaveBeenCalled();
    const reads = vi.spyOn(fixture.conversation, 'readSession'); reads.mockClear();
    expect(await fixture.navigation.resolve({ ...request, workspaceId: 'workspace-b' }, signal)).toMatchObject({ status: 'unauthorized', current: null, target: null });
    expect(reads).not.toHaveBeenCalled();
    expect(await fixture.navigation.resolve({ ...request, sessionId: 'session-b' }, signal)).toMatchObject({ status: 'missing', current: null });
    await fixture.productivity.execute('update-goal', { kind: 'goal.put', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: 'workspace-a', sessionId: 'session-a', goalId: 'goal-a', expectedVersion: 1,
      title: '新版本', phase: 'implementation', status: 'active', roundCap: 8 });
    expect(await fixture.navigation.resolve(request, signal)).toMatchObject({ status: 'stale', current: { version: 2 }, target: null });
  });
  it('rechecks a changing Source at the final navigation boundary and reports an archived owner explicitly', async () => {
    const fixture = await open(); await goal(fixture);
    const original = fixture.productivity.readTaskCatalogItem.bind(fixture.productivity);
    let reads = 0;
    vi.spyOn(fixture.productivity, 'readTaskCatalogItem').mockImplementation(async (...args) => {
      const item = await original(...args); reads++;
      return reads === 2 && item ? { ...item, version: item.version! + 1 } : item;
    });
    expect(await fixture.navigation.resolve(request, new AbortController().signal)).toMatchObject({ status: 'stale', target: null });
    await new ConversationAuthorityService(fixture.conversation).mutateSession({ kind: 'conversation.mutate_session',
      commandId: 'archive-a', eventId: 'archive-event-a', workspaceId: 'workspace-a', sessionId: 'session-a',
      expectedSessionVersion: 1, mutation: { kind: 'set_status', status: 'archived' }, occurredAt: new Date().toISOString() });
    expect(await fixture.navigation.resolve(request, new AbortController().signal)).toMatchObject({ status: 'archived', target: null });
  });
  it('opens the exact pending decision and refuses a replaced Core version or unrelated decision', async () => {
    const fixture = await open(); await append(fixture, 1, [session('a'), run('run-000', 'a', 1, 'waiting_decision'), decision()]);
    const core = { runId: 'run-000', version: 1, updatedAt: timestamp,
      binding: { workspace: { workspaceId: 'workspace-a' }, sessionId: 'session-a' },
      state: { status: 'waiting', reason: 'user_question', decision: { decisionId: 'decision-a', kind: 'user_question' } } } as unknown as AgentRun;
    fixture.runs.set('run-000', core);
    const exact = { ...request, reference: { source: 'run' as const, sourceId: 'run-000' }, expectedSourceStatus: 'waiting_decision',
      destination: 'decision' as const, decisionId: 'decision-a', expectedDecisionVersion: 1 };
    const signal = new AbortController().signal;
    expect(await fixture.navigation.resolve(exact, signal)).toMatchObject({ status: 'ok', target: { moduleId: 'chat.main',
      runId: 'run-000', expectedRunVersion: 1, decisionId: 'decision-a', expectedDecisionVersion: 1 } });
    expect(await fixture.navigation.resolve({ ...exact, decisionId: 'unrelated' }, signal)).toMatchObject({ status: 'stale', target: null });
    fixture.runs.set('run-000', { ...core, version: 2 });
    expect(await fixture.navigation.resolve(exact, signal)).toMatchObject({ status: 'stale', current: { version: 2 }, target: null });
  });
});
