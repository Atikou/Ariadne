import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, type ProductivityCommand } from '@ariadne/protocol/public';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-dag', sessionId: 'session-dag' } as const;
const now = new Date('2026-10-01T00:00:00Z');
const fixtures: { root: string; store: SqliteProductivityStore }[] = [];
type Item = Extract<ProductivityCommand, { kind: 'todo.snapshot.replace' }>['items'][number];
afterEach(async () => {
  const context = createShutdownContext(Date.now() + 5_000);
  try { for (const fixture of fixtures.splice(0)) {
    await fixture.store.close(context); rmSync(fixture.root, { recursive: true, force: true });
  } } finally { context.dispose(); }
});
async function open() {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-workflow-dag-'));
  const store = new SqliteProductivityStore(root); fixtures.push({ store, root });
  await store.execute('goal', { ...scope, kind: 'goal.put', goalId: 'goal-dag', expectedVersion: null,
    title: 'Dependency graph', phase: 'implementation', status: 'active', roundCap: 8 }, now);
  return store;
}
const todo = (todoId: string, dependsOn: string[] = []): Item => ({ todoId, title: todoId, status: 'pending', dependsOn });
const replace = (store: SqliteProductivityStore, items: Item[], commandId = 'todos', revision: number | null = null, goalVersion = 1) =>
  store.execute(commandId, { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal-dag', expectedGoalVersion: goalVersion, expectedRevision: revision, items }, now);
const query = (store: SqliteProductivityStore) => store.query(scope.workspaceId, scope.sessionId);
const start = (store: SqliteProductivityStore, ids: string[], executionMode: 'manual' | 'agent' = 'manual') => store.execute('start', {
  ...scope, kind: 'workflow.start', workflowId: 'workflow-dag', goalId: 'goal-dag', expectedGoalVersion: 1,
  expectedTodoRevision: 1, todoIds: ids, maxConcurrency: 2, maxTransitions: ids.length,
  executionMode, deadlineAt: '2098-01-01T00:00:00Z'
}, now);
async function settle(store: SqliteProductivityStore, id: string, mode: 'manual' | 'agent') {
  const workflow = (await query(store)).workflows[0]!;
  if (mode === 'manual') await store.execute(`complete-${id}`, { ...scope, kind: 'workflow.advance', workflowId: workflow.workflowId,
    expectedVersion: workflow.version, completed: [{ todoId: id, outcome: 'completed', summary: `Actual ${id}` }] }, now);
  else {
    const task = (await store.claimWorkflowAgentTask(workflow.workflowId, id, now))!;
    await store.recordWorkflowAgentSubmission(workflow.workflowId, id, `run-${id}`, now);
    await store.settleWorkflowAgentTask(workflow.workflowId, id, 'completed', `Actual ${id}`, now, {
      runId: `run-${id}`, runVersion: 3, resultMessage: { sessionId: task.sessionId, messageId: `result-${id}`,
        messageVersion: 1, contentDigest: `sha256:${'a'.repeat(64)}` }
    });
  }
}

describe('Workflow dependency authority', () => {
  it('edits and explicitly removes predecessor edges using one revisioned atomic replacement', async () => {
    const store = await open(); await replace(store, [todo('a'), todo('b', ['a']), todo('c')]);
    const edited = [todo('a'), { ...todo('b', ['c']), title: 'Edited future task' }, todo('c')];
    await replace(store, edited, 'edit-title-and-edge', 1);
    expect((await query(store)).todos[1]).toMatchObject({ title: 'Edited future task', dependsOn: ['c'] });
    const before = await query(store);
    await expect(replace(store, edited.filter(item => item.todoId !== 'c'), 'dangling-delete', 2))
      .rejects.toThrow('todo_dependency_invalid');
    expect(await query(store)).toEqual(before);
    await replace(store, [todo('a'), { ...edited[1]!, dependsOn: [] }], 'explicit-edge-removal-and-delete', 2);
    expect(await query(store)).toMatchObject({ todoRevision: 3, todos: [
      { todoId: 'a' }, { todoId: 'b', title: 'Edited future task', dependsOn: [] }
    ] });
    await expect(replace(store, [todo('a')], 'stale-revision-delete', 2)).rejects.toThrow('todo_revision_conflict');
    expect((await query(store)).todoRevision).toBe(3);
  });
  it('refuses title changes and deletions for every task referenced by a running workflow', async () => {
    const store = await open(); await replace(store, [todo('a'), todo('b', ['a'])]); await start(store, ['a', 'b']);
    const before = await query(store), items = before.todos.map(({ ordinal: _ordinal, ...item }) => item);
    await expect(replace(store, items.map(item => item.todoId === 'a' ? { ...item, title: 'Changed active task' } : item),
      'edit-active-title', before.todoRevision, before.goal!.version)).rejects.toThrow('todo_bound_to_running_workflow');
    await expect(replace(store, items.filter(item => item.todoId !== 'b'), 'delete-frozen-pending', before.todoRevision, before.goal!.version))
      .rejects.toThrow('todo_bound_to_running_workflow');
    expect(await query(store)).toEqual(before);
  });
  it.each([
    { name: 'self edge', items: [todo('a', ['a'])], code: 'todo_dependency_invalid' },
    { name: 'missing node', items: [todo('a', ['outside'])], code: 'todo_dependency_invalid' },
    { name: 'duplicate edge', items: [todo('a'), todo('b', ['a', 'a'])], code: 'todo_dependency_duplicate' },
    { name: 'cycle', items: [todo('a', ['b']), todo('b', ['c']), todo('c', ['a'])], code: 'todo_dependency_cycle' }
  ])('rejects $name atomically', async ({ items, code }) => {
    const store = await open(); const before = await query(store);
    await expect(replace(store, items)).rejects.toThrow(code);
    expect(await query(store)).toEqual(before);
  });

  it.each(['manual', 'agent'] as const)('joins a diamond graph in %s mode regardless of selected node order', async mode => {
    const store = await open();
    await replace(store, [todo('a'), todo('b', ['a']), todo('c', ['a']), todo('d', ['b', 'c'])]);
    await start(store, ['d', 'c', 'b', 'a'], mode);
    expect((await query(store)).workflows[0]).toMatchObject({ activeTodoIds: ['a'], pendingTodoIds: ['d', 'c', 'b'] });
    await settle(store, 'a', mode);
    expect((await query(store)).workflows[0]).toMatchObject({ activeTodoIds: ['c', 'b'], pendingTodoIds: ['d'] });
    await settle(store, 'c', mode);
    expect((await query(store)).workflows[0]).toMatchObject({ activeTodoIds: ['b'], pendingTodoIds: ['d'] });
    await settle(store, 'b', mode);
    expect((await query(store)).workflows[0]).toMatchObject({ activeTodoIds: ['d'], pendingTodoIds: [] });
    await settle(store, 'd', mode);
    expect((await query(store)).workflows[0]).toMatchObject({ status: 'completed', transitionsUsed: 4 });
  });

  it('rejects omitted unfinished dependencies and freezes edges while work is running', async () => {
    const store = await open(); await replace(store, [todo('a'), todo('b', ['a'])]);
    await expect(start(store, ['b'])).rejects.toThrow('workflow_dependency_unavailable');
    await start(store, ['b', 'a']);
    const current = await query(store);
    const items = current.todos.map(({ ordinal: _ordinal, ...item }) => item);
    items[1]!.dependsOn = [];
    await expect(replace(store, items, 'rewrite-edges', current.todoRevision, current.goal!.version))
      .rejects.toThrow('todo_bound_to_running_workflow');
    expect(await query(store)).toEqual(current);
  });

  it('distinguishes a prior completed snapshot from an actual result produced in this round', async () => {
    const store = await open(); await replace(store, [{ ...todo('a'), status: 'completed' }, todo('b', ['a'])]);
    await start(store, ['b'], 'agent');
    const task = (await store.claimWorkflowAgentTask('workflow-dag', 'b', now))!;
    expect(task.dependencyMessages).toBeUndefined();
    expect(task.prompt).toContain('没有本轮 Agent 结果引用');
    expect(task.prompt).toContain('请验证所需产物');
  });

  it('cannot release a dependent task using a completed status without an exact result message', async () => {
    const store = await open(); await replace(store, [todo('a'), todo('b', ['a'])]); await start(store, ['b', 'a'], 'agent');
    await store.claimWorkflowAgentTask('workflow-dag', 'a', now);
    await store.recordWorkflowAgentSubmission('workflow-dag', 'a', 'run-a', now);
    const before = await query(store);
    await expect(store.settleWorkflowAgentTask('workflow-dag', 'a', 'completed', 'status only', now,
      { runId: 'run-a', runVersion: 3 })).rejects.toThrow('workflow_dependency_result_missing');
    expect(await query(store)).toEqual(before);
    expect(await store.claimWorkflowAgentTask('workflow-dag', 'b', now)).toBeNull();
  });
});
