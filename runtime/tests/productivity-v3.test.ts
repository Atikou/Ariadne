import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';

import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { V3ScheduleWorker } from '../src/composition/V3ScheduleWorker.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { LegacySchedulerJournalReader } from '../src/scheduler/LegacySchedulerJournalReader.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('v3 productivity authority', () => {
  it('replays Goal/Todo commands and runs a bounded concurrent Workflow to structured completion', async () => {
    const store = new SqliteProductivityStore(root());
    const goalCommand = {
      kind: 'goal.put.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: 'workspace-1', sessionId: 'session-1', goalId: 'goal-1',
      expectedVersion: null, title: 'Ship the release', phase: 'implementation',
      status: 'active', roundCap: 8
    } as const;
    await expect(store.reconcile('command-goal', goalCommand)).resolves.toBeNull();
    const goal = await store.execute('command-goal', goalCommand);
    await expect(store.execute('command-goal', goalCommand)).resolves.toEqual(goal);
    await expect(store.reconcile('command-goal', goalCommand)).resolves.toEqual(goal);
    await store.execute('command-todos', {
      kind: 'todo.snapshot.replace.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: 'workspace-1', sessionId: 'session-1', goalId: 'goal-1',
      expectedGoalVersion: 1, expectedRevision: null,
      items: ['one', 'two', 'three'].map((todoId) => ({ todoId, title: todoId, status: 'pending' as const }))
    });
    const started = await store.execute('command-workflow', {
      kind: 'workflow.start.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: 'workspace-1', sessionId: 'session-1', workflowId: 'workflow-1',
      goalId: 'goal-1', expectedGoalVersion: 1, expectedTodoRevision: 1,
      todoIds: ['one', 'two', 'three'], maxConcurrency: 2, maxTransitions: 3,
      deadlineAt: '2099-01-01T00:00:00.000Z'
    });
    expect(started).toMatchObject({ workflow: { activeTodoIds: ['one', 'two'], pendingTodoIds: ['three'] } });
    await expect(store.query('workspace-1', 'session-1')).resolves.toMatchObject({
      goal: { version: 2, roundsUsed: 1, roundCap: 8 }
    });
    const advanced = await store.execute('command-advance-1', {
      kind: 'workflow.advance.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: 'workspace-1', sessionId: 'session-1', workflowId: 'workflow-1', expectedVersion: 1,
      completed: [{ todoId: 'one', outcome: 'completed', summary: 'done one' }]
    });
    expect(advanced).toMatchObject({ workflow: { version: 2, activeTodoIds: ['two', 'three'], pendingTodoIds: [] } });
    const terminal = await store.execute('command-advance-2', {
      kind: 'workflow.advance.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: 'workspace-1', sessionId: 'session-1', workflowId: 'workflow-1', expectedVersion: 2,
      completed: [
        { todoId: 'two', outcome: 'completed', summary: 'done two' },
        { todoId: 'three', outcome: 'completed', summary: 'done three' }
      ]
    });
    expect(terminal).toMatchObject({ workflow: { status: 'completed', transitionsUsed: 3, results: [{ todoId: 'one' }, { todoId: 'two' }, { todoId: 'three' }] } });
    await close(store);
  });

  it('recovers one durable Schedule occurrence identity across store restart', async () => {
    const dataRoot = root();
    let store = new SqliteProductivityStore(dataRoot);
    await store.execute('command-schedule', {
      kind: 'schedule.create.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: 'workspace-1', sessionId: 'session-1', scheduleId: 'schedule-1',
      prompt: 'Run the ordinary v3 turn',
      timing: { kind: 'once', at: '2026-09-01T00:00:00.000Z', missPolicy: 'run_once' }
    }, new Date('2026-08-31T00:00:00.000Z'));
    await store.materializeDue(new Date('2026-09-01T00:00:01.000Z'));
    const before = await store.pendingOccurrences();
    expect(before).toHaveLength(1);
    await close(store);

    store = new SqliteProductivityStore(dataRoot);
    await store.materializeDue(new Date('2026-09-01T00:00:02.000Z'));
    const after = await store.pendingOccurrences();
    expect(after).toEqual(before);
    await store.settleOccurrence(after[0]!.occurrenceId, true);
    expect(await store.pendingOccurrences()).toEqual([]);
    await close(store);
  });

  it('submits a durable occurrence as an ordinary versioned Conversation turn', async () => {
    const occurrence = {
      occurrenceId: 'occurrence-1', scheduleId: 'schedule-1', workspaceId: 'workspace-1',
      sessionId: 'session-1', prompt: 'Continue the session', dueAt: '2026-08-31T00:00:00.000Z',
      commandId: 'command-1', messageId: 'message-1', attempts: 0
    };
    const settled: Array<[string, boolean, string?]> = [];
    const store = {
      materializeDue: async () => undefined,
      pendingOccurrences: async () => [occurrence],
      settleOccurrence: async (id: string, success: boolean, error?: string) => { settled.push([id, success, error]); }
    } as unknown as SqliteProductivityStore;
    const conversation = {
      readSession: async () => ({ sessionId: 'session-1', workspaceId: 'workspace-1', version: 7, status: 'active' })
    } as unknown as SqliteConversationRunHandoffUnitOfWork;
    const envelopes: unknown[] = [];
    const worker = new V3ScheduleWorker(store, conversation, async (envelope) => {
      envelopes.push(envelope);
      return {
        settlement: 'completed',
        outcome: {
          ok: true,
          result: {
            kind: 'conversation.message.accepted.v3', sessionId: 'session-1', sessionVersion: 8,
            messageId: 'message-1', messageVersion: 1, sagaId: 'saga-1'
          }
        }
      };
    }, 60_000);

    await worker.start();
    await worker.stop();

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      commandId: 'command-1', correlationId: 'occurrence-1',
      command: {
        kind: 'conversation.message.accept.v3', workspaceId: 'workspace-1', sessionId: 'session-1',
        expectedSessionVersion: 7, messageId: 'message-1', content: 'Continue the session',
        execution: { mode: 'agent' }
      }
    });
    expect(settled).toEqual([['occurrence-1', true, undefined]]);
  });

  it('does not resurrect a skipped one-time Schedule that is already overdue', async () => {
    const store = new SqliteProductivityStore(root());
    const result = await store.execute('command-skip', {
      kind: 'schedule.create.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: 'workspace-1', sessionId: 'session-1', scheduleId: 'schedule-skip',
      prompt: 'Do not replay stale work',
      timing: { kind: 'once', at: '2026-08-30T00:00:00.000Z', missPolicy: 'skip' }
    }, new Date('2026-08-31T00:00:00.000Z'));
    expect(result).toMatchObject({ schedule: { status: 'completed', nextFireAt: null, fireCount: 0 } });
    await store.materializeDue(new Date('2026-09-01T00:00:00.000Z'));
    expect(await store.pendingOccurrences()).toEqual([]);
    await close(store);
  });

  it('reads the retired Scheduler journal without arming or mutating it', () => {
    const dataRoot = root();
    const journal = path.join(dataRoot, 'triggers.jsonl');
    const first = legacyTrigger('legacy-1', '2030-01-01T00:00:00.000Z');
    const replacement = { ...first, goal: 'new goal', updatedAt: '2029-01-02T00:00:00.000Z' };
    writeFileSync(journal, [
      JSON.stringify({ op: 'upsert', time: first.updatedAt, trigger: first }),
      'not-json',
      JSON.stringify({ op: 'upsert', time: replacement.updatedAt, trigger: replacement }),
      JSON.stringify({ op: 'delete', time: '2029-01-03T00:00:00.000Z', id: 'legacy-deleted' })
    ].join('\n'));

    expect(new LegacySchedulerJournalReader(journal).list()).toEqual([replacement]);
    expect(new LegacySchedulerJournalReader(path.join(dataRoot, 'missing.jsonl')).list()).toEqual([]);
  });
});

function root(): string { const value = mkdtempSync(path.join(os.tmpdir(), 'ariadne-productivity-')); roots.push(value); return value; }
async function close(store: SqliteProductivityStore): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try { await store.close(context); } finally { context.dispose(); }
}

function legacyTrigger(id: string, at: string) {
  return {
    id, name: 'legacy', goal: 'old goal', kind: 'once' as const, status: 'active' as const,
    at, missPolicy: 'run_once' as const, createdAt: '2029-01-01T00:00:00.000Z',
    updatedAt: '2029-01-01T00:00:00.000Z', fireCount: 0
  };
}
