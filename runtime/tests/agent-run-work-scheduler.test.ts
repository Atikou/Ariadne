import {
  AgentRunVersionConflictError,
  deriveStableAgentId,
  type AgentRun,
  type AgentRunRecoveryPage,
  type AgentRunRecoveryQuery,
  type BlockedAgentRunRecovery,
  type ReadyResumableAgentRunRecovery,
  type RecoverableAgentRun
} from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentRunWorkScheduler,
  AgentRunWorkSchedulerHealthError,
  AgentRunWorkSchedulerShutdownError,
  type AgentRunStartedWorkRecoveryOwner,
  type AgentRunWorkContinuationOwner,
  type AgentRunWorkEffectDispatcher,
  type AgentRunWorkFollowUpOwner,
  type AgentRunWorkInboxContinuationOwner,
  type AgentRunWorkSchedulerOptions,
  type AgentRunWorkTerminalizationOwner
} from '../src/composition/AgentRunWorkScheduler.js';
import type { AgentRunWorkClassification } from
  '../src/control/execution/AgentRunWorkClassifier.js';

describe('AgentRunWorkScheduler', () => {
  it('scans every startup page before doing I/O and fails closed on a later blocked Run', async () => {
    const action = dispatchEffect('run-action', 4);
    const ready = resumable(action);
    const blocked = blockedRecovery('run-blocked', 9, ['missing_turn_input']);
    const cursor = { createdAt: AT, runId: ready.run.runId };
    const query: AgentRunRecoveryQuery = {
      listActiveRuns: vi.fn(async (request = {}) => {
        expect(request.limit).toBe(1);
        return request.after === undefined
          ? { items: [ready], nextCursor: cursor }
          : { items: [blocked] };
      })
    };
    const ports = rejectingPorts();
    const scheduler = createScheduler(query, classifierFor([action]), ports, {
      pageSize: 1
    });

    await expect(scheduler.start()).rejects.toMatchObject({
      code: 'AGENT_RUN_WORK_SCHEDULER_UNHEALTHY',
      faults: [expect.objectContaining({
        runId: 'run-blocked',
        kind: 'blocked_recovery',
        reason: 'missing_turn_input'
      })]
    });
    expect(query.listActiveRuns).toHaveBeenCalledTimes(2);
    expect(query.listActiveRuns).toHaveBeenNthCalledWith(2, {
      limit: 1,
      after: cursor
    });
    expect(ports.effects.dispatch).not.toHaveBeenCalled();
    expect(() => scheduler.assertHealthy()).toThrow(AgentRunWorkSchedulerHealthError);
  });

  it('drives Effect, continuation, and follow-up owners with exact requests to a fixed point', async () => {
    let current = dispatchEffect(RUN_ID, 4);
    const query = mutableQuery(() => [resumable(current)]);
    const classifier = classifierForDynamic(() => current);
    const effects: AgentRunWorkEffectDispatcher = {
      dispatch: vi.fn(async (request, signal) => {
        expect(signal.aborted).toBe(false);
        current = continueEffects(RUN_ID, 5);
        return {
          run: { runId: RUN_ID, version: 5 },
          effect: {
            effectId: EFFECT_ID,
            state: { status: 'succeeded' }
          },
          status: 'succeeded'
        };
      })
    };
    const continuations: AgentRunWorkContinuationOwner = {
      continueSettledBatch: vi.fn(async (recovery, signal) => {
        expect(signal.aborted).toBe(false);
        expect(recovery.run.version).toBe(5);
        current = followUp(RUN_ID, 6);
        return {
          receiptVersion: 1,
          commandId: 'continue-command',
          runId: RUN_ID,
          runVersion: 6,
          turnId: FOLLOW_UP_TURN_ID,
          attemptId: FOLLOW_UP_ATTEMPT_ID,
          replayed: false
        };
      })
    };
    const followUps: AgentRunWorkFollowUpOwner = {
      dispatchOwned: vi.fn(async (_request, signal) => {
        expect(signal.aborted).toBe(false);
        current = terminal(RUN_ID, 7);
        return {
          status: 'completed',
          inferenceStatus: 'succeeded',
          result: {
            run: { runId: RUN_ID, version: 7 },
            turn: { turnId: FOLLOW_UP_TURN_ID },
            attempt: { attemptId: FOLLOW_UP_ATTEMPT_ID }
          }
        };
      })
    };
    const scheduler = createScheduler(
      query,
      classifier,
      {
        effects,
        continuations,
        followUps,
        terminalizations: rejectingPorts().terminalizations
      }
    );

    await scheduler.start();
    scheduler.assertHealthy();

    const expectedCommandId = await deriveStableAgentId(
      'run-work-effect-dispatch',
      RUN_ID,
      SOURCE_TURN_ID,
      SOURCE_ATTEMPT_ID,
      DIRECTIVE_DIGEST,
      EFFECT_ID,
      INPUT_DIGEST,
      '1'
    );
    expect(effects.dispatch).toHaveBeenCalledWith({
      commandId: expectedCommandId,
      runId: RUN_ID,
      effectId: EFFECT_ID,
      expectedVersion: 4,
      occurredAt: '2026-08-01T00:00:01.000Z'
    }, expect.any(AbortSignal));
    expect(continuations.continueSettledBatch).toHaveBeenCalledOnce();
    expect(followUps.dispatchOwned).toHaveBeenCalledWith({
      runId: RUN_ID,
      turnId: FOLLOW_UP_TURN_ID,
      attemptId: FOLLOW_UP_ATTEMPT_ID,
      expectedVersion: 6,
      occurredAt: '2026-08-01T00:00:02.000Z'
    }, expect.any(AbortSignal));
    // dispatch -> continuation -> inference -> terminal fixed-point scan.
    expect(query.listActiveRuns).toHaveBeenCalledTimes(4);
    await scheduler.shutdown(FUTURE);
  });

  it('persists deterministic settled-batch terminalization and reaches a terminal fixed point', async () => {
    let current = failModelTurnBudget(RUN_ID, 5);
    const ports = rejectingPorts();
    ports.terminalizations.terminalize = vi.fn(async (work, signal) => {
      expect(signal.aborted).toBe(false);
      current = terminal(RUN_ID, 6);
      return {
        receiptVersion: 1,
        commandId: 'terminalize-budget-command',
        runId: work.runId,
        runVersion: 6,
        checkpointVersion: 6,
        status: 'failed',
        reason: 'model_turn_budget_exhausted',
        errorCode: 'agent_model_turn_budget_exhausted',
        replayed: false
      };
    });
    const query = mutableQuery(() => [resumable(current)]);
    const scheduler = createScheduler(
      query,
      classifierForDynamic(() => current),
      ports
    );

    await scheduler.start();
    scheduler.assertHealthy();
    expect(ports.terminalizations.terminalize).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'fail_model_turn_budget',
        runId: RUN_ID,
        expectedVersion: 5
      }),
      expect.any(AbortSignal)
    );
    expect(query.listActiveRuns).toHaveBeenCalledTimes(2);
    await scheduler.shutdown(FUTURE);
  });

  it('recovers abandoned started work only during startup, then rescans before readiness', async () => {
    let current = startedEffect(RUN_ID, 4);
    const query = mutableQuery(() => [resumable(current)]);
    const startedWorkRecovery: AgentRunStartedWorkRecoveryOwner = {
      recover: vi.fn(async (work) => {
        current = wait(RUN_ID, 5, 'recovering_uncertain_effect');
        return {
          receiptVersion: 1,
          commandId: 'startup-recovery-command',
          runId: work.runId,
          runVersion: 5,
          subjectKind: 'effect',
          subjectId: EFFECT_ID,
          recoveryDecisionId: 'recovery-decision',
          replayed: false
        };
      })
    };
    const ports = rejectingPorts();
    const scheduler = createScheduler(
      query,
      classifierForDynamic(() => current),
      ports,
      { startedWorkRecovery }
    );

    await scheduler.start();
    scheduler.assertHealthy();
    expect(startedWorkRecovery.recover).toHaveBeenCalledOnce();
    expect(ports.effects.dispatch).not.toHaveBeenCalled();
    // recovery scan, post-recovery scan, then the normal fixed-point scan.
    expect(query.listActiveRuns).toHaveBeenCalledTimes(2);
    await scheduler.shutdown(FUTURE);
  });

  it('fails startup on abandoned work without an owner and never retries it', async () => {
    const work = startedInference(RUN_ID, 6);
    const ports = rejectingPorts();
    const scheduler = createScheduler(
      mutableQuery(() => [resumable(work)]),
      classifierFor([work]),
      ports
    );

    await expect(scheduler.start()).rejects.toMatchObject({
      faults: [expect.objectContaining({
        kind: 'recovery_uncertain_inference',
        runId: RUN_ID
      })]
    });
    expect(ports.followUps.dispatchOwned).not.toHaveBeenCalled();
  });

  it('treats newly observed started work as a steady-state fault even with a startup owner', async () => {
    let current = terminal(RUN_ID, 7);
    const startedWorkRecovery: AgentRunStartedWorkRecoveryOwner = {
      recover: vi.fn(async () => {
        throw new Error('steady-state recovery must not run');
      })
    };
    const scheduler = createScheduler(
      mutableQuery(() => [resumable(current)]),
      classifierForDynamic(() => current),
      rejectingPorts(),
      { startedWorkRecovery }
    );
    await scheduler.start();
    current = startedEffect(RUN_ID, 8);

    await expect(scheduler.drainOnce()).rejects.toMatchObject({
      faults: [expect.objectContaining({ kind: 'recovery_uncertain_effect' })]
    });
    expect(startedWorkRecovery.recover).not.toHaveBeenCalled();
    expect(scheduler.getFault()).toBeInstanceOf(AgentRunWorkSchedulerHealthError);
  });

  it('single-flights drains and retains a wake that arrives during an active scan', async () => {
    const state = terminal(RUN_ID, 7);
    const gate = deferred<void>();
    let blockNext = false;
    const query: AgentRunRecoveryQuery = {
      listActiveRuns: vi.fn(async () => {
        if (blockNext) {
          blockNext = false;
          await gate.promise;
        }
        return { items: [resumable(state)] };
      })
    };
    const scheduler = createScheduler(
      query,
      classifierFor([state]),
      rejectingPorts()
    );
    await scheduler.start();
    vi.mocked(query.listActiveRuns).mockClear();
    blockNext = true;

    const first = scheduler.drainOnce();
    await vi.waitFor(() => expect(query.listActiveRuns).toHaveBeenCalledOnce());
    scheduler.wake();
    const second = scheduler.drainOnce();
    expect(second).toBe(first);
    gate.resolve();

    await expect(first).resolves.toMatchObject({ rounds: 2, scannedRuns: 2 });
    expect(query.listActiveRuns).toHaveBeenCalledTimes(2);
    await scheduler.shutdown(FUTURE);
  });

  it('latches any owner error and stops accepting later work', async () => {
    let current = terminal(RUN_ID, 7);
    const failure = new Error('effect adapter failed');
    const ports = rejectingPorts();
    ports.effects.dispatch = vi.fn(async () => { throw failure; });
    const scheduler = createScheduler(
      mutableQuery(() => [resumable(current)]),
      classifierForDynamic(() => current),
      ports
    );
    await scheduler.start();
    current = dispatchEffect(RUN_ID, 8);

    await expect(scheduler.drainOnce()).rejects.toBe(failure);
    expect(scheduler.getFault()).toBe(failure);
    expect(() => scheduler.assertHealthy()).toThrow(failure);
    await expect(scheduler.drainOnce()).rejects.toBe(failure);
  });

  it('rescans exact optimistic version conflicts without latching health', async () => {
    const cases = [
      {
        name: 'effect version',
        initial: dispatchEffect(RUN_ID, 4),
        error: new AgentRunVersionConflictError(RUN_ID, 4, 5)
      },
      {
        name: 'follow-up version',
        initial: followUp(RUN_ID, 6),
        error: new AgentRunVersionConflictError(RUN_ID, 6, 7)
      }
    ] as const;

    for (const fixture of cases) {
      let current: AgentRunWorkClassification = fixture.initial;
      const ports = rejectingPorts();
      if (fixture.name === 'effect version') {
        ports.effects.dispatch = vi.fn(async () => {
          current = terminal(RUN_ID, 7);
          throw fixture.error;
        });
      } else {
        ports.followUps.dispatchOwned = vi.fn(async () => {
          current = terminal(RUN_ID, 7);
          throw fixture.error;
        });
      }
      const query = mutableQuery(() => [resumable(current)]);
      const scheduler = createScheduler(
        query,
        classifierForDynamic(() => current),
        ports
      );

      await scheduler.start();
      scheduler.assertHealthy();
      expect(scheduler.getFault()).toBeNull();
      expect(query.listActiveRuns).toHaveBeenCalledTimes(2);
      await scheduler.shutdown(FUTURE);
    }
  });

  it('preflights every startup authority and every actionable round before owner I/O', async () => {
    let current = dispatchEffect(RUN_ID, 4);
    const order: string[] = [];
    const ports = rejectingPorts();
    ports.effects.dispatch = vi.fn(async () => {
      order.push('effect');
      current = terminal(RUN_ID, 5);
      return {
        run: { runId: RUN_ID, version: 5 },
        effect: { effectId: EFFECT_ID, state: { status: 'succeeded' } },
        status: 'succeeded'
      };
    });
    const scheduler = createScheduler(
      mutableQuery(() => [resumable(current)]),
      classifierForDynamic(() => current),
      ports,
      {
        authorityVerifier: {
          assertRestorable: vi.fn(async (run) => {
            order.push(`verify:${run.version}`);
          })
        }
      }
    );

    await scheduler.start();
    expect(order).toEqual(['verify:4', 'verify:4', 'effect']);
    await scheduler.shutdown(FUTURE);
  });

  it('aborts and joins active work, and enforces the absolute shutdown deadline', async () => {
    let current = terminal(RUN_ID, 7);
    const started = deferred<void>();
    const never = deferred<never>();
    const ports = rejectingPorts();
    ports.effects.dispatch = vi.fn(async (_request, signal) => {
      started.resolve();
      expect(signal.aborted).toBe(false);
      return never.promise;
    });
    const scheduler = createScheduler(
      mutableQuery(() => [resumable(current)]),
      classifierForDynamic(() => current),
      ports
    );
    await scheduler.start();
    current = dispatchEffect(RUN_ID, 8);
    void scheduler.drainOnce().catch(() => undefined);
    await started.promise;

    await expect(scheduler.shutdown(new Date(Date.now() + 15).toISOString()))
      .rejects.toBeInstanceOf(AgentRunWorkSchedulerShutdownError);
    const signal = vi.mocked(ports.effects.dispatch).mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(true);
  });
});

interface Ports {
  effects: AgentRunWorkEffectDispatcher;
  continuations: AgentRunWorkContinuationOwner;
  inboxContinuations: AgentRunWorkInboxContinuationOwner;
  followUps: AgentRunWorkFollowUpOwner;
  terminalizations: AgentRunWorkTerminalizationOwner;
}

function createScheduler(
  query: AgentRunRecoveryQuery,
  classifier: { classify(run: AgentRun): AgentRunWorkClassification },
  ports: Ports,
  options: AgentRunWorkSchedulerOptions = {}
): AgentRunWorkScheduler {
  let tick = 1;
  return new AgentRunWorkScheduler(
    query,
    classifier,
    ports.effects,
    ports.continuations,
    ports.inboxContinuations,
    ports.followUps,
    ports.terminalizations,
    {
      intervalMs: 60_000,
      pageSize: 100,
      clock: {
        now: () => `2026-08-01T00:00:${String(tick++).padStart(2, '0')}.000Z`
      },
      ...options
    }
  );
}

function rejectingPorts(): Ports {
  return {
    effects: {
      dispatch: vi.fn(async () => { throw new Error('unexpected Effect dispatch'); })
    },
    continuations: {
      continueSettledBatch: vi.fn(async () => {
        throw new Error('unexpected Effect continuation');
      })
    },
    inboxContinuations: {
      continueInbox: vi.fn(async () => {
        throw new Error('unexpected inbox continuation');
      })
    },
    followUps: {
      dispatchOwned: vi.fn(async () => {
        throw new Error('unexpected follow-up dispatch');
      })
    },
    terminalizations: {
      terminalize: vi.fn(async () => {
        throw new Error('unexpected Run terminalization');
      })
    }
  };
}

function mutableQuery(
  read: () => readonly RecoverableAgentRun[]
): AgentRunRecoveryQuery {
  return {
    listActiveRuns: vi.fn(async (): Promise<AgentRunRecoveryPage> => ({
      items: read()
    }))
  };
}

function classifierFor(
  work: readonly AgentRunWorkClassification[]
): { classify(run: AgentRun): AgentRunWorkClassification } {
  const byId = new Map(work.map((item) => [item.runId, item]));
  return {
    classify: vi.fn((run) => {
      const found = byId.get(run.runId);
      if (found === undefined) throw new Error(`missing classifier fixture:${run.runId}`);
      return found;
    })
  };
}

function classifierForDynamic(
  read: () => AgentRunWorkClassification
): { classify(run: AgentRun): AgentRunWorkClassification } {
  return {
    classify: vi.fn((run) => {
      const work = read();
      expect(run.runId).toBe(work.runId);
      expect(run.version).toBe(work.expectedVersion);
      return work;
    })
  };
}

function resumable(work: AgentRunWorkClassification): ReadyResumableAgentRunRecovery {
  const run = {
    runId: work.runId,
    version: work.expectedVersion
  } as AgentRun;
  return {
    ready: true,
    phase: 'resumable',
    run,
    checkpoint: {
      runId: run.runId,
      runVersion: run.version,
      checkpointVersion: work.checkpointVersion,
      commandId: `checkpoint-${run.runId}`,
      createdAt: AT
    },
    turnInputPayloads: [],
    effectPayloads: []
  };
}

function blockedRecovery(
  runId: string,
  version: number,
  issues: BlockedAgentRunRecovery['issues']
): BlockedAgentRunRecovery {
  return {
    ready: false,
    run: { runId, version } as AgentRun,
    issues
  };
}

function dispatchEffect(runId: string, expectedVersion: number): AgentRunWorkClassification {
  return {
    kind: 'dispatch_effect',
    runId,
    expectedVersion,
    checkpointVersion: expectedVersion,
    sourceTurnId: SOURCE_TURN_ID,
    sourceAttemptId: SOURCE_ATTEMPT_ID,
    sourceDirectiveDigest: DIRECTIVE_DIGEST,
    effectId: EFFECT_ID,
    toolCallId: TOOL_CALL_ID,
    inputDigest: INPUT_DIGEST,
    effectAttempt: 1
  };
}

function continueEffects(runId: string, expectedVersion: number): AgentRunWorkClassification {
  return {
    kind: 'continue_effect_results',
    boundaryKind: 'effect_results',
    runId,
    expectedVersion,
    checkpointVersion: expectedVersion,
    sourceTurnId: SOURCE_TURN_ID,
    sourceAttemptId: SOURCE_ATTEMPT_ID,
    sourceDirectiveDigest: DIRECTIVE_DIGEST,
    effectIds: [EFFECT_ID],
    toolCallIds: [TOOL_CALL_ID]
  };
}

function failModelTurnBudget(
  runId: string,
  expectedVersion: number
): AgentRunWorkClassification {
  return {
    kind: 'fail_model_turn_budget',
    boundaryKind: 'effect_results',
    runId,
    expectedVersion,
    checkpointVersion: expectedVersion,
    sourceTurnId: SOURCE_TURN_ID,
    sourceAttemptId: SOURCE_ATTEMPT_ID,
    sourceDirectiveDigest: DIRECTIVE_DIGEST,
    effectIds: [EFFECT_ID],
    toolCallIds: [TOOL_CALL_ID],
    observedModelTurns: 1,
    modelTurnLimit: 1
  };
}

function followUp(runId: string, expectedVersion: number): AgentRunWorkClassification {
  return {
    kind: 'dispatch_follow_up',
    runId,
    expectedVersion,
    checkpointVersion: expectedVersion,
    turnId: FOLLOW_UP_TURN_ID,
    attemptId: FOLLOW_UP_ATTEMPT_ID,
    inputDigest: FOLLOW_UP_INPUT_DIGEST,
    sourceTurnId: SOURCE_TURN_ID,
    sourceAttemptId: SOURCE_ATTEMPT_ID,
    sourceDirectiveDigest: DIRECTIVE_DIGEST
  };
}

function startedEffect(runId: string, expectedVersion: number): AgentRunWorkClassification {
  return {
    kind: 'recovery_uncertain_effect',
    runId,
    expectedVersion,
    checkpointVersion: expectedVersion,
    effectId: EFFECT_ID,
    toolCallId: TOOL_CALL_ID,
    effectAttempt: 1,
    sourceTurnId: SOURCE_TURN_ID,
    sourceAttemptId: SOURCE_ATTEMPT_ID,
    sourceDirectiveDigest: DIRECTIVE_DIGEST
  };
}

function startedInference(runId: string, expectedVersion: number): AgentRunWorkClassification {
  return {
    kind: 'recovery_uncertain_inference',
    runId,
    expectedVersion,
    checkpointVersion: expectedVersion,
    turnId: FOLLOW_UP_TURN_ID,
    attemptId: FOLLOW_UP_ATTEMPT_ID,
    inputDigest: FOLLOW_UP_INPUT_DIGEST,
    sourceTurnId: SOURCE_TURN_ID,
    sourceAttemptId: SOURCE_ATTEMPT_ID,
    sourceDirectiveDigest: DIRECTIVE_DIGEST
  };
}

function wait(
  runId: string,
  expectedVersion: number,
  reason: Extract<AgentRunWorkClassification, { kind: 'wait' }>['reason']
): AgentRunWorkClassification {
  return {
    kind: 'wait',
    runId,
    expectedVersion,
    checkpointVersion: expectedVersion,
    reason,
    subjectIds: [EFFECT_ID, 'recovery-decision']
  };
}

function terminal(runId: string, expectedVersion: number): AgentRunWorkClassification {
  return {
    kind: 'terminal',
    runId,
    expectedVersion,
    checkpointVersion: expectedVersion,
    status: 'completed'
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

const RUN_ID = 'run-work-scheduler';
const EFFECT_ID = 'effect-work';
const TOOL_CALL_ID = 'tool-call-work';
const SOURCE_TURN_ID = 'turn-source';
const SOURCE_ATTEMPT_ID = 'attempt-source';
const FOLLOW_UP_TURN_ID = 'turn-follow-up';
const FOLLOW_UP_ATTEMPT_ID = 'attempt-follow-up';
const DIRECTIVE_DIGEST = `sha256:${'a'.repeat(64)}`;
const INPUT_DIGEST = `sha256:${'b'.repeat(64)}`;
const FOLLOW_UP_INPUT_DIGEST = `sha256:${'c'.repeat(64)}`;
const AT = '2026-08-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
