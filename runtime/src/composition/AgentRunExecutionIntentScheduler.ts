import {
  deriveStableAgentId,
  isCanonicalIsoTimestamp,
  sha256AgentControlData
} from '@ariadne/agent-core';
import { randomUUID } from 'node:crypto';

import type {
  AgentRunExecutionIntentRecoveryCursor,
  AgentRunExecutionIntentLedger,
  RecoverableAgentRunExecutionIntent
} from '../control/ports/AgentRunExecutionStarter.js';
import type {
  AgentRunExecutionDispatchReceiptV1,
  AgentRunExecutionDispatcher
} from '../control/execution/AgentRunExecutionDispatchController.js';
import type { ShutdownContext } from '../ingress/ShutdownContext.js';

export interface AgentRunExecutionIntentRecoveryNotice {
  readonly noticeVersion: 1;
  readonly executionIntentId: string;
  readonly runId: string;
  readonly state: 'dispatching' | 'dispatched';
  readonly dispatchAttemptId: string | null;
  readonly reason:
    | 'startup_crossed_dispatch_boundary'
    | 'dispatch_outcome_uncertain'
    | 'dispatch_commit_failed'
    | 'settlement_commit_failed';
}

export interface AgentRunExecutionIntentRecoveryReporter {
  reportExecutionIntentRecovery(
    notice: AgentRunExecutionIntentRecoveryNotice
  ): Promise<void>;
}

export interface AgentRunExecutionSchedulerClock {
  now(): string;
}

export interface AgentRunExecutionIntentSchedulerOptions {
  readonly intervalMs?: number;
  readonly leaseMs?: number;
  readonly batchSize?: number;
  readonly clock?: AgentRunExecutionSchedulerClock;
  readonly nextClaimId?: () => string;
  /** Synchronous edge emitted only after the durable settlement commit. */
  readonly onSettled?: (receipt: AgentRunExecutionDispatchReceiptV1) => void;
  readonly startedInitialInferenceRecovery?: StartedInitialInferenceRecoveryOwner;
}

export interface StartedInitialInferenceRecoveryOwner {
  recoverInitialInference(
    request: {
      readonly runId: string;
      readonly expectedVersion: number;
      readonly sessionId: string;
      readonly objectiveMessageId: string;
      readonly objectiveMessageVersion: number;
      readonly objectiveDigest: string;
    },
    signal: AbortSignal
  ): Promise<{
    readonly commandId: string;
    readonly runId: string;
    readonly runVersion: number;
    readonly subjectKind: 'inference';
    readonly subjectId: string;
    readonly turnId: string;
    readonly recoveryDecisionId: string;
    readonly completedAt: string;
  }>;
}

export interface AgentRunExecutionIntentDrainResult {
  readonly claimed: number;
  readonly settled: number;
}

export interface ActiveAgentRunCancellationRecovery {
  readonly runId: string;
  readonly runVersion: number;
  readonly recoveryDecisionId: string;
}

export type ActiveAgentRunCancellationResult =
  | { readonly status: 'not_active' }
  | { readonly status: 'cancelled'; readonly runVersion: number };

export interface ActiveAgentRunCancellationRequest {
  readonly commandId: string;
  readonly runId: string;
  readonly expectedVersion: number;
  finalize(
    recovery: ActiveAgentRunCancellationRecovery
  ): Promise<{ readonly runVersion: number }>;
}

export class AgentRunExecutionIntentSchedulerRecoveryRequiredError extends Error {
  public readonly code = 'AGENT_EXECUTION_INTENT_RECOVERY_REQUIRED';

  public constructor(public readonly executionIntentIds: readonly string[]) {
    super('One or more execution intents crossed an uncertain dispatch boundary.');
    this.name = 'AgentRunExecutionIntentSchedulerRecoveryRequiredError';
  }
}

export class AgentRunExecutionIntentSchedulerShutdownError extends Error {
  public readonly code = 'AGENT_EXECUTION_SCHEDULER_SHUTDOWN_DEADLINE_EXCEEDED';

  public constructor() {
    super('Execution-intent scheduler did not join active work before shutdown deadline.');
    this.name = 'AgentRunExecutionIntentSchedulerShutdownError';
  }
}

const SYSTEM_CLOCK: AgentRunExecutionSchedulerClock = {
  now: () => new Date().toISOString()
};

interface PendingActiveCancellation {
  readonly request: ActiveAgentRunCancellationRequest;
  readonly result: Promise<ActiveAgentRunCancellationResult>;
  readonly resolve: (result: ActiveAgentRunCancellationResult) => void;
  readonly reject: (error: unknown) => void;
}

interface ActiveExecutionDispatch {
  readonly admittedRunVersion: number;
  readonly controller: AbortController;
  cancellation: PendingActiveCancellation | null;
}

/** Durable producer: only pending is retryable; every crossed fence is recovery work. */
export class AgentRunExecutionIntentScheduler {
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly clock: AgentRunExecutionSchedulerClock;
  private readonly nextClaimId: () => string;
  private readonly onSettled: ((receipt: AgentRunExecutionDispatchReceiptV1) => void) | undefined;
  private readonly startedInitialInferenceRecovery:
    | StartedInitialInferenceRecoveryOwner
    | undefined;
  private readonly abortController = new AbortController();
  private readonly activeByRun = new Map<string, ActiveExecutionDispatch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeDrain: Promise<AgentRunExecutionIntentDrainResult> | null = null;
  private startupPreflight: Promise<void> | null = null;
  private wakePending = false;
  private started = false;
  private stopped = false;
  private fault: unknown = null;

  public constructor(
    private readonly ledger: AgentRunExecutionIntentLedger,
    private readonly dispatcher: AgentRunExecutionDispatcher,
    private readonly recovery: AgentRunExecutionIntentRecoveryReporter,
    options: AgentRunExecutionIntentSchedulerOptions = {}
  ) {
    this.intervalMs = boundedPositive(options.intervalMs ?? 250, 60_000, 'intervalMs');
    this.leaseMs = boundedPositive(options.leaseMs ?? 30_000, 300_000, 'leaseMs');
    this.batchSize = boundedPositive(options.batchSize ?? 1, 1_000, 'batchSize');
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.nextClaimId = options.nextClaimId ?? (() => `execution-claim-${randomUUID()}`);
    this.startedInitialInferenceRecovery = options.startedInitialInferenceRecovery;
    if (options.onSettled !== undefined && typeof options.onSettled !== 'function') {
      throw new Error('onSettled must be a function.');
    }
    this.onSettled = options.onSettled;
  }

  /**
   * Read-only, idempotent startup gate. It enumerates every recovery page and
   * reports every crossed dispatch fence without starting the producer.
   */
  public preflightStartupRecovery(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error('Execution-intent scheduler is already stopped.'));
    }
    if (this.startupPreflight !== null) return this.startupPreflight;
    const operation = this.inspectStartupRecovery().then(async (items) => {
      const blocking: RecoverableAgentRunExecutionIntent[] = [];
      for (const item of items) {
        if (await this.recoverStartedInitialInference(item)) continue;
        blocking.push(item);
      }
      for (const item of blocking) {
        await this.report(item, 'startup_crossed_dispatch_boundary');
      }
      if (blocking.length > 0) {
        throw new AgentRunExecutionIntentSchedulerRecoveryRequiredError(
          blocking.map((item) => item.intent.executionIntentId)
        );
      }
    }).catch((error: unknown) => {
      this.latchFault(error);
      throw error;
    });
    this.startupPreflight = operation;
    return operation;
  }

  /** Enumerates all durable non-settled rows before the producer can run. */
  public async start(): Promise<void> {
    if (this.stopped) throw new Error('Execution-intent scheduler is already stopped.');
    if (this.started) return;
    await this.preflightStartupRecovery();
    if (this.stopped) throw new Error('Execution-intent scheduler is already stopped.');
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      this.wake();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  public assertHealthy(): void {
    if (this.fault !== null) throw this.fault;
    if (!this.started || this.stopped) {
      throw new Error('Execution-intent scheduler is not running.');
    }
  }

  /** Wakes the same single-flight scheduler without making timer state authoritative. */
  public wake(): void {
    if (!this.started || this.stopped || this.fault !== null) return;
    this.wakePending = true;
    if (this.activeDrain !== null) {
      // Preserve the existing health semantics: a wake observing a failing
      // manual drain turns that failure into a scheduler fault.
      void this.activeDrain.catch(() => undefined);
      return;
    }
    this.startWakeDrain();
  }

  public drainOnce(): Promise<AgentRunExecutionIntentDrainResult> {
    if (!this.started || this.stopped) {
      return Promise.reject(new Error('Execution-intent scheduler is not running.'));
    }
    if (this.fault !== null) return Promise.reject(this.fault);
    if (this.activeDrain !== null) return this.activeDrain;
    return this.startDrain('manual');
  }

  /**
   * Interrupts only the exact initial inference currently owned by this
   * scheduler. The caller must durably resolve the resulting uncertain
   * inference before the execution intent can be settled as cancelled.
   */
  public cancelActiveRun(
    request: ActiveAgentRunCancellationRequest
  ): Promise<ActiveAgentRunCancellationResult> {
    const active = this.activeByRun.get(request.runId);
    if (
      active === undefined
      || (
        request.expectedVersion !== active.admittedRunVersion
        && request.expectedVersion !== active.admittedRunVersion + 1
      )
    ) {
      return Promise.resolve({ status: 'not_active' });
    }
    const existing = active.cancellation;
    if (existing !== null) {
      if (existing.request.commandId !== request.commandId) {
        return Promise.reject(new Error(
          'A different cancellation already owns this active Agent Run.'
        ));
      }
      return existing.result;
    }
    let resolve!: (result: ActiveAgentRunCancellationResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<ActiveAgentRunCancellationResult>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    active.cancellation = { request, result, resolve, reject };
    if (!active.controller.signal.aborted) {
      active.controller.abort(new Error('agent_run_user_cancellation_requested'));
    }
    return result;
  }

  public async shutdown(deadlineAt: string): Promise<void> {
    if (!isCanonicalIsoTimestamp(deadlineAt)) {
      throw new Error('Execution scheduler shutdown deadline must be canonical ISO time.');
    }
    this.stopped = true;
    this.started = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.abortController.abort(new Error('execution_scheduler_shutdown'));
    const active = this.activeDrain;
    if (active === null) return;
    const remainingMs = Date.parse(deadlineAt) - Date.now();
    if (remainingMs <= 0) throw new AgentRunExecutionIntentSchedulerShutdownError();
    await joinBeforeDeadline(active, remainingMs);
  }

  public prepareShutdown(context: ShutdownContext): Promise<void> {
    context.throwIfExpired('execution_scheduler_shutdown_deadline_exceeded');
    return this.shutdown(new Date(context.deadlineAt).toISOString());
  }

  public getFault(): unknown {
    return this.fault;
  }

  private async inspectStartupRecovery(): Promise<RecoverableAgentRunExecutionIntent[]> {
    const blocking: RecoverableAgentRunExecutionIntent[] = [];
    let after: AgentRunExecutionIntentRecoveryCursor | undefined = undefined;
    do {
      const page = await this.ledger.listExecutionIntentRecovery({
        limit: 100,
        ...(after === undefined ? {} : { after })
      });
      for (const item of page.items) {
        if (item.state === 'pending') continue;
        blocking.push(item);
      }
      after = page.nextCursor;
    } while (after !== undefined);
    return blocking;
  }

  private async recoverStartedInitialInference(
    item: RecoverableAgentRunExecutionIntent
  ): Promise<boolean> {
    const owner = this.startedInitialInferenceRecovery;
    if (
      owner === undefined
      || item.state !== 'dispatching'
      || item.dispatchAttemptId === null
    ) return false;
    const recovery = await owner.recoverInitialInference({
      runId: item.intent.runId,
      expectedVersion: item.intent.admittedRunVersion + 1,
      sessionId: item.intent.sessionId,
      objectiveMessageId: item.intent.objectiveMessageId,
      objectiveMessageVersion: item.intent.objectiveMessageVersion,
      objectiveDigest: item.intent.objectiveDigest
    }, this.abortController.signal);
    if (
      recovery.runId !== item.intent.runId
      || recovery.runVersion <= item.intent.admittedRunVersion
      || recovery.subjectKind !== 'inference'
    ) {
      throw new Error('Started initial inference recovery returned a contradictory receipt.');
    }
    const receipt: AgentRunExecutionDispatchReceiptV1 = {
      receiptVersion: 1,
      executionIntentId: item.intent.executionIntentId,
      dispatchAttemptId: item.dispatchAttemptId,
      externalDispatchId: await deriveStableAgentId(
        'execution-recovery-external',
        item.intent.executionIntentId,
        item.dispatchAttemptId,
        recovery.subjectId
      ),
      runId: recovery.runId,
      runVersion: recovery.runVersion,
      turnId: recovery.turnId,
      attemptId: recovery.subjectId,
      resultCommandId: recovery.commandId,
      inferenceStatus: 'uncertain',
      recoveryDecisionId: recovery.recoveryDecisionId,
      completedAt: recovery.completedAt
    };
    await this.commitSettlement(item, item.dispatchAttemptId, receipt, 'failed');
    this.onSettled?.(receipt);
    return true;
  }

  private startWakeDrain(): void {
    if (
      this.activeDrain !== null
      || !this.wakePending
      || !this.started
      || this.stopped
      || this.fault !== null
    ) {
      return;
    }
    const operation = this.startDrain('wake');
    void operation.catch(() => undefined);
  }

  private startDrain(
    owner: 'manual' | 'wake'
  ): Promise<AgentRunExecutionIntentDrainResult> {
    const task = owner === 'wake'
      ? this.drainWakeBatches()
      : this.drainClaimedBatch();
    let operation!: Promise<AgentRunExecutionIntentDrainResult>;
    operation = task.then(
      (result) => {
        this.finishDrain(operation);
        return result;
      },
      (error: unknown) => {
        if (owner === 'wake' || this.wakePending) this.latchFault(error);
        this.finishDrain(operation);
        throw error;
      }
    );
    this.activeDrain = operation;
    return operation;
  }

  private finishDrain(operation: Promise<AgentRunExecutionIntentDrainResult>): void {
    if (this.activeDrain !== operation) return;
    this.activeDrain = null;
    this.startWakeDrain();
  }

  /** Wake-owned work drains full batches and consumes every dirty wake edge. */
  private async drainWakeBatches(): Promise<AgentRunExecutionIntentDrainResult> {
    let claimed = 0;
    let settled = 0;
    do {
      // This claim observes all wake edges that preceded its query. Any wake
      // arriving while the query is active makes the loop dirty again.
      this.wakePending = false;
      const batch = await this.drainClaimedBatch();
      claimed += batch.claimed;
      settled += batch.settled;
      if (batch.claimed < this.batchSize && !this.wakePending) break;
    } while (!this.stopped && this.fault === null);
    return { claimed, settled };
  }

  private async drainClaimedBatch(): Promise<AgentRunExecutionIntentDrainResult> {
    const claimId = this.nextClaimId();
    const claimed = await this.ledger.claimPendingExecutionIntents({
      claimId,
      leaseMs: this.leaseMs,
      limit: this.batchSize
    });
    let settled = 0;
    const recoveryIds: string[] = [];
    for (const item of claimed) {
      const dispatchAttemptId = await deriveStableAgentId(
        'execution-dispatch-attempt',
        item.intent.executionIntentId,
        item.claimId,
        String(item.claimAttempts)
      );
      const startedAt = this.now();
      await this.ledger.markExecutionDispatchStarted({
        executionIntentId: item.intent.executionIntentId,
        claimId: item.claimId,
        dispatchAttemptId,
        startedAt
      });
      const dispatchController = new AbortController();
      const active: ActiveExecutionDispatch = {
        admittedRunVersion: item.intent.admittedRunVersion,
        controller: dispatchController,
        cancellation: null
      };
      if (this.activeByRun.has(item.intent.runId)) {
        throw new Error('An Agent Run already has an active initial inference dispatch.');
      }
      this.activeByRun.set(item.intent.runId, active);
      let outcome;
      try {
        outcome = await this.dispatcher.dispatchClaimedExecution({
          intent: item.intent,
          intentDigest: item.intentDigest,
          admissionCommandId: item.admissionCommandId,
          dispatchAttemptId,
          startedAt
        }, AbortSignal.any([
          this.abortController.signal,
          dispatchController.signal
        ]));
      } catch (error) {
        active.cancellation?.reject(error);
        recoveryIds.push(item.intent.executionIntentId);
        await this.reportCrossed(item, dispatchAttemptId, 'dispatch_outcome_uncertain');
        this.activeByRun.delete(item.intent.runId);
        continue;
      }
      if (outcome.status === 'recovery_required') {
        const cancellation = active.cancellation;
        const receipt = outcome.receipt;
        if (
          cancellation !== null
          && outcome.reason === 'inference_outcome_uncertain'
          && receipt?.inferenceStatus === 'uncertain'
          && receipt.recoveryDecisionId !== undefined
        ) {
          try {
            const finalized = await cancellation.request.finalize({
              runId: receipt.runId,
              runVersion: receipt.runVersion,
              recoveryDecisionId: receipt.recoveryDecisionId
            });
            if (
              finalized.runVersion <= receipt.runVersion
              || finalized.runVersion > Number.MAX_SAFE_INTEGER
            ) {
              throw new Error('Active cancellation returned an invalid final Run version.');
            }
            await this.commitSettlement(item, dispatchAttemptId, receipt, 'cancelled');
            settled += 1;
            cancellation.resolve({
              status: 'cancelled',
              runVersion: finalized.runVersion
            });
            this.activeByRun.delete(item.intent.runId);
            this.onSettled?.(receipt);
            continue;
          } catch (error) {
            cancellation.reject(error);
            recoveryIds.push(item.intent.executionIntentId);
            await this.reportCrossed(item, dispatchAttemptId, 'dispatch_outcome_uncertain');
            this.activeByRun.delete(item.intent.runId);
            continue;
          }
        }
        active.cancellation?.reject(new Error(
          'Active Agent Run cancellation did not produce exact inference recovery evidence.'
        ));
        recoveryIds.push(item.intent.executionIntentId);
        await this.reportCrossed(item, dispatchAttemptId, 'dispatch_outcome_uncertain');
        this.activeByRun.delete(item.intent.runId);
        continue;
      }
      this.activeByRun.delete(item.intent.runId);
      assertExactReceipt(outcome.receipt, item.intent.executionIntentId, dispatchAttemptId);
      const expectedOutcome = outcome.receipt.inferenceStatus === 'succeeded'
        ? 'completed'
        : outcome.receipt.inferenceStatus;
      if (outcome.outcome !== expectedOutcome) {
        throw new Error('Execution settlement outcome contradicts its strict receipt.');
      }
      try {
        await this.commitSettlement(
          item,
          dispatchAttemptId,
          outcome.receipt,
          outcome.outcome
        );
        settled += 1;
      } catch (error) {
        recoveryIds.push(item.intent.executionIntentId);
        const state = (error as { readonly dispatchCommitted?: boolean }).dispatchCommitted
          ? 'dispatched'
          : 'dispatching';
        await this.reportCrossed(
          item,
          dispatchAttemptId,
          state === 'dispatched' ? 'settlement_commit_failed' : 'dispatch_commit_failed',
          state
        );
        continue;
      }
      this.onSettled?.(outcome.receipt);
    }
    if (recoveryIds.length > 0) {
      throw new AgentRunExecutionIntentSchedulerRecoveryRequiredError(recoveryIds);
    }
    return { claimed: claimed.length, settled };
  }

  private async commitSettlement(
    item: { readonly intent: { readonly executionIntentId: string } },
    dispatchAttemptId: string,
    receipt: AgentRunExecutionDispatchReceiptV1,
    outcome: 'completed' | 'failed' | 'cancelled'
  ): Promise<void> {
    assertExactReceipt(receipt, item.intent.executionIntentId, dispatchAttemptId);
    const receiptDigest = await sha256AgentControlData(receipt);
    const dispatchedAt = this.nowAfter(receipt.completedAt);
    await this.ledger.markExecutionDispatched({
        executionIntentId: item.intent.executionIntentId,
        dispatchAttemptId,
        externalDispatchId: receipt.externalDispatchId,
        dispatchReceiptDigest: receiptDigest,
        dispatchedAt
    });
    const settlementDigest = await sha256AgentControlData({
      settlementVersion: 1,
      receipt,
      outcome
    });
    try {
      await this.ledger.settleExecutionIntent({
        executionIntentId: item.intent.executionIntentId,
        dispatchAttemptId,
        externalDispatchId: receipt.externalDispatchId,
        outcome,
        settlementDigest,
        settledAt: this.nowAfter(dispatchedAt)
      });
    } catch (error) {
      throw new ExecutionIntentCommitError(true, error);
    }
  }

  private async report(
    item: RecoverableAgentRunExecutionIntent,
    reason: AgentRunExecutionIntentRecoveryNotice['reason']
  ): Promise<void> {
    if (item.state === 'pending') return;
    await this.recovery.reportExecutionIntentRecovery({
      noticeVersion: 1,
      executionIntentId: item.intent.executionIntentId,
      runId: item.intent.runId,
      state: item.state,
      dispatchAttemptId: item.dispatchAttemptId,
      reason
    });
  }

  private reportCrossed(
    item: { readonly intent: { readonly executionIntentId: string; readonly runId: string } },
    dispatchAttemptId: string,
    reason: AgentRunExecutionIntentRecoveryNotice['reason'],
    state: 'dispatching' | 'dispatched' = 'dispatching'
  ): Promise<void> {
    return this.recovery.reportExecutionIntentRecovery({
      noticeVersion: 1,
      executionIntentId: item.intent.executionIntentId,
      runId: item.intent.runId,
      state,
      dispatchAttemptId,
      reason
    });
  }

  private now(): string {
    const value = this.clock.now();
    if (!isCanonicalIsoTimestamp(value)) throw new Error('Execution scheduler clock is invalid.');
    return value;
  }

  private nowAfter(earliest: string): string {
    const value = this.now();
    if (value < earliest) throw new Error('Execution scheduler clock moved backwards.');
    return value;
  }

  private latchFault(error: unknown): void {
    if (this.fault === null) this.fault = error;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

function assertExactReceipt(
  receipt: AgentRunExecutionDispatchReceiptV1,
  executionIntentId: string,
  dispatchAttemptId: string
): void {
  const keys = Object.keys(receipt);
  const expected = [
    'receiptVersion', 'executionIntentId', 'dispatchAttemptId', 'externalDispatchId',
    'runId', 'runVersion', 'turnId', 'attemptId', 'resultCommandId',
    'inferenceStatus', 'completedAt'
  ];
  const allowed = receipt.inferenceStatus === 'uncertain'
    ? [...expected, 'recoveryDecisionId']
    : expected;
  if (
    keys.length !== allowed.length
    || keys.some((key) => !allowed.includes(key))
    || receipt.receiptVersion !== 1
    || receipt.executionIntentId !== executionIntentId
    || receipt.dispatchAttemptId !== dispatchAttemptId
    || !Number.isSafeInteger(receipt.runVersion)
    || receipt.runVersion < 1
    || !['succeeded', 'failed', 'cancelled', 'uncertain'].includes(receipt.inferenceStatus)
    || (
      receipt.inferenceStatus === 'uncertain'
      && (
        typeof receipt.recoveryDecisionId !== 'string'
        || receipt.recoveryDecisionId.trim() !== receipt.recoveryDecisionId
        || receipt.recoveryDecisionId.length < 1
      )
    )
    || (
      receipt.inferenceStatus !== 'uncertain'
      && receipt.recoveryDecisionId !== undefined
    )
    || !isCanonicalIsoTimestamp(receipt.completedAt)
    || [
      receipt.externalDispatchId,
      receipt.runId,
      receipt.turnId,
      receipt.attemptId,
      receipt.resultCommandId
    ].some((value) => typeof value !== 'string' || value.trim() !== value || value.length < 1)
  ) {
    throw new Error('Execution dispatcher returned an invalid strict receipt.');
  }
}

class ExecutionIntentCommitError extends Error {
  public constructor(
    public readonly dispatchCommitted: boolean,
    cause: unknown
  ) {
    super('Execution-intent settlement commit failed.', { cause });
    this.name = 'ExecutionIntentCommitError';
  }
}

function boundedPositive(value: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} is outside its bounded range.`);
  }
  return value;
}

function joinBeforeDeadline(
  active: Promise<unknown>,
  remainingMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(
      new AgentRunExecutionIntentSchedulerShutdownError()
    ), Math.min(remainingMs, 2_147_483_647));
    timeout.unref?.();
    active.then(
      () => { clearTimeout(timeout); resolve(); },
      () => { clearTimeout(timeout); resolve(); }
    );
  });
}
