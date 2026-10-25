import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, runtimeResultSchema } from '@ariadne/protocol/public';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import type { GoalPlannerTask } from '../src/adapters/persistence/SqliteGoalAutonomy.js';
import type { GoalDecision, GoalPlannerResultSource } from '../src/control/ports/GoalPlanningAuthority.js';
import { renderProductivityTaskPrompt } from '../src/conversation/ProductivityTaskPrompt.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-1', sessionId: 'session-1' } as const;
const clock = new Date('2098-01-01T00:00:00Z');
const deadline = '2098-01-02T00:00:00Z';
const context = { sourceSessionId: scope.sessionId, sourceSessionVersion: 1 };
const stores: SqliteProductivityStore[] = [];
const roots: string[] = [];
const digest = `sha256:${'a'.repeat(64)}`;
const plan: GoalDecision = { decision: 'plan', summary: 'Execute and verify', tasks: [
  { key: 'work', title: 'Implement the feature', dependsOn: [] },
  { key: 'verify', title: 'Verify the actual result', dependsOn: ['work'] }
] };
const complete: GoalDecision = { decision: 'complete', summary: 'Both criteria verified', checks: [
  { criterion: 0, status: 'passed', evidence: 'Verified the resulting source and executable behavior.', sources: [{ kind: 'task_result', messageId: 'current-task-result' }] },
  { criterion: 1, status: 'passed', evidence: 'Verified durable state after restart.', sources: [{ kind: 'task_result', messageId: 'current-task-result' }] }
] };
afterEach(async () => {
  for (const store of stores.splice(0)) await close(store);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function close(store: SqliteProductivityStore) {
  const shutdown = createShutdownContext(Date.now() + 5_000);
  try { await store.close(shutdown); } finally { shutdown.dispose(); }
}
function open(root?: string) {
  const directory = root ?? mkdtempSync(path.join(os.tmpdir(), 'ariadne-goal-autonomy-'));
  if (root === undefined) roots.push(directory);
  const store = new SqliteProductivityStore(directory); stores.push(store);
  return { store, root: directory };
}
async function query(store: SqliteProductivityStore) { return store.query(scope.workspaceId, scope.sessionId); }
async function start(store: SqliteProductivityStore, roundCap = 3, criteria = ['Working implementation', 'Survives restart']) {
  await store.execute('goal', { ...scope, kind: 'goal.put', goalId: 'goal-1', expectedVersion: null,
    title: 'Deliver feature', phase: 'implementation', status: 'active', roundCap }, clock);
  await store.execute('start', { ...scope, kind: 'goal.autonomy.start', goalId: 'goal-1', expectedVersion: 1,
    criteria, deadlineAt: deadline, maxConcurrency: 2 }, clock, context);
  return (await store.pendingGoalAutonomy())[0]!.agentExecution!.tasks.at(-1)!;
}
async function transition(store: SqliteProductivityStore, action: 'pause' | 'resume', commandId = action) {
  return store.execute(commandId, { ...scope, kind: 'goal.autonomy.transition', goalId: 'goal-1',
    expectedVersion: (await query(store)).goal!.version, action }, clock);
}
async function bound(store: SqliteProductivityStore, task: GoalPlannerTask) {
  await store.claimGoalPlannerTask('goal-1', task.attempt, clock);
  await store.recordGoalPlannerSubmission('goal-1', task.attempt, `planner-run-${task.attempt}`, clock);
  return source(task);
}
function source(task: GoalPlannerTask): GoalPlannerResultSource {
  // Result-reference fixtures test the SQLite owner. Real Core/Conversation proof is the Worker's responsibility.
  return { runId: `planner-run-${task.attempt}`, runVersion: 4, sessionVersion: 3,
    message: { sessionId: task.sessionId, messageId: `planner-result-${task.attempt}`, messageVersion: 1, contentDigest: digest } };
}
async function stage(store: SqliteProductivityStore, task: GoalPlannerTask, decision: GoalDecision = plan) {
  if (decision.decision === 'complete') decision = { ...decision, checks: decision.checks.map(check => ({ ...check,
    sources: check.sources.map(source => source.kind === 'task_result' && source.messageId === 'current-task-result'
      ? { ...source, messageId: task.dependencyMessages?.[0]?.reference.messageId ?? source.messageId } : source)
  })) };
  return store.stageGoalDecision('goal-1', task.attempt, { runId: `planner-run-${task.attempt}`,
    effectId: `effect-${task.attempt}`, idempotencyKey: `key-${task.attempt}`, decision }, clock);
}
async function settle(store: SqliteProductivityStore, task: GoalPlannerTask, outcome: 'completed' | 'failed' | 'cancelled' = 'completed') {
  await store.settleGoalPlannerTask('goal-1', task.attempt, outcome, source(task), clock);
}
async function startRound(store: SqliteProductivityStore, task: GoalPlannerTask, decision: GoalDecision = plan) {
  await bound(store, task); await stage(store, task, decision); await settle(store, task);
}
async function finishRound(store: SqliteProductivityStore, outcome: 'completed' | 'failed' = 'completed') {
  const work = (await store.pendingWorkflowAgentWork())[0]!;
  for (const task of work.workflow.agentExecution!.tasks) {
    if (await store.claimWorkflowAgentTask(work.workflow.workflowId, task.todoId, clock) === null) continue;
    const runId = `run-${task.todoId}`;
    await store.recordWorkflowAgentSubmission(work.workflow.workflowId, task.todoId, runId, clock);
    await store.settleWorkflowAgentTask(work.workflow.workflowId, task.todoId, outcome, 'Actual terminal result', clock,
      { runId, runVersion: 5, ...(outcome === 'completed' ? { resultMessage: { sessionId: task.sessionId,
        messageId: task.messageId, messageVersion: 2, contentDigest: digest } } : {}) });
    if (outcome === 'failed') break;
  }
  await store.pollGoalAutonomy('goal-1', clock);
  return (await store.pendingGoalAutonomy())[0]!.agentExecution!.tasks.at(-1)!;
}

describe('autonomous Goal durable decision state machine', () => {
  it('stages privately, waits for actual planner settlement, runs a DAG, replans, then verifies every criterion', async () => {
    const { store } = open(); const first = await start(store);
    await bound(store, first); await stage(store, first);
    const staged = await query(store);
    expect(staged.goal).toMatchObject({ status: 'active', roundsUsed: 0, autonomy: { status: 'planning' } });
    expect(staged.todos).toEqual([]); expect(staged.workflows).toEqual([]);
    expect(JSON.stringify(staged)).not.toContain('agentExecution'); expect(JSON.stringify(staged)).not.toContain('fingerprint');
    runtimeResultSchema.parse(staged);
    await settle(store, first);
    expect((await query(store)).goal).toMatchObject({ roundsUsed: 1, autonomy: { status: 'executing' } });
    const work = (await store.pendingWorkflowAgentWork())[0]!;
    expect(work.workflow.activeTodoIds).toHaveLength(1); expect(work.workflow.pendingTodoIds).toHaveLength(1);
    expect(work.workflow.agentExecution!.criteria).toContain('Survives restart');
    expect(work.workflow.agentExecution!.tasks[0]!.prompt).not.toContain('Survives restart');
    const verification = await finishRound(store);
    expect(verification).toMatchObject({ attempt: 2, phase: 'verifying' });
    expect(verification.dependencyMessages).toHaveLength(2);
    expect((await query(store)).goal!.status).toBe('active');
    await startRound(store, verification, { decision: 'plan', summary: 'Repair missing restart behavior',
      tasks: [{ key: 'repair', title: 'Repair durable state, then verify restart', dependsOn: [] }] });
    expect((await query(store)).goal!.roundsUsed).toBe(2);
    const final = await finishRound(store); await bound(store, final); await stage(store, final, complete);
    expect((await query(store)).goal!.status).toBe('active');
    await settle(store, final);
    expect((await query(store)).goal).toMatchObject({ status: 'complete', roundsUsed: 2,
      autonomy: { status: 'complete', plannerAttempts: 3, summary: 'Both criteria verified', completedBy: 'verification',
        assessment: complete.decision === 'complete' ? complete.checks.map(({ sources: _sources, ...check }) => check) : [] } });
    expect(JSON.stringify((await query(store)).goal!.autonomy)).not.toContain('sources');
    expect(await store.pendingGoalAutonomy()).toEqual([]);
    expect(await stage(store, first)).toEqual({ staged: true, goalId: 'goal-1', attempt: 1 });
    await settle(store, first); // Historical proof remains replayable after further attempts.
    await expect(store.settleGoalPlannerTask('goal-1', 1, 'failed', source(first), clock)).rejects.toThrow('goal_planner_result_conflict');
  });

  it('keeps manual completion distinct from verified completion and keeps quiescent metadata in its owning state', async () => {
    const { store } = open(); await start(store); await transition(store, 'pause'); await store.pollGoalAutonomy('goal-1', clock);
    const change = async (status: 'paused' | 'blocked' | 'complete', id: string) => {
      const goal = (await query(store)).goal!;
      return store.execute(id, { ...scope, kind: 'goal.put', goalId: goal.goalId, expectedVersion: goal.version,
        title: goal.title, phase: goal.phase, roundCap: goal.roundCap, status }, clock);
    };
    await change('complete', 'manual-complete');
    expect((await query(store)).goal).toMatchObject({ status: 'complete', autonomy: { status: 'complete', completedBy: 'user' } });
    expect((await query(store)).goal!.autonomy!.assessment).toBeUndefined();
    await change('blocked', 'manual-blocked');
    expect((await query(store)).goal).toMatchObject({ status: 'blocked', autonomy: { status: 'blocked' } });
    expect((await query(store)).goal!.autonomy!.completedBy).toBeUndefined();
    await transition(store, 'resume');
    expect((await query(store)).goal!.autonomy!.status).toBe('planning');
  });

  it.each([
    [{ key: 'x', title: 'First', dependsOn: [] }, { key: 'x', title: 'Duplicate', dependsOn: [] }],
    [{ key: 'x', title: 'First', dependsOn: ['y'] }, { key: 'y', title: 'Cycle', dependsOn: ['x'] }],
    [{ key: 'x', title: 'Missing dependency', dependsOn: ['missing'] }]
  ])('rejects invalid dependency plans atomically: %j', async tasks => {
    const { store } = open(); const task = await start(store); await bound(store, task);
    const before = await query(store);
    await expect(stage(store, task, { decision: 'plan', summary: 'Invalid graph', tasks })).rejects.toThrow();
    expect(await query(store)).toEqual(before);
    expect((await store.findGoalPlannerTask(task.sessionId, task.messageId))!.task.decision).toBeUndefined();
  });

  it('requires a bound terminal planner source and refuses conflicting staged Run identities', async () => {
    const { store } = open(); const task = await start(store);
    await store.claimGoalPlannerTask('goal-1', 1, clock);
    await stage(store, task);
    await expect(store.settleGoalPlannerTask('goal-1', 1, 'completed', undefined, clock)).rejects.toThrow('goal_planner_result_conflict');
    await expect(store.recordGoalPlannerSubmission('goal-1', 1, 'another-run', clock)).rejects.toThrow('goal_planner_run_conflict');
    await store.recordGoalPlannerSubmission('goal-1', 1, 'planner-run-1', clock);
    await expect(store.stageGoalDecision('goal-1', 1, { runId: 'another-run', effectId: 'effect-1',
      idempotencyKey: 'key-1', decision: plan }, clock)).rejects.toThrow('goal_decision_conflict');
    await expect(store.settleGoalPlannerTask('goal-1', 1, 'completed', { ...source(task), runId: 'another-run' }, clock)).rejects.toThrow('goal_planner_result_conflict');
    expect((await query(store)).workflows).toEqual([]);
  });

  it('rejects first-phase completion and each incomplete, duplicate, unknown, failed or empty-evidence assessment', async () => {
    const { store } = open(); const first = await start(store); await bound(store, first);
    await expect(stage(store, first, complete)).rejects.toThrow('goal_completion_not_proven');
    await stage(store, first); await settle(store, first); const task = await finishRound(store); await bound(store, task);
    if (complete.decision !== 'complete') throw new Error('fixture_invalid');
    for (const checks of [complete.checks.slice(0, 1), [complete.checks[0]!, complete.checks[0]!],
      complete.checks.map(check => ({ ...check, status: 'unknown' as const })),
      complete.checks.map(check => ({ ...check, status: 'failed' as const })),
      complete.checks.map(check => ({ ...check, evidence: ' ' }))]) {
      await expect(stage(store, task, { ...complete, checks })).rejects.toThrow();
    }
    expect((await query(store)).goal!.status).toBe('active');
    expect((await store.findGoalPlannerTask(task.sessionId, task.messageId))!.task.decision).toBeUndefined();
  });

  it('preserves a human Todo edit made after staging and blocks old-plan application', async () => {
    const { store } = open(); const task = await start(store); await bound(store, task); await stage(store, task);
    await store.execute('human-edit', { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal-1',
      expectedGoalVersion: (await query(store)).goal!.version, expectedRevision: null,
      items: [{ todoId: 'human-todo', title: 'New user requirement', status: 'pending' }] }, clock);
    await settle(store, task);
    expect((await query(store)).goal).toMatchObject({ status: 'blocked', roundsUsed: 0 });
    expect((await query(store)).todos).toMatchObject([{ todoId: 'human-todo', title: 'New user requirement' }]);
    expect((await query(store)).workflows).toEqual([]);
    await transition(store, 'resume');
    expect((await store.pendingGoalAutonomy())[0]!.agentExecution!.tasks.at(-1)!.prompt).toContain('New user requirement');
  });

  it('rolls back planner terminalization, Todo replacement and round charging if Workflow creation fails', async () => {
    const { store, root } = open(); const task = await start(store); await bound(store, task); await stage(store, task);
    const before = await query(store);
    const database = new DatabaseSync(path.join(root, 'data', 'productivity', 'productivity.db'));
    try {
      database.exec("CREATE TRIGGER reject_goal_workflow BEFORE INSERT ON productivity_workflows BEGIN SELECT RAISE(ABORT,'injected_workflow_failure'); END;");
      await expect(settle(store, task)).rejects.toThrow('injected_workflow_failure');
      expect(await query(store)).toEqual(before);
      expect((await store.findGoalPlannerTask(task.sessionId, task.messageId))!.task.status).toBe('submitted');
      database.exec('DROP TRIGGER reject_goal_workflow');
      await settle(store, task);
      expect((await query(store)).goal!.roundsUsed).toBe(1);
    } finally { database.close(); }
  });

  it('fences user additions after verification staging instead of completing from a stale assessment', async () => {
    const { store } = open(); const first = await start(store); await startRound(store, first);
    const task = await finishRound(store); await bound(store, task); await stage(store, task, complete);
    const current = await query(store);
    await store.execute('new-requirement', { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal-1',
      expectedGoalVersion: current.goal!.version, expectedRevision: current.todoRevision,
      items: [...current.todos.map(({ ordinal: _ordinal, ...item }) => item),
        { todoId: 'new-human-todo', title: 'Additional user work', status: 'pending' }] }, clock);
    await settle(store, task);
    expect((await query(store)).goal!.status).toBe('blocked');
    expect((await query(store)).todos.at(-1)).toMatchObject({ todoId: 'new-human-todo', status: 'pending' });
  });

  it('settles a planner at the exact deadline without applying its candidate or relying on a preceding poll', async () => {
    const { store } = open(); const task = await start(store); await bound(store, task); await stage(store, task);
    await store.settleGoalPlannerTask('goal-1', 1, 'completed', source(task), new Date(deadline));
    expect((await query(store)).goal).toMatchObject({ status: 'paused', roundsUsed: 0, autonomy: { status: 'paused' } });
    expect((await query(store)).workflows).toEqual([]);
    expect((await store.findGoalPlannerTask(task.sessionId, task.messageId))!.task.outcome).toBe('completed');
  });

  it('holds claimed planners during pause, refuses direct activation and joins before generating a new identity', async () => {
    const { store } = open(); const task = await start(store); await bound(store, task); await stage(store, task);
    await transition(store, 'pause');
    const stopping = await query(store);
    expect(stopping.goal).toMatchObject({ status: 'paused', autonomy: { status: 'stopping' } });
    await store.pollGoalAutonomy('goal-1', clock); await transition(store, 'pause', 'pause-again');
    expect((await query(store)).goal!.version).toBe(stopping.goal!.version);
    await expect(transition(store, 'resume')).rejects.toThrow('goal_autonomy_not_resumable');
    await expect(store.execute('direct-active', { ...scope, kind: 'goal.put', goalId: 'goal-1',
      expectedVersion: stopping.goal!.version, title: 'Deliver feature', phase: 'implementation', status: 'active', roundCap: 3 }, clock))
      .rejects.toThrow('goal_autonomy_resume_required');
    await settle(store, task, 'cancelled');
    expect((await query(store)).goal!.autonomy!.status).toBe('paused');
    expect((await query(store)).workflows).toEqual([]);
    await transition(store, 'resume');
    const resumed = (await store.pendingGoalAutonomy())[0]!.agentExecution!.tasks.at(-1)!;
    expect(resumed).toMatchObject({ attempt: 2, status: 'unclaimed' }); expect(resumed.sessionId).not.toBe(task.sessionId);
  });

  it('withdraws unclaimed planning at the exact deadline and performs no repeated version writes', async () => {
    const { store } = open(); await start(store);
    const expired = new Date(deadline);
    await store.pollGoalAutonomy('goal-1', expired);
    const stopped = await query(store);
    expect(stopped.goal).toMatchObject({ status: 'paused', autonomy: { status: 'paused' } });
    expect(await store.pendingGoalAutonomy()).toEqual([]);
    await store.pollGoalAutonomy('goal-1', expired); expect(await query(store)).toEqual(stopped);
    await expect(store.execute('expired-resume', { ...scope, kind: 'goal.autonomy.transition', goalId: 'goal-1',
      expectedVersion: stopped.goal!.version, action: 'resume' }, expired)).rejects.toThrow('goal_deadline_exceeded');
  });

  it('pauses executing Workflows and waits for claimed task settlement before becoming resumable', async () => {
    const { store } = open(); const first = await start(store); await startRound(store, first);
    const work = (await store.pendingWorkflowAgentWork())[0]!; const active = work.workflow.agentExecution!.tasks[0]!;
    await store.claimWorkflowAgentTask(work.workflow.workflowId, active.todoId, clock);
    await store.recordWorkflowAgentSubmission(work.workflow.workflowId, active.todoId, 'actual-run', clock);
    await transition(store, 'pause'); await store.pollGoalAutonomy('goal-1', clock);
    expect((await query(store)).goal!.autonomy!.status).toBe('stopping');
    expect((await query(store)).workflows[0]!.status).toBe('cancelling');
    await store.settleWorkflowAgentTask(work.workflow.workflowId, active.todoId, 'cancelled', 'Actual Run joined', clock,
      { runId: 'actual-run', runVersion: 5 });
    await store.pollGoalAutonomy('goal-1', clock);
    expect((await query(store)).goal!.autonomy!.status).toBe('paused');
    expect((await query(store)).workflows[0]!.status).toBe('cancelled');
  });

  it('refuses a concurrent manually started Workflow and freezes Goal configuration during autonomy', async () => {
    const { store } = open(); await start(store); const current = (await query(store)).goal!;
    await store.execute('todo', { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal-1', expectedGoalVersion: current.version,
      expectedRevision: null, items: [{ todoId: 'manual', title: 'Manual task', status: 'pending' }] }, clock);
    await expect(store.execute('manual-workflow', { ...scope, kind: 'workflow.start', workflowId: 'manual-workflow', goalId: 'goal-1',
      expectedGoalVersion: current.version, expectedTodoRevision: 1, todoIds: ['manual'], maxConcurrency: 1, maxTransitions: 1, deadlineAt: deadline }, clock))
      .rejects.toThrow('workflow_goal_autonomy_owned');
    await expect(store.execute('retitle', { ...scope, kind: 'goal.put', goalId: 'goal-1', expectedVersion: current.version,
      title: 'Changed', phase: current.phase, status: current.status, roundCap: current.roundCap }, clock)).rejects.toThrow('goal_autonomy_configuration_locked');
  });

  it('permits verification recovery at the last execution round but prevents any extra execution round', async () => {
    const { store } = open(); const first = await start(store, 1); await startRound(store, first);
    const verify = await finishRound(store); await bound(store, verify); await settle(store, verify, 'failed');
    expect((await query(store)).goal!.status).toBe('blocked');
    await transition(store, 'resume'); const last = (await store.pendingGoalAutonomy())[0]!.agentExecution!.tasks.at(-1)!;
    await bound(store, last); await stage(store, last, complete); await settle(store, last);
    expect((await query(store)).goal).toMatchObject({ status: 'complete', roundsUsed: 1 });
  });

  it('persists the exact staged decision across restart and uses new generation IDs for a fresh start', async () => {
    const { store, root } = open(); const task = await start(store); await bound(store, task); await stage(store, task);
    const before = (await store.findGoalPlannerTask(task.sessionId, task.messageId))!;
    await close(store); const recovered = open(root).store;
    expect(await recovered.findGoalPlannerTask(task.sessionId, task.messageId)).toEqual(before);
    await stage(recovered, task); await settle(recovered, task, 'cancelled');
    const current = (await query(recovered)).goal!;
    await recovered.execute('new-generation', { ...scope, kind: 'goal.autonomy.start', goalId: 'goal-1', expectedVersion: current.version,
      criteria: ['New requirement'], maxConcurrency: 1, deadlineAt: deadline }, clock, context);
    const next = (await recovered.pendingGoalAutonomy())[0]!.agentExecution!.tasks.at(-1)!;
    expect(next.attempt).toBe(1); expect(next.sessionId).not.toBe(task.sessionId); expect(next.submitCommandId).not.toBe(task.submitCommandId);
  });

  it('bounds maximum criteria and 256 predecessor outputs without dropping a criterion or immutable reference', async () => {
    const { store } = open(); const criteria = Array.from({ length: 32 }, (_, index) => `${index}:` + 'x'.repeat(1_995));
    const first = await start(store, 3, criteria);
    await startRound(store, first, { decision: 'plan', summary: 'Verify every artifact', tasks: Array.from({ length: 256 }, (_, index) =>
      ({ key: `item-${index}`, title: `Inspect artifact ${index}`, dependsOn: [] })) });
    const verify = await finishRound(store);
    const rendered = await renderProductivityTaskPrompt({ resolveMessageReference: async () =>
      ({ workspaceId: scope.workspaceId, role: 'assistant', content: 'z'.repeat(200_000) }) }, scope.workspaceId, verify);
    expect(rendered.length).toBeLessThanOrEqual(100_000);
    for (const text of criteria) expect(rendered).toContain(text);
    for (const dependency of verify.dependencyMessages!) expect(rendered).toContain(dependency.reference.messageId);
    expect(rendered).toContain('已截断');
  }, 15_000);
});
