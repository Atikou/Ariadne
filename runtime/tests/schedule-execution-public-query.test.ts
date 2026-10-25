import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@ariadne/agent-core';
import { runtimeResultSchema } from '@ariadne/protocol/public';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { createAgentConversationComponent } from '../src/composition/agent-entity/components/conversation/AgentConversationComponent.js';
import type { AgentControlExecutionPipeline } from '../src/composition/ProductionAgentControlExecutionPipelineFactory.js';
import { ScheduleWorker } from '../src/composition/ScheduleWorker.js';
import { ProductivityPublicCommandHandler } from '../src/composition/ProductivityPublicCommandHandler.js';
import { ConversationRunHandoffSagaService } from '../src/control/conversation/ConversationRunHandoffSagaService.js';
import { ConversationAgentResultProjectionService } from '../src/control/conversation/ConversationAgentResultProjectionService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { SqliteTaskQuerySnapshotStore } from '../src/adapters/persistence/SqliteTaskQuerySnapshotStore.js';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { ScheduleExecutionFacts } from '../src/composition/ScheduleExecutionFacts.js';
import { TaskCenterNavigationResolver } from '../src/composition/TaskCenterNavigationResolver.js';

const scope = { contractVersion: '5.0', workspaceId: 'workspace-1', sessionId: 'session-1' } as const;
const clock = new Date('2098-01-01T00:00:00Z');
const roots: string[] = []; const stores: SqliteProductivityStore[] = []; const conversations: SqliteConversationRunHandoffUnitOfWork[] = [];
const indexes: SqliteTaskQuerySnapshotStore[] = []; const projections: SqlitePublicProjectionStore[] = [];
afterEach(async () => { const shutdown = createShutdownContext(Date.now() + 5_000); try {
  vi.restoreAllMocks(); for (const index of indexes.splice(0)) index.close();
  for (const projection of projections.splice(0)) await projection.close(shutdown);
  for (const store of stores.splice(0)) await store.close(shutdown); for (const conversation of conversations.splice(0)) await conversation.close(shutdown);
} finally { shutdown.dispose(); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function harness(uncertain = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-schedule-result-')); roots.push(root);
  const store = new SqliteProductivityStore(root); stores.push(store);
  const conversation = new SqliteConversationRunHandoffUnitOfWork(root); conversations.push(conversation);
  const pipeline = { runWorkScheduler: { assertHealthy() {} }, executionScheduler: { assertHealthy() {}, wake() {} },
    handoffProducer: { assertHealthy() {}, wake() {} }, assertConversationMessageAdmission() {} } as unknown as AgentControlExecutionPipeline;
  const owner = createAgentConversationComponent({ conversation, executionPipeline: pipeline, wakeProjectionDrain() {},
    options: { commandNow: () => new Date(clock.getTime() + 1_000) } });
  const envelope = (command: Parameters<typeof owner.executeSession>[1]) => ({ commandId: 'create-session', correlationId: 'create-session',
    deadlineAt: new Date(Date.now() + 5_000).toISOString(), signal: new AbortController().signal, command });
  const create = { ...scope, kind: 'conversation.session.create', title: 'Scheduled results' } as const;
  await owner.executeSession(envelope(create), create);
  await store.execute('schedule', { ...scope, kind: 'schedule.create', scheduleId: 'schedule-1', prompt: 'Actual scheduled objective',
    timing: { kind: 'once', at: clock.toISOString(), missPolicy: 'run_once' } }, clock);
  await store.materializeDue(clock); const occurrence = (await store.pendingOccurrences())[0]!;
  const worker = new ScheduleWorker(store, conversation, async request => {
    if (request.command.kind !== 'conversation.message.accept') throw new Error('fixture_command_invalid');
    const accepted = await owner.executeAcceptMessage(request, request.command); return uncertain ? null : accepted;
  }, 60_000);
  try { await worker.start(); } finally { await worker.stop(); }
  const runs = new Map<string, AgentRun>();
  const handler = new ProductivityPublicCommandHandler(store, conversation, [scope.workspaceId], false, undefined, async id => runs.get(id) ?? null);
  const query = async () => {
    const command = { ...scope, kind: 'schedule.occurrences.query', before: null, limit: 50 } as const;
    const result = await handler.execute({ commandId: 'query', correlationId: 'query', deadlineAt: new Date(Date.now() + 5_000).toISOString(), signal: new AbortController().signal, command }, command);
    if (!result.outcome.ok) throw new Error(result.outcome.error.code); return result.outcome.result;
  };
  return { root, store, conversation, occurrence, runs, query };
}
async function link(h: Awaited<ReturnType<typeof harness>>, fail = false) {
  const saga = (await h.conversation.readSagaByMessage(h.occurrence.messageId, 1))!;
  const identity = { sagaId: saga.sagaId, workspaceId: scope.workspaceId, sessionId: scope.sessionId, messageId: saga.messageId, messageVersion: 1, objectiveDigest: saga.objectiveDigest };
  const service = new ConversationRunHandoffSagaService(h.conversation);
  await service.execute({ ...identity, kind: 'handoff.request_agent_run', commandId: 'request', expectedVersion: 1,
    inboxEventId: 'request-inbox', outboxMessageId: 'request-outbox', occurredAt: new Date(clock.getTime() + 2_000).toISOString(), runRequestId: 'run-request', agentCommandId: 'agent-command' });
  await service.execute({ ...identity, kind: fail ? 'handoff.fail_agent_start' : 'handoff.link_agent_run', commandId: 'link', expectedVersion: 2,
    inboxEventId: 'link-inbox', outboxMessageId: 'link-outbox', occurredAt: new Date(clock.getTime() + 3_000).toISOString(), runRequestId: 'run-request', agentCommandId: 'agent-command',
    ...(fail ? { failureCode: 'PRIVATE-ERROR-MESSAGE' } : { runId: 'run-1', admittedRunVersion: 1 }) } as Parameters<typeof service.execute>[0]);
  // Core is a structural observation fixture; scheduled acceptance, Saga and result projection use real production SQLite owners.
  const run = { runId: 'run-1', version: 4, updatedAt: new Date(clock.getTime() + 3_000).toISOString(), state: { status: 'running' }, binding: { sessionId: scope.sessionId, workspace: { workspaceId: scope.workspaceId },
    objectiveRef: { kind: 'conversation_message', messageId: saga.messageId, messageVersion: 1, contentDigest: saga.objectiveDigest } } } as unknown as AgentRun;
  h.runs.set(run.runId, run); return run;
}
async function project(h: Awaited<ReturnType<typeof harness>>, run: AgentRun, text = 'ACTUAL PUBLIC ASSISTANT RESULT') {
  const saga = (await h.conversation.readSagaByMessage(h.occurrence.messageId, 1))!;
  if (saga.stage.kind !== 'agent_run_linked') throw new Error('fixture_stage_invalid');
  const { deriveConversationAuthorityId } = await import('../src/conversation/ConversationRunHandoffIds.js');
  await new ConversationAgentResultProjectionService(h.conversation).project({ kind: 'conversation.project_agent_result',
    commandId: 'project', eventId: 'project-event', sessionId: scope.sessionId, workspaceId: scope.workspaceId, expectedSessionVersion: 2,
    messageId: await deriveConversationAuthorityId('agent-result-message', 'terminal-event'), expectedMessageVersion: null, assistantContent: text,
    sagaId: saga.sagaId, expectedSagaVersion: saga.version, handoffCommandId: 'project-handoff', handoffInboxEventId: 'project-inbox', handoffOutboxMessageId: 'project-outbox',
    objectiveMessageId: saga.messageId, objectiveMessageVersion: 1, objectiveDigest: saga.objectiveDigest, runRequestId: saga.stage.runRequestId,
    agentCommandId: saga.stage.agentCommandId, runId: run.runId, admittedRunVersion: saga.stage.admittedRunVersion, resultRunVersion: run.version,
    resultStatus: run.state.status as 'completed' | 'failed' | 'cancelled', sourceRunEventId: 'terminal-event', occurredAt: new Date(clock.getTime() + 4_000).toISOString() });
}

describe('scheduled execution outcome public authority', () => {
  it('joins actual result identity and navigates without reading assistant or objective message bodies', async () => {
    const h = await harness(), run = await link(h);
    const terminal = { ...run, state: { status: 'completed' } } as AgentRun;
    h.runs.set(run.runId, terminal); await project(h, terminal, 'PRIVATE_RESULT_BODY'.repeat(1000));
    const bodyReads = vi.spyOn(h.conversation, 'readMessageVersion');
    const fact = await new ScheduleExecutionFacts(h.store, h.conversation, async id => h.runs.get(id) ?? null)
      .read(h.occurrence.occurrenceId, scope.workspaceId, scope.sessionId, true, new AbortController().signal);
    expect(fact).toMatchObject({ status: 'completed', runId: run.runId, runVersion: 4, resultPending: false,
      resultReference: { sessionId: scope.sessionId, messageVersion: 1 } });
    expect(bodyReads).not.toHaveBeenCalled(); expect(JSON.stringify(fact)).not.toContain('PRIVATE_RESULT_BODY');
    const index = new SqliteTaskQuerySnapshotStore(h.root), projection = new SqlitePublicProjectionStore(h.root);
    indexes.push(index); projections.push(projection);
    const resolver = new TaskCenterNavigationResolver({ index, projection, productivity: h.store, conversation: h.conversation,
      authorizedWorkspaceIds: [scope.workspaceId], loadRun: async id => h.runs.get(id) ?? null });
    const response = await resolver.resolve({ kind: 'tasks.navigate', contractVersion: '1.0', reference: { source: 'run', sourceId: run.runId },
      workspaceId: scope.workspaceId, sessionId: scope.sessionId, expectedVersion: 4, expectedAttempts: null,
      expectedSourceStatus: 'completed', destination: 'result', decisionId: null, expectedDecisionVersion: null }, new AbortController().signal);
    expect(response).toMatchObject({ status: 'ok', target: { moduleId: 'chat.main', runId: run.runId,
      expectedRunVersion: 4, workspaceId: scope.workspaceId, sessionId: scope.sessionId, resultReference: fact!.resultReference } });
    expect(bodyReads).not.toHaveBeenCalled(); expect(JSON.stringify(response)).not.toContain('PRIVATE_RESULT_BODY');
  });
  it('separates submission from actual Run status, waits for exact result projection and bounds the public assistant summary', async () => {
    const h = await harness(); expect(await h.query()).toMatchObject({ occurrences: [{ status: 'submitted', execution: { status: 'handoff_pending', runId: null } }] });
    const run = await link(h);
    expect(await h.query()).toMatchObject({ occurrences: [{ status: 'submitted', execution: { status: 'running', runId: run.runId, resultSummary: null } }] });
    const completed = { ...run, state: { status: 'completed' } } as AgentRun; h.runs.set(run.runId, completed);
    expect(await h.query()).toMatchObject({ occurrences: [{ execution: { status: 'completed', resultPending: true, resultSummary: null } }] });
    await project(h, completed, 'ACTUAL PUBLIC ASSISTANT RESULT'.repeat(300)); const result = await h.query();
    expect(runtimeResultSchema.parse(result)).toEqual(result);
    if (result.kind !== 'schedule.occurrences.query_result') throw new Error('fixture_result_invalid');
    expect(result.occurrences[0]!.execution!.resultSummary).toHaveLength(4_000);
    expect(result.occurrences[0]!.execution!.resultSummary).toContain('【结果已截断');
    expect(JSON.stringify(result)).not.toMatch(/commandId|messageId|objectiveDigest|sourceRunEventId/);
  });
  it('shows an actual accepted Run even when the submitter did not receive acknowledgement', async () => {
    const h = await harness(true); const run = await link(h);
    expect(await h.query()).toMatchObject({ occurrences: [{ status: 'dispatching', attempts: 1, execution: { status: 'running', runId: run.runId } }] });
  });
  it('reports start failure independently without copying private failure details', async () => {
    const h = await harness(); await link(h, true); const result = await h.query();
    expect(result).toMatchObject({ occurrences: [{ status: 'submitted', execution: { status: 'start_failed', runId: null } }] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-ERROR-MESSAGE');
  });
  it('shows durable cancellation while the actual running Tool still owns its unfinished work', async () => {
    const h = await harness(); const run = await link(h);
    const requested = { ...run, cancellationRequest: { requestedAt: clock.toISOString(), reason: 'user_requested' } } as unknown as AgentRun;
    h.runs.set(run.runId, requested);
    expect(await h.query()).toMatchObject({ occurrences: [{ status: 'submitted', execution: { status: 'cancelling', resultPending: false, resultSummary: null } }] });
    h.runs.set(run.runId, { ...requested, state: { status: 'recovering' } } as AgentRun);
    expect(await h.query()).toMatchObject({ occurrences: [{ execution: { status: 'recovering', resultPending: false } }] });
    h.runs.set(run.runId, { ...requested, state: { status: 'cancelled' } } as AgentRun);
    expect(await h.query()).toMatchObject({ occurrences: [{ execution: { status: 'cancelled', resultPending: true } }] });
  });
  it.each(['workspace','session','objective','digest'] as const)('refuses a foreign Core %s binding', async field => {
    const h = await harness(); const run = await link(h);
    h.runs.set(run.runId, { ...run, binding: { ...run.binding,
      ...(field === 'workspace' ? { workspace: { ...run.binding.workspace, workspaceId: 'foreign' } } : {}),
      ...(field === 'session' ? { sessionId: 'foreign' } : {}),
      ...(field === 'objective' || field === 'digest' ? { objectiveRef: { ...run.binding.objectiveRef,
        ...(field === 'objective' ? { messageId: 'foreign' } : { contentDigest: `sha256:${'a'.repeat(64)}` }) } } : {}) } } as AgentRun);
    await expect(h.query()).rejects.toThrow('schedule_execution_run_conflict');
  });
  it.each(['failed','cancelled'] as const)('keeps actual %s outcome separate from submitted status', async status => {
    const h = await harness(); const run = await link(h); const terminal = { ...run, state: { status, message: 'PRIVATE-CORE-ERROR' } } as unknown as AgentRun;
    h.runs.set(run.runId, terminal); await project(h, terminal);
    expect(await h.query()).toMatchObject({ occurrences: [{ status: 'submitted', execution: { status, resultPending: false, resultSummary: 'ACTUAL PUBLIC ASSISTANT RESULT' } }] });
    expect(JSON.stringify(await h.query())).not.toContain('PRIVATE-CORE-ERROR');
  });
});
