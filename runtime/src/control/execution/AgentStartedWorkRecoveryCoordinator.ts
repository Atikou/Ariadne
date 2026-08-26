import {
  AgentRunCommandService,
  AgentRunInvariantError,
  AgentRunVersionConflictError,
  assertValidAgentRun,
  deriveStableAgentId,
  type AgentEffectResult,
  type AgentInferenceAttemptResult,
  type AgentRun,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';

import { V3AgentEffectDispatchCheckpointFactory } from
  './AgentEffectDispatchCheckpointFactory.js';
import { V3AgentInferenceDispatchCheckpointFactory } from
  './AgentInferenceDispatchCheckpointFactory.js';
import type { AgentRunWorkClassification } from './AgentRunWorkClassifier.js';

type StartedWork = Extract<
  AgentRunWorkClassification,
  {
    readonly kind:
      | 'recovery_uncertain_effect'
      | 'recovery_uncertain_inference'
      | 'recovery_uncertain_delegated_inference'
  }
>;

export interface AgentStartedWorkRecoveryReceiptV1 {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly subjectKind: 'effect' | 'inference';
  readonly subjectId: string;
  readonly turnId?: string;
  readonly recoveryDecisionId: string;
  readonly completedAt: string;
  readonly replayed: boolean;
}

export interface RecoverStartedInitialInferenceRequest {
  readonly runId: string;
  readonly expectedVersion: number;
  readonly sessionId: string;
  readonly objectiveMessageId: string;
  readonly objectiveMessageVersion: number;
  readonly objectiveDigest: string;
}

/**
 * Startup-only owner for work that crossed its durable start fence before the
 * process stopped. It never retries an external call; it records uncertainty
 * and hands control to the explicit recovery-decision path.
 */
export class AgentStartedWorkRecoveryCoordinator {
  private readonly commands: AgentRunCommandService;
  private readonly effectCheckpoints = new V3AgentEffectDispatchCheckpointFactory();
  private readonly inferenceCheckpoints = new V3AgentInferenceDispatchCheckpointFactory();

  public constructor(private readonly runs: AgentRunUnitOfWork) {
    this.commands = new AgentRunCommandService(runs);
  }

  public async recover(
    work: StartedWork,
    signal: AbortSignal
  ): Promise<AgentStartedWorkRecoveryReceiptV1> {
    signal.throwIfAborted();
    const run = await this.runs.transaction((transaction) => (
      transaction.loadRun(work.runId)
    ));
    if (run === null) {
      throw new AgentRunVersionConflictError(
        work.runId,
        work.expectedVersion,
        null
      );
    }
    if (run.version !== work.expectedVersion) {
      throw new AgentRunVersionConflictError(
        run.runId,
        work.expectedVersion,
        run.version
      );
    }
    if (run.state.status !== 'running') {
      throw invariant('Started-work recovery requires the exact running Run version.');
    }
    assertValidAgentRun(run);
    return work.kind === 'recovery_uncertain_effect'
      ? this.recoverEffect(run, work, signal)
      : this.recoverInference(run, work, signal);
  }

  public async recoverInitialInference(
    request: RecoverStartedInitialInferenceRequest,
    signal: AbortSignal
  ): Promise<AgentStartedWorkRecoveryReceiptV1 & {
    readonly subjectKind: 'inference';
    readonly turnId: string;
  }> {
    signal.throwIfAborted();
    const run = await this.runs.transaction((transaction) => (
      transaction.loadRun(request.runId)
    ));
    if (run === null) {
      throw new AgentRunVersionConflictError(
        request.runId,
        request.expectedVersion,
        null
      );
    }
    if (run.version !== request.expectedVersion) {
      throw new AgentRunVersionConflictError(
        run.runId,
        request.expectedVersion,
        run.version
      );
    }
    if (run.state.status !== 'running') {
      throw invariant('Started initial inference recovery requires a running Run.');
    }
    assertValidAgentRun(run);
    const turn = run.turns[0];
    const attempt = turn?.attempts[0];
    if (
      turn === undefined
      || run.binding.sessionId !== request.sessionId
      || run.binding.objectiveRef.kind !== 'conversation_message'
      || run.binding.objectiveRef.messageId !== request.objectiveMessageId
      || run.binding.objectiveRef.messageVersion !== request.objectiveMessageVersion
      || run.binding.objectiveRef.contentDigest !== request.objectiveDigest
      || run.turns.length !== 1
      || turn.intention.cause.kind !== 'conversation_objective'
      || turn.attempts.length !== 1
      || attempt?.state.status !== 'started'
    ) {
      throw invariant('Started initial inference recovery identity drifted from the aggregate.');
    }
    return this.commitInferenceRecovery(run, turn, attempt, signal);
  }

  private async recoverEffect(
    run: AgentRun,
    work: Extract<StartedWork, { readonly kind: 'recovery_uncertain_effect' }>,
    signal: AbortSignal
  ): Promise<AgentStartedWorkRecoveryReceiptV1> {
    const effect = run.effects.find((candidate) => candidate.effectId === work.effectId);
    if (
      effect?.state.status !== 'started'
      || effect.toolCallId !== work.toolCallId
      || effect.state.attempt !== work.effectAttempt
      || (effect.origin?.turnId ?? null) !== work.sourceTurnId
      || (effect.origin?.attemptId ?? null) !== work.sourceAttemptId
      || (effect.origin?.directiveDigest ?? null) !== work.sourceDirectiveDigest
    ) {
      throw invariant('Started Effect recovery identity drifted from the aggregate.');
    }
    const identity = [
      run.runId,
      effect.effectId,
      effect.toolCallId,
      effect.inputDigest,
      String(effect.state.attempt)
    ] as const;
    const [commandId, recoveryDecisionId] = await Promise.all([
      deriveStableAgentId('startup-effect-uncertain', ...identity),
      deriveStableAgentId('startup-effect-recovery', ...identity)
    ]);
    const result: AgentEffectResult = {
      status: 'uncertain',
      reason: 'effect_started_without_durable_outcome_after_restart',
      recoveryDecisionId,
      allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
    };
    const occurredAt = run.updatedAt;
    const checkpoint = this.effectCheckpoints.create({
      run,
      effect,
      checkpointVersion: run.state.checkpointVersion + 1,
      phase: 'effect_result',
      occurredAt
    });
    signal.throwIfAborted();
    const committed = await this.commands.execute({
      kind: 'run.record_effect_result',
      commandId,
      runId: run.runId,
      expectedVersion: run.version,
      occurredAt,
      effectId: effect.effectId,
      result
    }, {
      checkpoint,
      turnInputPayloads: [],
      effectPayloads: []
    });
    if (
      committed.run.state.status !== 'recovering'
      || committed.run.state.reason !== 'uncertain_effect'
      || committed.run.state.decision.decisionId !== recoveryDecisionId
    ) {
      throw invariant('Started Effect recovery returned a contradictory receipt.');
    }
    return {
      receiptVersion: 1,
      commandId,
      runId: committed.run.runId,
      runVersion: committed.run.version,
      subjectKind: 'effect',
      subjectId: effect.effectId,
      recoveryDecisionId,
      completedAt: committed.run.updatedAt,
      replayed: committed.replayed
    };
  }

  private async recoverInference(
    run: AgentRun,
    work: Extract<
      StartedWork,
      {
        readonly kind:
          | 'recovery_uncertain_inference'
          | 'recovery_uncertain_delegated_inference'
      }
    >,
    signal: AbortSignal
  ): Promise<AgentStartedWorkRecoveryReceiptV1> {
    const turn = run.turns.find((candidate) => candidate.turnId === work.turnId);
    const attempt = turn?.attempts.find(
      (candidate) => candidate.attemptId === work.attemptId
    );
    const cause = turn?.intention.cause;
    const exactContinuation = work.kind === 'recovery_uncertain_inference'
      && (
        cause?.kind === 'effect_results'
        || cause?.kind === 'inbox_inputs'
        || cause?.kind === 'child_results'
      )
      && cause.sourceTurnId === work.sourceTurnId
      && cause.sourceAttemptId === work.sourceAttemptId
      && cause.sourceDirectiveDigest === work.sourceDirectiveDigest;
    const exactDelegation = work.kind === 'recovery_uncertain_delegated_inference'
      && cause?.kind === 'delegation_objective'
      && cause.parentRunId === work.parentRunId
      && cause.delegationId === work.delegationId
      && cause.objectiveDigest === work.objectiveDigest;
    if (
      turn === undefined
      || attempt?.state.status !== 'started'
      || turn.intention.inputDigest !== work.inputDigest
      || (!exactContinuation && !exactDelegation)
    ) {
      throw invariant('Started inference recovery identity drifted from the aggregate.');
    }
    return this.commitInferenceRecovery(run, turn, attempt, signal);
  }

  private async commitInferenceRecovery(
    run: AgentRun,
    turn: AgentRun['turns'][number],
    attempt: AgentRun['turns'][number]['attempts'][number],
    signal: AbortSignal
  ): Promise<AgentStartedWorkRecoveryReceiptV1 & {
    readonly subjectKind: 'inference';
    readonly turnId: string;
  }> {
    if (attempt.state.status !== 'started') {
      throw invariant('Inference recovery requires one started Attempt.');
    }
    const identity = [
      run.runId,
      turn.turnId,
      attempt.attemptId,
      turn.intention.inputDigest,
      attempt.providerIdempotencyKey
    ] as const;
    const [commandId, recoveryDecisionId] = await Promise.all([
      deriveStableAgentId('startup-inference-uncertain', ...identity),
      deriveStableAgentId('startup-inference-recovery', ...identity)
    ]);
    const result: AgentInferenceAttemptResult = {
      status: 'uncertain',
      reason: 'inference_started_without_durable_outcome_after_restart',
      recoveryDecisionId,
      allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
    };
    const occurredAt = run.updatedAt;
    const checkpoint = this.inferenceCheckpoints.create({
      run,
      turn,
      attempt,
      checkpointVersion: run.state.checkpointVersion + 1,
      phase: 'inference_result',
      occurredAt,
      result
    });
    signal.throwIfAborted();
    const committed = await this.commands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId,
      runId: run.runId,
      expectedVersion: run.version,
      occurredAt,
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      result
    }, {
      checkpoint,
      turnInputPayloads: [],
      effectPayloads: []
    });
    if (
      committed.run.state.status !== 'recovering'
      || committed.run.state.reason !== 'uncertain_inference'
      || committed.run.state.turnId !== turn.turnId
      || committed.run.state.attemptId !== attempt.attemptId
    ) {
      throw invariant('Started inference recovery returned a contradictory receipt.');
    }
    return {
      receiptVersion: 1,
      commandId,
      runId: committed.run.runId,
      runVersion: committed.run.version,
      subjectKind: 'inference',
      subjectId: attempt.attemptId,
      turnId: turn.turnId,
      recoveryDecisionId,
      completedAt: committed.run.updatedAt,
      replayed: committed.replayed
    };
  }
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
