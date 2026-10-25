import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@ariadne/agent-core';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, runtimeCommandSchema, runtimeResultSchema } from '@ariadne/protocol/public';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { createAgentConversationComponent } from '../src/composition/agent-entity/components/conversation/AgentConversationComponent.js';
import type { AgentControlExecutionPipeline } from '../src/composition/ProductionAgentControlExecutionPipelineFactory.js';
import { ConversationRunHandoffSagaService } from '../src/control/conversation/ConversationRunHandoffSagaService.js';
import { WorkflowAgentWorker } from '../src/composition/WorkflowAgentWorker.js';
import { ProductivityPublicCommandHandler } from '../src/composition/ProductivityPublicCommandHandler.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import type { WorkflowAgentTask } from '../src/adapters/persistence/SqliteWorkflowExecution.js';
import { ConversationAgentResultProjectionService } from '../src/control/conversation/ConversationAgentResultProjectionService.js';
import { deriveConversationAuthorityId } from '../src/conversation/ConversationRunHandoffIds.js';
import { ProductivityTaskRecovery } from '../src/composition/ProductivityTaskRecovery.js';
import { createProductivityTaskIsolationCommandOwners } from '../src/composition/ProductivityTaskIsolationCommandHandler.js';
import type { ProductivityTaskRecoveryCommand } from '@ariadne/protocol/public';

async function recoverTask(recovery: ProductivityTaskRecovery, workspaceId: string, sessionId: string,
  faultId: string, expectedRevision: number, commandId = ['recovery', workspaceId, sessionId, faultId, expectedRevision].join('-')) {
  return (await recovery.reconcile(commandId, { kind: 'productivity.task.reconcile', contractVersion: '1.0',
    workspaceId, sessionId, faultId, expectedRevision })).fault;
}

const roots: string[] = [];
const stores: SqliteProductivityStore[] = [];
const conversations: SqliteConversationRunHandoffUnitOfWork[] = [];
const workers: WorkflowAgentWorker[] = [];
const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-1', sessionId: 'session-1' } as const;
const clock = new Date('2026-10-01T00:00:00Z');
const deadline = '2098-01-01T00:01:00Z';
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop().catch(() => undefined);
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    for (const store of stores.splice(0)) await store.close(context);
    for (const conversation of conversations.splice(0)) await conversation.close(context);
  } finally { context.dispose(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function open(root?: string) {
  const directory = root ?? mkdtempSync(path.join(os.tmpdir(), 'ariadne-workflow-agent-'));
  if (root === undefined) roots.push(directory);
  const store = new SqliteProductivityStore(directory); stores.push(store);
  return { store, root: directory };
}
async function close(store: SqliteProductivityStore) {
  const context = createShutdownContext(Date.now() + 5_000);
  try { await store.close(context); } finally { context.dispose(); }
}
async function start(store: SqliteProductivityStore, concurrency = 2, dependencies = false) {
  await store.execute('goal', { ...scope, kind: 'goal.put', goalId: 'goal-1', expectedVersion: null,
    title: 'Complete the release', phase: 'implementation', status: 'active', roundCap: 8 }, clock);
  await store.execute('todos', { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal-1', expectedGoalVersion: 1,
    expectedRevision: null, items: ['one', 'two', 'three'].map((todoId, index, ids) => ({ todoId, title: todoId, status: 'pending' as const,
      ...(dependencies ? { dependsOn: index === 0 ? [] : [ids[index - 1]!] } : {}) })) }, clock);
  return store.execute('start', { ...scope, kind: 'workflow.start', workflowId: 'workflow-1', goalId: 'goal-1',
    expectedGoalVersion: 1, expectedTodoRevision: 1, todoIds: ['one', 'two', 'three'], maxConcurrency: concurrency,
    maxTransitions: 3, deadlineAt: deadline, executionMode: 'agent' }, clock);
}
async function snapshot(store: SqliteProductivityStore) { return store.query(scope.workspaceId, scope.sessionId); }
async function stop(store: SqliteProductivityStore, commandId = 'cancel') {
  const current = (await snapshot(store)).workflows[0]!;
  return store.execute(commandId, { ...scope, kind: 'workflow.cancel', workflowId: current.workflowId, expectedVersion: current.version }, clock);
}
async function claimed(store: SqliteProductivityStore, todoId = 'one') {
  return (await store.claimWorkflowAgentTask('workflow-1', todoId, clock))!;
}
function harness(root: string, store: SqliteProductivityStore) {
  const conversation = new SqliteConversationRunHandoffUnitOfWork(root); conversations.push(conversation);
  const pipeline = { runWorkScheduler: { assertHealthy() {} }, executionScheduler: { assertHealthy() {}, wake() {} },
    handoffProducer: { assertHealthy() {}, wake() {} }, assertConversationMessageAdmission() {}
  } as unknown as AgentControlExecutionPipeline;
  const owner = createAgentConversationComponent({ conversation, executionPipeline: pipeline, wakeProjectionDrain() {} });
  const dispatch = vi.fn<ConstructorParameters<typeof WorkflowAgentWorker>[3]>(async envelope => {
    runtimeCommandSchema.parse(envelope.command);
    if (envelope.command.kind === 'conversation.session.create') return owner.executeSession(envelope, envelope.command);
    if (envelope.command.kind === 'conversation.session.fork') return owner.executeNavigation(envelope, envelope.command);
    if (envelope.command.kind === 'conversation.message.accept') return owner.executeAcceptMessage(envelope, envelope.command);
    throw new Error('unexpected fixture command');
  });
  const runs = new Map<string, AgentRun>();
  const worker = new WorkflowAgentWorker(store, conversation, async id => runs.get(id) ?? null, dispatch, 60_000);
  workers.push(worker);
  return { conversation, worker, dispatch, runs };
}
async function link(conversation: SqliteConversationRunHandoffUnitOfWork, task: WorkflowAgentTask, status: 'running' | 'completed' = 'running'): Promise<AgentRun> {
  const saga = (await conversation.readSagaByMessage(task.messageId, 1))!;
  const service = new ConversationRunHandoffSagaService(conversation);
  const identity = { sagaId: saga.sagaId, sessionId: task.sessionId, workspaceId: scope.workspaceId,
    messageId: task.messageId, messageVersion: 1, objectiveDigest: saga.objectiveDigest };
  await service.execute({ ...identity, kind: 'handoff.request_agent_run', commandId: `${task.todoId}-request`,
    expectedVersion: 1, inboxEventId: `${task.todoId}-request-inbox`, outboxMessageId: `${task.todoId}-request-outbox`,
    occurredAt: new Date().toISOString(), runRequestId: `${task.todoId}-run-request`, agentCommandId: `${task.todoId}-agent-command` });
  await service.execute({ ...identity, kind: 'handoff.link_agent_run', commandId: `${task.todoId}-link`,
    expectedVersion: 2, inboxEventId: `${task.todoId}-link-inbox`, outboxMessageId: `${task.todoId}-link-outbox`,
    occurredAt: new Date().toISOString(), runRequestId: `${task.todoId}-run-request`, agentCommandId: `${task.todoId}-agent-command`,
    runId: `run-${task.todoId}`, admittedRunVersion: 1 });
  // Structural observation fixture: physical execution and cancellation are covered by real Electron smoke.
  const run = { runId: `run-${task.todoId}`, version: 3, updatedAt: new Date().toISOString(), state: { status },
    binding: { sessionId: task.sessionId, workspace: { workspaceId: scope.workspaceId },
      objectiveRef: { kind: 'conversation_message', messageId: task.messageId, messageVersion: 1, contentDigest: saga.objectiveDigest } }
  } as AgentRun;
  if (status === 'completed') await projectResult(conversation, task, run, `Actual output of ${task.todoId}`);
  return run;
}

async function projectResult(conversation: SqliteConversationRunHandoffUnitOfWork, task: WorkflowAgentTask, run: AgentRun, content: string) {
  const saga = (await conversation.readSagaByMessage(task.messageId, 1))!;
  if (saga.stage.kind !== 'agent_run_linked') throw new Error('fixture_run_not_linked');
  const sourceRunEventId = `${task.todoId}-terminal-event`;
  const messageId = await deriveConversationAuthorityId('agent-result-message', sourceRunEventId);
  await new ConversationAgentResultProjectionService(conversation).project({ kind: 'conversation.project_agent_result',
    commandId: `${task.todoId}-project-result`, eventId: `${task.todoId}-result-event`, sessionId: task.sessionId,
    workspaceId: scope.workspaceId, expectedSessionVersion: (await conversation.readSession(task.sessionId))!.version,
    messageId, expectedMessageVersion: null, assistantContent: content, sagaId: saga.sagaId, expectedSagaVersion: saga.version,
    handoffCommandId: `${task.todoId}-result-handoff`, handoffInboxEventId: `${task.todoId}-result-inbox`, handoffOutboxMessageId: `${task.todoId}-result-outbox`,
    objectiveMessageId: task.messageId, objectiveMessageVersion: 1, objectiveDigest: saga.objectiveDigest,
    runRequestId: saga.stage.runRequestId, agentCommandId: saga.stage.agentCommandId, runId: run.runId,
    admittedRunVersion: saga.stage.admittedRunVersion, resultRunVersion: run.version, resultStatus: 'completed', sourceRunEventId,
    occurredAt: new Date().toISOString() });
}

describe('automatic Workflow durable execution ownership', () => {
  it('reconciles a task that legitimately settled while isolated, using its original result message and Run version', async () => {
    const { store, root } = open(); await start(store, 1);
    const h = harness(root, store); await h.worker.start(); await h.worker.stop();
    const task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    const fault = (await store.quarantineTask('workflow', 'workflow-1', task.todoId, 'result_authority_conflict'))!;
    const run = await link(h.conversation, task, 'completed');
    const saga = (await h.conversation.readSagaByMessage(task.messageId, 1))!;
    if (saga.stage.kind !== 'agent_result_projected') throw new Error('fixture_result_missing');
    const messageId = await deriveConversationAuthorityId('agent-result-message', saga.stage.sourceRunEventId);
    const message = (await h.conversation.readMessageVersion(messageId, 1))!;
    await store.recordWorkflowAgentSubmission('workflow-1', task.todoId, run.runId);
    await store.settleWorkflowAgentTask('workflow-1', task.todoId, 'completed', 'Actual output', new Date(), {
      runId: run.runId, runVersion: run.version, resultMessage: { sessionId: task.sessionId, messageId,
        messageVersion: 1, contentDigest: message.contentDigest } });
    const recovery = new ProductivityTaskRecovery(store, h.conversation, async () => run);
    const completed = await recovery.reconcile('terminal-recovery', { kind: 'productivity.task.reconcile', contractVersion: '1.0',
      workspaceId: scope.workspaceId, sessionId: scope.sessionId, faultId: fault.faultId, expectedRevision: fault.revision });
    expect(completed).toMatchObject({ outcome: 'recovered', fault: { state: 'resolved', revision: 3 } });
    expect((await snapshot(store)).workflows[0]!.results[0]).toMatchObject({ todoId: task.todoId, outcome: 'completed' });
  });
  it.each(['before', 'after'] as const)('recovers the actual %s COMMIT boundary without partial fault metadata or duplicate stages', async boundary => {
    const { store, root } = open(); await start(store, 1);
    const h = harness(root, store); await h.worker.start(); await h.worker.stop();
    const task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    const fault = (await store.quarantineTask('workflow', 'workflow-1', task.todoId, 'task_authority_conflict'))!;
    const command: ProductivityTaskRecoveryCommand = { kind: 'productivity.task.reconcile', contractVersion: '1.0',
      workspaceId: scope.workspaceId, sessionId: scope.sessionId, faultId: fault.faultId, expectedRevision: 1 };
    // Exercise the transaction owner's existing boundary hooks, not a mocked
    // receipt or a thrown error before SQL was entered.
    const options = (store as unknown as { owner: { options: { beforeWriteCommit?: () => void; afterWriteCommit?: () => void } } }).owner.options;
    const hook = boundary === 'before' ? 'beforeWriteCommit' : 'afterWriteCommit';
    options[hook] = () => { delete options[hook]; throw new Error(`fixture_${boundary}_commit`); };
    await expect(store.beginTaskRecoveryCommand('commit-boundary', command)).rejects.toThrow(`fixture_${boundary}_commit`);
    expect(() => store.assertHealthy()).not.toThrow();
    expect((await store.queryTaskFaults(scope.workspaceId, scope.sessionId, 32)).faults[0]!.revision).toBe(boundary === 'before' ? 1 : 2);
    expect(await store.readTaskRecoveryCommand('commit-boundary', command)).toEqual(boundary === 'before' ? null : expect.objectContaining({ phase: 'reconciling' }));
    const recovery = new ProductivityTaskRecovery(store, h.conversation, async () => null);
    expect(await recovery.reconcile('commit-boundary', command)).toMatchObject({ outcome: 'unresolved', fault: { revision: 3 } });
  });
  it('reopens a committed recovery stage and replays its exact completed receipt after response loss', async () => {
    let { store, root } = open(); await start(store, 1);
    const h = harness(root, store); await h.worker.start(); await h.worker.stop();
    const task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    const fault = (await store.quarantineTask('workflow', 'workflow-1', task.todoId, 'task_authority_conflict'))!;
    const command: ProductivityTaskRecoveryCommand = { kind: 'productivity.task.reconcile', contractVersion: '1.0',
      workspaceId: scope.workspaceId, sessionId: scope.sessionId, faultId: fault.faultId, expectedRevision: fault.revision };
    const dispatches = h.dispatch.mock.calls.length;
    expect(await store.beginTaskRecoveryCommand('original-recovery', command)).toMatchObject({ kind: 'reconciling', claim: { fault: { revision: 2 } } });
    await close(store); store = open(root).store; // Full production startup audit includes the pending receipt.
    expect(await store.queryTaskRecoveryClaims(scope.workspaceId, scope.sessionId, [{ faultId: fault.faultId, revision: 2 }]))
      .toEqual([{ faultId: fault.faultId, claimRevision: 2, commandId: 'original-recovery', expectedRevision: 1 }]);
    await expect(store.queryTaskRecoveryClaims('foreign-workspace', scope.sessionId, [{ faultId: fault.faultId, revision: 2 }])).rejects.toThrow('fault_not_found');
    const recovery = new ProductivityTaskRecovery(store, h.conversation, async () => null);
    const finish = store.finishTaskRecoveryCommand.bind(store);
    vi.spyOn(store, 'finishTaskRecoveryCommand').mockImplementationOnce(async (...args) => {
      await finish(...args); throw new Error('response_lost_after_real_commit');
    });
    await expect(recovery.reconcile('original-recovery', command)).rejects.toThrow('response_lost_after_real_commit');
    const replay = await recovery.reconcile('original-recovery', command);
    expect(replay).toMatchObject({ outcome: 'unresolved', fault: { revision: 3, state: 'quarantined' } });
    expect(await recovery.reconcile('original-recovery', command)).toEqual(replay);
    expect(await store.queryTaskRecoveryClaims(scope.workspaceId, scope.sessionId, [{ faultId: fault.faultId, revision: 2 }]))
      .toEqual([{ faultId: fault.faultId, claimRevision: 2, commandId: 'original-recovery', expectedRevision: 1 }]);
    await expect(recovery.reconcile('original-recovery', { ...command, expectedRevision: 3 })).rejects.toThrow('productivity_command_conflict');
    expect(h.dispatch).toHaveBeenCalledTimes(dispatches);
    const reader = new DatabaseSync(path.join(root, 'data/productivity/productivity.db'), { readOnly: true });
    try {
      const record = String(reader.prepare('SELECT result_json FROM productivity_commands WHERE command_id=?').get('original-recovery')!.result_json);
      expect(record).not.toContain(task.prompt); expect(record).not.toContain('dependencyMessages');
    } finally { reader.close(); }
    await close(store); store = open(root).store;
    expect((await store.readTaskRecoveryCommand('original-recovery', command))!.phase).toBe('completed');
  });
  it('keeps competing recovery command receipts separate and never assigns a newer claim result to an older command', async () => {
    const { store, root } = open(); await start(store, 1);
    const h = harness(root, store); await h.worker.start(); await h.worker.stop();
    const task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    const fault = (await store.quarantineTask('workflow', 'workflow-1', task.todoId, 'task_authority_conflict'))!;
    const first: ProductivityTaskRecoveryCommand = { kind: 'productivity.task.reconcile', contractVersion: '1.0',
      workspaceId: scope.workspaceId, sessionId: scope.sessionId, faultId: fault.faultId, expectedRevision: fault.revision };
    await store.beginTaskRecoveryCommand('first-recovery', first);
    const newer = { ...first, expectedRevision: 2 };
    const recovery = new ProductivityTaskRecovery(store, h.conversation, async () => null);
    const result = await recovery.reconcile('newer-recovery', newer);
    expect(result).toMatchObject({ outcome: 'unresolved', fault: { revision: 4 } });
    const superseded = await recovery.reconcile('first-recovery', first);
    expect(superseded).toMatchObject({ outcome: 'superseded', fault: { revision: 4 } });
    expect(await recovery.reconcile('newer-recovery', newer)).toEqual(result);
    expect(await recovery.reconcile('first-recovery', first)).toEqual(superseded);
    expect((await store.queryTaskFaults(scope.workspaceId, scope.sessionId, 32)).faults).toEqual([result.fault]);
  });
  it('authorizes the parent scope and exposes body-free faults through the actual public command owner', async () => {
    const { store, root } = open(); await start(store, 1);
    const h = harness(root, store); await h.worker.start(); await h.worker.stop();
    await new ConversationAuthorityService(h.conversation).createSession({ kind: 'conversation.create_session',
      commandId: 'parent-create', eventId: 'parent-create-event', sessionId: scope.sessionId,
      workspaceId: scope.workspaceId, expectedVersion: null, occurredAt: new Date().toISOString() });
    const task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    const fault = (await store.quarantineTask('workflow', 'workflow-1', task.todoId, 'task_authority_conflict'))!;
    const owner = createProductivityTaskIsolationCommandOwners(store, h.conversation, [scope.workspaceId], async () => null)[0]!;
    const command = runtimeCommandSchema.parse({ kind: 'productivity.task_faults.query', contractVersion: '1.0',
      workspaceId: scope.workspaceId, sessionId: scope.sessionId, limit: 32 });
    const envelope = { commandId: 'fault-read', correlationId: 'fault-read', command, deadlineAt: deadline, signal: new AbortController().signal };
    const page = await owner.execute(envelope);
    expect(page.outcome).toMatchObject({ ok: true, result: { kind: 'productivity.task_faults.query_result', faults: [fault] } });
    expect(JSON.stringify(page)).not.toContain(task.prompt);
    const foreign = await owner.execute({ ...envelope, command: runtimeCommandSchema.parse({ ...command, workspaceId: 'foreign-workspace' }) });
    expect(foreign.outcome).toMatchObject({ ok: false, error: { code: 'workspace_not_authorized' } });
    const recoverEnvelope = { ...envelope, commandId: 'owner-recovery', command: runtimeCommandSchema.parse({
      kind: 'productivity.task.reconcile', contractVersion: '1.0', workspaceId: scope.workspaceId,
      sessionId: scope.sessionId, faultId: fault.faultId, expectedRevision: fault.revision }) };
    const completed = await owner.execute(recoverEnvelope);
    expect(completed.outcome).toMatchObject({ ok: true, result: { outcome: 'unresolved', fault: { revision: 3 } } });
    expect(await owner.reconcile(recoverEnvelope)).toEqual({ kind: 'committed', outcome: completed.outcome });
  });
  it.each(['wrong_run', 'changed_source'] as const)('keeps recovery quarantined on %s without recording a fictitious terminal outcome', async mode => {
    const { store, root } = open(); await start(store, 1);
    const h = harness(root, store); await h.worker.start(); await h.worker.stop();
    const task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    const run = await link(h.conversation, task);
    const fault = (await store.quarantineTask('workflow', 'workflow-1', task.todoId, 'task_authority_conflict'))!;
    let entered!: () => void, resume!: () => void;
    const enteredBarrier = new Promise<void>(resolve => { entered = resolve; });
    const resumeBarrier = new Promise<void>(resolve => { resume = resolve; });
    const recovery = new ProductivityTaskRecovery(store, h.conversation, async () => {
      if (mode === 'wrong_run') return { ...run, runId: 'foreign-run' };
      entered(); await resumeBarrier; return run;
    });
    const calls = h.dispatch.mock.calls.length;
    const recovering = recoverTask(recovery, scope.workspaceId, scope.sessionId, fault.faultId, fault.revision);
    if (mode === 'changed_source') {
      await enteredBarrier;
      // A previously admitted worker can finish one durable boundary while
      // recovery is reading another source; that change must win the fence.
      await store.recordWorkflowAgentSubmission('workflow-1', task.todoId, run.runId);
      resume();
    }
    expect(await recovering).toMatchObject({ state: 'quarantined', revision: 3 });
    expect(h.dispatch).toHaveBeenCalledTimes(calls);
    const current = (await store.pendingWorkflowAgentWork())[0]!.workflow;
    expect(current.results).toEqual([]); expect(current.status).toBe('running');
  });
  it('isolates one receipt conflict, continues independent work and reconciles the original Run without dispatching effects', async () => {
    const { store, root } = open(); await start(store, 2);
    const h = harness(root, store), submit = h.dispatch.getMockImplementation()!;
    const one = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    h.dispatch.mockImplementation(async envelope => {
      const result = await submit(envelope);
      if (envelope.command.kind === 'conversation.message.accept' && envelope.command.messageId === one.messageId
        && result?.outcome.ok && result.outcome.result.kind === 'conversation.message.accepted') {
        return { ...result, outcome: { ok: true, result: { ...result.outcome.result, messageId: 'conflicting-public-receipt' } } };
      }
      return result;
    });
    await h.worker.start();
    expect(() => h.worker.assertHealthy()).not.toThrow();
    const work = (await store.pendingWorkflowAgentWork())[0]!;
    expect(work.workflow.agentExecution!.tasks.slice(0, 2).map(task => task.status)).toEqual(['claimed', 'submitted']);
    let fault = (await store.queryTaskFaults(scope.workspaceId, scope.sessionId, 32)).faults[0]!;
    expect(fault).toMatchObject({ taskId: 'one', state: 'quarantined', revision: 1, code: 'submission_identity_conflict' });
    expect(await store.claimWorkflowAgentTask('workflow-1', 'one')).toBeNull();
    const dispatches = h.dispatch.mock.calls.length;
    const recovery = new ProductivityTaskRecovery(store, h.conversation, async id => h.runs.get(id) ?? null);
    // Accepted message with no linked Run is unresolved; no automatic resend.
    fault = await recoverTask(recovery, scope.workspaceId, scope.sessionId, fault.faultId, fault.revision);
    expect(fault).toMatchObject({ state: 'quarantined', revision: 3 });
    expect(h.dispatch).toHaveBeenCalledTimes(dispatches);
    await expect(recoverTask(recovery, 'foreign-workspace', scope.sessionId, fault.faultId, 3)).rejects.toThrow('fault_not_found');
    const run = await link(h.conversation, one); h.runs.set(run.runId, run);
    fault = await recoverTask(recovery, scope.workspaceId, scope.sessionId, fault.faultId, fault.revision);
    expect(fault).toMatchObject({ state: 'resolved', revision: 5 });
    expect(h.dispatch).toHaveBeenCalledTimes(dispatches);
    await expect(recoverTask(recovery, scope.workspaceId, scope.sessionId, fault.faultId, 1, 'different-stale-recovery')).rejects.toThrow('recovery_conflict');
    h.dispatch.mockImplementation(submit); await h.worker.wake(); await h.worker.stop();
    expect((await h.conversation.readSession(one.sessionId))!.version).toBe(2);
    expect((await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]).toMatchObject({ status: 'submitted', runId: run.runId });
    const reader = new DatabaseSync(path.join(root, 'data/conversation/conversation.db'), { readOnly: true });
    try { expect(reader.prepare('SELECT count(*) AS count FROM conversation_handoff_sagas WHERE message_id=?').get(one.messageId)!.count).toBe(1); }
    finally { reader.close(); }
    await close(store); const reopened = open(root).store;
    expect((await reopened.queryTaskFaults(scope.workspaceId, scope.sessionId, 32)).faults).toEqual([fault]);
  });

  it('keeps dependency unavailability uncertain and refuses to misclassify it as a single-task identity fault', async () => {
    const { store, root } = open(); await start(store, 2);
    const h = harness(root, store), submit = h.dispatch.getMockImplementation()!;
    const one = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    h.dispatch.mockImplementation(async envelope => envelope.commandId === one.createCommandId
      ? { commandId: envelope.commandId, correlationId: envelope.correlationId, settlement: 'completed', outcome: { ok: false,
        error: { code: 'runtime_conversation_unavailable', message: 'Source unavailable', retryable: false } } }
      : submit(envelope));
    await h.worker.start(); await h.worker.stop();
    expect(() => h.worker.assertHealthy()).not.toThrow();
    expect((await store.queryTaskFaults(scope.workspaceId, scope.sessionId, 32)).faults).toEqual([]);
    expect((await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks.slice(0, 2).map(task => task.status)).toEqual(['claimed', 'submitted']);
  });

  it('pauses the whole worker on actual shared authority corruption and retains the original malformed source', async () => {
    const { store, root } = open(); await start(store, 2);
    const h = harness(root, store), database = new DatabaseSync(path.join(root, 'data/productivity/productivity.db'));
    try { database.prepare("UPDATE productivity_workflows SET workflow_json='{}'").run(); }
    finally { database.close(); }
    await expect(h.worker.start()).rejects.toThrow('workflow_execution_authority_invalid');
    expect(() => h.worker.assertHealthy()).toThrow('workflow_execution_authority_invalid');
    expect(() => store.assertHealthy()).toThrow('productivity_authority_integrity');
    const reader = new DatabaseSync(path.join(root, 'data/productivity/productivity.db'), { readOnly: true });
    try {
      expect(reader.prepare('SELECT count(*) AS count FROM productivity_task_faults').get()!.count).toBe(0);
      expect(reader.prepare('SELECT workflow_json FROM productivity_workflows').get()!.workflow_json).toBe('{}');
    } finally { reader.close(); }
  });

  it('waits for exact projected predecessor results, then freezes bounded dependency input across uncertain submission replay', async () => {
    const { store, root } = open(); await start(store, 3, true);
    const h = harness(root, store); await h.worker.start();
    let state = await snapshot(store);
    expect(state.workflows[0]).toMatchObject({ activeTodoIds: ['one'], pendingTodoIds: ['two', 'three'] });
    const one = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    const running = await link(h.conversation, one);
    const completed = { ...running, state: { status: 'completed' } } as AgentRun;
    h.runs.set(completed.runId, completed);
    await h.worker.wake();
    expect((await snapshot(store)).workflows[0]!.results).toEqual([]);
    expect(h.dispatch.mock.calls.filter(([envelope]) => envelope.command.kind === 'conversation.message.accept')).toHaveLength(1);
    await projectResult(h.conversation, one, completed, 'Actual immutable predecessor output. ' + 'x'.repeat(150_000));
    const submit = h.dispatch.getMockImplementation()!;
    h.dispatch.mockImplementation(async envelope => {
      const result = await submit(envelope);
      return envelope.command.kind === 'conversation.message.accept' && envelope.command.messageId !== one.messageId ? null : result;
    });
    await h.worker.wake(); await h.worker.wake(); await h.worker.stop();
    state = await snapshot(store);
    expect(state.workflows[0]).toMatchObject({ activeTodoIds: ['two'], pendingTodoIds: ['three'] });
    const two = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[1]!;
    expect(two.status).toBe('claimed'); expect(two.dependencyMessages).toHaveLength(1);
    const input = (await h.conversation.readMessageVersion(two.messageId, 1))!.payload.content;
    expect(input).toContain('Actual immutable predecessor output.'); expect(input).toContain('已截断');
    expect(input.length).toBeLessThanOrEqual(100_000);
    await close(store); const recovered = open(root).store;
    const worker = new WorkflowAgentWorker(recovered, h.conversation, async id => h.runs.get(id) ?? null, submit, 60_000); workers.push(worker);
    await worker.start(); await worker.stop();
    expect((await h.conversation.readMessageVersion(two.messageId, 1))!.payload.content).toBe(input);
    expect((await recovered.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[1]).toMatchObject({
      status: 'submitted', dependencyMessages: two.dependencyMessages });
    expect((await h.conversation.readSession(two.sessionId))!.version).toBe(2);
  });

  it('captures parent context at the public owner, preserves it through later messages and limits long task titles to the session contract', async () => {
    const { store, root } = open(); const h = harness(root, store);
    const authority = new ConversationAuthorityService(h.conversation);
    await authority.createSession({ kind: 'conversation.create_session', commandId: 'parent-create', eventId: 'parent-create-event',
      workspaceId: scope.workspaceId, sessionId: scope.sessionId, expectedVersion: null, occurredAt: clock.toISOString() });
    const acceptParent = (messageId: string, version: number, content: string) => authority.acceptUserMessage({
      kind: 'conversation.accept_user_message', commandId: `${messageId}-command`, eventId: `${messageId}-event`,
      workspaceId: scope.workspaceId, sessionId: scope.sessionId, expectedSessionVersion: version,
      messageId, expectedMessageVersion: null, content, sagaId: `${messageId}-saga`, handoffCommandId: `${messageId}-handoff`,
      handoffOutboxMessageId: `${messageId}-outbox`, occurredAt: clock.toISOString() });
    await acceptParent('parent-first', 1, 'Original frozen requirements');
    await store.execute('goal', { ...scope, kind: 'goal.put', goalId: 'goal-1', expectedVersion: null,
      title: 'Goal with parent context', phase: 'implementation', status: 'active', roundCap: 8 }, clock);
    await store.execute('todos', { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal-1', expectedGoalVersion: 1,
      expectedRevision: null, items: [{ todoId: 'one', title: 'Long task title '.repeat(100), status: 'pending' }] }, clock);
    const owner = new ProductivityPublicCommandHandler(store, h.conversation, [scope.workspaceId], true);
    const command = { ...scope, kind: 'workflow.start' as const, workflowId: 'workflow-1', goalId: 'goal-1',
      expectedGoalVersion: 1, expectedTodoRevision: 1, todoIds: ['one'], maxConcurrency: 1,
      maxTransitions: 1, deadlineAt: deadline, executionMode: 'agent' as const };
    const envelope = { commandId: 'start', correlationId: 'start', command, signal: new AbortController().signal, deadlineAt: deadline };
    const receipt = await owner.execute(envelope, command);
    expect(receipt.outcome.ok).toBe(true);
    await acceptParent('parent-later', 2, 'Later requirements must not enter this round');
    expect(await owner.execute(envelope, command)).toEqual(receipt);
    await h.worker.start(); await h.worker.stop();
    const task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    expect((await h.conversation.readSession(task.sessionId))!.title.length).toBeLessThanOrEqual(80);
    const history = await h.conversation.authorityTransaction(tx => tx.loadSessionMessageHistoryThrough(task.sessionId, task.messageId, 1));
    expect(history.map(message => message.payload.content)).toEqual(['Original frozen requirements', task.prompt]);
    expect(JSON.stringify(await snapshot(store))).not.toContain('sourceSessionVersion');
  });

  it('persists immutable task identities, projects safe Run references and forbids manual completion', async () => {
    const { store, root } = open(); await start(store);
    const one = await claimed(store); expect(one.prompt).toContain('Complete the release');
    await store.recordWorkflowAgentSubmission('workflow-1', 'one', 'run-one', clock);
    const publicResult = await snapshot(store);
    expect(runtimeResultSchema.parse(publicResult)).toEqual(publicResult);
    expect(publicResult.workflows[0]).toMatchObject({ executionMode: 'agent', taskRuns: [{ todoId: 'one', runId: 'run-one' }] });
    expect(JSON.stringify(publicResult)).not.toMatch(/agentExecution|createCommandId|submitCommandId|resultRunVersion/);
    await expect(store.execute('manual', { ...scope, kind: 'workflow.advance', workflowId: 'workflow-1',
      expectedVersion: publicResult.workflows[0]!.version, completed: [{ todoId: 'one', outcome: 'completed', summary: 'fabricated' }] }, clock))
      .rejects.toThrow('workflow_agent_result_owned');
    await expect(store.settleWorkflowAgentTask('workflow-1', 'one', 'completed', 'result', clock)).rejects.toThrow('workflow_task_result_source_required');
    await close(store);
    const recovered = open(root).store;
    expect(await recovered.claimWorkflowAgentTask('workflow-1', 'one', clock)).toMatchObject({ ...one, status: 'submitted', runId: 'run-one' });
  });

  it('cancellation withdraws only unclaimed work and preserves exact pending receipt after joined completion', async () => {
    const { store, root } = open(); await start(store); await claimed(store);
    const current = (await snapshot(store)).workflows[0]!;
    const command = { ...scope, kind: 'workflow.cancel' as const, workflowId: current.workflowId, expectedVersion: current.version };
    const requested = await store.execute('cancel', command, clock);
    expect(requested).toMatchObject({ workflow: { status: 'cancelling', activeTodoIds: ['one'], pendingTodoIds: [],
      results: [{ todoId: 'two', outcome: 'cancelled' }, { todoId: 'three', outcome: 'cancelled' }] } });
    const state = await snapshot(store);
    await expect(store.execute('replace', { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal-1',
      expectedGoalVersion: state.goal!.version, expectedRevision: state.todoRevision, items: [] }, clock)).rejects.toThrow('todo_bound_to_running_workflow');
    await store.recordWorkflowAgentSubmission('workflow-1', 'one', 'run-one', clock);
    await store.settleWorkflowAgentTask('workflow-1', 'one', 'cancelled', 'joined', clock, { runId: 'run-one', runVersion: 8 });
    expect((await snapshot(store)).workflows[0]).toMatchObject({ status: 'cancelled', activeTodoIds: [], pendingTodoIds: [] });
    await close(store); const recovered = open(root).store;
    expect(await recovered.reconcile('cancel', command)).toEqual(requested);
    const database = new DatabaseSync(path.join(root, 'data/productivity/productivity.db'), { readOnly: true });
    try { expect(JSON.parse((database.prepare('SELECT workflow_json FROM productivity_workflows').get() as { workflow_json: string }).workflow_json)
      .agentExecution.tasks[0]).toMatchObject({ status: 'terminal', resultRunVersion: 8 }); }
    finally { database.close(); }
  });

  it('failure waits for other claimed work, never activates queued work and preserves actual sibling outcome', async () => {
    const { store } = open(); await start(store); await claimed(store, 'one'); await claimed(store, 'two');
    await store.recordWorkflowAgentSubmission('workflow-1', 'one', 'run-one', clock);
    await store.recordWorkflowAgentSubmission('workflow-1', 'two', 'run-two', clock);
    await store.settleWorkflowAgentTask('workflow-1', 'one', 'failed', 'actual failure', clock, { runId: 'run-one', runVersion: 7 });
    expect((await snapshot(store)).workflows[0]).toMatchObject({ status: 'cancelling', activeTodoIds: ['two'], pendingTodoIds: [] });
    expect(await store.claimWorkflowAgentTask('workflow-1', 'three', clock)).toBeNull();
    await store.settleWorkflowAgentTask('workflow-1', 'two', 'completed', 'actual completion', clock, { runId: 'run-two', runVersion: 9 });
    expect((await snapshot(store)).workflows[0]).toMatchObject({ status: 'failed', results: [
      { todoId: 'one', outcome: 'failed' }, { todoId: 'three', outcome: 'cancelled' }, { todoId: 'two', outcome: 'completed' }
    ] });
    expect((await snapshot(store)).todos.map(todo => todo.status)).toEqual(['failed', 'completed', 'cancelled']);
  });

  it('deadline requests cancellation and Goal pause prevents new claims without falsifying active work', async () => {
    const { store } = open(); await start(store); await claimed(store);
    const state = await snapshot(store);
    await store.execute('pause', { ...scope, kind: 'goal.put', goalId: 'goal-1', expectedVersion: state.goal!.version,
      title: state.goal!.title, phase: state.goal!.phase, status: 'paused', roundCap: state.goal!.roundCap }, clock);
    expect(await store.claimWorkflowAgentTask('workflow-1', 'two', clock)).toBeNull();
    await store.materializeDue(new Date(deadline));
    expect((await snapshot(store)).workflows[0]).toMatchObject({ status: 'cancelling', activeTodoIds: ['one'] });
    await store.settleWorkflowAgentTask('workflow-1', 'one', 'cancelled', 'submission withdrawn', new Date(deadline));
    expect((await snapshot(store)).workflows[0]?.status).toBe('failed');
  });

  it('refuses a persisted task identity drift before the worker can create a different session', async () => {
    const { store, root } = open(); await start(store); await close(store);
    const database = new DatabaseSync(path.join(root, 'data/productivity/productivity.db'));
    try {
      const record = JSON.parse((database.prepare('SELECT workflow_json FROM productivity_workflows').get() as { workflow_json: string }).workflow_json);
      record.agentExecution.tasks[0].sessionId = 'drifted-session';
      database.prepare('UPDATE productivity_workflows SET workflow_json=?').run(JSON.stringify(record));
    } finally { database.close(); }
    expect(() => open(root)).toThrow('workflow_execution_authority_invalid');
    const reader = new DatabaseSync(path.join(root, 'data/productivity/productivity.db'), { readOnly: true });
    try { expect(String(reader.prepare('SELECT workflow_json FROM productivity_workflows').get()!.workflow_json)).toContain('drifted-session'); }
    finally { reader.close(); }
  });

  it('replays an accepted but unacknowledged submission after reopening without creating a second session or message', async () => {
    const { store, root } = open(); await start(store, 1);
    const h = harness(root, store); const submit = h.dispatch.getMockImplementation()!;
    h.dispatch.mockImplementation(async envelope => { const result = await submit(envelope);
      return envelope.command.kind === 'conversation.message.accept' ? null : result; });
    await h.worker.start(); await h.worker.stop();
    const task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    expect(task.status).toBe('claimed');
    await close(store); const recovered = open(root).store;
    const dispatch = vi.fn(submit);
    const worker = new WorkflowAgentWorker(recovered, h.conversation, async () => null, dispatch, 60_000); workers.push(worker);
    await worker.start();
    expect(dispatch.mock.calls.map(([envelope]) => envelope.commandId)).toEqual([task.createCommandId, task.submitCommandId]);
    expect((await h.conversation.readSession(task.sessionId))?.version).toBe(2);
    const database = new DatabaseSync(path.join(root, 'data/conversation/conversation.db'), { readOnly: true });
    try { expect(database.prepare('SELECT count(*) AS count FROM conversation_sessions').get()).toMatchObject({ count: 1 });
      expect(database.prepare('SELECT count(*) AS count FROM conversation_message_heads').get()).toMatchObject({ count: 1 }); }
    finally { database.close(); }
    expect((await recovered.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]?.status).toBe('submitted');
  });

  it('does not hide a persistence failure behind a simultaneous shutdown abort', async () => {
    const { store, root } = open(); await start(store, 1); const h = harness(root, store);
    let entered!: () => void; let finish!: () => void;
    const boundary = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(store, 'recordWorkflowAgentSubmission').mockImplementation(async () => {
      entered(); await release; throw new Error('workflow_persistence_failed');
    });
    const starting = h.worker.start();
    const startFailed = expect(starting).rejects.toThrow('workflow_persistence_failed');
    await boundary;
    const stopping = h.worker.stop();
    const stopFailed = expect(stopping).rejects.toThrow('workflow_persistence_failed');
    finish(); await startFailed; await stopFailed;
    expect(() => h.worker.assertHealthy()).toThrow('workflow_persistence_failed');
    expect((await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]?.status).toBe('claimed');
  });

  it('observes exact linked Run outcomes, activates the next slot, and preserves uncertainty until actual terminal authority', async () => {
    const { store, root } = open(); await start(store, 1); const h = harness(root, store); await h.worker.start();
    let task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[0]!;
    h.runs.set('run-one', await link(h.conversation, task, 'completed'));
    await h.worker.wake(); await h.worker.wake();
    expect((await snapshot(store)).workflows[0]).toMatchObject({ activeTodoIds: ['two'], results: [{ todoId: 'one', outcome: 'completed' }] });
    task = (await store.pendingWorkflowAgentWork())[0]!.workflow.agentExecution!.tasks[1]!;
    const run = await link(h.conversation, task); h.runs.set(run.runId, { ...run, state: { status: 'recovering' } } as AgentRun);
    await stop(store);
    const delegate = h.dispatch.getMockImplementation()!;
    h.dispatch.mockImplementation(async envelope => envelope.command.kind === 'agent.run.cancel'
      ? { settlement: 'completed', outcome: { ok: true, result: { kind: 'agent.run.cancellation.requested', runId: run.runId, runVersion: run.version } } }
      : delegate(envelope));
    await h.worker.wake();
    expect((await snapshot(store)).workflows[0]).toMatchObject({ status: 'cancelling', activeTodoIds: ['two'] });
    h.runs.set(run.runId, { ...run, version: 4, state: { status: 'cancelled' } } as AgentRun);
    await h.worker.wake();
    expect((await snapshot(store)).workflows[0]?.status).toBe('cancelled');
    expect(h.dispatch.mock.calls.filter(([envelope]) => envelope.command.kind === 'agent.run.cancel')).toHaveLength(1);
  });

  it('rejects automatic start at the public owner when no execution pipeline is available', async () => {
    const { store, root } = open();
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root); conversations.push(conversation);
    await new ConversationAuthorityService(conversation).createSession({ kind: 'conversation.create_session', commandId: 'session',
      eventId: 'session-event', sessionId: scope.sessionId, workspaceId: scope.workspaceId, expectedVersion: null, occurredAt: clock.toISOString() });
    const owner = new ProductivityPublicCommandHandler(store, conversation, [scope.workspaceId]);
    const command = { ...scope, kind: 'workflow.start' as const, workflowId: 'workflow-1', goalId: 'goal-1', expectedGoalVersion: 1,
      expectedTodoRevision: 1, todoIds: ['one', 'two', 'three'], maxConcurrency: 2, maxTransitions: 3, deadlineAt: deadline, executionMode: 'agent' as const };
    expect(await owner.execute({ commandId: 'start', correlationId: 'start', command, signal: new AbortController().signal, deadlineAt: deadline }, command))
      .toMatchObject({ outcome: { ok: false, error: { code: 'workflow_execution_unavailable' } } });
    const committed = await start(store);
    expect(await owner.execute({ commandId: 'start', correlationId: 'start', command, signal: new AbortController().signal, deadlineAt: deadline }, command))
      .toEqual({ outcome: { ok: true, result: committed }, settlement: 'completed' });
  });
});
