import { describe, expect, it } from 'vitest';
import {
  AgentRunTransitionError,
  assertValidAgentRun
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

describe('exact decisions and effect recovery', () => {
  it('binds a permission answer to the exact decision, checkpoint, effect and capabilities', async () => {
    const service = new TestAgentRunCommandService(
      new InMemoryAgentRunUnitOfWork()
    );
    await service.execute(startCommand());
    await begin(service);
    await registerEffect(service);

    const waiting = await service.execute({
      kind: 'run.request_decision',
      commandId: 'command-request-permission',
      runId: 'run-1',
      expectedVersion: 3,
      occurredAt: at(3),
      decision: {
        kind: 'permission',
        decisionId: 'decision-permission-1',
        requestedAt: at(3),
        effectId: 'effect-1',
        toolCallId: 'tool-call-1',
        capabilityIds: ['workspace.write'],
        scope: ['src/result.ts']
      }
    });
    expect(waiting.run.state).toMatchObject({
      status: 'waiting',
      reason: 'tool_permission',
      checkpointVersion: 3
    });
    if (waiting.run.state.status !== 'waiting' || waiting.run.state.reason !== 'tool_permission') {
      throw new Error('expected permission waiting state');
    }
    expect(() => assertValidAgentRun({
      ...waiting.run,
      state: {
        ...waiting.run.state,
        decision: {
          ...waiting.run.state.decision,
          capabilityIds: ['workspace.read']
        }
      }
    })).toThrow(/bind exactly to its intended effect/);

    await expect(service.execute({
      kind: 'run.resolve_decision',
      commandId: 'command-resolve-stale',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(4),
      resolution: {
        kind: 'permission',
        decisionId: 'decision-permission-1',
        checkpoint: { runId: 'run-1', version: 2 },
        resolvedAt: at(4),
        effectId: 'effect-1',
        outcome: 'allow_once',
        approvedCapabilityIds: ['workspace.write']
      }
    })).rejects.toThrow(/checkpoint exactly/);

    await expect(service.execute({
      kind: 'run.resolve_decision',
      commandId: 'command-resolve-partial',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(5),
      resolution: {
        kind: 'permission',
        decisionId: 'decision-permission-1',
        checkpoint: { runId: 'run-1', version: 3 },
        resolvedAt: at(5),
        effectId: 'effect-1',
        outcome: 'allow_once',
        approvedCapabilityIds: []
      }
    })).rejects.toThrow(/exact capability set/);

    const resolved = await service.execute({
      kind: 'run.resolve_decision',
      commandId: 'command-resolve-permission',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(6),
      resolution: {
        kind: 'permission',
        decisionId: 'decision-permission-1',
        checkpoint: { runId: 'run-1', version: 3 },
        resolvedAt: at(6),
        effectId: 'effect-1',
        outcome: 'allow_once',
        approvedCapabilityIds: ['workspace.write']
      }
    });
    expect(resolved.run.state.status).toBe('running');
    expect(resolved.run.effects[0]?.state).toMatchObject({
      status: 'authorized',
      decisionId: 'decision-permission-1'
    });
  });

  it('binds plan approval to the exact plan version and hash', async () => {
    const service = new TestAgentRunCommandService(
      new InMemoryAgentRunUnitOfWork()
    );
    await service.execute(startCommand());
    await begin(service);
    const waiting = await service.execute({
      kind: 'run.request_decision',
      commandId: 'command-request-plan',
      runId: 'run-1',
      expectedVersion: 2,
      occurredAt: at(2),
      decision: {
        kind: 'plan',
        decisionId: 'decision-plan-1',
        requestedAt: at(2),
        planId: 'plan-1',
        planVersion: 7,
        planHash: `sha256:${'7'.repeat(64)}`
      }
    });
    expect(waiting.run.state.status).toBe('waiting');

    await expect(service.execute({
      kind: 'run.resolve_decision',
      commandId: 'command-resolve-wrong-plan',
      runId: 'run-1',
      expectedVersion: 3,
      occurredAt: at(3),
      resolution: {
        kind: 'plan',
        decisionId: 'decision-plan-1',
        checkpoint: { runId: 'run-1', version: 2 },
        resolvedAt: at(3),
        planId: 'plan-1',
        planVersion: 8,
        planHash: `sha256:${'8'.repeat(64)}`,
        outcome: 'approve'
      }
    })).rejects.toThrow(/exact plan ID, version, and hash/);
  });

  it('commits permission denial and terminal cancellation atomically', async () => {
    const unitOfWork = new InMemoryAgentRunUnitOfWork();
    const service = new TestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand());
    await begin(service);
    await registerEffect(service);
    const waiting = await service.execute({
      kind: 'run.request_decision',
      commandId: 'command-request-deniable-permission',
      runId: 'run-1',
      expectedVersion: 3,
      occurredAt: at(3),
      decision: {
        kind: 'permission',
        decisionId: 'decision-deny-1',
        requestedAt: at(3),
        effectId: 'effect-1',
        toolCallId: 'tool-call-1',
        capabilityIds: ['workspace.write'],
        scope: ['src/result.ts']
      }
    });

    const denied = await service.execute({
      kind: 'run.resolve_decision',
      commandId: 'command-deny-permission',
      runId: 'run-1',
      expectedVersion: waiting.run.version,
      occurredAt: at(4),
      resolution: {
        kind: 'permission',
        decisionId: 'decision-deny-1',
        checkpoint: { runId: 'run-1', version: 3 },
        resolvedAt: at(4),
        effectId: 'effect-1',
        outcome: 'deny',
        approvedCapabilityIds: []
      }
    });

    expect(denied.run).toMatchObject({
      version: 5,
      state: {
        status: 'cancelled',
        checkpointVersion: 4,
        reason: 'permission_denied'
      },
      effects: [{ state: { status: 'cancelled', reason: 'permission_denied' } }]
    });
    expect(denied.events.map((event) => event.payload.type)).toEqual([
      'decision.resolved',
      'effect.transitioned',
      'run.cancelled',
      'run.state_changed'
    ]);
  });

  it('moves uncertain effects into explicit recovery and retries with a new attempt', async () => {
    const service = new TestAgentRunCommandService(
      new InMemoryAgentRunUnitOfWork()
    );
    await service.execute(startCommand());
    await begin(service);
    await registerEffect(service);
    await service.execute({
      kind: 'run.authorize_effect',
      commandId: 'command-authorize',
      runId: 'run-1',
      expectedVersion: 3,
      occurredAt: at(3),
      effectId: 'effect-1'
    });
    await service.execute({
      kind: 'run.start_effect',
      commandId: 'command-start-effect',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(4),
      effectId: 'effect-1'
    });
    const uncertain = await service.execute({
      kind: 'run.record_effect_result',
      commandId: 'command-uncertain',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      effectId: 'effect-1',
      result: {
        status: 'uncertain',
        reason: 'Process exited before acknowledgement.',
        recoveryDecisionId: 'decision-recovery-1',
        allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
      }
    });
    expect(uncertain.run.state).toMatchObject({
      status: 'recovering',
      reason: 'uncertain_effect',
      checkpointVersion: 5,
      decision: {
        kind: 'recovery',
        effectId: 'effect-1'
      }
    });
    expect(uncertain.run.effects[0]?.state).toMatchObject({
      status: 'uncertain',
      attempt: 1
    });

    await expect(service.execute({
      kind: 'run.start_effect',
      commandId: 'command-start-while-uncertain',
      runId: 'run-1',
      expectedVersion: 6,
      occurredAt: at(6),
      effectId: 'effect-1'
    })).rejects.toBeInstanceOf(AgentRunTransitionError);

    const retrying = await service.execute({
      kind: 'run.resolve_decision',
      commandId: 'command-retry',
      runId: 'run-1',
      expectedVersion: 6,
      occurredAt: at(7),
      resolution: {
        kind: 'recovery',
        decisionId: 'decision-recovery-1',
        checkpoint: { runId: 'run-1', version: 5 },
        resolvedAt: at(7),
        effectId: 'effect-1',
        outcome: 'retry'
      }
    });
    expect(retrying.run.state.status).toBe('running');
    expect(retrying.run.effects[0]?.state).toMatchObject({
      status: 'authorized',
      attempt: 2
    });
  });
});

async function begin(service: TestAgentRunCommandService): Promise<void> {
  await service.execute({
    kind: 'run.begin',
    commandId: 'command-begin',
    runId: 'run-1',
    expectedVersion: 1,
    occurredAt: at(1)
  });
}

async function registerEffect(service: TestAgentRunCommandService): Promise<void> {
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
      inputDigest: TEST_EFFECT_INPUT_DIGEST
    }
  });
}
