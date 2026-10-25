import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import { SqliteProductivityStore, SCHEDULE_SUBMISSION_MAX_ATTEMPTS } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { createAgentConversationComponent } from '../src/composition/agent-entity/components/conversation/AgentConversationComponent.js';
import type { AgentControlExecutionPipeline } from '../src/composition/ProductionAgentControlExecutionPipelineFactory.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { DatabaseSync } from 'node:sqlite';
import { ScheduleWorker } from '../src/composition/ScheduleWorker.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const stores: SqliteProductivityStore[] = [];
const roots: string[] = [];
const workers: ScheduleWorker[] = [];
const conversations: SqliteConversationRunHandoffUnitOfWork[] = [];
const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-1', sessionId: 'session-1' } as const;
const clock = new Date('2098-01-01T00:00:00Z');
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop().catch(() => undefined);
  for (const store of stores.splice(0)) {
    const context = createShutdownContext(Date.now() + 5_000);
    try { await store.close(context); } finally { context.dispose(); }
  }
  for (const conversation of conversations.splice(0)) {
    const context = createShutdownContext(Date.now() + 5_000);
    try { await conversation.close(context); } finally { context.dispose(); }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function open(dataRoot?: string) {
  const root = dataRoot ?? mkdtempSync(path.join(os.tmpdir(), 'ariadne-productivity-invariants-'));
  if (dataRoot === undefined) roots.push(root);
  const store = new SqliteProductivityStore(root); stores.push(store);
  return { store, root };
}
async function workflow(store: SqliteProductivityStore, maxConcurrency = 2) {
  await store.execute('goal', { ...scope, kind: 'goal.put', goalId: 'goal-1', expectedVersion: null, title: 'Release', phase: 'implementation', status: 'active', roundCap: 8 }, clock);
  await store.execute('todos', { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal-1', expectedGoalVersion: 1, expectedRevision: null, items: ['one', 'two', 'three'].map(todoId => ({ todoId, title: todoId, status: 'pending' as const })) }, clock);
  await store.execute('start', { ...scope, kind: 'workflow.start', workflowId: 'workflow-1', goalId: 'goal-1', expectedGoalVersion: 1, expectedTodoRevision: 1, todoIds: ['one', 'two', 'three'], maxConcurrency, maxTransitions: 3, deadlineAt: '2098-01-01T00:01:00Z' }, clock);
}
async function due(store: SqliteProductivityStore, once = false) {
  await store.execute('schedule', { ...scope, kind: 'schedule.create', scheduleId: 'schedule-1', prompt: 'Continue the session', timing: once ? { kind: 'once', at: '2098-01-01T00:00:01Z', missPolicy: 'run_once' } : { kind: 'interval', intervalMs: 1_000 } }, clock);
  await store.materializeDue(new Date(clock.getTime() + 1_000));
  return (await store.pendingOccurrences())[0]!;
}
const activeConversation = () => ({ readCommittedAuthorityCommand: async () => null, readSession: async () => ({ ...scope, version: 7, status: 'active' }) }) as unknown as SqliteConversationRunHandoffUnitOfWork;
function worker(store: SqliteProductivityStore, dispatch: ConstructorParameters<typeof ScheduleWorker>[2], timeoutMs = 120_000, conversation = activeConversation(), interval = 60_000) {
  const value = new ScheduleWorker(store, conversation, dispatch, interval, timeoutMs); workers.push(value); return value;
}
const accepted = { settlement: 'completed', outcome: { ok: true, result: { kind: 'conversation.message.accepted', sessionId: 'session-1', sessionVersion: 8, messageId: 'message-1', messageVersion: 1, sagaId: 'saga-1' } } } as const;

function productionOwner(conversation: SqliteConversationRunHandoffUnitOfWork) {
  const pipeline = {
    runWorkScheduler: { assertHealthy() {} }, executionScheduler: { assertHealthy() {}, wake() {} },
    handoffProducer: { assertHealthy() {}, wake() {} }, assertConversationMessageAdmission() {}
  } as unknown as AgentControlExecutionPipeline;
  return createAgentConversationComponent({ conversation, executionPipeline: pipeline,
    wakeProjectionDrain() {}, options: { commandNow: () => new Date(clock.getTime() + 2_000) }
  });
}

describe('productivity authority invariants', () => {
  it('failure terminalizes every remaining task exactly once and survives restart', async () => {
    const { store, root } = open(); await workflow(store);
    await store.execute('failed', { ...scope, kind: 'workflow.advance', workflowId: 'workflow-1', expectedVersion: 1, completed: [{ todoId: 'one', outcome: 'failed', summary: 'failed one' }] }, clock);
    const context = createShutdownContext(Date.now() + 5_000);
    try { await store.close(context); } finally { context.dispose(); }
    const recovered = open(root).store;
    const snapshot = await recovered.query(scope.workspaceId, scope.sessionId);
    expect(snapshot.workflows[0]).toMatchObject({ status: 'failed', version: 2, activeTodoIds: [], pendingTodoIds: [], results: [
      { todoId: 'one', outcome: 'failed' }, { todoId: 'two', outcome: 'cancelled' }, { todoId: 'three', outcome: 'cancelled' }
    ] });
    expect(snapshot.todos.map(item => item.status)).toEqual(['failed', 'cancelled', 'cancelled']);
  });

  it.each(['remove', 'retitle', 'state'] as const)('rejects %s of bound tasks but permits independent additions', async mutation => {
    const { store } = open(); await workflow(store);
    const before = await store.query(scope.workspaceId, scope.sessionId);
    const items = before.todos.map(({ ordinal: _ordinal, ...item }) => item);
    if (mutation === 'remove') items.splice(2, 1);
    if (mutation === 'retitle') items[2]!.title = 'changed';
    if (mutation === 'state') items[2]!.status = 'completed';
    await expect(store.execute('invalid', { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal-1', expectedGoalVersion: 2, expectedRevision: 2, items }, clock)).rejects.toThrow('todo_bound_to_running_workflow');
    expect(await store.query(scope.workspaceId, scope.sessionId)).toEqual(before);
    await store.execute('append', { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal-1', expectedGoalVersion: 2, expectedRevision: 2, items: [...before.todos.map(({ ordinal: _ordinal, ...item }) => item), { todoId: 'four', title: 'four', status: 'pending' }] }, clock);
    expect((await store.query(scope.workspaceId, scope.sessionId)).todos).toHaveLength(4);
  });

  it('does not let a second workflow claim a queued task', async () => {
    const { store } = open(); await workflow(store);
    await expect(store.execute('second', { ...scope, kind: 'workflow.start', workflowId: 'workflow-2', goalId: 'goal-1', expectedGoalVersion: 2, expectedTodoRevision: 2, todoIds: ['three'], maxConcurrency: 1, maxTransitions: 1, deadlineAt: '2098-01-01T01:00:00Z' }, clock)).rejects.toThrow('workflow_todo_unavailable');
    expect((await store.query(scope.workspaceId, scope.sessionId)).goal?.roundsUsed).toBe(1);
  });

  it('rejects a workflow budget that cannot finish its selected tasks', async () => {
    const { store } = open(); await workflow(store);
    await store.execute('cancel', { ...scope, kind: 'workflow.cancel', workflowId: 'workflow-1', expectedVersion: 1 }, clock);
    await expect(store.execute('budget', { ...scope, kind: 'workflow.start', workflowId: 'workflow-2', goalId: 'goal-1', expectedGoalVersion: 2, expectedTodoRevision: 3, todoIds: ['one', 'two'], maxConcurrency: 1, maxTransitions: 1, deadlineAt: '2098-01-01T01:00:00Z' }, clock)).rejects.toThrow('workflow_budget_insufficient');
  });

  it('expires without user advancement at the exact deadline and does not repeat terminalization', async () => {
    const { store } = open(); await workflow(store);
    await store.materializeDue(new Date('2098-01-01T00:01:00Z'));
    const expired = await store.query(scope.workspaceId, scope.sessionId);
    expect(expired.workflows[0]).toMatchObject({ status: 'failed', version: 2, activeTodoIds: [], pendingTodoIds: [] });
    expect(expired.workflows[0]?.results).toHaveLength(3);
    expect(expired.todoRevision).toBe(3);
    await store.materializeDue(new Date('2098-01-01T00:10:00Z'));
    expect(await store.query(scope.workspaceId, scope.sessionId)).toEqual(expired);
  });

  it.each([false, true])('cancellation withdraws an unclaimed occurrence (once=%s)', async once => {
    const { store } = open(); const occurrence = await due(store, once);
    await store.execute('cancel', { ...scope, kind: 'schedule.transition', scheduleId: 'schedule-1', expectedVersion: 2, action: 'cancel' }, clock);
    expect(await store.pendingOccurrences()).toEqual([]);
    expect(await store.claimOccurrence(occurrence.occurrenceId)).toBe(false);
    const dispatch = vi.fn(async () => accepted);
    await worker(store, dispatch).start();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['2098-01-01T08:00:01+08:00', '2098-01-01T00:00:01Z'])('reads an existing schema-1 due time by instant: %s', async storedAt => {
    const { store, root } = open();
    const created = await store.execute('schedule', { ...scope, kind: 'schedule.create', scheduleId: 'schedule-1', prompt: 'Task',
      timing: { kind: 'once', at: storedAt, missPolicy: 'run_once' } }, clock);
    expect(created).toMatchObject({ schedule: { nextFireAt: '2098-01-01T00:00:01.000Z' } });
    const context = createShutdownContext(Date.now() + 5_000);
    try { await store.close(context); } finally { context.dispose(); }
    // Schema 1 previously wrote this valid public datetime verbatim. Preserve and exercise that data contract.
    const database = new DatabaseSync(path.join(root, 'data', 'productivity', 'productivity.db'));
    try {
      const row = database.prepare('SELECT schedule_json FROM productivity_schedules').get() as { schedule_json: string };
      database.prepare('UPDATE productivity_schedules SET next_fire_at=?,schedule_json=?').run(storedAt, JSON.stringify({ ...JSON.parse(row.schedule_json), nextFireAt: storedAt }));
    } finally { database.close(); }
    const recovered = open(root).store;
    await recovered.materializeDue(new Date('2098-01-01T00:00:01.000Z'));
    expect(await recovered.pendingOccurrences()).toHaveLength(1);
  });

  it('checks authority again when cancellation races a session read', async () => {
    const { store } = open(); await due(store);
    let finish!: (value: unknown) => void;
    const conversation = { readCommittedAuthorityCommand: async () => null, readSession: () => new Promise(resolve => { finish = resolve; }) } as unknown as SqliteConversationRunHandoffUnitOfWork;
    const dispatch = vi.fn(async () => accepted);
    const starting = worker(store, dispatch, 120_000, conversation).start();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await store.execute('cancel', { ...scope, kind: 'schedule.transition', scheduleId: 'schedule-1', expectedVersion: 2, action: 'cancel' }, clock);
    finish({ ...scope, version: 7, status: 'active' });
    await starting;
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('pause holds unclaimed work and resume releases the same identity', async () => {
    const { store } = open(); const occurrence = await due(store);
    await store.execute('pause', { ...scope, kind: 'schedule.transition', scheduleId: 'schedule-1', expectedVersion: 2, action: 'pause' }, clock);
    expect(await store.pendingOccurrences()).toEqual([]);
    expect(await store.claimOccurrence(occurrence.occurrenceId)).toBe(false);
    await store.execute('resume', { ...scope, kind: 'schedule.transition', scheduleId: 'schedule-1', expectedVersion: 3, action: 'resume' }, clock);
    expect(await store.pendingOccurrences()).toEqual([occurrence]);
  });

  it('retains an already claimed submission across cancellation and restart', async () => {
    const { store, root } = open(); const occurrence = await due(store);
    expect(await store.claimOccurrence(occurrence.occurrenceId)).toBe(true);
    await store.execute('cancel', { ...scope, kind: 'schedule.transition', scheduleId: 'schedule-1', expectedVersion: 2, action: 'cancel' }, clock);
    const context = createShutdownContext(Date.now() + 5_000);
    try { await store.close(context); } finally { context.dispose(); }
    const recovered = open(root).store;
    expect(await recovered.pendingOccurrences()).toEqual([]);
    expect(await recovered.claimedOccurrences()).toEqual([{ ...occurrence, attempts: 1 }]);
    await recovered.settleOccurrence(occurrence.occurrenceId, true);
    expect(await recovered.pendingOccurrences()).toEqual([]);
  });

  it('persists the retry cap and terminal rejection', async () => {
    const { store } = open(); const occurrence = await due(store);
    for (let attempt = 0; attempt < SCHEDULE_SUBMISSION_MAX_ATTEMPTS; attempt++) {
      const attemptTime = new Date(clock.getTime() + attempt * 61_000);
      expect(await store.claimOccurrence(occurrence.occurrenceId, attemptTime)).toBe(true);
      await store.settleOccurrence(occurrence.occurrenceId, false, 'temporary', true, attemptTime);
    }
    expect(await store.pendingOccurrences()).toEqual([]);
    expect(await store.claimOccurrence(occurrence.occurrenceId)).toBe(false);
  });
});

describe('schedule worker lifecycle', () => {
  it('refreshes the Conversation CAS input after a user turn races schedule admission', async () => {
    const { store, root } = open(); await due(store, true);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root); conversations.push(conversation);
    await new ConversationAuthorityService(conversation).createSession({
      kind: 'conversation.create_session', commandId: 'create-session-1', eventId: 'create-event-1',
      sessionId: scope.sessionId, workspaceId: scope.workspaceId, expectedVersion: null, occurredAt: clock.toISOString()
    });
    const owner = productionOwner(conversation);
    let submissions = 0;
    const dispatch = async (envelope: Parameters<ConstructorParameters<typeof ScheduleWorker>[2]>[0]) => {
      if (envelope.command.kind !== 'conversation.message.accept') throw new Error('wrong command');
      if (submissions++ === 0) {
        const intervening = { ...envelope, commandId: 'intervening-message-command', command: {
          ...envelope.command, messageId: 'intervening-message', content: 'Other user turn'
        } };
        expect((await owner.executeAcceptMessage(intervening, intervening.command)).outcome.ok).toBe(true);
      }
      return owner.executeAcceptMessage(envelope, envelope.command);
    };
    const value = worker(store, dispatch, 120_000, conversation);
    await value.start();
    expect(await store.pendingOccurrences()).toEqual([]);
    expect((await store.queryOccurrences({ ...scope, kind: 'schedule.occurrences.query', before: null, limit: 50 })).occurrences[0]?.attempts).toBe(1);
    expect((await conversation.readSession(scope.sessionId))?.version).toBe(2);
    const later = Date.now() + 1_001;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await value.wake();
    expect(submissions).toBe(2);
    expect((await conversation.readSession(scope.sessionId))?.version).toBe(3);
    expect(await store.pendingOccurrences()).toEqual([]);
  });

  it('recovers through the production Conversation owner after acceptance committed but settlement failed', async () => {
    const { store, root } = open(); const occurrence = await due(store, true);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root); conversations.push(conversation);
    await new ConversationAuthorityService(conversation).createSession({
      kind: 'conversation.create_session', commandId: 'create-session-1', eventId: 'create-event-1',
      sessionId: scope.sessionId, workspaceId: scope.workspaceId, expectedVersion: null, occurredAt: clock.toISOString()
    });
    // Only the execution wake/admission boundary is a fixture; commands and both databases are production.
    const pipeline = {
      runWorkScheduler: { assertHealthy() {} }, executionScheduler: { assertHealthy() {}, wake() {} },
      handoffProducer: { assertHealthy() {}, wake() {} }, assertConversationMessageAdmission() {}
    } as unknown as AgentControlExecutionPipeline;
    const owner = createAgentConversationComponent({ conversation, executionPipeline: pipeline,
      wakeProjectionDrain() {}, options: { commandNow: () => new Date(clock.getTime() + 2_000) }
    });
    const submit = async (envelope: Parameters<ConstructorParameters<typeof ScheduleWorker>[2]>[0]) => {
      if (envelope.command.kind !== 'conversation.message.accept') throw new Error('wrong command');
      return owner.executeAcceptMessage(envelope, envelope.command);
    };
    const fault = vi.spyOn(store, 'settleOccurrence').mockRejectedValueOnce(new Error('lost_settlement'));
    await expect(worker(store, submit, 120_000, conversation).start()).rejects.toThrow('lost_settlement');
    fault.mockRestore();
    expect((await conversation.readSession(scope.sessionId))?.version).toBe(2);
    const envelope = {
      commandId: 'intervening-message-command', correlationId: 'intervening-correlation',
      deadlineAt: new Date(Date.now() + 10_000).toISOString(), signal: new AbortController().signal,
      command: { ...scope, kind: 'conversation.message.accept' as const, expectedSessionVersion: 2,
        messageId: 'intervening-message', content: 'Other user message', execution: { mode: 'agent' as const } }
    };
    expect((await submit(envelope))?.outcome.ok).toBe(true);
    const shutdown = createShutdownContext(Date.now() + 5_000);
    try { await store.close(shutdown); await conversation.close(shutdown); } finally { shutdown.dispose(); }
    const recoveredStore = open(root).store;
    const recoveredConversation = new SqliteConversationRunHandoffUnitOfWork(root); conversations.push(recoveredConversation);
    const recoveredOwner = createAgentConversationComponent({ conversation: recoveredConversation,
      executionPipeline: pipeline, wakeProjectionDrain() {}, options: { commandNow: () => new Date(clock.getTime() + 3_000) }
    });
    const recoveredDispatch = vi.fn(async (retry: Parameters<typeof submit>[0]) => {
      if (retry.command.kind !== 'conversation.message.accept') throw new Error('wrong command');
      return recoveredOwner.executeAcceptMessage(retry, retry.command);
    });
    await worker(recoveredStore, recoveredDispatch, 120_000, recoveredConversation).start();
    expect(recoveredDispatch).not.toHaveBeenCalled(); // The exact committed message settles the durable claim without another submission.
    expect((await recoveredConversation.readSession(scope.sessionId))?.version).toBe(3);
    expect(await recoveredStore.pendingOccurrences()).toEqual([]);
    const database = new DatabaseSync(path.join(root, 'data', 'conversation', 'conversation.db'), { readOnly: true });
    try {
      expect(database.prepare('SELECT count(*) AS count FROM conversation_message_heads').get()).toMatchObject({ count: 2 });
      expect(database.prepare('SELECT count(*) AS count FROM conversation_handoff_sagas').get()).toMatchObject({ count: 2 });
    } finally { database.close(); }
  });

  it('uses the committed receipt CAS version after an uncertain submission', async () => {
    const { store } = open(); const occurrence = await due(store);
    await store.claimOccurrence(occurrence.occurrenceId);
    await store.settleOccurrence(occurrence.occurrenceId, false, 'schedule_submission_uncertain');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_001);
    const { digestConversationMessagePayload } = await import('../src/conversation/ConversationAuthority.js');
    const contentDigest = await digestConversationMessagePayload({ content: occurrence.prompt, execution: { mode: 'agent' } });
    const conversation = {
      readCommittedAuthorityCommand: async () => ({ receipt: { ...scope, kind: 'conversation.accept_user_message', messageId: occurrence.messageId, messageVersion: 1, resultingSessionVersion: 8 } }),
      readMessageVersion: async () => ({ workspaceId: scope.workspaceId, sessionId: scope.sessionId, role: 'user', contentDigest }),
      readSession: vi.fn(async () => ({ ...scope, version: 42, status: 'active' }))
    } as unknown as SqliteConversationRunHandoffUnitOfWork;
    const dispatch = vi.fn(async () => accepted);
    await worker(store, dispatch, 120_000, conversation).start();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ commandId: occurrence.commandId, command: { expectedSessionVersion: 7 } });
    expect(conversation.readSession).not.toHaveBeenCalled();
    expect(await store.pendingOccurrences()).toEqual([]);
  });

  it('terminates a nonretryable public rejection', async () => {
    const { store } = open(); await due(store);
    const dispatch = vi.fn(async () => ({ settlement: 'completed', outcome: { ok: false, error: { code: 'session_missing', message: 'missing', retryable: false } } } as const));
    const value = worker(store, dispatch); await value.start(); await value.wake();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await store.pendingOccurrences()).toEqual([]);
  });

  it('aborts the active submission when stop races startup and installs no new timer', async () => {
    const { store } = open(); await due(store);
    let signal: AbortSignal | undefined;
    const dispatch = vi.fn(async envelope => { signal = envelope.signal; await new Promise((_resolve, reject) => envelope.signal.addEventListener('abort', () => reject(envelope.signal.reason), { once: true })); return accepted; });
    const value = worker(store, dispatch);
    const starting = value.start();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await value.stop(); await starting;
    expect(signal?.aborted).toBe(true);
    await value.wake(); expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('enforces the submission deadline through AbortSignal', async () => {
    const { store } = open(); await due(store);
    let reason: unknown;
    const dispatch = async (envelope: Parameters<ConstructorParameters<typeof ScheduleWorker>[2]>[0]) => {
      await new Promise((_resolve, reject) => envelope.signal.addEventListener('abort', () => { reason = envelope.signal.reason; reject(reason); }, { once: true }));
      return accepted;
    };
    await worker(store, dispatch, 10).start();
    expect(reason).toEqual(new Error('schedule_submission_deadline_exceeded'));
    expect(await store.pendingOccurrences()).toEqual([]);
    expect((await store.queryOccurrences({ ...scope, kind: 'schedule.occurrences.query', before: null, limit: 50 })).occurrences[0]?.attempts).toBe(1);
  });

  it('surfaces background persistence failures in health instead of an unhandled rejection', async () => {
    const { store } = open();
    const value = worker(store, async () => accepted, 120_000, activeConversation(), 10);
    await value.start();
    vi.spyOn(store, 'materializeDue').mockRejectedValue(new Error('database_failed'));
    await vi.waitFor(() => expect(() => value.assertHealthy()).toThrow('database_failed'));
  });
});
