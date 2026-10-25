import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentEffectExecutionInput } from '@ariadne/agent-core';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, runtimeCommandSchema } from '@ariadne/protocol/public';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { GoalPlannerTask } from '../src/adapters/persistence/SqliteGoalAutonomy.js';
import type { WorkflowAgentTask } from '../src/adapters/persistence/SqliteWorkflowExecution.js';
import type { AgentProtectedEffectResultAuthorityRecord } from '../src/control/ports/AgentToolExecution.js';
import { historicalProviderToolCallId } from '../src/adapters/model/AgentModelToolResultReference.js';
import { createAgentConversationComponent } from '../src/composition/agent-entity/components/conversation/AgentConversationComponent.js';
import type { AgentControlExecutionPipeline } from '../src/composition/ProductionAgentControlExecutionPipelineFactory.js';
import { ConversationRunHandoffSagaService } from '../src/control/conversation/ConversationRunHandoffSagaService.js';
import { ConversationAgentResultProjectionService } from '../src/control/conversation/ConversationAgentResultProjectionService.js';
import { deriveConversationAuthorityId } from '../src/conversation/ConversationRunHandoffIds.js';
import { GoalAutonomyWorker } from '../src/composition/GoalAutonomyWorker.js';
import { WorkflowAgentWorker } from '../src/composition/WorkflowAgentWorker.js';
import { ProductionGoalPlanningAuthority } from '../src/composition/ProductionGoalPlanningAuthority.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import type { GoalDecision } from '../src/control/ports/GoalPlanningAuthority.js';
import { ProductivityTaskRecovery } from '../src/composition/ProductivityTaskRecovery.js';

const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-1', sessionId: 'session-1' } as const;
const clock = new Date('2026-10-01T00:00:00Z');
const deadline = '2098-01-01T00:00:00Z';
const digest = `sha256:${'a'.repeat(64)}`;
const decision: GoalDecision = { decision: 'plan', summary: 'Implement and verify the feature',
  tasks: [{ key: 'work', title: 'Complete the actual work and verify it', dependsOn: [] }] };
async function recoverTask(recovery: ProductivityTaskRecovery, workspaceId: string, sessionId: string,
  faultId: string, expectedRevision: number, commandId = ['recovery', workspaceId, sessionId, faultId, expectedRevision].join('-')) {
  return (await recovery.reconcile(commandId, { kind: 'productivity.task.reconcile', contractVersion: '1.0',
    workspaceId, sessionId, faultId, expectedRevision })).fault;
}

const roots: string[] = [];
const stores: SqliteProductivityStore[] = [];
const conversations: SqliteConversationRunHandoffUnitOfWork[] = [];
const workers: GoalAutonomyWorker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop().catch(() => undefined);
  const shutdown = createShutdownContext(Date.now() + 5_000);
  try {
    for (const store of stores.splice(0)) await store.close(shutdown);
    for (const conversation of conversations.splice(0)) await conversation.close(shutdown);
  } finally { shutdown.dispose(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function open(root?: string) {
  const directory = root ?? mkdtempSync(path.join(os.tmpdir(), 'ariadne-goal-worker-'));
  if (root === undefined) roots.push(directory);
  const store = new SqliteProductivityStore(directory); stores.push(store);
  return { store, root: directory };
}
async function start(store: SqliteProductivityStore) {
  await store.execute('goal', { ...scope, kind: 'goal.put', goalId: 'goal-1', expectedVersion: null,
    title: 'Deliver actual behavior', phase: 'implementation', status: 'active', roundCap: 3 }, clock);
  await store.execute('start', { ...scope, kind: 'goal.autonomy.start', goalId: 'goal-1', expectedVersion: 1,
    criteria: ['Actual behavior works'], maxConcurrency: 1, deadlineAt: deadline }, clock,
    { sourceSessionId: scope.sessionId, sourceSessionVersion: 1 });
  return (await store.pendingGoalAutonomy())[0]!.agentExecution!.tasks[0]!;
}
async function query(store: SqliteProductivityStore) { return store.query(scope.workspaceId, scope.sessionId); }
function harness(root: string, store: SqliteProductivityStore, conversation?: SqliteConversationRunHandoffUnitOfWork) {
  const authority = conversation ?? new SqliteConversationRunHandoffUnitOfWork(root);
  if (conversation === undefined) conversations.push(authority);
  const pipeline = { runWorkScheduler: { assertHealthy() {} }, executionScheduler: { assertHealthy() {}, wake() {} },
    handoffProducer: { assertHealthy() {}, wake() {} }, assertConversationMessageAdmission() {}
  } as unknown as AgentControlExecutionPipeline;
  const owner = createAgentConversationComponent({ conversation: authority, executionPipeline: pipeline, wakeProjectionDrain() {} });
  const dispatch = vi.fn<ConstructorParameters<typeof GoalAutonomyWorker>[3]>(async envelope => {
    runtimeCommandSchema.parse(envelope.command);
    if (envelope.command.kind === 'conversation.session.create') return owner.executeSession(envelope, envelope.command);
    if (envelope.command.kind === 'conversation.session.fork') return owner.executeNavigation(envelope, envelope.command);
    if (envelope.command.kind === 'conversation.message.accept') return owner.executeAcceptMessage(envelope, envelope.command);
    throw new Error('unexpected_fixture_command');
  });
  const runs = new Map<string, AgentRun>();
  const inputs = new Map<string, AgentEffectExecutionInput>();
  const results = new Map<string, AgentProtectedEffectResultAuthorityRecord>();
  const loadRun = async (id: string) => runs.get(id) ?? null;
  const worker = new GoalAutonomyWorker(store, authority, loadRun, dispatch, 60_000); workers.push(worker);
  const planning = new ProductionGoalPlanningAuthority(store, authority, loadRun, async (_runId, effectId) => {
    const input = inputs.get(effectId); if (input === undefined) throw new Error('fixture_effect_missing'); return input;
  }, { loadProtectedEffectResultAuthority: async (_runId, effectId) => results.get(effectId) ?? null });
  return { conversation: authority, owner, worker, dispatch, runs, inputs, results, planning };
}
async function link(h: ReturnType<typeof harness>, task: WorkflowAgentTask): Promise<AgentRun> {
  const saga = (await h.conversation.readSagaByMessage(task.messageId, 1))!;
  const service = new ConversationRunHandoffSagaService(h.conversation);
  const identity = { sagaId: saga.sagaId, sessionId: task.sessionId, workspaceId: scope.workspaceId,
    messageId: task.messageId, messageVersion: 1, objectiveDigest: saga.objectiveDigest };
  await service.execute({ ...identity, kind: 'handoff.request_agent_run', commandId: `${task.todoId}-request`,
    expectedVersion: 1, inboxEventId: `${task.todoId}-request-inbox`, outboxMessageId: `${task.todoId}-request-outbox`,
    occurredAt: new Date().toISOString(), runRequestId: `${task.todoId}-run-request`, agentCommandId: `${task.todoId}-agent-command` });
  const runId = `run-${task.todoId}`;
  await service.execute({ ...identity, kind: 'handoff.link_agent_run', commandId: `${task.todoId}-link`,
    expectedVersion: 2, inboxEventId: `${task.todoId}-link-inbox`, outboxMessageId: `${task.todoId}-link-outbox`,
    occurredAt: new Date().toISOString(), runRequestId: `${task.todoId}-run-request`, agentCommandId: `${task.todoId}-agent-command`,
    runId, admittedRunVersion: 1 });
  // Core observations are structural fixtures; both Conversation persistence and command ingress are production.
  const run = { runId, version: 3, updatedAt: clock.toISOString(), state: { status: 'running' }, effects: [],
    binding: { sessionId: task.sessionId, workspace: { workspaceId: scope.workspaceId },
      objectiveRef: { kind: 'conversation_message', messageId: task.messageId, messageVersion: 1, contentDigest: saga.objectiveDigest } }
  } as unknown as AgentRun;
  h.runs.set(runId, run); return run;
}
function tool(h: ReturnType<typeof harness>, run: AgentRun, value: GoalDecision = decision) {
  const effectId = `effect-${run.runId}`; const idempotencyKey = `key-${run.runId}`;
  const effect = { effectId, toolCallId: `goal-call-${run.runId}`, runId: run.runId, idempotencyKey, scope: [scope.workspaceId], inputDigest: digest,
    tool: { toolName: 'productivity.record_goal_decision' }, state: { status: 'started' } };
  const active = { ...run, effects: [effect] } as unknown as AgentRun;
  h.runs.set(run.runId, active);
  h.inputs.set(effectId, { runId: run.runId, effectId, inputDigest: digest, input: value });
  return { input: { runId: run.runId, effectId, idempotencyKey, decision: value }, run: active };
}
async function project(h: ReturnType<typeof harness>, task: WorkflowAgentTask, run: AgentRun, status: 'completed' | 'failed' | 'cancelled' = 'completed') {
  const saga = (await h.conversation.readSagaByMessage(task.messageId, 1))!;
  if (saga.stage.kind !== 'agent_run_linked') throw new Error('fixture_run_not_linked');
  const sourceRunEventId = `${task.todoId}-terminal-event`;
  const messageId = await deriveConversationAuthorityId('agent-result-message', sourceRunEventId);
  await new ConversationAgentResultProjectionService(h.conversation).project({ kind: 'conversation.project_agent_result',
    commandId: `${task.todoId}-project-result`, eventId: `${task.todoId}-result-event`, sessionId: task.sessionId,
    workspaceId: scope.workspaceId, expectedSessionVersion: (await h.conversation.readSession(task.sessionId))!.version,
    messageId, expectedMessageVersion: null, assistantContent: 'Actual planner output and reasons', sagaId: saga.sagaId, expectedSagaVersion: saga.version,
    handoffCommandId: `${task.todoId}-result-handoff`, handoffInboxEventId: `${task.todoId}-result-inbox`, handoffOutboxMessageId: `${task.todoId}-result-outbox`,
    objectiveMessageId: task.messageId, objectiveMessageVersion: 1, objectiveDigest: saga.objectiveDigest,
    runRequestId: saga.stage.runRequestId, agentCommandId: saga.stage.agentCommandId, runId: run.runId,
    admittedRunVersion: saga.stage.admittedRunVersion, resultRunVersion: run.version, resultStatus: status, sourceRunEventId,
    occurredAt: new Date().toISOString() });
}

async function verification(h: ReturnType<typeof harness>, store: SqliteProductivityStore, first: GoalPlannerTask) {
  await h.worker.start(); const run = await link(h, first); const invocation = tool(h, run);
  await h.planning.stageDecision(invocation.input, new AbortController().signal);
  const terminal = { ...invocation.run, version: 5, state: { status: 'completed' } } as AgentRun;
  h.runs.set(run.runId, terminal); await project(h, first, terminal); await h.worker.wake();
  const task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
  const workflow = new WorkflowAgentWorker(store, h.conversation, async id => h.runs.get(id) ?? null, h.dispatch, 60_000);
  try {
    await workflow.start(); const workRun = await link(h, task);
    const completed = { ...workRun, version: 5, state: { status: 'completed' } } as AgentRun;
    h.runs.set(workRun.runId, completed); await project(h, task, completed); await workflow.wake();
  } finally { await workflow.stop(); }
  await h.worker.wake(); const planner = (await store.pendingGoalAutonomy())[0]!.agentExecution!.tasks.at(-1)!;
  return { planner, run: await link(h, planner) };
}

describe('Goal planner Worker and protected Tool authority', () => {
  it('quarantines one planner receipt conflict, continues another Goal and reconciles only the original linked Run', async () => {
    const { store, root } = open(), first = await start(store);
    const otherScope = { ...scope, sessionId: 'session-independent' };
    await store.execute('other-goal', { ...otherScope, kind: 'goal.put', goalId: 'goal-independent', expectedVersion: null,
      title: 'Independent Goal', phase: 'implementation', status: 'active', roundCap: 3 }, clock);
    await store.execute('other-start', { ...otherScope, kind: 'goal.autonomy.start', goalId: 'goal-independent', expectedVersion: 1,
      criteria: ['Independent work progresses'], maxConcurrency: 1, deadlineAt: deadline }, clock,
      { sourceSessionId: otherScope.sessionId, sourceSessionVersion: 1 });
    const h = harness(root, store), submit = h.dispatch.getMockImplementation()!;
    h.dispatch.mockImplementation(async envelope => {
      const result = await submit(envelope);
      if (envelope.command.kind === 'conversation.message.accept' && envelope.command.messageId === first.messageId
        && result?.outcome.ok && result.outcome.result.kind === 'conversation.message.accepted') {
        return { ...result, outcome: { ok: true, result: { ...result.outcome.result, sessionId: 'conflicting-planner-receipt' } } };
      }
      return result;
    });
    await h.worker.start(); await h.worker.stop();
    expect(() => h.worker.assertHealthy()).not.toThrow(); expect(h.worker.hasQuarantinedTasks()).toBe(true);
    expect((await query(store)).goal!.autonomy!.status).toBe('planning');
    expect((await store.pendingGoalAutonomy()).find(goal => goal.goalId === 'goal-independent')!.agentExecution!.tasks[0]!.status).toBe('submitted');
    let fault = (await store.queryTaskFaults(scope.workspaceId, scope.sessionId, 32)).faults[0]!;
    expect(fault).toMatchObject({ taskKind: 'goal', taskId: first.todoId, ownerSessionId: scope.sessionId, state: 'quarantined' });
    const run = await link(h, first);
    const calls = h.dispatch.mock.calls.length;
    const recovery = new ProductivityTaskRecovery(store, h.conversation, async id => h.runs.get(id) ?? null);
    fault = await recoverTask(recovery, scope.workspaceId, scope.sessionId, fault.faultId, fault.revision);
    expect(fault.state).toBe('resolved'); expect(h.dispatch).toHaveBeenCalledTimes(calls);
    expect((await store.findGoalPlannerTask(first.sessionId, first.messageId))!.task.runId).toBeUndefined();
    expect((await h.conversation.readSession(first.sessionId))!.version).toBe(2);
    expect(run.binding.sessionId).toBe(first.sessionId);
  });
  it.each(['valid', 'raw-call-id', 'foreign-workspace', 'foreign-run', 'failed', 'wrong-pin', 'missing-result', 'foreign-message'] as const)
    ('binds completion evidence to actual predecessor or successful protected Tool results: %s', async variant => {
      const { store, root } = open(); const first = await start(store); const h = harness(root, store);
      const { planner, run } = await verification(h, store, first);
      const pin = { catalogId: 'catalog', revision: 1, digest, toolName: 'workspace.read_file', toolVersion: '1.0.0', providerId: 'provider', contractDigest: digest };
      const evidenceEffect = { effectId: 'evidence-effect', runId: run.runId, toolCallId: 'read-call', tool: pin,
        scope: [scope.workspaceId], state: { status: 'succeeded' } } as unknown as AgentRun['effects'][number];
      h.results.set(evidenceEffect.effectId, { runId: run.runId, workspaceId: scope.workspaceId, effectId: evidenceEffect.effectId,
        toolCallId: evidenceEffect.toolCallId, status: 'succeeded', tool: pin, result: { content: 'Actual file content' } });
      const source = variant === 'foreign-message' ? { kind: 'task_result' as const, messageId: 'other-message' }
        : { kind: 'tool_result' as const, toolCallId: variant === 'raw-call-id' ? evidenceEffect.toolCallId
          : historicalProviderToolCallId(run.runId, evidenceEffect.effectId, evidenceEffect.toolCallId) };
      const value: GoalDecision = { decision: 'complete', summary: 'Actual result inspected',
        checks: [{ criterion: 0, status: 'passed', evidence: 'Inspected the produced file and its behavior', sources: [source] }] };
      const invocation = tool(h, run, value);
      h.runs.set(run.runId, { ...invocation.run, effects: [...invocation.run.effects, variant === 'failed'
        ? { ...evidenceEffect, state: { status: 'failed', reason: 'Tool failed' } } : evidenceEffect] } as AgentRun);
      const record = h.results.get(evidenceEffect.effectId)!;
      if (variant === 'foreign-workspace') h.results.set(evidenceEffect.effectId, { ...record, workspaceId: 'foreign' });
      if (variant === 'foreign-run') h.results.set(evidenceEffect.effectId, { ...record, runId: 'foreign' });
      if (variant === 'wrong-pin') h.results.set(evidenceEffect.effectId, { ...record, tool: { ...pin, revision: 2 } });
      if (variant === 'missing-result') h.results.delete(evidenceEffect.effectId);
      if (variant !== 'valid') {
        await expect(h.planning.stageDecision(invocation.input, new AbortController().signal)).rejects.toThrow('goal_completion_evidence_not_authorized');
        expect((await query(store)).goal!.status).toBe('active');
        expect((await store.findGoalPlannerTask(planner.sessionId, planner.messageId))!.task.decision).toBeUndefined();
      } else {
        await h.planning.stageDecision(invocation.input, new AbortController().signal);
        expect((await query(store)).goal!.status).toBe('active');
        const completed = { ...h.runs.get(run.runId)!, version: 7, state: { status: 'completed' } } as AgentRun;
        h.runs.set(run.runId, completed); await project(h, planner, completed); await h.worker.wake();
        expect((await query(store)).goal).toMatchObject({ status: 'complete', autonomy: { completedBy: 'verification' } });
      }
    });
  it('includes frozen Goal criteria in the actual accepted Workflow task without duplicating them in every durable task intent', async () => {
    const { store, root } = open(); const task = await start(store); const h = harness(root, store);
    await h.worker.start(); const run = await link(h, task); const invocation = tool(h, run);
    await h.planning.stageDecision(invocation.input, new AbortController().signal);
    const completed = { ...invocation.run, state: { status: 'completed' }, version: 5 } as AgentRun;
    h.runs.set(run.runId, completed); await project(h, task, completed); await h.worker.wake(); await h.worker.stop();
    const work = (await store.pendingWorkflowAgentWork())[0]!; const todo = work.workflow.agentExecution!.tasks[0]!;
    expect(work.workflow.agentExecution!.criteria).toEqual(['Actual behavior works']);
    expect(todo.prompt).not.toContain('Actual behavior works');
    const workflow = new WorkflowAgentWorker(store, h.conversation, async id => h.runs.get(id) ?? null, h.dispatch, 60_000);
    try {
      await workflow.start();
      expect((await h.conversation.readMessageVersion(todo.messageId, 1))!.payload.content).toContain('0: Actual behavior works');
    } finally { await workflow.stop(); }
  });

  it('accepts only an exact protected invocation, stages before Run linkage is recorded, and applies only after exact terminal projection', async () => {
    const { store, root } = open(); const task = await start(store); const h = harness(root, store);
    await h.worker.start(); const run = await link(h, task); const invocation = tool(h, run);
    expect((await store.findGoalPlannerTask(task.sessionId, task.messageId))!.task.runId).toBeUndefined();
    await h.planning.stageDecision(invocation.input, new AbortController().signal);
    expect((await query(store)).workflows).toEqual([]);
    await h.worker.wake();
    const completed = { ...invocation.run, state: { status: 'completed' }, version: 5 } as AgentRun;
    h.runs.set(run.runId, completed); await h.worker.wake();
    expect((await query(store)).workflows).toEqual([]);
    await project(h, task, completed); await h.worker.wake(); await h.worker.stop();
    expect((await query(store)).goal).toMatchObject({ roundsUsed: 1, autonomy: { status: 'executing' } });
    expect((await query(store)).workflows).toHaveLength(1);
    const terminal = (await store.findGoalPlannerTask(task.sessionId, task.messageId))!.task;
    expect(terminal).toMatchObject({ status: 'terminal', outcome: 'completed', source: { runId: run.runId, runVersion: 5 } });
  });

  it.each(['workspace', 'session', 'objective', 'effect', 'effect-key', 'effect-input', 'effect-digest', 'effect-scope', 'tool-name'] as const)
    ('refuses a forged %s binding without creating a decision or Workflow', async field => {
      const { store, root } = open(); const task = await start(store); const h = harness(root, store);
      await h.worker.start(); const run = await link(h, task); const invocation = tool(h, run);
      if (field === 'workspace') h.runs.set(run.runId, { ...invocation.run, binding: { ...run.binding, workspace: { ...run.binding.workspace, workspaceId: 'other' } } });
      if (field === 'session') h.runs.set(run.runId, { ...invocation.run, binding: { ...run.binding, sessionId: 'other' } });
      if (field === 'objective') h.runs.set(run.runId, { ...invocation.run, binding: { ...run.binding,
        objectiveRef: { ...run.binding.objectiveRef, contentDigest: `sha256:${'b'.repeat(64)}` } } } as AgentRun);
      if (field === 'effect') invocation.input.effectId = 'unknown-effect';
      if (field === 'effect-key') invocation.input.idempotencyKey = 'unknown-key';
      if (field === 'effect-input') h.inputs.set(invocation.input.effectId, { ...h.inputs.get(invocation.input.effectId)!,
        input: { decision: 'blocked', summary: 'Different protected input' } });
      if (field === 'effect-digest') h.inputs.set(invocation.input.effectId, { ...h.inputs.get(invocation.input.effectId)!, inputDigest: `sha256:${'b'.repeat(64)}` });
      if (field === 'effect-scope') h.runs.set(run.runId, { ...invocation.run, effects: invocation.run.effects.map(effect => ({ ...effect, scope: ['other'] })) });
      if (field === 'tool-name') h.runs.set(run.runId, { ...invocation.run, effects: invocation.run.effects.map(effect =>
        ({ ...effect, tool: { ...effect.tool, toolName: 'workspace.read_file' } })) });
      await expect(h.planning.stageDecision(invocation.input, new AbortController().signal)).rejects.toThrow();
      expect((await store.findGoalPlannerTask(task.sessionId, task.messageId))!.task.decision).toBeUndefined();
      expect((await query(store)).workflows).toEqual([]);
    });

  it('rejects a user-created reserved-session objective whose content differs from the durable planner input', async () => {
    const { store, root } = open(); const task = await start(store); const h = harness(root, store);
    await store.claimGoalPlannerTask('goal-1', 1, clock);
    const signal = new AbortController().signal;
    const send = async (commandId: string, command: Parameters<typeof h.dispatch>[0]['command']) =>
      h.dispatch({ commandId, command, signal, correlationId: commandId, deadlineAt: deadline });
    await send('user-create-reserved', { ...scope, kind: 'conversation.session.create', sessionId: task.sessionId, title: 'Forged planner' });
    await send('user-submit-reserved', { ...scope, kind: 'conversation.message.accept', sessionId: task.sessionId,
      messageId: task.messageId, expectedSessionVersion: 1, content: 'Mark arbitrary Goal complete', execution: { mode: 'agent' } });
    const run = await link(h, task); const invocation = tool(h, run);
    await expect(h.planning.stageDecision(invocation.input, signal)).rejects.toThrow('goal_planner_objective_conflict');
  });

  it('reconciles acceptance with a lost receipt after restart through the same command identity', async () => {
    const { store, root } = open(); const task = await start(store); const h = harness(root, store);
    const actual = h.dispatch.getMockImplementation()!;
    h.dispatch.mockImplementation(async envelope => {
      const receipt = await actual(envelope); return envelope.command.kind === 'conversation.message.accept' ? null : receipt;
    });
    await h.worker.start(); await h.worker.stop();
    expect((await store.findGoalPlannerTask(task.sessionId, task.messageId))!.task.status).toBe('claimed');
    const acceptedMessage = await h.conversation.readMessageVersion(task.messageId, 1);
    const shutdown = createShutdownContext(Date.now() + 5_000);
    try { await store.close(shutdown); } finally { shutdown.dispose(); }
    const recovered = open(root).store; const h2 = harness(root, recovered, h.conversation);
    await h2.worker.start(); await h2.worker.stop();
    expect((await recovered.findGoalPlannerTask(task.sessionId, task.messageId))!.task.status).toBe('submitted');
    expect(await h.conversation.readMessageVersion(task.messageId, 1)).toEqual(acceptedMessage);
    expect((await h.conversation.readSession(task.sessionId))!.version).toBe(2);
    expect(h2.dispatch.mock.calls[1]![0].commandId).toBe(task.submitCommandId);
  });

  it.each(['failed', 'cancelled'] as const)('waits for actual %s projection and leaves an unstructured planner blocked', async status => {
    const { store, root } = open(); const task = await start(store); const h = harness(root, store);
    await h.worker.start(); const run = await link(h, task);
    const terminal = { ...run, state: { status }, version: 5 } as AgentRun;
    h.runs.set(run.runId, terminal); await h.worker.wake();
    expect((await query(store)).goal!.autonomy!.status).toBe('planning');
    await project(h, task, terminal, status); await h.worker.wake(); await h.worker.stop();
    expect((await query(store)).goal).toMatchObject({ status: 'blocked', roundsUsed: 0, autonomy: { status: 'blocked' } });
    expect((await store.findGoalPlannerTask(task.sessionId, task.messageId))!.task).toMatchObject({ outcome: status, source: { runVersion: 5 } });
  });

  it('does not confuse a cancellation request with terminal settlement and discards a staged plan after pause', async () => {
    const { store, root } = open(); const task = await start(store); const h = harness(root, store);
    await h.worker.start(); const run = await link(h, task); const invocation = tool(h, run);
    await h.planning.stageDecision(invocation.input, new AbortController().signal);
    await store.execute('pause', { ...scope, kind: 'goal.autonomy.transition', goalId: 'goal-1',
      expectedVersion: (await query(store)).goal!.version, action: 'pause' }, clock);
    const actual = h.dispatch.getMockImplementation()!;
    h.dispatch.mockImplementation(async envelope => envelope.command.kind === 'agent.run.cancel'
      ? { settlement: 'completed', outcome: { ok: true, result: { kind: 'agent.run.cancel.requested.v3', runId: run.runId, runVersion: 4 } } }
      : actual(envelope));
    await h.worker.wake();
    expect((await query(store)).goal!.autonomy!.status).toBe('stopping');
    const cancelled = { ...invocation.run, state: { status: 'cancelled' }, version: 5 } as AgentRun;
    h.runs.set(run.runId, cancelled); await project(h, task, cancelled, 'cancelled'); await h.worker.wake(); await h.worker.stop();
    expect((await query(store)).goal!.autonomy!.status).toBe('paused'); expect((await query(store)).workflows).toEqual([]);
  });

  it('aborts and joins an owned in-flight submission during shutdown, preserving the durable claim for replay', async () => {
    const { store, root } = open(); const task = await start(store); const h = harness(root, store);
    const actual = h.dispatch.getMockImplementation()!;
    let aborted = false; let submitting = false;
    h.dispatch.mockImplementation(async envelope => {
      if (envelope.command.kind !== 'conversation.message.accept') return actual(envelope);
      submitting = true;
      return new Promise((_resolve, reject) => envelope.signal.addEventListener('abort', () => {
        aborted = true; reject(envelope.signal.reason);
      }, { once: true }));
    });
    const starting = h.worker.start(); await vi.waitFor(() => expect(submitting).toBe(true));
    await h.worker.stop(); await starting;
    expect(aborted).toBe(true); expect(() => h.worker.assertHealthy()).not.toThrow();
    expect((await store.findGoalPlannerTask(task.sessionId, task.messageId))!.task.status).toBe('claimed');
  });
});
