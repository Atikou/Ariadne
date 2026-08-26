import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { deriveStableAgentId } from '@ariadne/agent-core';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveAgentControlDatabasePath } from '../src/adapters/persistence/agentControlDbSchema.js';
import { resolveConversationDatabasePath } from '../src/adapters/persistence/ConversationDbSchema.js';
import { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  SqliteConversationRunHandoffUnitOfWork
} from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import {
  ConversationAgentHandoffCoordinator,
  type ConversationAgentHandoffBoundary,
  type ConversationAgentHandoffFaultInjector
} from '../src/composition/ConversationAgentHandoffCoordinator.js';
import {
  deriveConversationRunHandoffStepId
} from '../src/conversation/ConversationRunHandoffIds.js';
import type {
  AcceptConversationUserMessageCommand,
  CreateConversationSessionCommand
} from '../src/conversation/ConversationAuthority.js';
import type {
  ConversationRunHandoffCommand,
  ConversationRunHandoffSaga
} from '../src/conversation/ConversationRunHandoffSaga.js';
import {
  ConversationRunHandoffSagaService
} from '../src/control/conversation/ConversationRunHandoffSagaService.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import {
  AgentRunAdmissionController,
  type AgentRunAdmissionSnapshot,
  type AgentRunAdmissionSnapshotReader
} from '../src/control/run/AgentRunAdmissionController.js';
import type {
  AgentRunExecutionIntent,
  AgentRunExecutionIntentReceipt,
  AgentRunExecutionStarter
} from '../src/control/ports/AgentRunExecutionStarter.js';
import type {
  ConversationRunHandoffOutboxPort
} from '../src/control/ports/ConversationRunHandoffOutbox.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const CATALOG_DIGEST = `sha256:${'b'.repeat(64)}`;
const TOOL_CONTRACT_DIGEST = `sha256:${'c'.repeat(64)}`;
const ACCEPTED_AT = '2030-01-01T00:00:00.000Z';
const roots = new Set<string>();
const conversationUnits = new Set<SqliteConversationRunHandoffUnitOfWork>();
const agentUnits = new Set<SqliteAgentRunUnitOfWork>();

afterEach(async () => {
  await Promise.all([...conversationUnits].map(closeConversationUnit));
  await Promise.all([...agentUnits].map(closeAgentUnit));
  conversationUnits.clear();
  agentUnits.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('ConversationAgentHandoffCoordinator', () => {
  it('replays every durable boundary, ACKs all four kinds, and handles linked after saga v4', async () => {
    const fixture = await createFixture();
    const fault = new OneShotCoordinatorFault('request_after_commit');
    const coordinator = fixture.coordinator(fault);

    await expect(coordinator.dispatch(claim('accepted-claim')))
      .rejects.toThrow('kill_after_request_commit_before_ack');
    expect((await fixture.conversation.readSaga('saga-coordinator'))?.version).toBe(2);
    expect(agentCounts(fixture.root).commands).toBe(0);
    expect(outboxState(fixture.root)).toMatchObject([
      { message_kind: 'conversation.message.accepted', published_at: null },
      { message_kind: 'agent.run.requested', published_at: null }
    ]);

    const acceptedReplay = await coordinator.dispatch(claim('accepted-claim'));
    expect(acceptedReplay).toMatchObject([{
      status: 'acknowledged',
      kind: 'conversation.message.accepted',
      downstreamReplayed: true
    }]);

    fault.phase = 'admission_before_link';
    await expect(coordinator.dispatch(claim('agent-claim')))
      .rejects.toThrow('kill_after_agent_admission_before_link');
    expect(agentCounts(fixture.root)).toMatchObject({ commands: 1, runs: 1 });
    expect((await fixture.conversation.readSaga('saga-coordinator'))?.version).toBe(2);

    fault.phase = 'link_after_commit';
    await expect(coordinator.dispatch(claim('agent-claim')))
      .rejects.toThrow('kill_after_link_commit_before_ack');
    const linked = await fixture.conversation.readSaga('saga-coordinator');
    expect(linked).toMatchObject({ version: 3, stage: { kind: 'agent_run_linked' } });

    const linkedReplay = await coordinator.dispatch(claim('agent-claim'));
    expect(linkedReplay).toMatchObject([{
      status: 'acknowledged',
      kind: 'agent.run.requested',
      downstreamReplayed: true
    }]);
    expect(agentCounts(fixture.root)).toMatchObject({
      commands: 1,
      runs: 1,
      checkpoints: 1
    });

    if (linked === null) throw new Error('linked_saga_missing');
    await fixture.handoffs.execute(projectResult(linked));

    fault.phase = 'execution_after_commit';
    await expect(coordinator.dispatch(claim('linked-claim')))
      .rejects.toThrow('kill_after_execution_intent_commit_before_ack');
    expect(fixture.executionStarter.committedIntents).toHaveLength(1);
    expect(outboxState(fixture.root)[2]).toMatchObject({
      message_kind: 'conversation.agent_run.linked',
      published_at: null
    });

    const linkedExecutionReplay = await coordinator.dispatch(claim('linked-claim'));
    expect(linkedExecutionReplay).toMatchObject([{
      status: 'acknowledged',
      kind: 'conversation.agent_run.linked',
      downstreamReplayed: true
    }]);

    fault.phase = 'projected_before_ack';
    await expect(coordinator.dispatch(claim('projected-claim')))
      .rejects.toThrow('kill_after_projected_source_validation_before_ack');
    const projectedReplay = await coordinator.dispatch(claim('projected-claim'));
    expect(projectedReplay).toMatchObject([{
      status: 'acknowledged',
      kind: 'conversation.agent_result.projected',
      downstreamReplayed: false
    }]);
    expect(await fixture.conversation.countPendingHandoffOutbox()).toBe(0);

    const completed = await fixture.conversation.readSaga('saga-coordinator');
    if (completed === null) throw new Error('completed_saga_missing');
    expect(completed.processedSteps[1]).toMatchObject({
      commandId: await deriveConversationRunHandoffStepId(
        'request-command',
        'accepted-outbox'
      ),
      inboxEventId: await deriveConversationRunHandoffStepId(
        'request-inbox',
        'accepted-outbox'
      ),
      outboxMessageId: await deriveConversationRunHandoffStepId(
        'request-outbox',
        'accepted-outbox'
      )
    });
    expect(completed.processedSteps[2]).toMatchObject({
      commandId: await deriveConversationRunHandoffStepId(
        'link-command',
        completed.processedSteps[1]!.outboxMessageId
      ),
      outboxMessageId: await deriveConversationRunHandoffStepId(
        'link-outbox',
        completed.processedSteps[1]!.outboxMessageId
      )
    });

    const serialized = serializedPersistence(fixture.root);
    expect(serialized.conversation).not.toContain('raw user prompt');
    expect(serialized.agent).not.toContain('raw user prompt');
  });

  it('invokes the durable-boundary hook exactly once for each successful outbox dispatch', async () => {
    const fixture = await createFixture();
    const fault = new RecordingBoundaryFault();
    const coordinator = fixture.coordinator(fault);

    await coordinator.dispatch(claim('accepted-boundary-once'));
    await coordinator.dispatch(claim('requested-boundary-once'));
    const linked = await fixture.conversation.readSaga('saga-coordinator');
    if (linked === null) throw new Error('linked_saga_missing');
    await fixture.handoffs.execute(projectResult(linked));
    await coordinator.dispatch(claim('linked-boundary-once'));
    await coordinator.dispatch(claim('projected-boundary-once'));

    expect(fault.boundaries).toEqual([
      'conversation.message.accepted',
      'agent.run.requested',
      'conversation.agent_run.linked',
      'conversation.agent_result.projected'
    ]);
    expect(await fixture.conversation.countPendingHandoffOutbox()).toBe(0);
  });

  it('drains generated handoff messages to an exact pending-zero fixed point', async () => {
    const fixture = await createFixture();
    const coordinator = fixture.coordinator();
    const first = await coordinator.drainToFixedPoint({
      drainId: 'reusable-handoff-drain',
      limit: 1,
      leaseMs: 30_000
    });
    expect(first).toEqual({
      batches: 3,
      acknowledgedMessages: 3,
      pendingMessages: 0
    });
    expect(fixture.executionStarter.committedIntents).toHaveLength(1);
    expect(await fixture.conversation.countPendingHandoffOutbox()).toBe(0);

    const linked = await fixture.conversation.readSaga('saga-coordinator');
    if (linked === null) throw new Error('linked_saga_missing');
    await fixture.handoffs.execute(projectResult(linked));
    const terminal = await coordinator.drainToFixedPoint({
      drainId: 'reusable-handoff-drain',
      limit: 10,
      leaseMs: 30_000
    });
    expect(terminal).toEqual({
      batches: 1,
      acknowledgedMessages: 1,
      pendingMessages: 0
    });
    expect(await fixture.conversation.countPendingHandoffOutbox()).toBe(0);
  });

  it('does not report a fixed point while a pending row is owned by another live claim', async () => {
    const fixture = await createFixture();
    await fixture.conversation.claimPending({
      claimId: 'other-live-dispatcher',
      limit: 1,
      leaseMs: 30_000
    });
    await expect(fixture.coordinator().drainToFixedPoint({
      drainId: 'blocked-fixed-point-drain',
      limit: 10,
      leaseMs: 30_000
    })).rejects.toMatchObject({
      code: 'CONVERSATION_AGENT_HANDOFF_FIXED_POINT_BLOCKED'
    });
    expect(await fixture.conversation.countPendingHandoffOutbox()).toBe(1);
  });

  it('fails closed before claiming when a durable execution starter is absent', async () => {
    const fixture = await createFixture();
    expect(() => new ConversationAgentHandoffCoordinator(
      fixture.conversation,
      fixture.handoffs,
      fixture.admissions,
      undefined as unknown as AgentRunExecutionStarter
    )).toThrow('Conversation handoff requires a durable Agent execution starter.');
    expect(await fixture.conversation.countPendingHandoffOutbox()).toBe(1);
  });

  it('does not ACK a linked Run when the execution receipt drifts', async () => {
    const fixture = await createFixture();
    const coordinator = fixture.coordinator();
    await coordinator.dispatch(claim('accepted-before-receipt-drift'));
    await coordinator.dispatch(claim('requested-before-receipt-drift'));
    const driftingStarter: AgentRunExecutionStarter = {
      startExecutionIntent: async (intent) => ({
        executionIntentId: intent.executionIntentId,
        sourceOutboxMessageId: 'different-source-message',
        runId: intent.runId,
        admittedRunVersion: intent.admittedRunVersion,
        replayed: false
      })
    };
    const driftingCoordinator = new ConversationAgentHandoffCoordinator(
      fixture.conversation,
      fixture.handoffs,
      fixture.admissions,
      driftingStarter
    );
    await expect(driftingCoordinator.dispatch(claim('linked-receipt-drift')))
      .rejects.toMatchObject({ code: 'CONVERSATION_AGENT_HANDOFF_DOWNSTREAM_INVALID' });
    expect(await fixture.conversation.countPendingHandoffOutbox()).toBe(1);
    expect(outboxState(fixture.root).at(-1)).toMatchObject({
      message_kind: 'conversation.agent_run.linked',
      published_at: null
    });
  });

  it('fails closed on durable outbox payload drift before any Agent write', async () => {
    const fixture = await createFixture();
    await closeConversationUnit(fixture.conversation);
    conversationUnits.delete(fixture.conversation);
    const database = new DatabaseSync(resolveConversationDatabasePath(fixture.root));
    try {
      const row = database.prepare(
        'SELECT cursor, message_json FROM conversation_handoff_outbox WHERE cursor=1'
      ).get() as { cursor: number; message_json: string };
      const message = JSON.parse(row.message_json) as Record<string, unknown>;
      message.sessionId = 'drifted-session';
      database.prepare(
        'UPDATE conversation_handoff_outbox SET message_json=? WHERE cursor=?'
      ).run(JSON.stringify(message), row.cursor);
    } finally {
      database.close();
    }

    const reopened = trackConversation(
      new SqliteConversationRunHandoffUnitOfWork(fixture.root)
    );
    const coordinator = new ConversationAgentHandoffCoordinator(
      reopened,
      new ConversationRunHandoffSagaService(reopened),
      fixture.admissions,
      fixture.executionStarter
    );
    await expect(coordinator.dispatch(claim('drift-claim')))
      .rejects.toThrow('conversation_storage_corruption');
    expect(agentCounts(fixture.root).commands).toBe(0);
  });

  it('rejects projected source drift without ACKing the terminal fact', async () => {
    const fixture = await createFixture();
    const coordinator = fixture.coordinator();
    await coordinator.dispatch(claim('accepted-before-projected-drift'));
    await coordinator.dispatch(claim('requested-before-projected-drift'));
    const linked = await fixture.conversation.readSaga('saga-coordinator');
    if (linked === null) throw new Error('linked_saga_missing');
    await fixture.handoffs.execute(projectResult(linked));
    await coordinator.dispatch(claim('linked-before-projected-drift'));

    const driftingOutbox: ConversationRunHandoffOutboxPort = {
      claimPending: (request) => fixture.conversation.claimPending(request),
      acknowledgePublished: (request) => fixture.conversation.acknowledgePublished(request),
      countPendingHandoffOutbox: () => fixture.conversation.countPendingHandoffOutbox(),
      readSaga: async (sagaId) => {
        const saga = await fixture.conversation.readSaga(sagaId);
        if (saga === null || saga.stage.kind !== 'agent_result_projected') return saga;
        return {
          ...saga,
          stage: { ...saga.stage, sourceRunEventId: 'drifted-terminal-event' }
        };
      }
    };
    const driftingCoordinator = new ConversationAgentHandoffCoordinator(
      driftingOutbox,
      fixture.handoffs,
      fixture.admissions,
      fixture.executionStarter
    );
    await expect(driftingCoordinator.dispatch(claim('projected-source-drift')))
      .rejects.toMatchObject({ code: 'CONVERSATION_AGENT_HANDOFF_CORRUPTION' });
    expect(await fixture.conversation.countPendingHandoffOutbox()).toBe(1);
    expect(outboxState(fixture.root).at(-1)).toMatchObject({
      message_kind: 'conversation.agent_result.projected',
      published_at: null
    });
  });

  it('treats an undeclared message kind as corruption and never ACKs it', async () => {
    const fixture = await createFixture();
    const unknownKindOutbox: ConversationRunHandoffOutboxPort = {
      claimPending: async (request) => (await fixture.conversation.claimPending(request)).map(
        (entry) => ({
          ...entry,
          message: { ...entry.message, kind: 'unknown.handoff.kind' }
        }) as unknown as typeof entry
      ),
      acknowledgePublished: (request) => fixture.conversation.acknowledgePublished(request),
      countPendingHandoffOutbox: () => fixture.conversation.countPendingHandoffOutbox(),
      readSaga: (sagaId) => fixture.conversation.readSaga(sagaId)
    };
    const coordinator = new ConversationAgentHandoffCoordinator(
      unknownKindOutbox,
      fixture.handoffs,
      fixture.admissions,
      fixture.executionStarter
    );
    await expect(coordinator.dispatch(claim('unknown-kind-claim')))
      .rejects.toMatchObject({ code: 'CONVERSATION_AGENT_HANDOFF_CORRUPTION' });
    expect(await fixture.conversation.countPendingHandoffOutbox()).toBe(1);
  });
});

interface Fixture {
  readonly root: string;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly handoffs: ConversationRunHandoffSagaService;
  readonly admissions: AgentRunAdmissionController;
  readonly executionStarter: RecordingExecutionStarter;
  coordinator(
    fault?: ConversationAgentHandoffFaultInjector
  ): ConversationAgentHandoffCoordinator;
}

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-handoff-coordinator-'));
  roots.add(root);
  const conversation = trackConversation(
    new SqliteConversationRunHandoffUnitOfWork(root)
  );
  const agent = trackAgent(new SqliteAgentRunUnitOfWork(root));
  const handoffs = new ConversationRunHandoffSagaService(conversation);
  const authority = new ConversationAuthorityService(conversation);
  await authority.createSession(createSession());
  const accepted = await authority.acceptUserMessage(acceptMessage());
  const admissions = new AgentRunAdmissionController(
    agent,
    new FixedSnapshotReader(accepted.messageVersion.contentDigest)
  );
  const executionStarter = new RecordingExecutionStarter();
  return {
    root,
    conversation,
    handoffs,
    admissions,
    executionStarter,
    coordinator: (fault = {}) => new ConversationAgentHandoffCoordinator(
      conversation,
      handoffs,
      admissions,
      executionStarter,
      fault
    )
  };
}

class FixedSnapshotReader implements AgentRunAdmissionSnapshotReader {
  public constructor(private readonly objectiveDigest: string) {}

  public async readAdmissionSnapshot(
    request: Parameters<AgentRunAdmissionSnapshotReader['readAdmissionSnapshot']>[0]
  ): Promise<AgentRunAdmissionSnapshot> {
    return admissionSnapshot(this.objectiveDigest, request);
  }
}

class RecordingExecutionStarter implements AgentRunExecutionStarter {
  private readonly receipts = new Map<string, {
    readonly fingerprint: string;
    readonly receipt: Omit<AgentRunExecutionIntentReceipt, 'replayed'>;
  }>();

  public get committedIntents(): readonly AgentRunExecutionIntentReceipt[] {
    return [...this.receipts.values()].map(({ receipt }) => ({
      ...receipt,
      replayed: false
    }));
  }

  public async startExecutionIntent(
    intent: AgentRunExecutionIntent,
    signal: AbortSignal
  ): Promise<AgentRunExecutionIntentReceipt> {
    signal.throwIfAborted();
    const fingerprint = JSON.stringify(intent);
    const existing = this.receipts.get(intent.executionIntentId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error('execution_intent_command_conflict');
      }
      return { ...existing.receipt, replayed: true };
    }
    const receipt = {
      executionIntentId: intent.executionIntentId,
      sourceOutboxMessageId: intent.sourceOutboxMessageId,
      runId: intent.runId,
      admittedRunVersion: intent.admittedRunVersion
    };
    this.receipts.set(intent.executionIntentId, { fingerprint, receipt });
    return { ...receipt, replayed: false };
  }
}

class RecordingBoundaryFault implements ConversationAgentHandoffFaultInjector {
  public readonly boundaries: ConversationAgentHandoffBoundary['kind'][] = [];

  public afterDurableBoundaryBeforeAcknowledge(
    boundary: ConversationAgentHandoffBoundary
  ): void {
    this.boundaries.push(boundary.kind);
  }
}

class OneShotCoordinatorFault implements ConversationAgentHandoffFaultInjector {
  public constructor(public phase:
    | 'request_after_commit'
    | 'admission_before_link'
    | 'link_after_commit'
    | 'execution_after_commit'
    | 'projected_before_ack'
    | 'none') {}

  public afterAgentAdmissionBeforeLink(): void {
    if (this.phase !== 'admission_before_link') return;
    this.phase = 'none';
    throw new Error('kill_after_agent_admission_before_link');
  }

  public afterDurableBoundaryBeforeAcknowledge(
    boundary: ConversationAgentHandoffBoundary
  ): void {
    if (
      this.phase === 'request_after_commit'
      && boundary.kind === 'conversation.message.accepted'
    ) {
      this.phase = 'none';
      throw new Error('kill_after_request_commit_before_ack');
    }
    if (
      this.phase === 'link_after_commit'
      && boundary.kind === 'agent.run.requested'
    ) {
      this.phase = 'none';
      throw new Error('kill_after_link_commit_before_ack');
    }
    if (
      this.phase === 'execution_after_commit'
      && boundary.kind === 'conversation.agent_run.linked'
    ) {
      this.phase = 'none';
      throw new Error('kill_after_execution_intent_commit_before_ack');
    }
    if (
      this.phase === 'projected_before_ack'
      && boundary.kind === 'conversation.agent_result.projected'
    ) {
      this.phase = 'none';
      throw new Error('kill_after_projected_source_validation_before_ack');
    }
  }
}

function createSession(): CreateConversationSessionCommand {
  return {
    kind: 'conversation.create_session',
    commandId: 'create-session-command',
    eventId: 'session-created-event',
    sessionId: 'session-coordinator',
    workspaceId: 'workspace-coordinator',
    expectedVersion: null,
    occurredAt: ACCEPTED_AT
  };
}

function acceptMessage(): AcceptConversationUserMessageCommand {
  return {
    kind: 'conversation.accept_user_message',
    commandId: 'accept-authority-command',
    eventId: 'accepted-event',
    sessionId: 'session-coordinator',
    workspaceId: 'workspace-coordinator',
    expectedSessionVersion: 1,
    messageId: 'message-coordinator',
    expectedMessageVersion: null,
    content: 'raw user prompt',
    sagaId: 'saga-coordinator',
    handoffCommandId: 'accept-command',
    handoffOutboxMessageId: 'accepted-outbox',
    occurredAt: ACCEPTED_AT
  };
}

function projectResult(saga: ConversationRunHandoffSaga): Extract<
  ConversationRunHandoffCommand,
  { readonly kind: 'handoff.project_agent_result' }
> {
  if (saga.stage.kind !== 'agent_run_linked') throw new Error('saga_not_linked');
  return {
    kind: 'handoff.project_agent_result',
    sagaId: saga.sagaId,
    commandId: 'project-command',
    expectedVersion: saga.version,
    inboxEventId: 'terminal-agent-event',
    outboxMessageId: 'projected-outbox',
    occurredAt: '2030-01-01T00:00:01.000Z',
    sessionId: saga.sessionId,
    workspaceId: saga.workspaceId,
    messageId: saga.messageId,
    messageVersion: saga.messageVersion,
    objectiveDigest: saga.objectiveDigest,
    runRequestId: saga.stage.runRequestId,
    agentCommandId: saga.stage.agentCommandId,
    runId: saga.stage.runId,
    admittedRunVersion: saga.stage.admittedRunVersion,
    resultRunVersion: 2,
    resultStatus: 'completed',
    sourceRunEventId: 'terminal-agent-event-source'
  };
}

async function admissionSnapshot(
  objectiveDigest: string,
  request: Parameters<AgentRunAdmissionSnapshotReader['readAdmissionSnapshot']>[0]
): Promise<AgentRunAdmissionSnapshot> {
  const runId = await deriveStableAgentId(
    'agent-run',
    request.agentCommandId,
    request.runRequestId
  );
  return {
    sessionId: 'session-coordinator',
    workspaceId: 'workspace-coordinator',
    messageId: 'message-coordinator',
    messageVersion: 1,
    objectiveDigest,
    binding: {
      bindingVersion: 3,
      sessionId: 'session-coordinator',
      objectiveRef: {
        kind: 'conversation_message',
        messageId: 'message-coordinator',
        messageVersion: 1,
        contentDigest: objectiveDigest
      },
      workspace: {
        workspaceId: 'workspace-coordinator',
        revision: 1,
        grantDigest: `sha256:${'d'.repeat(64)}`,
        access: 'write',
        scopeIds: ['workspace']
      },
      model: {
        providerId: 'provider-coordinator',
        modelId: 'model-coordinator',
        settingsRevision: 1
      },
      policy: {
        policyId: 'policy-coordinator',
        revision: 1,
        permissionMode: 'ask'
      },
      capabilities: [{
        capabilityId: 'workspace.read',
        scopeIds: ['workspace']
      }],
      toolCatalog: {
        catalogId: 'catalog-coordinator',
        revision: 1,
        digest: CATALOG_DIGEST,
        allowedToolNames: ['workspace.read']
      },
      budget: {
        grantId: 'grant-coordinator',
        runId,
        vector: {
          modelTurns: 12,
          toolCalls: 8,
          readCalls: 8,
          writeCalls: 0,
          shellCalls: 0,
          costMicrousd: 1_000_000
        },
        deadlineAt: '2031-01-01T00:00:00.000Z',
        source: { kind: 'root' }
      }
    },
    input: {
      messages: [{ kind: 'text', role: 'user', content: 'raw user prompt' }],
      availableTools: [{
        tool: {
          catalogId: 'catalog-coordinator',
          revision: 1,
          digest: CATALOG_DIGEST,
          toolName: 'workspace.read',
          toolVersion: '1.0.0',
          providerId: 'ariadne.builtin',
          contractDigest: TOOL_CONTRACT_DIGEST
        },
        capabilityIds: ['workspace.read']
      }]
    }
  };
}

function claim(claimId: string) {
  return { claimId, limit: 1, leaseMs: 30_000 } as const;
}

function agentCounts(root: string): {
  readonly runs: number;
  readonly commands: number;
  readonly checkpoints: number;
} {
  const database = new DatabaseSync(resolveAgentControlDatabasePath(root), {
    readOnly: true
  });
  try {
    const count = (table: string): number => Number((database.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`
    ).get() as { count: number }).count);
    return {
      runs: count('agent_v3_runs'),
      commands: count('agent_v3_commands'),
      checkpoints: count('agent_v3_checkpoints')
    };
  } finally {
    database.close();
  }
}

function outboxState(root: string): Array<{
  readonly message_kind: string;
  readonly published_at: string | null;
}> {
  const database = new DatabaseSync(resolveConversationDatabasePath(root), {
    readOnly: true
  });
  try {
    return database.prepare(
      `SELECT message_kind, published_at
       FROM conversation_handoff_outbox ORDER BY cursor`
    ).all() as unknown as Array<{
      readonly message_kind: string;
      readonly published_at: string | null;
    }>;
  } finally {
    database.close();
  }
}

function serializedPersistence(root: string): {
  readonly conversation: string;
  readonly agent: string;
} {
  const conversation = new DatabaseSync(resolveConversationDatabasePath(root), {
    readOnly: true
  });
  const agent = new DatabaseSync(resolveAgentControlDatabasePath(root), {
    readOnly: true
  });
  try {
    const conversationValue = conversation.prepare(
      `SELECT group_concat(saga_json || message_json, '') AS value
       FROM conversation_handoff_sagas
       CROSS JOIN conversation_handoff_outbox`
    ).get() as { value: string };
    const agentValue = agent.prepare(
      `SELECT group_concat(aggregate_json || result_run_json || event_json || payload_json, '') AS value
       FROM agent_v3_runs
       CROSS JOIN agent_v3_command_runs
       CROSS JOIN agent_v3_events
       CROSS JOIN agent_v3_checkpoints`
    ).get() as { value: string };
    return { conversation: conversationValue.value, agent: agentValue.value };
  } finally {
    conversation.close();
    agent.close();
  }
}

function trackConversation(
  unit: SqliteConversationRunHandoffUnitOfWork
): SqliteConversationRunHandoffUnitOfWork {
  conversationUnits.add(unit);
  return unit;
}

function trackAgent(unit: SqliteAgentRunUnitOfWork): SqliteAgentRunUnitOfWork {
  agentUnits.add(unit);
  return unit;
}

async function closeConversationUnit(
  unit: SqliteConversationRunHandoffUnitOfWork
): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}

async function closeAgentUnit(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}
