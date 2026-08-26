import { describe, expect, it } from 'vitest';

import {
  ConversationRunHandoffError,
  assertValidConversationRunHandoffSaga,
  type ConversationRunHandoffCommand,
  type ConversationRunHandoffSaga
} from '../src/conversation/ConversationRunHandoffSaga.js';
import {
  ConversationRunHandoffSagaService,
  type CommittedConversationRunHandoffCommand,
  type ConversationRunHandoffCommit,
  type ConversationRunHandoffTransaction,
  type ConversationRunHandoffUnitOfWork
} from '../src/control/conversation/ConversationRunHandoffSagaService.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('ConversationRunHandoffSaga', () => {
  it('moves through the exact reference-only handoff flow', async () => {
    const unit = new InMemoryHandoffUnitOfWork();
    const service = new ConversationRunHandoffSagaService(unit);
    const accepted = await service.execute(acceptCommand());
    const requested = await service.execute(requestCommand(accepted.saga));
    const linked = await service.execute(linkCommand(requested.saga));
    const projected = await service.execute(projectCommand(linked.saga));

    expect(projected.saga).toMatchObject({
      version: 4,
      stage: {
        kind: 'agent_result_projected',
        runId: 'run-1',
        admittedRunVersion: 1,
        resultRunVersion: 7,
        resultStatus: 'completed',
        sourceRunEventId: 'run-event-7'
      }
    });
    expect(unit.commitCount).toBe(4);
    expect(unit.outbox.map((message) => message.kind)).toEqual([
      'conversation.message.accepted',
      'agent.run.requested',
      'conversation.agent_run.linked',
      'conversation.agent_result.projected'
    ]);
    const serialized = JSON.stringify({ saga: projected.saga, outbox: unit.outbox });
    expect(serialized).not.toContain('raw user prompt');
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).toContain(DIGEST);
  });

  it('replays an exact command and rejects payload or digest drift', async () => {
    const unit = new InMemoryHandoffUnitOfWork();
    const service = new ConversationRunHandoffSagaService(unit);
    const command = acceptCommand();
    const first = await service.execute(command);
    const replay = await service.execute(command);
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(unit.commitCount).toBe(1);

    await expect(service.execute({
      ...command,
      objectiveDigest: `sha256:${'b'.repeat(64)}`
    })).rejects.toMatchObject({ code: 'HANDOFF_COMMAND_CONFLICT' });
    await expect(service.execute({
      ...command,
      outboxMessageId: 'different-outbox'
    })).rejects.toMatchObject({ code: 'HANDOFF_COMMAND_CONFLICT' });
    expect(unit.commitCount).toBe(1);
  });

  it('rejects skipped stages, wrong identities, and stale versions', async () => {
    const unit = new InMemoryHandoffUnitOfWork();
    const service = new ConversationRunHandoffSagaService(unit);
    const accepted = await service.execute(acceptCommand());
    await expect(service.execute(linkCommand(accepted.saga)))
      .rejects.toMatchObject({ code: 'HANDOFF_INVALID_TRANSITION' });
    await expect(service.execute({
      ...requestCommand(accepted.saga),
      commandId: 'request-wrong-message',
      inboxEventId: 'inbox-wrong-message',
      outboxMessageId: 'outbox-wrong-message',
      messageId: 'message-other'
    })).rejects.toMatchObject({ code: 'HANDOFF_COMMAND_CONFLICT' });
    await expect(service.execute({
      ...requestCommand(accepted.saga),
      commandId: 'request-stale',
      inboxEventId: 'inbox-stale',
      outboxMessageId: 'outbox-stale',
      expectedVersion: 99
    })).rejects.toMatchObject({ code: 'HANDOFF_VERSION_CONFLICT' });
    expect(unit.commitCount).toBe(1);
  });

  it('binds link and result to the exact request and Run identities', async () => {
    const unit = new InMemoryHandoffUnitOfWork();
    const service = new ConversationRunHandoffSagaService(unit);
    const accepted = await service.execute(acceptCommand());
    const requested = await service.execute(requestCommand(accepted.saga));

    await expect(service.execute({
      ...linkCommand(requested.saga),
      commandId: 'link-wrong-request',
      inboxEventId: 'inbox-link-wrong-request',
      outboxMessageId: 'outbox-link-wrong-request',
      runRequestId: 'request-other'
    })).rejects.toMatchObject({ code: 'HANDOFF_INVALID_TRANSITION' });

    const linked = await service.execute(linkCommand(requested.saga));
    await expect(service.execute({
      ...projectCommand(linked.saga),
      commandId: 'project-wrong-run',
      inboxEventId: 'inbox-project-wrong-run',
      outboxMessageId: 'outbox-project-wrong-run',
      runId: 'run-other'
    })).rejects.toMatchObject({ code: 'HANDOFF_INVALID_TRANSITION' });
    await expect(service.execute({
      ...projectCommand(linked.saga),
      commandId: 'project-old-version',
      inboxEventId: 'inbox-project-old-version',
      outboxMessageId: 'outbox-project-old-version',
      resultRunVersion: 0
    })).rejects.toMatchObject({ code: 'HANDOFF_INVARIANT' });
  });

  it('terminalizes a pre-Run start failure without inventing a Run identity', async () => {
    const unit = new InMemoryHandoffUnitOfWork();
    const service = new ConversationRunHandoffSagaService(unit);
    const accepted = await service.execute(acceptCommand());
    const requested = await service.execute(requestCommand(accepted.saga));
    const failed = await service.execute(failStartCommand(requested.saga));

    expect(failed.saga).toMatchObject({
      version: 3,
      stage: {
        kind: 'agent_start_failed',
        runRequestId: 'run-request-1',
        agentCommandId: 'agent-admission-1',
        failureCode: 'admission_snapshot_unavailable'
      }
    });
    expect(failed.outbox).toMatchObject({
      kind: 'conversation.agent_start.failed',
      sagaVersion: 3,
      failureCode: 'admission_snapshot_unavailable'
    });
    expect(JSON.stringify(failed)).not.toContain('raw user prompt');
    await expect(service.execute(linkCommand(failed.saga)))
      .rejects.toMatchObject({ code: 'HANDOFF_INVALID_TRANSITION' });
  });

  it('recovers idempotently across pre-commit and post-commit process loss', async () => {
    const command = acceptCommand();
    const beforeStore = new InMemoryHandoffUnitOfWork();
    await expect(new ConversationRunHandoffSagaService(
      new KillBoundaryHandoffUnitOfWork(beforeStore, 'before_commit')
    ).execute(command)).rejects.toThrow('kill_before_handoff_commit');
    expect(beforeStore.commitCount).toBe(0);
    expect(beforeStore.loadSaga(command.sagaId)).toBeNull();

    const afterStore = new InMemoryHandoffUnitOfWork();
    await expect(new ConversationRunHandoffSagaService(
      new KillBoundaryHandoffUnitOfWork(afterStore, 'after_commit')
    ).execute(command)).rejects.toThrow('kill_after_handoff_commit');
    expect(afterStore.commitCount).toBe(1);
    expect(afterStore.outbox).toHaveLength(1);
    const replay = await new ConversationRunHandoffSagaService(afterStore)
      .execute(command);
    expect(replay.replayed).toBe(true);
    expect(afterStore.commitCount).toBe(1);
    expect(afterStore.outbox).toHaveLength(1);
  });

  it('fails closed on noncanonical IDs, RFC time, and unsafe versions', async () => {
    const base = acceptCommand();
    const cases: ConversationRunHandoffCommand[] = [
      { ...base, sagaId: ' saga-1 ' },
      { ...base, inboxEventId: 'i'.repeat(257) },
      { ...base, occurredAt: 'Wed, 31 Jul 2026 00:00:00 GMT' },
      { ...base, occurredAt: '2030-02-30T00:00:00.000Z' },
      { ...base, rawPrompt: 'must not enter a handoff command' } as ConversationRunHandoffCommand,
      { ...base, messageVersion: 2 ** 53 }
    ];
    for (const command of cases) {
      const unit = new InMemoryHandoffUnitOfWork();
      await expect(new ConversationRunHandoffSagaService(unit).execute(command))
        .rejects.toMatchObject({ code: 'HANDOFF_INVARIANT' });
      expect(unit.commitCount).toBe(0);
      expect(unit.outbox).toEqual([]);
    }
  });

  it('rejects persisted sagas whose stage chronology or aggregate timestamps drift', async () => {
    const service = new ConversationRunHandoffSagaService(
      new InMemoryHandoffUnitOfWork()
    );
    const accepted = await service.execute(acceptCommand());
    const requested = await service.execute(requestCommand(accepted.saga));
    const linked = await service.execute(linkCommand(requested.saga));

    expect(() => assertValidConversationRunHandoffSaga({
      ...linked.saga,
      updatedAt: at(9)
    })).toThrow(/durable stage boundaries/u);
    expect(() => assertValidConversationRunHandoffSaga({
      ...linked.saga,
      updatedAt: at(0),
      stage: {
        ...linked.saga.stage,
        linkedAt: at(0)
      }
    })).toThrow(/cannot precede/u);
  });
});

class InMemoryHandoffUnitOfWork implements ConversationRunHandoffUnitOfWork {
  private readonly sagas = new Map<string, ConversationRunHandoffSaga>();
  private readonly receipts = new Map<string, CommittedConversationRunHandoffCommand>();
  public readonly outbox: ConversationRunHandoffCommit['outbox'][] = [];
  public commitCount = 0;

  public async transaction<T>(
    operation: (transaction: ConversationRunHandoffTransaction) => Promise<T>
  ): Promise<T> {
    return operation({
      loadSaga: async (sagaId) => this.loadSaga(sagaId),
      loadCommittedCommand: async (commandId) => this.receipts.get(commandId) ?? null,
      commit: async (commit) => {
        const current = this.sagas.get(commit.sagaId) ?? null;
        if ((current?.version ?? null) !== commit.expectedVersion) {
          throw new ConversationRunHandoffError(
            'HANDOFF_VERSION_CONFLICT',
            'Injected storage compare-and-swap conflict.'
          );
        }
        if (this.receipts.has(commit.commandId)) {
          throw new ConversationRunHandoffError(
            'HANDOFF_COMMAND_CONFLICT',
            'Injected command receipt conflict.'
          );
        }
        this.sagas.set(commit.sagaId, structuredClone(commit.saga));
        this.receipts.set(commit.commandId, structuredClone(commit));
        this.outbox.push(structuredClone(commit.outbox));
        this.commitCount += 1;
      }
    });
  }

  public loadSaga(sagaId: string): ConversationRunHandoffSaga | null {
    const saga = this.sagas.get(sagaId);
    return saga === undefined ? null : structuredClone(saga);
  }
}

class KillBoundaryHandoffUnitOfWork implements ConversationRunHandoffUnitOfWork {
  public constructor(
    private readonly inner: InMemoryHandoffUnitOfWork,
    private readonly boundary: 'before_commit' | 'after_commit'
  ) {}

  public async transaction<T>(
    operation: (transaction: ConversationRunHandoffTransaction) => Promise<T>
  ): Promise<T> {
    if (this.boundary === 'before_commit') {
      return this.inner.transaction((transaction) => operation({
        ...transaction,
        commit: async () => {
          throw new Error('kill_before_handoff_commit');
        }
      }));
    }
    await this.inner.transaction(operation);
    throw new Error('kill_after_handoff_commit');
  }
}

function acceptCommand(): Extract<ConversationRunHandoffCommand, {
  kind: 'handoff.accept_message'
}> {
  return {
    kind: 'handoff.accept_message',
    sagaId: 'saga-1',
    commandId: 'command-accept',
    expectedVersion: null,
    inboxEventId: 'inbox-message-accepted',
    outboxMessageId: 'outbox-message-accepted',
    occurredAt: at(0),
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    messageId: 'message-1',
    messageVersion: 1,
    objectiveDigest: DIGEST
  };
}

function requestCommand(saga: ConversationRunHandoffSaga): Extract<
  ConversationRunHandoffCommand,
  { kind: 'handoff.request_agent_run' }
> {
  return {
    kind: 'handoff.request_agent_run',
    ...identity(saga),
    sagaId: saga.sagaId,
    commandId: 'command-request',
    expectedVersion: saga.version,
    inboxEventId: 'inbox-run-request',
    outboxMessageId: 'outbox-run-request',
    occurredAt: at(1),
    runRequestId: 'run-request-1',
    agentCommandId: 'agent-admission-1'
  };
}

function linkCommand(saga: ConversationRunHandoffSaga): Extract<
  ConversationRunHandoffCommand,
  { kind: 'handoff.link_agent_run' }
> {
  const stage = saga.stage;
  const runRequestId = 'runRequestId' in stage ? stage.runRequestId : 'run-request-1';
  const agentCommandId = 'agentCommandId' in stage ? stage.agentCommandId : 'agent-admission-1';
  return {
    kind: 'handoff.link_agent_run',
    ...identity(saga),
    sagaId: saga.sagaId,
    commandId: 'command-link',
    expectedVersion: saga.version,
    inboxEventId: 'inbox-run-linked',
    outboxMessageId: 'outbox-run-linked',
    occurredAt: at(2),
    runRequestId,
    agentCommandId,
    runId: 'run-1',
    admittedRunVersion: 1
  };
}

function failStartCommand(saga: ConversationRunHandoffSaga): Extract<
  ConversationRunHandoffCommand,
  { kind: 'handoff.fail_agent_start' }
> {
  const stage = saga.stage;
  return {
    kind: 'handoff.fail_agent_start',
    ...identity(saga),
    sagaId: saga.sagaId,
    commandId: 'command-fail-start',
    expectedVersion: saga.version,
    inboxEventId: 'inbox-fail-start',
    outboxMessageId: 'outbox-fail-start',
    occurredAt: at(2),
    runRequestId: 'runRequestId' in stage ? stage.runRequestId : 'run-request-1',
    agentCommandId: 'agentCommandId' in stage
      ? stage.agentCommandId
      : 'agent-admission-1',
    failureCode: 'admission_snapshot_unavailable'
  };
}

function projectCommand(saga: ConversationRunHandoffSaga): Extract<
  ConversationRunHandoffCommand,
  { kind: 'handoff.project_agent_result' }
> {
  const stage = saga.stage;
  const runRequestId = 'runRequestId' in stage ? stage.runRequestId : 'run-request-1';
  const agentCommandId = 'agentCommandId' in stage ? stage.agentCommandId : 'agent-admission-1';
  const runId = 'runId' in stage ? stage.runId : 'run-1';
  const admittedRunVersion = 'admittedRunVersion' in stage
    ? stage.admittedRunVersion
    : 1;
  return {
    kind: 'handoff.project_agent_result',
    ...identity(saga),
    sagaId: saga.sagaId,
    commandId: 'command-project',
    expectedVersion: saga.version,
    inboxEventId: 'inbox-result-projected',
    outboxMessageId: 'outbox-result-projected',
    occurredAt: at(3),
    runRequestId,
    agentCommandId,
    runId,
    admittedRunVersion,
    resultRunVersion: 7,
    resultStatus: 'completed',
    sourceRunEventId: 'run-event-7'
  };
}

function identity(saga: ConversationRunHandoffSaga) {
  return {
    sessionId: saga.sessionId,
    workspaceId: saga.workspaceId,
    messageId: saga.messageId,
    messageVersion: saga.messageVersion,
    objectiveDigest: saga.objectiveDigest
  };
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
