import {
  AgentRunVersionConflictError,
  deriveStableAgentId,
  isCanonicalIsoTimestamp,
  type AgentRunRecoveryCursor,
  type AgentRunRecoveryQuery,
  type RecoverableAgentRun
} from '@ariadne/agent-core';
import type { ShutdownContext } from '../ingress/ShutdownContext.js';
import type { AgentRunWorkClassifier } from '../control/execution/AgentRunWorkClassifier.js';
import type { AgentRunRetiredToolCatalogTerminalizationOwner } from '../control/ports/AgentRunAuthorityRetirement.js';
import {
  type ActionableWork,
  type ActiveAgentTurnInterruptionRecovery,
  type ActiveAgentTurnInterruptionRequest,
  type ActiveAgentTurnInterruptionResult,
  type ActiveInferenceDispatch,
  type AgentRunStartedWorkRecoveryOwner,
  type AgentRunWorkAuthorityAssessment,
  type AgentRunWorkAuthorityVerifier,
  type AgentRunWorkChildResultsContinuationOwner,
  type AgentRunWorkContinuationOwner,
  type AgentRunWorkDrainResult,
  type AgentRunWorkEffectDispatcher,
  type AgentRunWorkFollowUpOwner,
  type AgentRunWorkFollowUpReceipt,
  type AgentRunWorkInboxContinuationOwner,
  type AgentRunWorkSchedulerClock,
  AgentRunWorkSchedulerHealthError,
  type AgentRunWorkSchedulerOptions,
  AgentRunWorkSchedulerShutdownError,
  type AgentRunWorkTerminalizationOwner,
  type MutableAgentRunWorkDrainResult,
  type PendingActiveInterruption,
  type ScanRound,
  type ScannedRun
} from './AgentRunWorkSchedulerContracts.js';
import {
  assertChildResultsContinuationReceipt,
  assertContinuationReceipt,
  assertEffectReceipt,
  assertFollowUpReceipt,
  assertInboxContinuationReceipt,
  assertRetiredToolCatalogTerminalizationReceipt,
  assertStartedWorkRecoveryReceipt,
  assertTerminalizationReceipt,
  boundedInteger,
  exactUncertainInferenceRecovery,
  isConcurrentSnapshotConflict,
  requireResumable
} from './AgentRunWorkReceiptValidation.js';
import {
  childFirstRetirementOrder,
  collectFaults,
  compareRecoveryCursor,
  isActionable,
  mutableDrainResult,
  startedWorkFault
} from './AgentRunWorkRecoveryScan.js';
import { joinBeforeDeadline, uniquePromises } from './AgentRunWorkShutdown.js';
export type { AgentRunWorkEffectDispatchRequest } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkEffectDispatchReceipt } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkEffectDispatcher } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkContinuationReceipt } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkContinuationOwner } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkInboxContinuationOwner } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkChildResultsContinuationOwner } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkFollowUpRequest } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkFollowUpReceipt } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkFollowUpOwner } from './AgentRunWorkSchedulerContracts.js';
export type { ActiveAgentTurnInterruptionRecovery } from './AgentRunWorkSchedulerContracts.js';
export type { ActiveAgentTurnInterruptionRequest } from './AgentRunWorkSchedulerContracts.js';
export type { ActiveAgentTurnInterruptionResult } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkTerminalizationReceipt } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkTerminalizationOwner } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunStartedWorkRecoveryReceipt } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunStartedWorkRecoveryOwner } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkSchedulerClock } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkAuthorityVerifier } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkAuthorityAssessment } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkSchedulerOptions } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkDrainResult } from './AgentRunWorkSchedulerContracts.js';
export type { AgentRunWorkSchedulerFault } from './AgentRunWorkSchedulerContracts.js';
export { AgentRunWorkSchedulerHealthError } from './AgentRunWorkSchedulerContracts.js';
export { AgentRunWorkSchedulerShutdownError } from './AgentRunWorkSchedulerContracts.js';

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
  private readonly retiredToolCatalogTerminalizations:
    | AgentRunRetiredToolCatalogTerminalizationOwner
    | undefined;
  private readonly delegatedInference: AgentRunWorkFollowUpOwner | undefined;
  private readonly delegatedFollowUps: AgentRunWorkFollowUpOwner | undefined;
  private readonly childResultsContinuation:
    | AgentRunWorkChildResultsContinuationOwner
    | undefined;
  private readonly abortController = new AbortController();
  private readonly activeInferenceByRun = new Map<string, ActiveInferenceDispatch>();
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
    this.retiredToolCatalogTerminalizations =
      options.retiredToolCatalogTerminalizations;
    this.delegatedInference = options.delegatedInference;
    this.delegatedFollowUps = options.delegatedFollowUps;
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

  /** Interrupts only the exact inference currently owned by this scheduler. */
  public interruptActiveTurn(
    request: ActiveAgentTurnInterruptionRequest
  ): Promise<ActiveAgentTurnInterruptionResult> {
    const active = this.activeInferenceByRun.get(request.runId);
    if (
      active === undefined
      || (
        request.expectedVersion !== active.expectedVersion
        && request.expectedVersion !== active.expectedVersion + 1
      )
    ) return Promise.resolve({ status: 'not_active' });
    if (active.interruption !== null) {
      if (active.interruption.request.commandId !== request.commandId) {
        return Promise.reject(new Error(
          'A different interruption already owns this active Agent inference.'
        ));
      }
      return active.interruption.result;
    }
    let resolve!: (result: ActiveAgentTurnInterruptionResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<ActiveAgentTurnInterruptionResult>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    active.interruption = { request, result, resolve, reject };
    if (!active.controller.signal.aborted) {
      active.controller.abort(new Error('agent_subagent_turn_interruption_requested'));
    }
    return result;
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
      const retiredCatalogRuns = await this.assessAuthorities(round, false);
      const retiredRunIds = new Set(
        retiredCatalogRuns.map((item) => item.recovery.run.runId)
      );
      const faults = collectFaults(
        round,
        this.startedWorkRecovery !== undefined,
        retiredRunIds
      );
      if (faults.length > 0) throw new AgentRunWorkSchedulerHealthError(faults);
      const started = round.runs.flatMap((item) => (
        item.work?.kind === 'recovery_uncertain_effect'
          || item.work?.kind === 'recovery_uncertain_inference'
          || item.work?.kind === 'recovery_uncertain_delegated_inference'
          ? [item.work]
          : []
      ));
      if (started.length > 0) {
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
        continue;
      }
      if (retiredCatalogRuns.length === 0) return round;
      await this.terminalizeRetiredCatalogRuns(retiredCatalogRuns);
      round = await this.scanAllRuns();
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
      const retiredCatalogRuns = await this.assessAuthorities(current, true);
      if (retiredCatalogRuns.length > 0) {
        result.terminalizedRuns += await this.terminalizeRetiredCatalogRuns(
          retiredCatalogRuns
        );
        this.dirty = true;
        continue;
      }

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
        const isDelegatedChild = recovery.run.binding.objectiveRef.kind === 'parent_delegation';
        const owner = isDelegatedChild ? this.delegatedFollowUps : this.followUps;
        if (owner === undefined) {
          throw new Error('Delegated SubAgent follow-up has no execution provider owner.');
        }
        const receipt = await this.dispatchOwnedInference(owner, work);
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
        const receipt = await this.dispatchOwnedInference(this.delegatedInference, work);
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

  private async dispatchOwnedInference(
    owner: AgentRunWorkFollowUpOwner,
    work: Extract<
      ActionableWork,
      { readonly kind: 'dispatch_follow_up' | 'dispatch_delegated_initial' }
    >
  ): Promise<AgentRunWorkFollowUpReceipt> {
    if (this.activeInferenceByRun.has(work.runId)) {
      throw new Error('An Agent Run already has an active work-scheduler inference.');
    }
    const controller = new AbortController();
    const active: ActiveInferenceDispatch = {
      expectedVersion: work.expectedVersion,
      turnId: work.turnId,
      attemptId: work.attemptId,
      controller,
      interruption: null
    };
    this.activeInferenceByRun.set(work.runId, active);
    try {
      const receipt = await owner.dispatchOwned({
        runId: work.runId,
        turnId: work.turnId,
        attemptId: work.attemptId,
        expectedVersion: work.expectedVersion,
        occurredAt: this.now()
      }, AbortSignal.any([this.abortController.signal, controller.signal]));
      const interruption = active.interruption;
      if (interruption === null) return receipt;
      const uncertain = exactUncertainInferenceRecovery(receipt, work);
      if (uncertain === null) {
        interruption.resolve({ status: 'already_settled' });
        return receipt;
      }
      try {
        const finalized = await interruption.request.finalize(uncertain);
        if (
          finalized.runId !== uncertain.runId
          || finalized.runVersion <= uncertain.runVersion
        ) throw new Error('Agent Turn interruption finalizer returned contradictory evidence.');
        interruption.resolve({
          status: 'interrupted',
          ...uncertain,
          runVersion: finalized.runVersion
        });
      } catch (error) {
        interruption.reject(error);
        throw error;
      }
      return receipt;
    } catch (error) {
      active.interruption?.reject(error);
      throw error;
    } finally {
      this.activeInferenceByRun.delete(work.runId);
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

  private async assessAuthorities(
    round: ScanRound,
    actionableOnly: boolean
  ): Promise<readonly ScannedRun[]> {
    const verifier = this.authorityVerifier;
    if (verifier === undefined) return [];
    const retiredCatalogRuns: ScannedRun[] = [];
    for (const item of round.runs) {
      if (!item.recovery.ready || item.recovery.phase !== 'resumable') continue;
      if (actionableOnly && (item.work === null || !isActionable(item.work))) continue;
      this.abortController.signal.throwIfAborted();
      const assessment = await verifier.assessRestorability(
        item.recovery.run,
        this.abortController.signal
      );
      if (assessment.status === 'retired_tool_catalog') {
        retiredCatalogRuns.push(item);
      } else if (assessment.status !== 'restorable') {
        throw new Error('Agent Run authority verifier returned an invalid assessment.');
      }
    }
    return retiredCatalogRuns;
  }

  private async terminalizeRetiredCatalogRuns(
    items: readonly ScannedRun[]
  ): Promise<number> {
    const owner = this.retiredToolCatalogTerminalizations;
    if (owner === undefined) {
      throw new Error(
        'Retired Tool Catalog Runs have no durable terminalization owner.'
      );
    }
    let terminalized = 0;
    for (const item of childFirstRetirementOrder(items)) {
      this.abortController.signal.throwIfAborted();
      try {
        const receipt = await owner.terminalize(
          item.recovery.run,
          this.abortController.signal
        );
        assertRetiredToolCatalogTerminalizationReceipt(
          receipt,
          item.recovery.run
        );
        terminalized += 1;
      } catch (error) {
        if (error instanceof AgentRunVersionConflictError) return terminalized;
        throw error;
      }
    }
    return terminalized;
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
