import {
  AgentRunVersionConflictError,
  deriveStableAgentId,
  isCanonicalIsoTimestamp,
  type AgentRun,
  type AgentRunRecoveryCursor,
  type AgentRunRecoveryQuery,
  type ReadyResumableAgentRunRecovery,
  type RecoverableAgentRun
} from '@ariadne/agent-core';

import type { ShutdownContext } from '../ingress/ShutdownContext.js';
import type {
  AgentRunWorkClassification,
  AgentRunWorkClassifier
} from '../control/execution/AgentRunWorkClassifier.js';

type StartedWork = Extract<
  AgentRunWorkClassification,
  {
    readonly kind:
      | 'recovery_uncertain_effect'
      | 'recovery_uncertain_inference'
      | 'recovery_uncertain_delegated_inference'
  }
>;

type ActionableWork = Extract<
  AgentRunWorkClassification,
  {
    readonly kind:
      | 'dispatch_effect'
      | 'continue_effect_results'
      | 'continue_inbox'
      | 'continue_child_results'
      | 'dispatch_follow_up'
      | 'dispatch_delegated_initial'
      | 'fail_model_turn_budget'
      | 'fail_deadline_expired';
  }
>;

type TerminalizationWork = Extract<
  ActionableWork,
  { readonly kind: 'fail_model_turn_budget' | 'fail_deadline_expired' }
>;

export interface AgentRunWorkEffectDispatchRequest {
  readonly commandId: string;
  readonly runId: string;
  readonly effectId: string;
  readonly expectedVersion: number;
  readonly occurredAt: string;
}

/** Structural subset returned by AgentEffectDispatchService. */
export interface AgentRunWorkEffectDispatchReceipt {
  readonly run: {
    readonly runId: string;
    readonly version: number;
  };
  readonly effect: {
    readonly effectId: string;
    readonly state: { readonly status: string };
  };
  readonly status: string;
}

export interface AgentRunWorkEffectDispatcher {
  dispatch(
    request: AgentRunWorkEffectDispatchRequest,
    signal: AbortSignal
  ): Promise<AgentRunWorkEffectDispatchReceipt>;
}

/** Structural subset returned by AgentEffectContinuationController. */
export interface AgentRunWorkContinuationReceipt {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
  readonly replayed: boolean;
}

export interface AgentRunWorkContinuationOwner {
  continueSettledBatch(
    recovery: ReadyResumableAgentRunRecovery,
    signal: AbortSignal
  ): Promise<AgentRunWorkContinuationReceipt>;
}

export interface AgentRunWorkInboxContinuationOwner {
  continueInbox(
    recovery: ReadyResumableAgentRunRecovery,
    inputIds: readonly string[],
    signal: AbortSignal
  ): Promise<AgentRunWorkContinuationReceipt>;
}

export interface AgentRunWorkChildResultsContinuationOwner {
  continueChildResults(
    recovery: ReadyResumableAgentRunRecovery,
    signal: AbortSignal
  ): Promise<AgentRunWorkContinuationReceipt>;
}

export interface AgentRunWorkFollowUpRequest {
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly occurredAt: string;
}

interface AgentRunWorkFollowUpResultIdentity {
  readonly run: { readonly runId: string; readonly version: number };
  readonly turn: { readonly turnId: string };
  readonly attempt: { readonly attemptId: string };
}

export type AgentRunWorkFollowUpReceipt =
  | {
      readonly status: 'completed';
      readonly inferenceStatus: 'succeeded' | 'failed' | 'cancelled';
      readonly result: AgentRunWorkFollowUpResultIdentity;
    }
  | {
      readonly status: 'waiting_recovery';
      readonly reason:
        | 'inference_outcome_uncertain'
        | 'inference_already_crossed_boundary';
      readonly result?: AgentRunWorkFollowUpResultIdentity;
    };

export interface AgentRunWorkFollowUpOwner {
  dispatchOwned(
    request: AgentRunWorkFollowUpRequest,
    signal: AbortSignal
  ): Promise<AgentRunWorkFollowUpReceipt>;
}

export interface AgentRunWorkTerminalizationReceipt {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly checkpointVersion: number;
  readonly status: 'failed';
  readonly reason: 'model_turn_budget_exhausted' | 'deadline_expired';
  readonly errorCode:
    | 'agent_model_turn_budget_exhausted'
    | 'agent_run_deadline_expired';
  readonly replayed: boolean;
}

export interface AgentRunWorkTerminalizationOwner {
  terminalize(
    work: TerminalizationWork,
    signal: AbortSignal
  ): Promise<AgentRunWorkTerminalizationReceipt>;
}

/** Structural subset returned by AgentStartedWorkRecoveryCoordinator. */
export interface AgentRunStartedWorkRecoveryReceipt {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly subjectKind: 'effect' | 'inference';
  readonly subjectId: string;
  readonly recoveryDecisionId: string;
  readonly replayed: boolean;
}

export interface AgentRunStartedWorkRecoveryOwner {
  recover(
    work: StartedWork,
    signal: AbortSignal
  ): Promise<AgentRunStartedWorkRecoveryReceipt>;
}

export interface AgentRunWorkSchedulerClock {
  now(): string;
}

export interface AgentRunWorkAuthorityVerifier {
  /** Restores the exact historical model and immutable Tool Catalog authority. */
  assertRestorable(run: AgentRun, signal: AbortSignal): Promise<void>;
}

export interface AgentRunWorkSchedulerOptions {
  readonly intervalMs?: number;
  readonly pageSize?: number;
  readonly maxFixedPointRounds?: number;
  readonly clock?: AgentRunWorkSchedulerClock;
  /** Startup-only. Steady-state started work is always a health fault. */
  readonly startedWorkRecovery?: AgentRunStartedWorkRecoveryOwner;
  readonly authorityVerifier?: AgentRunWorkAuthorityVerifier;
  readonly delegatedInference?: AgentRunWorkFollowUpOwner;
  readonly childResultsContinuation?: AgentRunWorkChildResultsContinuationOwner;
}

export interface AgentRunWorkDrainResult {
  readonly rounds: number;
  readonly scannedRuns: number;
  readonly dispatchedEffects: number;
  readonly continuedBatches: number;
  readonly continuedInboxInputs: number;
  readonly continuedChildResults: number;
  readonly dispatchedFollowUps: number;
  readonly dispatchedDelegatedInitials: number;
  readonly terminalizedRuns: number;
}

export interface AgentRunWorkSchedulerFault {
  readonly runId: string;
  readonly expectedVersion: number;
  readonly kind:
    | 'blocked_recovery'
    | 'unsupported'
    | 'health_fault'
    | 'recovery_uncertain_effect'
    | 'recovery_uncertain_inference'
    | 'recovery_uncertain_delegated_inference';
  readonly reason: string;
}

export class AgentRunWorkSchedulerHealthError extends Error {
  public readonly code = 'AGENT_RUN_WORK_SCHEDULER_UNHEALTHY';

  public constructor(public readonly faults: readonly AgentRunWorkSchedulerFault[]) {
    super('One or more active Agent Runs have no safe production work owner.');
    this.name = 'AgentRunWorkSchedulerHealthError';
  }
}

export class AgentRunWorkSchedulerShutdownError extends Error {
  public readonly code = 'AGENT_RUN_WORK_SCHEDULER_SHUTDOWN_DEADLINE_EXCEEDED';

  public constructor() {
    super('Agent Run work scheduler did not join active work before shutdown deadline.');
    this.name = 'AgentRunWorkSchedulerShutdownError';
  }
}

interface ScannedRun {
  readonly recovery: RecoverableAgentRun;
  readonly work: AgentRunWorkClassification | null;
}

interface ScanRound {
  readonly runs: readonly ScannedRun[];
}

const SYSTEM_CLOCK: AgentRunWorkSchedulerClock = {
  now: () => new Date().toISOString()
};

/**
 * Durable steady-state owner for exactly one next action per active Run.
 *
 * The active-run recovery query is the queue. Every round traverses every
 * immutable pagination cursor before any action is performed, so a fault on a
 * later page prevents earlier-page external I/O. Work is serialized globally
 * for now; that is stronger than the required per-Run single-writer boundary.
 */
export class AgentRunWorkScheduler {
  private readonly intervalMs: number;
  private readonly pageSize: number;
  private readonly maxFixedPointRounds: number;
  private readonly clock: AgentRunWorkSchedulerClock;
  private readonly startedWorkRecovery: AgentRunStartedWorkRecoveryOwner | undefined;
  private readonly authorityVerifier: AgentRunWorkAuthorityVerifier | undefined;
  private readonly delegatedInference: AgentRunWorkFollowUpOwner | undefined;
  private readonly childResultsContinuation:
    | AgentRunWorkChildResultsContinuationOwner
    | undefined;
  private readonly abortController = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeDrain: Promise<AgentRunWorkDrainResult> | null = null;
  private startOperation: Promise<void> | null = null;
  private stopOperation: Promise<void> | null = null;
  private lifecycle: 'new' | 'starting' | 'running' | 'failed' | 'stopping' | 'stopped' = 'new';
  private dirty = false;
  private fault: unknown = null;

  public constructor(
    private readonly recoveries: AgentRunRecoveryQuery,
    private readonly classifier: Pick<AgentRunWorkClassifier, 'classify'>,
    private readonly effects: AgentRunWorkEffectDispatcher,
    private readonly continuations: AgentRunWorkContinuationOwner,
    private readonly inboxContinuations: AgentRunWorkInboxContinuationOwner,
    private readonly followUps: AgentRunWorkFollowUpOwner,
    private readonly terminalizations: AgentRunWorkTerminalizationOwner,
    options: AgentRunWorkSchedulerOptions = {}
  ) {
    this.intervalMs = boundedInteger(options.intervalMs ?? 250, 1, 2_147_483_647, 'intervalMs');
    this.pageSize = boundedInteger(options.pageSize ?? 100, 1, 1_000, 'pageSize');
    this.maxFixedPointRounds = boundedInteger(
      options.maxFixedPointRounds ?? 1_000,
      1,
      100_000,
      'maxFixedPointRounds'
    );
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.startedWorkRecovery = options.startedWorkRecovery;
    this.authorityVerifier = options.authorityVerifier;
    this.delegatedInference = options.delegatedInference;
    this.childResultsContinuation = options.childResultsContinuation;
  }

  /** Full pagination and abandoned-start recovery complete before readiness. */
  public start(): Promise<void> {
    if (this.startOperation !== null) return this.startOperation;
    if (this.lifecycle !== 'new') {
      return Promise.reject(new Error('Agent Run work scheduler cannot be restarted.'));
    }
    this.lifecycle = 'starting';
    this.startOperation = this.finishStart();
    return this.startOperation;
  }

  public assertHealthy(): void {
    if (this.fault !== null) throw this.fault;
    if (this.lifecycle !== 'running') {
      throw new Error('Agent Run work scheduler is not running.');
    }
  }

  public getFault(): unknown {
    return this.fault;
  }

  /** A wake during an active scan is retained by the dirty latch. */
  public wake(): void {
    if (this.lifecycle !== 'running' || this.fault !== null) return;
    this.dirty = true;
    if (this.activeDrain !== null) return;
    void this.beginDrain().catch(() => {
      // beginDrain records the first fault before exposing the rejection.
    });
  }

  public drainOnce(): Promise<AgentRunWorkDrainResult> {
    if (this.fault !== null) return Promise.reject(this.fault);
    if (this.lifecycle !== 'running') {
      return Promise.reject(new Error('Agent Run work scheduler is not running.'));
    }
    this.dirty = true;
    return this.activeDrain ?? this.beginDrain();
  }

  public shutdown(deadlineAt: string): Promise<void> {
    this.stopOperation ??= this.finishShutdown(deadlineAt);
    return this.stopOperation;
  }

  public prepareShutdown(context: ShutdownContext): Promise<void> {
    context.throwIfExpired('agent_run_work_scheduler_shutdown_deadline_exceeded');
    return this.shutdown(new Date(context.deadlineAt).toISOString());
  }

  private async finishStart(): Promise<void> {
    try {
      const startup = await this.recoverAbandonedStartedWork();
      await this.beginDrain(startup);
      this.abortController.signal.throwIfAborted();
      if (this.lifecycle !== 'starting') return;
      this.lifecycle = 'running';
      this.timer = setInterval(() => this.wake(), this.intervalMs);
      this.timer.unref?.();
    } catch (error) {
      if (this.lifecycle !== 'stopping' && this.lifecycle !== 'stopped') {
        this.recordFault(error);
      }
      throw error;
    }
  }

  /**
   * Startup is the only phase allowed to convert persisted started work to
   * uncertainty. It completes before normal dispatch begins.
   */
  private async recoverAbandonedStartedWork(): Promise<ScanRound> {
    let round = await this.scanAllRuns();
    for (let index = 0; index < this.maxFixedPointRounds; index += 1) {
      const faults = collectFaults(round, this.startedWorkRecovery !== undefined);
      if (faults.length > 0) throw new AgentRunWorkSchedulerHealthError(faults);
      await this.verifyAuthorities(round, false);
      const started = round.runs.flatMap((item) => (
        item.work?.kind === 'recovery_uncertain_effect'
          || item.work?.kind === 'recovery_uncertain_inference'
          || item.work?.kind === 'recovery_uncertain_delegated_inference'
          ? [item.work]
          : []
      ));
      if (started.length === 0) return round;
      const owner = this.startedWorkRecovery;
      if (owner === undefined) {
        throw new AgentRunWorkSchedulerHealthError(
          started.map(startedWorkFault)
        );
      }
      let staleSnapshot = false;
      for (const work of started) {
        this.abortController.signal.throwIfAborted();
        try {
          const receipt = await owner.recover(work, this.abortController.signal);
          assertStartedWorkRecoveryReceipt(receipt, work);
        } catch (error) {
          if (error instanceof AgentRunVersionConflictError) {
            staleSnapshot = true;
            break;
          }
          throw error;
        }
      }
      round = await this.scanAllRuns();
      if (staleSnapshot) continue;
    }
    throw new Error('Agent Run startup recovery did not reach a fixed point.');
  }

  private beginDrain(initial?: ScanRound): Promise<AgentRunWorkDrainResult> {
    if (this.activeDrain !== null) {
      this.dirty = true;
      return this.activeDrain;
    }
    const operation = this.drainToFixedPoint(initial).catch((error: unknown) => {
      if (this.lifecycle !== 'stopping' && this.lifecycle !== 'stopped') {
        this.recordFault(error);
      }
      throw error;
    }).finally(() => {
      if (this.activeDrain === operation) this.activeDrain = null;
      if (
        this.dirty
        && this.lifecycle === 'running'
        && this.fault === null
      ) {
        void this.beginDrain().catch(() => {
          // beginDrain records the first fault before exposing the rejection.
        });
      }
    });
    this.activeDrain = operation;
    return operation;
  }

  private async drainToFixedPoint(initial?: ScanRound): Promise<AgentRunWorkDrainResult> {
    const result = mutableDrainResult();
    let round = initial;
    for (let index = 0; index < this.maxFixedPointRounds; index += 1) {
      this.abortController.signal.throwIfAborted();
      this.dirty = false;
      const current = round ?? await this.scanAllRuns();
      round = undefined;
      result.rounds += 1;
      result.scannedRuns += current.runs.length;
      const faults = collectFaults(current, false);
      if (faults.length > 0) throw new AgentRunWorkSchedulerHealthError(faults);
      await this.verifyAuthorities(current, true);

      let progressed = false;
      for (const item of current.runs) {
        const work = item.work;
        if (work === null || !isActionable(work)) continue;
        this.abortController.signal.throwIfAborted();
        try {
          await this.perform(item.recovery, work, result);
          progressed = true;
        } catch (error) {
          if (isConcurrentSnapshotConflict(error)) {
            this.dirty = true;
            continue;
          }
          throw error;
        }
      }
      if (progressed) this.dirty = true;
      if (!this.dirty) return Object.freeze({ ...result });
    }
    throw new Error('Agent Run work scheduler did not reach a fixed point.');
  }

  private async perform(
    recovery: RecoverableAgentRun,
    work: ActionableWork,
    result: MutableAgentRunWorkDrainResult
  ): Promise<void> {
    switch (work.kind) {
      case 'dispatch_effect': {
        requireResumable(recovery, work);
        const commandId = await deriveStableAgentId(
          'run-work-effect-dispatch',
          work.runId,
          work.sourceTurnId,
          work.sourceAttemptId,
          work.sourceDirectiveDigest,
          work.effectId,
          work.inputDigest,
          String(work.effectAttempt)
        );
        const receipt = await this.effects.dispatch({
          commandId,
          runId: work.runId,
          effectId: work.effectId,
          expectedVersion: work.expectedVersion,
          occurredAt: this.now()
        }, this.abortController.signal);
        assertEffectReceipt(receipt, work);
        result.dispatchedEffects += 1;
        return;
      }
      case 'continue_effect_results': {
        const resumable = requireResumable(recovery, work);
        const receipt = await this.continuations.continueSettledBatch(
          resumable,
          this.abortController.signal
        );
        assertContinuationReceipt(receipt, work);
        result.continuedBatches += 1;
        return;
      }
      case 'continue_inbox': {
        const resumable = requireResumable(recovery, work);
        const receipt = await this.inboxContinuations.continueInbox(
          resumable,
          work.inputIds,
          this.abortController.signal
        );
        assertInboxContinuationReceipt(receipt, work);
        result.continuedInboxInputs += work.inputIds.length;
        return;
      }
      case 'dispatch_follow_up': {
        requireResumable(recovery, work);
        const receipt = await this.followUps.dispatchOwned({
          runId: work.runId,
          turnId: work.turnId,
          attemptId: work.attemptId,
          expectedVersion: work.expectedVersion,
          occurredAt: this.now()
        }, this.abortController.signal);
        assertFollowUpReceipt(receipt, work);
        result.dispatchedFollowUps += 1;
        return;
      }
      case 'continue_child_results': {
        const resumable = requireResumable(recovery, work);
        if (this.childResultsContinuation === undefined) {
          throw new Error('SubAgent results have no production continuation owner.');
        }
        const receipt = await this.childResultsContinuation.continueChildResults(
          resumable,
          this.abortController.signal
        );
        assertChildResultsContinuationReceipt(receipt, work);
        result.continuedChildResults += work.childRunIds.length;
        return;
      }
      case 'dispatch_delegated_initial': {
        requireResumable(recovery, work);
        if (this.delegatedInference === undefined) {
          throw new Error('Delegated inference has no production work owner.');
        }
        const receipt = await this.delegatedInference.dispatchOwned({
          runId: work.runId,
          turnId: work.turnId,
          attemptId: work.attemptId,
          expectedVersion: work.expectedVersion,
          occurredAt: this.now()
        }, this.abortController.signal);
        assertFollowUpReceipt(receipt, work);
        result.dispatchedDelegatedInitials += 1;
        return;
      }
      case 'fail_model_turn_budget':
      case 'fail_deadline_expired': {
        requireResumable(recovery, work);
        const receipt = await this.terminalizations.terminalize(
          work,
          this.abortController.signal
        );
        assertTerminalizationReceipt(receipt, work);
        result.terminalizedRuns += 1;
        return;
      }
    }
  }

  private async scanAllRuns(): Promise<ScanRound> {
    const runs: ScannedRun[] = [];
    const seenRuns = new Set<string>();
    const seenCursors = new Set<string>();
    let after: AgentRunRecoveryCursor | undefined;
    let previousCursor: AgentRunRecoveryCursor | undefined;
    do {
      this.abortController.signal.throwIfAborted();
      const page = await this.recoveries.listActiveRuns({
        limit: this.pageSize,
        ...(after === undefined ? {} : { after })
      });
      this.abortController.signal.throwIfAborted();
      if (page.items.length > this.pageSize) {
        throw new Error('Active Run recovery returned more rows than requested.');
      }
      for (const recovery of page.items) {
        if (seenRuns.has(recovery.run.runId)) {
          throw new Error('Active Run recovery repeated a Run within one pagination round.');
        }
        seenRuns.add(recovery.run.runId);
        runs.push({
          recovery,
          work: recovery.ready ? this.classifier.classify(recovery.run) : null
        });
      }
      after = page.nextCursor;
      if (after !== undefined) {
        const cursorKey = `${after.createdAt}\u0000${after.runId}`;
        if (
          seenCursors.has(cursorKey)
          || (
            previousCursor !== undefined
            && compareRecoveryCursor(after, previousCursor) <= 0
          )
        ) {
          throw new Error('Active Run recovery pagination cursor did not advance.');
        }
        seenCursors.add(cursorKey);
        previousCursor = after;
      }
    } while (after !== undefined);
    return { runs };
  }

  private async verifyAuthorities(
    round: ScanRound,
    actionableOnly: boolean
  ): Promise<void> {
    const verifier = this.authorityVerifier;
    if (verifier === undefined) return;
    for (const item of round.runs) {
      if (!item.recovery.ready || item.recovery.phase !== 'resumable') continue;
      if (actionableOnly && (item.work === null || !isActionable(item.work))) continue;
      this.abortController.signal.throwIfAborted();
      await verifier.assertRestorable(
        item.recovery.run,
        this.abortController.signal
      );
    }
  }

  private now(): string {
    const value = this.clock.now();
    if (!isCanonicalIsoTimestamp(value)) {
      throw new Error('Agent Run work scheduler clock is invalid.');
    }
    return value;
  }

  private recordFault(error: unknown): void {
    this.fault ??= error;
    this.stopTimer();
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(error);
    }
    if (this.lifecycle !== 'stopping' && this.lifecycle !== 'stopped') {
      this.lifecycle = 'failed';
    }
  }

  private async finishShutdown(deadlineAt: string): Promise<void> {
    if (!isCanonicalIsoTimestamp(deadlineAt)) {
      throw new Error('Agent Run work scheduler shutdown deadline must be canonical ISO time.');
    }
    this.stopTimer();
    if (this.lifecycle !== 'stopped') this.lifecycle = 'stopping';
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new Error('agent_run_work_scheduler_shutdown'));
    }
    const remainingMs = Date.parse(deadlineAt) - Date.now();
    if (remainingMs <= 0) throw new AgentRunWorkSchedulerShutdownError();

    const operations = uniquePromises([
      this.activeDrain,
      this.startOperation
    ]);
    if (operations.length > 0) {
      await joinBeforeDeadline(Promise.allSettled(operations), remainingMs);
    }
    this.lifecycle = 'stopped';
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

interface MutableAgentRunWorkDrainResult {
  rounds: number;
  scannedRuns: number;
  dispatchedEffects: number;
  continuedBatches: number;
  continuedInboxInputs: number;
  continuedChildResults: number;
  dispatchedFollowUps: number;
  dispatchedDelegatedInitials: number;
  terminalizedRuns: number;
}

function mutableDrainResult(): MutableAgentRunWorkDrainResult {
  return {
    rounds: 0,
    scannedRuns: 0,
    dispatchedEffects: 0,
    continuedBatches: 0,
    continuedInboxInputs: 0,
    continuedChildResults: 0,
    dispatchedFollowUps: 0,
    dispatchedDelegatedInitials: 0,
    terminalizedRuns: 0
  };
}

function collectFaults(
  round: ScanRound,
  startupRecoveryAvailable: boolean
): AgentRunWorkSchedulerFault[] {
  const faults: AgentRunWorkSchedulerFault[] = [];
  for (const item of round.runs) {
    if (!item.recovery.ready) {
      faults.push({
        runId: item.recovery.run.runId,
        expectedVersion: item.recovery.run.version,
        kind: 'blocked_recovery',
        reason: item.recovery.issues.join(',')
      });
      continue;
    }
    const work = item.work;
    if (work === null) {
      faults.push({
        runId: item.recovery.run.runId,
        expectedVersion: item.recovery.run.version,
        kind: 'health_fault',
        reason: 'ready_recovery_was_not_classified'
      });
      continue;
    }
    if (work.kind === 'unsupported' || work.kind === 'health_fault') {
      faults.push({
        runId: work.runId,
        expectedVersion: work.expectedVersion,
        kind: work.kind,
        reason: work.reason
      });
      continue;
    }
    if (
      (work.kind === 'recovery_uncertain_effect'
        || work.kind === 'recovery_uncertain_inference'
        || work.kind === 'recovery_uncertain_delegated_inference')
      && !startupRecoveryAvailable
    ) {
      faults.push(startedWorkFault(work));
    }
  }
  return faults;
}

function startedWorkFault(work: StartedWork): AgentRunWorkSchedulerFault {
  return {
    runId: work.runId,
    expectedVersion: work.expectedVersion,
    kind: work.kind,
    reason: work.kind === 'recovery_uncertain_effect'
      ? `${work.effectId}:${work.effectAttempt}`
      : `${work.turnId}:${work.attemptId}`
  };
}

function isActionable(work: AgentRunWorkClassification): work is ActionableWork {
  return work.kind === 'dispatch_effect'
    || work.kind === 'continue_effect_results'
    || work.kind === 'continue_inbox'
    || work.kind === 'continue_child_results'
    || work.kind === 'dispatch_follow_up'
    || work.kind === 'dispatch_delegated_initial'
    || work.kind === 'fail_model_turn_budget'
    || work.kind === 'fail_deadline_expired';
}

function assertInboxContinuationReceipt(
  receipt: AgentRunWorkContinuationReceipt,
  work: Extract<ActionableWork, { readonly kind: 'continue_inbox' }>
): void {
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== work.runId
    || receipt.runVersion <= work.expectedVersion
    || !nonEmpty(receipt.commandId)
    || !nonEmpty(receipt.turnId)
    || !nonEmpty(receipt.attemptId)
  ) throw new Error('Inbox continuation returned a contradictory work receipt.');
}

function assertChildResultsContinuationReceipt(
  receipt: AgentRunWorkContinuationReceipt,
  work: Extract<ActionableWork, { readonly kind: 'continue_child_results' }>
): void {
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== work.runId
    || receipt.runVersion <= work.expectedVersion
    || !nonEmpty(receipt.commandId)
    || !nonEmpty(receipt.turnId)
    || !nonEmpty(receipt.attemptId)
  ) throw new Error('SubAgent continuation returned a contradictory work receipt.');
}

function isConcurrentSnapshotConflict(error: unknown): boolean {
  return error instanceof AgentRunVersionConflictError;
}

function requireResumable(
  recovery: RecoverableAgentRun,
  work: ActionableWork
): ReadyResumableAgentRunRecovery {
  if (!recovery.ready || recovery.phase !== 'resumable') {
    throw new Error(
      `Agent Run work "${work.kind}" requires exact resumable recovery authority.`
    );
  }
  if (
    recovery.run.runId !== work.runId
    || recovery.run.version !== work.expectedVersion
  ) {
    throw new Error('Agent Run work recovery authority drifted before dispatch.');
  }
  return recovery;
}

function assertEffectReceipt(
  receipt: AgentRunWorkEffectDispatchReceipt,
  work: Extract<ActionableWork, { readonly kind: 'dispatch_effect' }>
): void {
  if (
    receipt.run.runId !== work.runId
    || receipt.run.version <= work.expectedVersion
    || receipt.effect.effectId !== work.effectId
    || receipt.status !== receipt.effect.state.status
    || !['succeeded', 'failed', 'cancelled', 'uncertain'].includes(receipt.status)
  ) {
    throw new Error('Effect dispatcher returned a contradictory work receipt.');
  }
}

function assertContinuationReceipt(
  receipt: AgentRunWorkContinuationReceipt,
  work: Extract<ActionableWork, { readonly kind: 'continue_effect_results' }>
): void {
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== work.runId
    || receipt.runVersion <= work.expectedVersion
    || !nonEmpty(receipt.commandId)
    || !nonEmpty(receipt.turnId)
    || !nonEmpty(receipt.attemptId)
  ) {
    throw new Error('Effect continuation returned a contradictory work receipt.');
  }
}

function assertFollowUpReceipt(
  receipt: AgentRunWorkFollowUpReceipt,
  work: Extract<
    ActionableWork,
    { readonly kind: 'dispatch_follow_up' | 'dispatch_delegated_initial' }
  >
): void {
  if (receipt.status === 'waiting_recovery') {
    if (receipt.result !== undefined) {
      assertFollowUpResultIdentity(receipt.result, work);
    }
    return;
  }
  assertFollowUpResultIdentity(receipt.result, work);
}

function assertFollowUpResultIdentity(
  result: AgentRunWorkFollowUpResultIdentity,
  work: Extract<
    ActionableWork,
    { readonly kind: 'dispatch_follow_up' | 'dispatch_delegated_initial' }
  >
): void {
  if (
    result.run.runId !== work.runId
    || result.run.version <= work.expectedVersion
    || result.turn.turnId !== work.turnId
    || result.attempt.attemptId !== work.attemptId
  ) {
    throw new Error('Follow-up inference returned a contradictory work receipt.');
  }
}

function assertTerminalizationReceipt(
  receipt: AgentRunWorkTerminalizationReceipt,
  work: TerminalizationWork
): void {
  const expected = work.kind === 'fail_deadline_expired'
    ? {
        reason: 'deadline_expired' as const,
        errorCode: 'agent_run_deadline_expired' as const
      }
    : {
        reason: 'model_turn_budget_exhausted' as const,
        errorCode: 'agent_model_turn_budget_exhausted' as const
      };
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== work.runId
    || receipt.runVersion !== work.expectedVersion + 1
    || receipt.checkpointVersion !== work.checkpointVersion + 1
    || receipt.status !== 'failed'
    || receipt.reason !== expected.reason
    || receipt.errorCode !== expected.errorCode
    || !nonEmpty(receipt.commandId)
  ) {
    throw new Error('Run terminalization returned a contradictory work receipt.');
  }
}

function assertStartedWorkRecoveryReceipt(
  receipt: AgentRunStartedWorkRecoveryReceipt,
  work: StartedWork
): void {
  const subjectKind = work.kind === 'recovery_uncertain_effect' ? 'effect' : 'inference';
  const subjectId = work.kind === 'recovery_uncertain_effect'
    ? work.effectId
    : work.attemptId;
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== work.runId
    || receipt.runVersion <= work.expectedVersion
    || receipt.subjectKind !== subjectKind
    || receipt.subjectId !== subjectId
    || !nonEmpty(receipt.commandId)
    || !nonEmpty(receipt.recoveryDecisionId)
  ) {
    throw new Error('Started-work recovery returned a contradictory receipt.');
  }
}

function nonEmpty(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} is outside its bounded range.`);
  }
  return value;
}

function compareRecoveryCursor(
  left: AgentRunRecoveryCursor,
  right: AgentRunRecoveryCursor
): number {
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  return createdAt === 0 ? left.runId.localeCompare(right.runId) : createdAt;
}

function uniquePromises(
  values: readonly (Promise<unknown> | null)[]
): Promise<unknown>[] {
  const unique: Promise<unknown>[] = [];
  for (const value of values) {
    if (value !== null && !unique.includes(value)) unique.push(value);
  }
  return unique;
}

function joinBeforeDeadline(
  operation: Promise<unknown>,
  remainingMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new AgentRunWorkSchedulerShutdownError());
    }, Math.min(remainingMs, 2_147_483_647));
    timeout.unref?.();
    operation.then(
      () => { clearTimeout(timeout); resolve(); },
      () => { clearTimeout(timeout); resolve(); }
    );
  });
}
