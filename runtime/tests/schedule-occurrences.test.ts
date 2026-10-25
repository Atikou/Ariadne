import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, runtimeResultSchema, type ProductivityCommand } from '@ariadne/protocol/public';
import { SqliteProductivityStore, SCHEDULE_SUBMISSION_MAX_ATTEMPTS } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { ProductivityPublicCommandHandler } from '../src/composition/ProductivityPublicCommandHandler.js';
import { createAgentConversationComponent } from '../src/composition/agent-entity/components/conversation/AgentConversationComponent.js';
import type { AgentControlExecutionPipeline } from '../src/composition/ProductionAgentControlExecutionPipelineFactory.js';
import { ScheduleWorker } from '../src/composition/ScheduleWorker.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots: string[] = [];
const stores: SqliteProductivityStore[] = [];
const conversations: SqliteConversationRunHandoffUnitOfWork[] = [];
const workers: ScheduleWorker[] = [];
const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-1', sessionId: 'session-1' } as const;
const clock = new Date('2098-01-01T00:00:00Z');
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    for (const store of stores.splice(0)) await store.close(context);
    for (const conversation of conversations.splice(0)) await conversation.close(context);
  } finally { context.dispose(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function open(root?: string) {
  const directory = root ?? mkdtempSync(path.join(os.tmpdir(), 'ariadne-schedule-occurrences-'));
  if (root === undefined) roots.push(directory);
  const store = new SqliteProductivityStore(directory); stores.push(store);
  return { store, root: directory };
}
async function close(store: SqliteProductivityStore) {
  const context = createShutdownContext(Date.now() + 5_000);
  try { await store.close(context); } finally { context.dispose(); }
}
async function due(store: SqliteProductivityStore, scheduleId = 'schedule-1', once = true) {
  await store.execute(`create-${scheduleId}`, { ...scope, kind: 'schedule.create', scheduleId, prompt: `Task ${scheduleId}`,
    timing: once ? { kind: 'once', at: '2098-01-01T00:00:01Z', missPolicy: 'run_once' } : { kind: 'interval', intervalMs: 1_000 }
  }, clock);
  await store.materializeDue(new Date(clock.getTime() + 1_000));
  return (await store.pendingOccurrences()).find(item => item.scheduleId === scheduleId)!;
}
function page(store: SqliteProductivityStore, input: Partial<Extract<ProductivityCommand, { kind: 'schedule.occurrences.query' }>> = {}) {
  return store.queryOccurrences({ ...scope, kind: 'schedule.occurrences.query', before: null, limit: 50, ...input });
}
function retry(occurrenceId: string, expectedAttempts: number) {
  return { ...scope, kind: 'schedule.occurrence.retry', occurrenceId, expectedAttempts } as const;
}

describe('durable schedule submission history and recovery', () => {
  it('excludes quarantined occurrences before the page limit and freezes uncertain attempts across lease expiry and reopening', async () => {
    const { store, root } = open();
    for (let index = 0; index < 20; index++) {
      await store.execute(`create-${index}`, { ...scope, kind: 'schedule.create', scheduleId: `schedule-${index}`,
        prompt: `Original independent task ${index}`, timing: { kind: 'once', at: '2098-01-01T00:00:01Z', missPolicy: 'run_once' } }, clock);
    }
    await store.materializeDue(new Date(clock.getTime() + 1_000));
    const original = await store.pendingOccurrences(128);
    expect(original).toHaveLength(20);
    for (const occurrence of original.slice(0, 16)) {
      await store.quarantineTask('schedule', occurrence.scheduleId, occurrence.occurrenceId, 'submission_identity_conflict');
    }
    expect((await store.pendingOccurrences(16)).map(item => item.occurrenceId)).toEqual(original.slice(16).map(item => item.occurrenceId));
    expect(await store.claimOccurrence(original[0]!.occurrenceId)).toBe(false);
    const inFlight = original[16]!;
    for (let attempt = 1; attempt <= 8; attempt++) {
      const time = new Date(clock.getTime() + 2_000 + attempt * 1_000_000);
      expect(await store.claimOccurrence(inFlight.occurrenceId, time, 1_000)).toBe(true);
      if (attempt < 8) await store.settleOccurrence(inFlight.occurrenceId, false, 'schedule_submission_uncertain', true, time);
    }
    await store.quarantineTask('schedule', inFlight.scheduleId, inFlight.occurrenceId, 'submission_identity_conflict');
    await store.materializeDue(new Date(clock.getTime() + 10_000_000));
    expect((await page(store)).occurrences.find(item => item.occurrenceId === inFlight.occurrenceId))
      .toMatchObject({ status: 'dispatching', attempts: 8 });
    expect(await store.claimedOccurrences()).toEqual([]);
    await close(store); const reopened = open(root).store;
    expect(await reopened.countQuarantinedTasks('schedule')).toBe(17);
    expect((await reopened.pendingOccurrences(16)).map(item => item.occurrenceId)).toEqual(original.slice(17).map(item => item.occurrenceId));
  });
  it('projects submission facts, filters by owner and hides arbitrary exceptions', async () => {
    const { store, root } = open(); const occurrence = await due(store);
    expect((await page(store)).occurrences[0]).toMatchObject({ status: 'pending', attempts: 0, canRetry: false, errorCode: null });
    await store.claimOccurrence(occurrence.occurrenceId);
    await store.settleOccurrence(occurrence.occurrenceId, false, 'Error: token=private-credential /private/path', false);
    expect((await page(store)).occurrences[0]).toMatchObject({ status: 'failed', attempts: 1, canRetry: true, errorCode: 'schedule_submission_failed' });
    expect((await page(store, { workspaceId: 'another-workspace' })).occurrences).toEqual([]);
    expect((await page(store, { sessionId: 'another-session' })).occurrences).toEqual([]);
    await close(store);
    // Existing schema-1 journals may contain raw exception messages. Reading them must stay safe too.
    const database = new DatabaseSync(path.join(root, 'data', 'productivity', 'productivity.db'));
    try { database.prepare('UPDATE productivity_schedule_occurrences SET last_error=?').run('legacy-secret-token'); }
    finally { database.close(); }
    const result = await page(open(root).store);
    expect(runtimeResultSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/legacy-secret|private-credential|commandId|messageId/);
  });

  it('pages tied due instants without overlap even after a new occurrence arrives', async () => {
    const { store, root } = open();
    for (const id of ['one', 'two', 'three']) await due(store, id);
    const original = (await page(store)).occurrences.map(item => item.occurrenceId);
    const initial = await page(store, { limit: 1 });
    expect(initial.nextCursor).not.toBeNull();
    // Pagination of historical offsets uses instants rather than lexicographic timestamps.
    await close(store);
    const database = new DatabaseSync(path.join(root, 'data', 'productivity', 'productivity.db'));
    try { database.prepare('UPDATE productivity_schedule_occurrences SET due_at=? WHERE schedule_id=?').run('2098-01-01T08:00:01+08:00', 'one'); }
    finally { database.close(); }
    const recovered = open(root).store;
    await recovered.execute('new-arrival', { ...scope, kind: 'schedule.create', scheduleId: 'newer', prompt: 'New task',
      timing: { kind: 'once', at: '2098-01-01T00:00:02Z', missPolicy: 'run_once' } }, clock);
    await recovered.materializeDue(new Date(clock.getTime() + 2_000));
    expect((await page(recovered, { limit: 1 })).occurrences[0]?.scheduleId).toBe('newer');
    const second = await page(recovered, { limit: 1, before: initial.nextCursor });
    const third = await page(recovered, { limit: 1, before: second.nextCursor });
    expect([...initial.occurrences, ...second.occurrences, ...third.occurrences].map(item => item.occurrenceId)).toEqual(original);
    expect(third.nextCursor).toBeNull();
  });

  it('replays explicit retries, preserves identity and attempts, and rejects stale callers', async () => {
    const { store, root } = open(); const occurrence = await due(store);
    for (let attempt = 0; attempt < SCHEDULE_SUBMISSION_MAX_ATTEMPTS; attempt++) {
      const attemptTime = new Date(clock.getTime() + attempt * 61_000);
      expect(await store.claimOccurrence(occurrence.occurrenceId, attemptTime)).toBe(true);
      await store.settleOccurrence(occurrence.occurrenceId, false, 'schedule_submission_uncertain', true, attemptTime);
    }
    const command = retry(occurrence.occurrenceId, 8);
    const result = await store.execute('retry-1', command, clock);
    expect(result).toMatchObject({ occurrence: { status: 'pending', attempts: 8, canRetry: false } });
    expect(await store.execute('retry-1', command, clock)).toEqual(result);
    expect(await store.reconcile('retry-1', command)).toEqual(result);
    await expect(store.execute('duplicate-click', command, clock)).rejects.toThrow('schedule_occurrence_retry_unavailable');
    expect(await store.pendingOccurrences()).toEqual([{ ...occurrence, attempts: 8 }]);
    await store.claimOccurrence(occurrence.occurrenceId);
    await store.settleOccurrence(occurrence.occurrenceId, false, 'schedule_submission_failed');
    expect(await store.pendingOccurrences()).toEqual([]);
    await expect(store.execute('stale', command, clock)).rejects.toThrow('schedule_occurrence_version_conflict');
    await close(store);
    const recovered = open(root).store;
    expect((await page(recovered)).occurrences[0]).toMatchObject({ status: 'failed', attempts: 9, canRetry: true });
    expect(await recovered.reconcile('retry-1', command)).toEqual(result);
    await expect(recovered.execute('foreign-owner', { ...retry(occurrence.occurrenceId, 9), sessionId: 'foreign' }, clock)).rejects.toThrow('schedule_occurrence_not_found');
    await recovered.execute('retry-2', retry(occurrence.occurrenceId, 9), clock);
    await recovered.claimOccurrence(occurrence.occurrenceId);
    await recovered.settleOccurrence(occurrence.occurrenceId, true);
    expect((await page(recovered)).occurrences[0]).toMatchObject({ status: 'submitted', attempts: 10, canRetry: false, errorCode: null });
    await expect(recovered.execute('submitted-again', retry(occurrence.occurrenceId, 10), clock)).rejects.toThrow('schedule_occurrence_retry_unavailable');
  });

  it.each(['pause', 'cancel'] as const)('refuses retries when the owning schedule is %s', async action => {
    const { store } = open(); const occurrence = await due(store, 'schedule-1', false);
    await store.claimOccurrence(occurrence.occurrenceId);
    await store.settleOccurrence(occurrence.occurrenceId, false, 'schedule_submission_rejected', false);
    await store.execute('transition', { ...scope, kind: 'schedule.transition', scheduleId: 'schedule-1', expectedVersion: 2, action }, clock);
    expect((await page(store)).occurrences[0]?.canRetry).toBe(false);
    await expect(store.execute('retry', retry(occurrence.occurrenceId, 1), clock)).rejects.toThrow('schedule_occurrence_retry_unavailable');
    if (action === 'pause') {
      await store.execute('resume', { ...scope, kind: 'schedule.transition', scheduleId: 'schedule-1', expectedVersion: 3, action: 'resume' }, clock);
      expect((await page(store)).occurrences[0]?.canRetry).toBe(true);
    }
  });

  it('authorizes history queries and retry reconciliation through the public command owner', async () => {
    const { store, root } = open(); const occurrence = await due(store);
    await store.claimOccurrence(occurrence.occurrenceId);
    await store.settleOccurrence(occurrence.occurrenceId, false, 'schedule_submission_failed', false);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root); conversations.push(conversation);
    await new ConversationAuthorityService(conversation).createSession({
      kind: 'conversation.create_session', commandId: 'create-session', eventId: 'create-event',
      sessionId: scope.sessionId, workspaceId: scope.workspaceId, expectedVersion: null, occurredAt: clock.toISOString()
    });
    const owner = new ProductivityPublicCommandHandler(store, conversation, [scope.workspaceId]);
    const envelope = (command: ProductivityCommand) => ({ commandId: 'public-retry', correlationId: 'correlation-1',
      deadlineAt: new Date(Date.now() + 10_000).toISOString(), signal: new AbortController().signal, command });
    const query = { ...scope, kind: 'schedule.occurrences.query', before: null, limit: 50 } as const;
    expect(await owner.execute(envelope(query), query)).toMatchObject({ outcome: { ok: true, result: { occurrences: [{ status: 'failed' }] } } });
    const command = retry(occurrence.occurrenceId, 1);
    const result = await owner.execute(envelope(command), command);
    expect(result).toMatchObject({ outcome: { ok: true, result: { occurrence: { status: 'pending' } } } });
    expect(await owner.reconcile(envelope(command))).toEqual(result);
    expect(await owner.reconcile(envelope(query))).toBeNull();
    const denied = { ...query, workspaceId: 'not-authorized' };
    expect(await owner.execute(envelope(denied), denied)).toMatchObject({ outcome: { ok: false, error: { code: 'workspace_not_authorized' } } });
  });

  it('manually recovers an accepted but unacknowledged submission without a second message or saga', async () => {
    const { store, root } = open(); const occurrence = await due(store);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root); conversations.push(conversation);
    await new ConversationAuthorityService(conversation).createSession({ kind: 'conversation.create_session',
      commandId: 'session-create', eventId: 'session-event', sessionId: scope.sessionId, workspaceId: scope.workspaceId,
      expectedVersion: null, occurredAt: clock.toISOString() });
    const pipeline = { runWorkScheduler: { assertHealthy() {} }, executionScheduler: { assertHealthy() {}, wake() {} },
      handoffProducer: { assertHealthy() {}, wake() {} }, assertConversationMessageAdmission() {}
    } as unknown as AgentControlExecutionPipeline;
    const owner = createAgentConversationComponent({ conversation, executionPipeline: pipeline,
      wakeProjectionDrain() {}, options: { commandNow: () => new Date(clock.getTime() + 2_000) } });
    const submit: ConstructorParameters<typeof ScheduleWorker>[2] = async envelope => {
      if (envelope.command.kind !== 'conversation.message.accept') throw new Error('wrong command');
      return owner.executeAcceptMessage(envelope, envelope.command);
    };
    const uncertain = new ScheduleWorker(store, conversation, async envelope => { await submit(envelope); return null; }, 60_000);
    workers.push(uncertain); await uncertain.start();
    let nextTime = Date.now();
    const time = vi.spyOn(Date, 'now');
    for (let attempt = 1; attempt < 8; attempt++) { nextTime += 61_000; time.mockReturnValue(nextTime); await uncertain.wake(); }
    time.mockRestore(); await uncertain.stop();
    expect((await page(store)).occurrences[0]).toMatchObject({ status: 'failed', attempts: 8 });
    const other = { commandId: 'other-message-command', correlationId: 'other-correlation',
      deadlineAt: new Date(Date.now() + 10_000).toISOString(), signal: new AbortController().signal,
      command: { ...scope, kind: 'conversation.message.accept' as const, expectedSessionVersion: 2,
        messageId: 'other-message', content: 'Another user turn', execution: { mode: 'agent' as const } } };
    expect((await submit(other))?.outcome.ok).toBe(true);
    await store.execute('manual-retry', retry(occurrence.occurrenceId, 8), clock);
    await close(store);
    const recovered = open(root).store;
    const dispatch = vi.fn(submit);
    const worker = new ScheduleWorker(recovered, conversation, dispatch, 60_000); workers.push(worker);
    await worker.start();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ commandId: occurrence.commandId,
      command: { messageId: occurrence.messageId, expectedSessionVersion: 1 } });
    expect((await conversation.readSession(scope.sessionId))?.version).toBe(3);
    expect((await page(recovered)).occurrences[0]).toMatchObject({ status: 'submitted', attempts: 9 });
    const database = new DatabaseSync(path.join(root, 'data', 'conversation', 'conversation.db'), { readOnly: true });
    try {
      expect(database.prepare('SELECT count(*) AS count FROM conversation_message_heads').get()).toMatchObject({ count: 2 });
      expect(database.prepare('SELECT count(*) AS count FROM conversation_handoff_sagas').get()).toMatchObject({ count: 2 });
    } finally { database.close(); }
  });
});
