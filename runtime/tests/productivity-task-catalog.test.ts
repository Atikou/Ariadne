import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, taskReferenceKey, type TaskSourceMetadata } from '@ariadne/protocol/public';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import type { ProductivityTaskReference } from '../src/control/ports/ProductivityTaskCatalogReadV1.js';

const fixtures: Array<{ root: string; store: SqliteProductivityStore }> = [];
const now = new Date('2026-10-06T00:00:00.000Z');
const all = { workspaceIds: null, session: null };
const a = { workspaceIds: ['workspace-a'], session: null };
const command = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-a', sessionId: 'session-a' } as const;
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const context = createShutdownContext(Date.now() + 5_000);
    try { await fixture.store.close(context); } finally { context.dispose(); }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
function open() {
  const root = mkdtempSync(join(tmpdir(), 'ariadne-task-catalog-')), store = new SqliteProductivityStore(root);
  fixtures.push({ root, store }); return store;
}
async function goal(store: SqliteProductivityStore, suffix = 'a', goalId = 'shared-id') {
  await store.execute('goal-' + suffix, { ...command, workspaceId: 'workspace-' + suffix, sessionId: 'session-' + suffix,
    kind: 'goal.put', goalId, expectedVersion: null, title: '公开目标 ' + suffix, phase: 'implementation', status: 'active', roundCap: 8 }, now);
}
async function schedule(store: SqliteProductivityStore, id = 'schedule-a', suffix = 'a') {
  await store.execute('create-' + id, { ...command, workspaceId: 'workspace-' + suffix, sessionId: 'session-' + suffix,
    kind: 'schedule.create', scheduleId: id, prompt: 'PROTECTED_SCHEDULE_PROMPT',
    timing: { kind: 'once', at: '2026-10-06T00:00:01.000Z', missPolicy: 'run_once' } }, now);
}
async function workflow(store: SqliteProductivityStore, agent = false, tasks = 1) {
  await goal(store);
  const ids = Array.from({ length: tasks }, (_, index) => 'todo-' + index);
  await store.execute('todos', { ...command, kind: 'todo.snapshot.replace', goalId: 'shared-id', expectedGoalVersion: 1,
    expectedRevision: null, items: ids.map(todoId => ({ todoId, title: '公开待办 ' + todoId, status: 'pending' as const })) }, now);
  await store.execute('workflow', { ...command, kind: 'workflow.start', workflowId: 'shared-id', goalId: 'shared-id',
    expectedGoalVersion: 1, expectedTodoRevision: 1, todoIds: ids, maxConcurrency: 1, maxTransitions: tasks,
    deadlineAt: '2099-01-01T00:00:00.000Z', executionMode: agent ? 'agent' : 'manual' }, now,
    agent ? { sourceSessionId: 'session-a', sourceSessionVersion: 1 } : undefined);
  return ids;
}

describe('Productivity task catalog read extension under the original owner', () => {
  it('reads actual source revisions and links without exporting prompts or changing business state', async () => {
    const store = open(); await workflow(store); await schedule(store);
    await store.materializeDue(new Date(now.getTime() + 1_000));
    const before = await store.query('workspace-a', 'session-a'), schedules = await store.querySchedules('workspace-a', 'session-a');
    const page = await store.readTaskCatalogPage(a, null, 128);
    expect(page.rows.map(row => row.reference.source).sort()).toEqual(['goal', 'occurrence', 'schedule', 'workflow']);
    expect(page.rows.find(row => row.reference.source === 'goal')).toMatchObject({ version: 2, title: '公开目标 a' });
    expect(page.rows.find(row => row.reference.source === 'workflow')?.relations).toEqual([
      { kind: 'goal', reference: { source: 'goal', sourceId: 'shared-id' }, owner: { workspaceId: 'workspace-a', sessionId: 'session-a' } }
    ]);
    expect(page.rows.find(row => row.reference.source === 'occurrence')).toMatchObject({ version: null, attempts: 0, updatedAt: null, state: 'queued' });
    expect(JSON.stringify(page)).not.toContain('PROTECTED_SCHEDULE_PROMPT');
    expect(await store.query('workspace-a', 'session-a')).toEqual(before);
    expect(await store.querySchedules('workspace-a', 'session-a')).toEqual(schedules);
    expect(new Set(page.rows.map(row => taskReferenceKey(row.reference))).size).toBe(4);
  });
  it('keeps Workspace and exact Session scope in every read, including empty authorization', async () => {
    const store = open(); await goal(store); await goal(store, 'b', 'foreign-goal'); await schedule(store, 'foreign-schedule', 'b');
    const page = await store.readTaskCatalogPage(a, null, 128);
    expect(page.rows).toHaveLength(1); expect(page.rows.every(row => row.workspaceId === 'workspace-a')).toBe(true);
    expect(await store.readTaskCatalogItem(a, { source: 'goal', sourceId: 'foreign-goal' })).toBeNull();
    expect((await store.readTaskCatalogPage({ workspaceIds: [], session: null }, null, 128)).rows).toEqual([]);
    expect((await store.readTaskCatalogPage({ ...a, session: { workspaceId: 'workspace-a', sessionId: 'session-b' } }, null, 128)).rows).toEqual([]);
    expect((await store.readTaskCatalogPage(all, null, 128)).rows).toHaveLength(3);
  });
  it('pages a growing source catalog with bounded source identity and includes low-key inserts on a new scan', async () => {
    const store = open();
    for (let index = 0; index < 130; index++) await schedule(store, 'schedule-' + String(index).padStart(3, '0'));
    const rows: TaskSourceMetadata[] = []; let after: ProductivityTaskReference | null = null;
    do { const page = await store.readTaskCatalogPage(a, after, 17); expect(page.rows.length).toBeLessThanOrEqual(17); rows.push(...page.rows); after = page.next; } while (after !== null);
    expect(rows).toHaveLength(130); expect(new Set(rows.map(row => taskReferenceKey(row.reference))).size).toBe(130);
    await schedule(store, 'schedule-000-before');
    const refreshed = await store.readTaskCatalogPage(a, null, 128);
    expect(refreshed.rows.some(row => row.reference.sourceId === 'schedule-000-before')).toBe(true);
    expect(refreshed.next).not.toBeNull();
    await expect(store.readTaskCatalogPage(a, null, 129)).rejects.toThrow('limit_invalid');
  });
  it('preserves submission and actual execution as separate facts', async () => {
    const store = open(); await schedule(store); await store.materializeDue(new Date(now.getTime() + 1_000));
    const occurrence = (await store.pendingOccurrences())[0]!;
    await store.claimOccurrence(occurrence.occurrenceId, now); await store.settleOccurrence(occurrence.occurrenceId, true, undefined, true, now);
    const item = await store.readTaskCatalogItem(a, { source: 'occurrence', sourceId: occurrence.occurrenceId });
    expect(item).toMatchObject({ sourceStatus: 'submitted', state: 'unknown', attempts: 1, runReferences: [] });
    expect(item?.relations).toMatchObject([{ reference: { source: 'schedule', sourceId: 'schedule-a' } }]);
  });
  it('bounds link summaries while retaining every synthetic source execution reference through versioned link pages', async () => {
    const store = open(), ids = await workflow(store, true, 40);
    for (const [index, id] of ids.entries()) {
      expect(await store.claimWorkflowAgentTask('shared-id', id, now)).not.toBeNull();
      await store.recordWorkflowAgentSubmission('shared-id', id, 'synthetic-source-run-' + index, now);
      await store.settleWorkflowAgentTask('shared-id', id, 'completed', 'PROTECTED_RESULT_BODY', now,
        { runId: 'synthetic-source-run-' + index, runVersion: 3 });
    }
    const reference = { source: 'workflow', sourceId: 'shared-id' } as const;
    const item = (await store.readTaskCatalogItem(a, reference))!;
    expect(item).toMatchObject({ state: 'completed', relationTotal: 41, runReferenceTotal: 40 });
    expect(item.relations).toHaveLength(32); expect(item.runReferences).toHaveLength(32);
    expect(JSON.stringify(item)).not.toContain('PROTECTED_RESULT_BODY');
    const links: unknown[] = []; let offset: number | null = 0;
    do { const page = await store.readTaskRelations(a, reference, { version: item.version, attempts: null }, offset, 13);
      expect(page.status).toBe('ok'); if (page.status !== 'ok') throw new Error('unexpected link state');
      links.push(...page.rows); offset = page.nextIndex;
    } while (offset !== null);
    expect(links).toHaveLength(41);
    expect(await store.readTaskRelations(a, reference, { version: item.version! - 1, attempts: null }, 0, 13))
      .toMatchObject({ status: 'stale', currentVersion: item.version });
    expect(await store.readTaskRelations({ workspaceIds: ['workspace-b'], session: null }, reference,
      { version: item.version, attempts: null }, 0, 13)).toEqual({ status: 'missing' });
  });
  it('retains read metadata after closing and reopening the same source authority', async () => {
    const store = open(); await workflow(store); const expected = (await store.readTaskCatalogPage(a, null, 128)).rows;
    const fixture = fixtures.pop()!, context = createShutdownContext(Date.now() + 5_000);
    try { await store.close(context); } finally { context.dispose(); }
    const reopened = new SqliteProductivityStore(fixture.root); fixtures.push({ root: fixture.root, store: reopened });
    expect((await reopened.readTaskCatalogPage(a, null, 128)).rows).toEqual(expected);
  });
});
