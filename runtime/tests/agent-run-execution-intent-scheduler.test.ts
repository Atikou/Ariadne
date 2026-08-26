import { describe, expect, it, vi } from 'vitest';

import {
  AgentRunExecutionIntentScheduler,
  AgentRunExecutionIntentSchedulerRecoveryRequiredError,
  AgentRunExecutionIntentSchedulerShutdownError,
  type AgentRunExecutionIntentRecoveryNotice
} from '../src/composition/AgentRunExecutionIntentScheduler.js';
import type {
  AgentRunExecutionDispatchReceiptV1,
  AgentRunExecutionDispatcher,
  AgentRunExecutionDispatchOutcome
} from '../src/control/execution/AgentRunExecutionDispatchController.js';
import type {
  AgentRunExecutionIntent,
  AgentRunExecutionIntentLedger,
  AgentRunExecutionIntentState,
  ClaimedAgentRunExecutionIntent
} from '../src/control/ports/AgentRunExecutionStarter.js';

describe('AgentRunExecutionIntentScheduler', () => {
  it('single-flights a pending claim, commits dispatching before I/O, then receipts and settles', async () => {
    const fixture = ledgerFixture('pending');
    const gate = deferred<AgentRunExecutionDispatchOutcome>();
    let observedDispatchAttemptId = '';
    const dispatcher: AgentRunExecutionDispatcher = {
      dispatchClaimedExecution: vi.fn(async (request) => {
        expect(fixture.state()).toBe('dispatching');
        observedDispatchAttemptId = request.dispatchAttemptId;
        return gate.promise;
      })
    };
    const notices: AgentRunExecutionIntentRecoveryNotice[] = [];
    const onSettled = vi.fn((receipt: AgentRunExecutionDispatchReceiptV1) => {
      expect(fixture.state()).toBe('settled');
      expect(receipt.executionIntentId).toBe(INTENT.executionIntentId);
    });
    const scheduler = createScheduler(fixture.ledger, dispatcher, notices, onSettled);
    await scheduler.start();
    scheduler.assertHealthy();

    scheduler.wake();
    const first = scheduler.drainOnce();
    const second = scheduler.drainOnce();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(dispatcher.dispatchClaimedExecution).toHaveBeenCalledOnce());
    gate.resolve(completedOutcome(observedDispatchAttemptId));

    await expect(first).resolves.toEqual({ claimed: 1, settled: 1 });
    expect(fixture.ledger.claimPendingExecutionIntents).toHaveBeenCalledTimes(2);
    expect(fixture.ledger.markExecutionDispatchStarted).toHaveBeenCalledOnce();
    expect(fixture.ledger.markExecutionDispatched).toHaveBeenCalledOnce();
    expect(fixture.ledger.settleExecutionIntent).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(fixture.state()).toBe('settled');
    expect(notices).toEqual([]);
    await scheduler.shutdown('2099-01-01T00:00:00.000Z');
  });

  it('leaves an unknown dispatch sticky in recovery and never retries or settles it', async () => {
    const fixture = ledgerFixture('pending');
    const dispatcher: AgentRunExecutionDispatcher = {
      dispatchClaimedExecution: vi.fn(async () => ({
        status: 'recovery_required',
        reason: 'inference_outcome_uncertain'
      }))
    };
    const notices: AgentRunExecutionIntentRecoveryNotice[] = [];
    const scheduler = createScheduler(fixture.ledger, dispatcher, notices);
    await scheduler.start();

    await expect(scheduler.drainOnce()).rejects.toBeInstanceOf(
      AgentRunExecutionIntentSchedulerRecoveryRequiredError
    );
    expect(fixture.state()).toBe('dispatching');
    expect(fixture.ledger.markExecutionDispatched).not.toHaveBeenCalled();
    expect(fixture.ledger.settleExecutionIntent).not.toHaveBeenCalled();
    expect(notices).toEqual([expect.objectContaining({
      state: 'dispatching',
      reason: 'dispatch_outcome_uncertain'
    })]);
    await scheduler.shutdown('2099-01-01T00:00:00.000Z');
  });

  it('aborts an active inference, durably resolves its uncertainty, then settles cancellation', async () => {
    const fixture = ledgerFixture('pending');
    let observedDispatchAttemptId = '';
    const dispatcher: AgentRunExecutionDispatcher = {
      dispatchClaimedExecution: vi.fn((request, signal) => new Promise((resolve) => {
        observedDispatchAttemptId = request.dispatchAttemptId;
        signal.addEventListener('abort', () => resolve({
          status: 'recovery_required',
          reason: 'inference_outcome_uncertain',
          receipt: uncertainOutcomeReceipt(request.dispatchAttemptId)
        }), { once: true });
      }))
    };
    const notices: AgentRunExecutionIntentRecoveryNotice[] = [];
    const scheduler = createScheduler(fixture.ledger, dispatcher, notices);
    await scheduler.start();
    const drain = scheduler.drainOnce();
    await vi.waitFor(() => expect(dispatcher.dispatchClaimedExecution).toHaveBeenCalledOnce());

    const finalize = vi.fn(async (recovery) => {
      expect(recovery).toEqual({
        runId: INTENT.runId,
        runVersion: 3,
        recoveryDecisionId: 'recovery-decision-1'
      });
      return { runVersion: 4 };
    });
    await expect(scheduler.cancelActiveRun({
      commandId: 'public-cancel-1',
      runId: INTENT.runId,
      expectedVersion: INTENT.admittedRunVersion,
      finalize
    })).resolves.toEqual({ status: 'cancelled', runVersion: 4 });

    await expect(drain).resolves.toEqual({ claimed: 1, settled: 1 });
    expect(observedDispatchAttemptId).not.toBe('');
    expect(finalize).toHaveBeenCalledOnce();
    expect(fixture.ledger.markExecutionDispatched).toHaveBeenCalledOnce();
    expect(fixture.ledger.settleExecutionIntent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'cancelled' })
    );
    expect(fixture.state()).toBe('settled');
    expect(notices).toEqual([]);
    await scheduler.shutdown('2099-01-01T00:00:00.000Z');
  });

  it.each(['dispatching', 'dispatched'] as const)(
    'reports startup %s state and fails closed before claiming pending work',
    async (state) => {
      const fixture = ledgerFixture(state);
      const notices: AgentRunExecutionIntentRecoveryNotice[] = [];
      const scheduler = createScheduler(fixture.ledger, rejectingDispatcher(), notices);

      await expect(scheduler.start()).rejects.toMatchObject({
        code: 'AGENT_EXECUTION_INTENT_RECOVERY_REQUIRED',
        executionIntentIds: [INTENT.executionIntentId]
      });
      expect(fixture.ledger.claimPendingExecutionIntents).not.toHaveBeenCalled();
      expect(notices).toEqual([expect.objectContaining({
        state,
        reason: 'startup_crossed_dispatch_boundary'
      })]);
    }
  );

  it('recovers a durably started initial inference before readiness without redispatch', async () => {
    const fixture = ledgerFixture('dispatching');
    const notices: AgentRunExecutionIntentRecoveryNotice[] = [];
    const dispatcher = rejectingDispatcher();
    const recovery = {
      recoverInitialInference: vi.fn(async () => ({
        commandId: 'startup-inference-recovery-command',
        runId: INTENT.runId,
        runVersion: 3,
        subjectKind: 'inference' as const,
        subjectId: 'attempt-1',
        turnId: 'turn-1',
        recoveryDecisionId: 'recovery-decision-1',
        completedAt: '2026-08-01T00:00:05.000Z'
      }))
    };
    let tick = 10;
    const scheduler = new AgentRunExecutionIntentScheduler(
      fixture.ledger,
      dispatcher,
      { reportExecutionIntentRecovery: vi.fn(async (notice) => { notices.push(notice); }) },
      {
        intervalMs: 60_000,
        leaseMs: 30_000,
        batchSize: 1,
        nextClaimId: () => 'execution-claim-test',
        clock: { now: () => `2026-08-01T00:00:${String(tick++).padStart(2, '0')}.000Z` },
        startedInitialInferenceRecovery: recovery
      }
    );

    await expect(scheduler.start()).resolves.toBeUndefined();
    scheduler.assertHealthy();
    expect(recovery.recoverInitialInference).toHaveBeenCalledOnce();
    expect(dispatcher.dispatchClaimedExecution).not.toHaveBeenCalled();
    expect(fixture.ledger.markExecutionDispatched).toHaveBeenCalledOnce();
    expect(fixture.ledger.settleExecutionIntent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' })
    );
    expect(fixture.state()).toBe('settled');
    expect(notices).toEqual([]);
    await scheduler.shutdown('2099-01-01T00:00:00.000Z');
  });

  it('preflights every recovery page exactly once without starting a timer or dispatching', async () => {
    const fixture = ledgerFixture('pending');
    const notices: AgentRunExecutionIntentRecoveryNotice[] = [];
    const dispatcher = rejectingDispatcher();
    const scheduler = createScheduler(fixture.ledger, dispatcher, notices);
    const cursor = {
      createdAt: '2026-08-01T00:00:00.000Z',
      executionIntentId: INTENT.executionIntentId
    };
    vi.mocked(fixture.ledger.listExecutionIntentRecovery).mockImplementation(async (request) => (
      request?.after === undefined
        ? { items: [], nextCursor: cursor }
        : { items: [recoveryItem('dispatching')] }
    ));
    const timer = vi.spyOn(globalThis, 'setInterval');

    try {
      const first = scheduler.preflightStartupRecovery();
      const second = scheduler.preflightStartupRecovery();
      expect(second).toBe(first);
      await expect(first).rejects.toMatchObject({
        code: 'AGENT_EXECUTION_INTENT_RECOVERY_REQUIRED',
        executionIntentIds: [INTENT.executionIntentId]
      });
      await expect(scheduler.preflightStartupRecovery()).rejects.toBe(
        scheduler.getFault()
      );

      expect(fixture.ledger.listExecutionIntentRecovery).toHaveBeenCalledTimes(2);
      expect(fixture.ledger.claimPendingExecutionIntents).not.toHaveBeenCalled();
      expect(dispatcher.dispatchClaimedExecution).not.toHaveBeenCalled();
      expect(timer).not.toHaveBeenCalled();
      expect(notices).toEqual([expect.objectContaining({
        state: 'dispatching',
        reason: 'startup_crossed_dispatch_boundary'
      })]);
    } finally {
      timer.mockRestore();
    }
  });

  it('does not emit the settlement edge when the durable settlement commit fails', async () => {
    const fixture = ledgerFixture('pending');
    vi.mocked(fixture.ledger.settleExecutionIntent).mockRejectedValueOnce(
      new Error('settlement write failed')
    );
    const dispatcher: AgentRunExecutionDispatcher = {
      dispatchClaimedExecution: vi.fn(async (request) => completedOutcome(
        request.dispatchAttemptId
      ))
    };
    const notices: AgentRunExecutionIntentRecoveryNotice[] = [];
    const onSettled = vi.fn();
    const scheduler = createScheduler(fixture.ledger, dispatcher, notices, onSettled);
    await scheduler.start();

    await expect(scheduler.drainOnce()).rejects.toBeInstanceOf(
      AgentRunExecutionIntentSchedulerRecoveryRequiredError
    );
    expect(onSettled).not.toHaveBeenCalled();
    expect(fixture.state()).toBe('dispatched');
    expect(notices).toEqual([expect.objectContaining({
      state: 'dispatched',
      reason: 'settlement_commit_failed'
    })]);
    await scheduler.shutdown('2099-01-01T00:00:00.000Z');
  });

  it('retains a wake racing an active claim query and immediately drains through empty', async () => {
    const fixture = ledgerFixture('pending');
    const firstClaim = deferred<readonly ClaimedAgentRunExecutionIntent[]>();
    const defaultClaim = vi.mocked(
      fixture.ledger.claimPendingExecutionIntents
    ).getMockImplementation();
    if (defaultClaim === undefined) throw new Error('Fixture claim implementation is missing.');
    vi.mocked(fixture.ledger.claimPendingExecutionIntents).mockImplementationOnce(
      () => firstClaim.promise
    ).mockImplementation(defaultClaim);
    const dispatcher: AgentRunExecutionDispatcher = {
      dispatchClaimedExecution: vi.fn(async (request) => completedOutcome(
        request.dispatchAttemptId
      ))
    };
    const scheduler = createScheduler(fixture.ledger, dispatcher, []);
    await scheduler.start();

    scheduler.wake();
    await vi.waitFor(() => {
      expect(fixture.ledger.claimPendingExecutionIntents).toHaveBeenCalledOnce();
    });
    scheduler.wake();
    firstClaim.resolve([]);

    await vi.waitFor(() => expect(fixture.state()).toBe('settled'));
    await vi.waitFor(() => {
      // Empty raced query, one full batch, then the wake-owned empty probe.
      expect(fixture.ledger.claimPendingExecutionIntents).toHaveBeenCalledTimes(3);
    });
    expect(dispatcher.dispatchClaimedExecution).toHaveBeenCalledOnce();
    await scheduler.shutdown('2099-01-01T00:00:00.000Z');
  });

  it('stops the producer, aborts and joins active dispatch within the deadline', async () => {
    const fixture = ledgerFixture('pending');
    const dispatcher: AgentRunExecutionDispatcher = {
      dispatchClaimedExecution: vi.fn((_request, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({
          status: 'recovery_required',
          reason: 'inference_outcome_uncertain'
        }), { once: true });
      }))
    };
    const scheduler = createScheduler(fixture.ledger, dispatcher, []);
    await scheduler.start();
    const drain = scheduler.drainOnce();
    await vi.waitFor(() => expect(dispatcher.dispatchClaimedExecution).toHaveBeenCalledOnce());

    await expect(scheduler.shutdown('2099-01-01T00:00:00.000Z')).resolves.toBeUndefined();
    await expect(drain).rejects.toBeInstanceOf(
      AgentRunExecutionIntentSchedulerRecoveryRequiredError
    );
  });

  it('fails the shutdown barrier when active dispatch does not join by deadline', async () => {
    const fixture = ledgerFixture('pending');
    const gate = deferred<AgentRunExecutionDispatchOutcome>();
    const dispatcher: AgentRunExecutionDispatcher = {
      dispatchClaimedExecution: vi.fn(() => gate.promise)
    };
    const scheduler = createScheduler(fixture.ledger, dispatcher, []);
    await scheduler.start();
    const drain = scheduler.drainOnce();
    await vi.waitFor(() => expect(dispatcher.dispatchClaimedExecution).toHaveBeenCalledOnce());

    await expect(scheduler.shutdown(new Date(Date.now() + 10).toISOString()))
      .rejects.toBeInstanceOf(AgentRunExecutionIntentSchedulerShutdownError);
    gate.resolve({ status: 'recovery_required', reason: 'inference_outcome_uncertain' });
    await expect(drain).rejects.toBeInstanceOf(
      AgentRunExecutionIntentSchedulerRecoveryRequiredError
    );
  });
});

function createScheduler(
  ledger: AgentRunExecutionIntentLedger,
  dispatcher: AgentRunExecutionDispatcher,
  notices: AgentRunExecutionIntentRecoveryNotice[],
  onSettled?: (receipt: AgentRunExecutionDispatchReceiptV1) => void
): AgentRunExecutionIntentScheduler {
  let tick = 10;
  return new AgentRunExecutionIntentScheduler(ledger, dispatcher, {
    reportExecutionIntentRecovery: vi.fn(async (notice) => { notices.push(notice); })
  }, {
    intervalMs: 60_000,
    leaseMs: 30_000,
    batchSize: 1,
    nextClaimId: () => 'execution-claim-test',
    clock: { now: () => `2026-08-01T00:00:${String(tick++).padStart(2, '0')}.000Z` },
    ...(onSettled === undefined ? {} : { onSettled })
  });
}

function ledgerFixture(initial: AgentRunExecutionIntentState): {
  readonly ledger: AgentRunExecutionIntentLedger;
  readonly state: () => AgentRunExecutionIntentState;
} {
  let state = initial;
  let dispatchAttemptId: string | null = initial === 'pending'
    ? null
    : 'execution-dispatch-attempt-existing';
  const ledger: AgentRunExecutionIntentLedger = {
    startExecutionIntent: vi.fn(async () => ({
      executionIntentId: INTENT.executionIntentId,
      sourceOutboxMessageId: INTENT.sourceOutboxMessageId,
      runId: INTENT.runId,
      admittedRunVersion: 1,
      replayed: false
    })),
    claimPendingExecutionIntents: vi.fn(async (request) => state === 'pending' ? [{
      intent: INTENT,
      intentDigest: DIGEST,
      admissionCommandId: 'admission-command',
      claimId: request.claimId,
      leaseExpiresAt: '2026-08-01T00:01:00.000Z',
      claimAttempts: 1
    }] : []),
    listExecutionIntentRecovery: vi.fn(async () => ({
      items: state === 'settled' ? [] : [{
        ...recoveryItem(state as Exclude<AgentRunExecutionIntentState, 'settled'>),
        dispatchAttemptId
      }]
    })),
    markExecutionDispatchStarted: vi.fn(async (request) => {
      expect(state).toBe('pending');
      state = 'dispatching';
      dispatchAttemptId = request.dispatchAttemptId;
      return {
        executionIntentId: request.executionIntentId,
        state,
        dispatchAttemptId,
        replayed: false
      };
    }),
    markExecutionDispatched: vi.fn(async (request) => {
      expect(state).toBe('dispatching');
      state = 'dispatched';
      return {
        executionIntentId: request.executionIntentId,
        state,
        dispatchAttemptId: request.dispatchAttemptId,
        replayed: false
      };
    }),
    settleExecutionIntent: vi.fn(async (request) => {
      expect(state).toBe('dispatched');
      state = 'settled';
      return {
        executionIntentId: request.executionIntentId,
        state,
        dispatchAttemptId: request.dispatchAttemptId,
        replayed: false
      };
    })
  };
  return { ledger, state: () => state };
}

function recoveryItem(
  state: Exclude<AgentRunExecutionIntentState, 'settled'>
) {
  return {
    intent: INTENT,
    intentDigest: DIGEST,
    admissionCommandId: 'admission-command',
    state,
    dispatchAttemptId: state === 'pending'
      ? null
      : 'execution-dispatch-attempt-existing',
    dispatchStartedAt: state === 'pending' ? null : '2026-08-01T00:00:01.000Z',
    externalDispatchId: state === 'dispatched' ? 'external-existing' : null,
    dispatchReceiptDigest: state === 'dispatched' ? DIGEST : null,
    dispatchedAt: state === 'dispatched' ? '2026-08-01T00:00:02.000Z' : null
  } as const;
}

function completedOutcome(dispatchAttemptId: string): AgentRunExecutionDispatchOutcome {
  return {
    status: 'completed',
    outcome: 'completed',
    receipt: {
      receiptVersion: 1,
      executionIntentId: INTENT.executionIntentId,
      dispatchAttemptId,
      externalDispatchId: 'external-dispatch',
      runId: INTENT.runId,
      runVersion: 3,
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      resultCommandId: 'result-command',
      inferenceStatus: 'succeeded',
      completedAt: '2026-08-01T00:00:10.000Z'
    }
  };
}

function uncertainOutcomeReceipt(
  dispatchAttemptId: string
): AgentRunExecutionDispatchReceiptV1 {
  return {
    receiptVersion: 1,
    executionIntentId: INTENT.executionIntentId,
    dispatchAttemptId,
    externalDispatchId: 'external-dispatch',
    runId: INTENT.runId,
    runVersion: 3,
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    resultCommandId: 'result-command',
    inferenceStatus: 'uncertain',
    recoveryDecisionId: 'recovery-decision-1',
    completedAt: '2026-08-01T00:00:10.000Z'
  };
}

function rejectingDispatcher(): AgentRunExecutionDispatcher {
  return {
    dispatchClaimedExecution: vi.fn(async () => {
      throw new Error('must not dispatch');
    })
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

const DIGEST = `sha256:${'a'.repeat(64)}`;
const INTENT: AgentRunExecutionIntent = {
  kind: 'agent.execution.start',
  executionIntentId: 'execution-intent-1',
  sourceOutboxMessageId: 'handoff-outbox-1',
  sagaId: 'saga-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  objectiveMessageId: 'message-1',
  objectiveMessageVersion: 1,
  objectiveDigest: DIGEST,
  runRequestId: 'run-request-1',
  runId: 'run-1',
  admittedRunVersion: 1,
  occurredAt: '2026-08-01T00:00:00.000Z'
};
