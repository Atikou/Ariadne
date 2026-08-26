import { describe, expect, it, vi } from 'vitest';

import {
  AgentEffectDispatchRecoveryRequiredError,
  AgentEffectDispatchService,
  AgentRunCommandService,
  type AgentEffectDispatchCheckpointFactory,
  type AgentEffectExecutionInputReader,
  type AgentEffectExecutor
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

const INPUT_DIGEST = TEST_EFFECT_INPUT_DIGEST;

describe('AgentEffectDispatchService', () => {
  it('commits start before one external execution and then commits the known result', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    await createAuthorizedEffect(unitOfWork);
    const executor: AgentEffectExecutor = {
      execute: vi.fn(async (request) => {
        expect(request).toMatchObject({
          runId: 'run-1',
          effectId: 'effect-1',
          tool: testPinnedToolIdentity('workspace.write'),
          idempotencyKey: 'run-1:tool-call-1',
          input: { path: 'src/result.ts', content: 'done' }
        });
        expect(unitOfWork.loadRun('run-1')).toMatchObject({
          version: 5,
          effects: [{ state: { status: 'started' } }]
        });
        return {
          status: 'succeeded' as const,
          outputRef: 'artifact:result',
          result: { written: true }
        };
      })
    };
    const dispatcher = createDispatcher(unitOfWork, executor);

    const result = await dispatcher.dispatch(dispatchRequest());

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'succeeded',
      alreadySettled: false,
      run: { version: 6 },
      effect: {
        state: { status: 'succeeded', outputRef: 'artifact:result' }
      }
    });

    const replay = await dispatcher.dispatch(dispatchRequest());
    expect(replay).toMatchObject({
      status: 'succeeded',
      alreadySettled: true,
      run: { version: 6 }
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent delivery of the same logical dispatch', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    await createAuthorizedEffect(unitOfWork);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor: AgentEffectExecutor = {
      execute: vi.fn(async () => {
        await held;
        return { status: 'succeeded' as const, result: { ok: true } };
      })
    };
    const dispatcher = createDispatcher(unitOfWork, executor);

    const first = dispatcher.dispatch(dispatchRequest());
    const second = dispatcher.dispatch(dispatchRequest());
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1));
    release();

    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('turns an executor exception into explicit uncertain recovery without persisting raw errors', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    await createAuthorizedEffect(unitOfWork);
    const executor: AgentEffectExecutor = {
      execute: vi.fn(async () => {
        throw new Error('secret provider failure');
      })
    };
    const dispatcher = createDispatcher(unitOfWork, executor);

    const result = await dispatcher.dispatch(dispatchRequest());

    expect(result).toMatchObject({
      status: 'uncertain',
      run: {
        version: 6,
        state: {
          status: 'recovering',
          reason: 'uncertain_effect',
          decision: {
            kind: 'recovery',
            effectId: 'effect-1',
            allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
          }
        }
      },
      effect: {
        state: {
          status: 'uncertain',
          reason: 'effect_executor_terminated_without_durable_outcome'
        }
      }
    });
    expect(JSON.stringify(result.run)).not.toContain('secret provider failure');
  });

  it('never executes an effect whose durable state is already started', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    await createAuthorizedEffect(unitOfWork);
    const commands = new AgentRunCommandService(unitOfWork);
    await commands.execute({
      kind: 'run.start_effect',
      commandId: 'dispatch-1:effect-start',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(4),
      effectId: 'effect-1'
    }, {
      checkpoint: checkpointFactory.create({
        run: unitOfWork.loadRun('run-1')!,
        effect: unitOfWork.loadRun('run-1')!.effects[0]!,
        checkpointVersion: 4,
        phase: 'effect_started',
        occurredAt: at(4)
      }),
      turnInputPayloads: [],
      effectPayloads: []
    });
    const executor: AgentEffectExecutor = {
      execute: vi.fn(async () => ({ status: 'succeeded' as const, result: null }))
    };
    const dispatcher = createDispatcher(unitOfWork, executor);

    await expect(dispatcher.dispatch({
      ...dispatchRequest(),
      expectedVersion: 5
    })).rejects.toBeInstanceOf(AgentEffectDispatchRecoveryRequiredError);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('rejects input that does not match the durable effect digest before starting', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    await createAuthorizedEffect(unitOfWork);
    const executor: AgentEffectExecutor = {
      execute: vi.fn(async () => ({ status: 'succeeded' as const, result: null }))
    };
    const dispatcher = new AgentEffectDispatchService(
      unitOfWork,
      inputReader('sha256:different'),
      executor,
      checkpointFactory,
      { now: () => at(5) }
    );

    await expect(dispatcher.dispatch(dispatchRequest())).rejects.toThrow(
      /must match the exact Run, Effect, and input digest/
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(unitOfWork.loadRun('run-1')).toMatchObject({
      version: 4,
      effects: [{ state: { status: 'authorized' } }]
    });
  });
});

const checkpointFactory: AgentEffectDispatchCheckpointFactory = {
  create: ({ checkpointVersion, phase, effect, occurredAt }) => ({
    checkpointVersion,
    createdAt: occurredAt,
    payload: {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: { phase, effectId: effect.effectId },
      modelContext: null
    }
  })
};

function createDispatcher(
  unitOfWork: InMemoryAgentRunUnitOfWork,
  executor: AgentEffectExecutor
): AgentEffectDispatchService {
  return new AgentEffectDispatchService(
    unitOfWork,
    inputReader(INPUT_DIGEST),
    executor,
    checkpointFactory,
    { now: () => at(5) }
  );
}

function inputReader(inputDigest: string): AgentEffectExecutionInputReader {
  return {
    loadEffectExecutionInput: async () => ({
      runId: 'run-1',
      effectId: 'effect-1',
      inputDigest,
      input: {
        path: 'src/result.ts',
        content: 'done'
      }
    })
  };
}

function dispatchRequest() {
  return {
    commandId: 'dispatch-1',
    runId: 'run-1',
    effectId: 'effect-1',
    expectedVersion: 4,
    occurredAt: at(4)
  } as const;
}

async function createAuthorizedEffect(
  unitOfWork: InMemoryAgentRunUnitOfWork
): Promise<void> {
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
      idempotencyKey: 'run-1:tool-call-1',
      capabilityIds: ['workspace.write'],
      scope: ['src/result.ts'],
      inputDigest: INPUT_DIGEST
    }
  });
  await service.execute({
    kind: 'run.authorize_effect',
    commandId: 'command-authorize',
    runId: 'run-1',
    expectedVersion: 3,
    occurredAt: at(3),
    effectId: 'effect-1'
  });
}
