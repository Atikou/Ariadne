import { describe, expect, it } from 'vitest';
import {
  AgentRunAdmissionService,
  AgentRunCommandService,
  digestAgentTurnInput,
  summarizeAgentTurnInput,
  type AdmitAgentRunRequest,
  type AgentRunTransaction,
  type AgentRunUnitOfWork
} from '../src/index.js';
import { bindingForRun, testAvailableTool } from './fixtures.js';
import { InMemoryAgentRunUnitOfWork } from './support/in-memory-unit-of-work.js';

const MODEL_INPUT = {
  messages: [{
    kind: 'text' as const,
    role: 'user' as const,
    content: 'Admit this Run atomically.'
  }],
  availableTools: [
    testAvailableTool('workspace.read'),
    testAvailableTool('workspace.write')
  ]
};

describe('atomic Agent Run admission', () => {
  it('creates running Run, first Turn, checkpoint, outbox, and receipt in one commit', async () => {
    const unit = new InMemoryAgentRunUnitOfWork();
    const service = new AgentRunAdmissionService(unit);
    const request = await admissionRequest();
    const admitted = await service.admit(request);

    expect(unit.transactionCount).toBe(1);
    expect(unit.commitCount).toBe(1);
    expect(admitted).toMatchObject({
      commandId: request.command.commandId,
      replayed: false,
      run: {
        runId: request.command.runId,
        version: 1,
        state: {
          status: 'running',
          checkpointVersion: 1,
          enteredAt: request.command.occurredAt
        },
        turns: [{
          turnId: request.command.turn.turnId,
          intention: {
            expectedRunVersion: null,
            checkpointVersion: 1,
            inputDigest: request.command.turn.inputDigest
          },
          attempts: [{
            attemptId: request.command.turn.attemptId,
            providerIdempotencyKey: request.command.turn.providerIdempotencyKey,
            state: { status: 'intended' }
          }]
        }]
      }
    });
    expect(admitted.events.map((event) => event.payload.type)).toEqual([
      'run.admitted',
      'run.state_changed',
      'turn.registered',
      'inference_attempt.registered'
    ]);
    expect(admitted.events.every(
      (event) => event.eventId === event.eventId.trim() && event.eventId.length <= 256
    )).toBe(true);
    expect(unit.loadCommittedArtifacts(request.command.commandId)).toEqual({
      checkpoint: {
        checkpointVersion: 1,
        payload: request.checkpoint,
        createdAt: request.command.occurredAt
      },
      turnInputPayloads: [{
        turnId: request.command.turn.turnId,
        inputDigest: request.command.turn.inputDigest,
        payload: request.turnInput,
        recordedAt: request.command.occurredAt
      }],
      effectPayloads: []
    });
    expect(unit.loadCommittedReceipt(request.command.commandId)).toMatchObject({
      mutations: [{
        resultingVersion: 1,
        run: { state: { status: 'running' } },
        events: admitted.events
      }]
    });
    expect(unit.events()).toEqual(admitted.events);
  });

  it('preserves a canonical explicit-offset admission timestamp without projection normalization', async () => {
    const occurredAt = '2026-07-31T08:00:00.000+08:00';
    const unit = new InMemoryAgentRunUnitOfWork();
    const admitted = await new AgentRunAdmissionService(unit).admit(
      await admissionRequest(occurredAt)
    );

    expect(admitted.run.createdAt).toBe(occurredAt);
    expect(admitted.run.updatedAt).toBe(occurredAt);
    expect(admitted.run.state).toMatchObject({ enteredAt: occurredAt });
    expect(admitted.events.every((event) => event.occurredAt === occurredAt)).toBe(true);
  });

  it('collapses concurrent duplicates and rejects command digest drift without another version', async () => {
    const unit = new InMemoryAgentRunUnitOfWork();
    const service = new AgentRunAdmissionService(unit);
    const request = await admissionRequest();
    const [first, duplicate] = await Promise.all([
      service.admit(request),
      service.admit(request)
    ]);

    expect([first.replayed, duplicate.replayed].sort()).toEqual([false, true]);
    expect(first.events).toEqual(duplicate.events);
    expect(unit.commitCount).toBe(1);
    expect(unit.loadRun(request.command.runId)?.version).toBe(1);

    await expect(service.admit({
      ...request,
      command: {
        ...request.command,
        turn: {
          ...request.command.turn,
          attemptId: 'attempt-drift'
        }
      }
    })).rejects.toMatchObject({
      code: 'AGENT_RUN_COMMAND_CONFLICT',
      reason: 'command_mismatch'
    });
    expect(unit.commitCount).toBe(1);
    expect(unit.loadRun(request.command.runId)).toMatchObject({
      version: 1,
      turns: [{ attempts: [{ attemptId: request.command.turn.attemptId }] }]
    });

    await expect(service.admit({
      ...request,
      command: {
        ...request.command,
        commandId: 'different-command-same-run'
      }
    })).rejects.toMatchObject({ code: 'AGENT_RUN_ALREADY_EXISTS' });
    expect(unit.commitCount).toBe(1);
  });

  it('leaves nothing before commit and replays the durable receipt after post-commit process loss', async () => {
    const request = await admissionRequest();
    const beforeStore = new InMemoryAgentRunUnitOfWork();
    const before = new AgentRunAdmissionService(
      new AdmissionBoundaryUnitOfWork(beforeStore, 'before_commit')
    );
    await expect(before.admit(request)).rejects.toThrow('kill_before_commit');
    expect(beforeStore.loadRun(request.command.runId)).toBeNull();
    expect(beforeStore.loadCommittedReceipt(request.command.commandId)).toBeNull();
    expect(beforeStore.loadCommittedArtifacts(request.command.commandId)).toBeNull();
    expect(beforeStore.events()).toHaveLength(0);
    expect(beforeStore.commitCount).toBe(0);

    const afterStore = new InMemoryAgentRunUnitOfWork();
    const after = new AgentRunAdmissionService(
      new AdmissionBoundaryUnitOfWork(afterStore, 'after_commit')
    );
    await expect(after.admit(request)).rejects.toThrow('kill_after_commit');
    expect(afterStore.loadRun(request.command.runId)).toMatchObject({
      version: 1,
      state: { status: 'running' },
      turns: [{ attempts: [{ state: { status: 'intended' } }] }]
    });
    expect(afterStore.events()).toHaveLength(4);
    expect(afterStore.loadCommittedArtifacts(request.command.commandId))
      .not.toBeNull();

    const reopened = afterStore.reopen();
    const replay = await new AgentRunAdmissionService(reopened).admit(request);
    expect(replay.replayed).toBe(true);
    expect(replay.run.version).toBe(1);
    expect(replay.events).toHaveLength(4);
    expect(reopened.commitCount).toBe(0);
  });

  it('rejects non-canonical or unrepresentable IDs instead of trimming them', async () => {
    const base = await admissionRequest();
    const cases: AdmitAgentRunRequest[] = [
      {
        ...base,
        command: { ...base.command, commandId: ' admission-command ' }
      },
      {
        ...base,
        command: { ...base.command, runId: ' run-admission ' }
      },
      {
        ...base,
        command: {
          ...base.command,
          turn: { ...base.command.turn, turnId: ' turn-admission ' }
        }
      },
      {
        ...base,
        command: {
          ...base.command,
          turn: { ...base.command.turn, attemptId: 'a'.repeat(257) }
        }
      },
      {
        ...base,
        command: {
          ...base.command,
          binding: { ...base.command.binding, sessionId: ' session-admission ' }
        }
      }
    ];
    for (const request of cases) {
      const unit = new InMemoryAgentRunUnitOfWork();
      await expect(new AgentRunAdmissionService(unit).admit(request))
        .rejects.toMatchObject({ code: 'AGENT_RUN_INVARIANT' });
      expect(unit.commitCount).toBe(0);
      expect(unit.events()).toHaveLength(0);
    }

    const maximumCommandId = 'c'.repeat(256);
    const unit = new InMemoryAgentRunUnitOfWork();
    const admitted = await new AgentRunAdmissionService(unit).admit({
      ...base,
      command: { ...base.command, commandId: maximumCommandId }
    });
    expect(admitted.commandId).toBe(maximumCommandId);
    expect(admitted.events.every((event) => event.eventId.length <= 256)).toBe(true);
  });

  it('rejects non-canonical timestamps and unsafe binding revisions before a transaction commits', async () => {
    const base = await admissionRequest();
    const cases: AdmitAgentRunRequest[] = [
      {
        ...base,
        command: { ...base.command, occurredAt: '2026-07-31T00:00:00.000' }
      },
      {
        ...base,
        command: {
          ...base.command,
          binding: {
            ...base.command.binding,
            model: {
              ...base.command.binding.model,
              settingsRevision: 2 ** 53
            }
          }
        }
      },
      {
        ...base,
        command: {
          ...base.command,
          binding: {
            ...base.command.binding,
            toolCatalog: {
              ...base.command.binding.toolCatalog,
              revision: 2 ** 53
            }
          }
        }
      }
    ];

    for (const request of cases) {
      const unit = new InMemoryAgentRunUnitOfWork();
      await expect(new AgentRunAdmissionService(unit).admit(request))
        .rejects.toMatchObject({ code: 'AGENT_RUN_INVARIANT' });
      expect(unit.commitCount).toBe(0);
      expect(unit.events()).toHaveLength(0);
    }
  });

  it('requires admission checkpoint material in the same command commit', async () => {
    const request = await admissionRequest();
    const unit = new InMemoryAgentRunUnitOfWork();
    await expect(new AgentRunCommandService(unit).execute(request.command, {
      turnInputPayloads: [{
        turnId: request.command.turn.turnId,
        inputDigest: request.command.turn.inputDigest,
        payload: request.turnInput,
        recordedAt: request.command.occurredAt
      }],
      effectPayloads: []
    }))
      .rejects.toMatchObject({
        code: 'AGENT_RUN_RECOVERY_CONFLICT',
        reason: 'checkpoint_mismatch'
      });
    expect(unit.loadRun(request.command.runId)).toBeNull();
    expect(unit.loadCommittedReceipt(request.command.commandId)).toBeNull();
    expect(unit.events()).toHaveLength(0);
    expect(unit.commitCount).toBe(0);
  });
});

async function admissionRequest(
  occurredAt = '2026-07-31T00:00:00.000Z'
): Promise<AdmitAgentRunRequest> {
  const inputDigest = await digestAgentTurnInput(MODEL_INPUT);
  const runBinding = bindingForRun('run-admission');
  if (runBinding.objectiveRef.kind !== 'conversation_message') {
    throw new Error('Admission fixture requires a Conversation objective.');
  }
  const cause = {
    kind: 'conversation_objective' as const,
    messageId: runBinding.objectiveRef.messageId,
    messageVersion: runBinding.objectiveRef.messageVersion,
    contentDigest: runBinding.objectiveRef.contentDigest
  };
  return {
    command: {
      kind: 'run.admit',
      commandId: 'admission-command',
      runId: 'run-admission',
      occurredAt,
      binding: runBinding,
      turn: {
        cause,
        turnId: 'turn-admission',
        attemptId: 'attempt-admission',
        providerIdempotencyKey: 'provider-admission',
        inputDigest,
        inputSummary: summarizeAgentTurnInput(MODEL_INPUT)
      }
    },
    checkpoint: {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: { phase: 'admitted' },
      modelContext: []
    },
    turnInput: {
      format: 'ariadne.agent-turn-input',
      schemaVersion: 1,
      runId: 'run-admission',
      turnId: 'turn-admission',
      cause,
      authorityRef: {
        kind: 'conversation_message',
        sessionId: runBinding.sessionId,
        workspaceId: runBinding.workspace.workspaceId,
        messageId: runBinding.objectiveRef.messageId,
        messageVersion: runBinding.objectiveRef.messageVersion,
        contentDigest: runBinding.objectiveRef.contentDigest
      },
      messages: MODEL_INPUT.messages,
      availableTools: MODEL_INPUT.availableTools
    }
  };
}

class AdmissionBoundaryUnitOfWork implements AgentRunUnitOfWork {
  public constructor(
    private readonly inner: InMemoryAgentRunUnitOfWork,
    private readonly boundary: 'before_commit' | 'after_commit'
  ) {}

  public async transaction<T>(
    operation: (transaction: AgentRunTransaction) => Promise<T>
  ): Promise<T> {
    if (this.boundary === 'before_commit') {
      return this.inner.transaction((transaction) => operation({
        ...transaction,
        commitCommand: async () => {
          throw new Error('kill_before_commit');
        }
      }));
    }
    await this.inner.transaction(operation);
    throw new Error('kill_after_commit');
  }
}
