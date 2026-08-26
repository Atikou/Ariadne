import { describe, expect, it } from 'vitest';
import {
  AgentRunCommandConflictError,
  AgentRunCommandService,
  AgentRunTransitionError,
  AgentRunVersionConflictError
} from '../src/index.js';
import {
  at,
  startCommand,
  TEST_EFFECT_INPUT_DIGEST,
  testPinnedToolIdentity
} from './fixtures.js';
import {
  InMemoryAgentRunUnitOfWork,
  TestAgentRunCommandService
} from './support/in-memory-unit-of-work.js';

describe('AgentRun state machine', () => {
  it('rejects raw objective text or other undeclared fields in the durable binding', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    const service = new AgentRunCommandService(unitOfWork);
    const command = startCommand('command-unsafe-binding', 'run-unsafe-binding');
    const unsafeCommand = {
      ...command,
      binding: {
        ...command.binding,
        objective: 'This raw user text must not enter aggregate events or outbox.'
      }
    } as typeof command;

    await expect(service.execute(unsafeCommand)).rejects.toMatchObject({
      code: 'AGENT_RUN_INVARIANT',
      message: expect.stringContaining('unsupported field "objective"')
    });
    expect(unitOfWork.loadRun(command.runId)).toBeNull();
    expect(unitOfWork.events()).toHaveLength(0);
  });

  it('rejects an active transition that omits its exact recovery checkpoint', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    const service = new AgentRunCommandService(unitOfWork);
    await service.execute(
      startCommand(),
      { turnInputPayloads: [], effectPayloads: [] }
    );

    await expect(service.execute({
      kind: 'run.begin',
      commandId: 'command-begin-without-checkpoint',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(1)
    }, { turnInputPayloads: [], effectPayloads: [] })).rejects.toMatchObject({
      code: 'AGENT_RUN_RECOVERY_CONFLICT',
      reason: 'checkpoint_mismatch'
    });
    expect(unitOfWork.loadRun('run-1')).toMatchObject({
      version: 1,
      state: { status: 'queued' }
    });
    expect(unitOfWork.events()).toHaveLength(2);
  });

  it('executes a legal run and effect lifecycle through one command service', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    const service = new TestAgentRunCommandService(unitOfWork);

    const created = await service.execute(startCommand());
    expect(created.run.state.status).toBe('queued');
    expect(created.run.version).toBe(1);

    const begun = await service.execute({
      kind: 'run.begin',
      commandId: 'command-begin',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(1)
    });
    expect(begun.run.state).toMatchObject({
      status: 'running',
      checkpointVersion: 1
    });

    const registered = await service.execute({
      kind: 'run.register_effect',
      commandId: 'command-register',
      runId: 'run-1',
      expectedVersion: 2,
      occurredAt: at(2),
      effect: {
        effectId: 'effect-1',
        toolCallId: 'tool-call-1',
        tool: testPinnedToolIdentity('workspace.write'),
        idempotencyKey: 'run-1:tool-call-1',
        capabilityIds: ['workspace.write'],
        scope: ['src/result.ts'],
        inputDigest: TEST_EFFECT_INPUT_DIGEST
      }
    });
    expect(registered.run.effects[0]?.state.status).toBe('intended');

    const authorized = await service.execute({
      kind: 'run.authorize_effect',
      commandId: 'command-authorize',
      runId: 'run-1',
      expectedVersion: 3,
      occurredAt: at(3),
      effectId: 'effect-1'
    });
    expect(authorized.run.effects[0]?.state).toMatchObject({
      status: 'authorized',
      attempt: 1
    });

    const started = await service.execute({
      kind: 'run.start_effect',
      commandId: 'command-start-effect',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(4),
      effectId: 'effect-1'
    });
    expect(started.run.effects[0]?.state.status).toBe('started');

    const succeeded = await service.execute({
      kind: 'run.record_effect_result',
      commandId: 'command-effect-result',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      effectId: 'effect-1',
      result: {
        status: 'succeeded',
        outputRef: 'artifact:result'
      }
    });
    expect(succeeded.run.effects[0]?.state.status).toBe('succeeded');

    const completed = await service.execute({
      kind: 'run.complete',
      commandId: 'command-complete',
      runId: 'run-1',
      expectedVersion: 6,
      occurredAt: at(6),
      outputRef: 'artifact:answer'
    });
    expect(completed.run.state).toMatchObject({
      status: 'completed',
      outputRef: 'artifact:answer'
    });
    expect(completed.run.version).toBe(7);
    expect(unitOfWork.events().some(
      (event) => event.payload.type === 'effect.transitioned'
    )).toBe(true);
  });

  it('rejects illegal state transitions and every mutation after a terminal state', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    const service = new TestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand());

    await expect(service.execute({
      kind: 'run.complete',
      commandId: 'command-complete-queued',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(1)
    })).rejects.toBeInstanceOf(AgentRunTransitionError);

    await service.execute({
      kind: 'run.cancel',
      commandId: 'command-cancel',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(2),
      reason: 'user_cancelled'
    });

    await expect(service.execute({
      kind: 'run.begin',
      commandId: 'command-begin-after-cancel',
      runId: 'run-1',
      expectedVersion: 2,
      occurredAt: at(3)
    })).rejects.toThrow(/Terminal run/);
  });

  it('does not complete while an external effect remains unsettled', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    const service = new TestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand());
    await service.execute({
      kind: 'run.begin',
      commandId: 'command-begin',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(1)
    });
    await service.execute({
      kind: 'run.register_effect',
      commandId: 'command-register',
      runId: 'run-1',
      expectedVersion: 2,
      occurredAt: at(2),
      effect: {
        effectId: 'effect-1',
        toolCallId: 'tool-call-1',
        tool: testPinnedToolIdentity('workspace.write'),
        idempotencyKey: 'effect-key-1',
        capabilityIds: ['workspace.write'],
        scope: ['src/a.ts'],
        inputDigest: TEST_EFFECT_INPUT_DIGEST
      }
    });

    await expect(service.execute({
      kind: 'run.complete',
      commandId: 'command-complete',
      runId: 'run-1',
      expectedVersion: 3,
      occurredAt: at(3)
    })).rejects.toThrow(/unsettled/);
  });

  it('does not report a started external effect as cancelled or failed', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    const service = new TestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand());
    await service.execute({
      kind: 'run.begin',
      commandId: 'command-begin-started-effect',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(1)
    });
    await service.execute({
      kind: 'run.register_effect',
      commandId: 'command-register-started-effect',
      runId: 'run-1',
      expectedVersion: 2,
      occurredAt: at(2),
      effect: {
        effectId: 'effect-started',
        toolCallId: 'tool-call-started',
        tool: testPinnedToolIdentity('workspace.write'),
        idempotencyKey: 'effect-key-started',
        capabilityIds: ['workspace.write'],
        scope: ['src/started.ts'],
        inputDigest: TEST_EFFECT_INPUT_DIGEST
      }
    });
    await service.execute({
      kind: 'run.authorize_effect',
      commandId: 'command-authorize-started-effect',
      runId: 'run-1',
      expectedVersion: 3,
      occurredAt: at(3),
      effectId: 'effect-started'
    });
    await service.execute({
      kind: 'run.start_effect',
      commandId: 'command-start-started-effect',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(4),
      effectId: 'effect-started'
    });

    await expect(service.execute({
      kind: 'run.cancel',
      commandId: 'command-cancel-started-effect',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      reason: 'user_cancelled'
    })).rejects.toThrow(/unknown external outcome/);
    await expect(service.execute({
      kind: 'run.fail',
      commandId: 'command-fail-started-effect',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      errorCode: 'EXECUTION_ABORTED',
      message: 'Execution was interrupted.'
    })).rejects.toThrow(/unknown external outcome/);

    expect(unitOfWork.loadRun('run-1')).toMatchObject({
      version: 5,
      state: { status: 'running' },
      effects: [{ state: { status: 'started' } }]
    });
  });

  it('uses the caller and persistence versions as optimistic concurrency gates', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    const service = new TestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand());
    await service.execute({
      kind: 'run.begin',
      commandId: 'command-begin',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(1)
    });

    await expect(service.execute({
      kind: 'run.cancel',
      commandId: 'command-stale',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(2),
      reason: 'stale_writer'
    })).rejects.toMatchObject({
      code: 'AGENT_RUN_VERSION_CONFLICT',
      expectedVersion: 1,
      actualVersion: 2
    });

    unitOfWork.forceNextVersionConflict(3);
    await expect(service.execute({
      kind: 'run.cancel',
      commandId: 'command-raced',
      runId: 'run-1',
      expectedVersion: 2,
      occurredAt: at(3),
      reason: 'racing_writer'
    })).rejects.toBeInstanceOf(AgentRunVersionConflictError);
    expect(unitOfWork.lastAttemptedCommit?.expectedVersion).toBe(2);
    expect(unitOfWork.loadRun('run-1')?.version).toBe(2);
  });

  it('replays a committed command idempotently without advancing the run', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    const service = new TestAgentRunCommandService(unitOfWork);
    const command = startCommand();
    const first = await service.execute(command);
    const replay = await service.execute(command);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.run.version).toBe(1);
    expect(replay.events).toEqual(first.events);

    await expect(service.execute({
      kind: 'run.cancel',
      commandId: command.commandId,
      runId: command.runId,
      expectedVersion: 1,
      occurredAt: at(1),
      reason: 'different_logical_command'
    })).rejects.toMatchObject({
      code: 'AGENT_RUN_COMMAND_CONFLICT',
      reason: 'command_mismatch',
      commandId: command.commandId
    });
    await expect(service.execute({
      kind: 'run.cancel',
      commandId: command.commandId,
      runId: command.runId,
      expectedVersion: 1,
      occurredAt: at(1),
      reason: 'different_logical_command'
    })).rejects.toBeInstanceOf(AgentRunCommandConflictError);
  });
});
