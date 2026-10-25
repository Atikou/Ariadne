import {
  AgentInferenceDispatchRecoveryRequiredError,
  AgentRunInvariantError,
  assertValidAgentRun,
  assertAgentRunInboxOnlyMutation,
  deriveStableAgentId,
  type AgentInferenceAttempt,
  type AgentInferenceDispatchService,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';

import type {
  AgentRunExecutionIntent
} from '../ports/AgentRunExecutionStarter.js';

export interface DispatchClaimedAgentRunExecutionRequest {
  readonly intent: AgentRunExecutionIntent;
  readonly intentDigest: string;
  readonly admissionCommandId: string;
  readonly dispatchAttemptId: string;
  readonly startedAt: string;
}

export interface AgentRunExecutionDispatchReceiptV1 {
  readonly receiptVersion: 1;
  readonly executionIntentId: string;
  readonly dispatchAttemptId: string;
  readonly externalDispatchId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
  readonly resultCommandId: string;
  readonly inferenceStatus: 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
  readonly recoveryDecisionId?: string;
  readonly completedAt: string;
}

export type AgentRunExecutionDispatchOutcome =
  | {
      /** The dispatcher has joined; authority proves no Provider boundary was crossed. */
      readonly status: 'not_started';
      readonly evidence: AgentRunExecutionNotStartedEvidence;
    }
  | {
      readonly status: 'completed';
      readonly outcome: 'completed' | 'failed' | 'cancelled';
      readonly receipt: AgentRunExecutionDispatchReceiptV1;
    }
  | {
      readonly status: 'recovery_required';
      readonly reason: 'inference_outcome_uncertain' | 'inference_already_crossed_boundary';
      /** Present only when this process durably recorded the uncertain outcome. */
      readonly receipt?: AgentRunExecutionDispatchReceiptV1;
    };

export interface AgentRunExecutionNotStartedEvidence {
  readonly executionIntentId: string;
  readonly dispatchAttemptId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
}

export interface AgentRunExecutionDispatcher {
  dispatchClaimedExecution(
    request: DispatchClaimedAgentRunExecutionRequest,
    signal: AbortSignal
  ): Promise<AgentRunExecutionDispatchOutcome>;
}

export interface AgentInferenceDispatcher {
  dispatch: AgentInferenceDispatchService['dispatch'];
}

/** Binds one durable execution intent to the already-admitted initial Turn. */
export class AgentRunExecutionDispatchController
implements AgentRunExecutionDispatcher {
  public constructor(
    private readonly runs: AgentRunUnitOfWork,
    private readonly inference: AgentInferenceDispatcher
  ) {}

  public async dispatchClaimedExecution(
    request: DispatchClaimedAgentRunExecutionRequest,
    signal: AbortSignal
  ): Promise<AgentRunExecutionDispatchOutcome> {
    const run = await this.runs.transaction(async (transaction) => {
      const current = await transaction.loadRun(request.intent.runId);
      if (current !== null && current.version !== request.intent.admittedRunVersion) {
        const admitted = await transaction.loadRunVersion?.(request.intent.runId, request.intent.admittedRunVersion);
        if (admitted === null || admitted === undefined) throw invariant('Execution intent has no exact admitted Run version.');
        assertAgentRunInboxOnlyMutation(admitted, current);
      }
      return current;
    });
    if (run === null) throw invariant('The execution intent Run does not exist.');
    assertValidAgentRun(run);
    const turn = run.turns[0];
    const attempt = turn?.attempts[0];
    if (
      run.runId !== request.intent.runId
      || run.version < request.intent.admittedRunVersion
      || run.binding.sessionId !== request.intent.sessionId
      || run.binding.workspace.workspaceId !== request.intent.workspaceId
      || run.binding.objectiveRef.kind !== 'conversation_message'
      || run.binding.objectiveRef.messageId !== request.intent.objectiveMessageId
      || run.binding.objectiveRef.messageVersion !== request.intent.objectiveMessageVersion
      || run.binding.objectiveRef.contentDigest !== request.intent.objectiveDigest
      || run.turns.length !== 1
      || turn === undefined
      || turn.attempts.length !== 1
      || attempt === undefined
      || attempt.state.status !== 'intended'
    ) {
      throw invariant('Execution intent does not match one exact admitted v3 Turn.');
    }
    const commandId = await deriveStableAgentId(
      'execution-inference-dispatch',
      request.intent.executionIntentId,
      request.dispatchAttemptId,
      request.intentDigest,
      request.admissionCommandId
    );
    let result;
    try {
      result = await this.inference.dispatch({
        commandId,
        runId: run.runId,
        turnId: turn.turnId,
        attemptId: attempt.attemptId,
        expectedVersion: run.version,
        occurredAt: request.startedAt
      }, signal);
    } catch (error) {
      if (error instanceof AgentInferenceDispatchRecoveryRequiredError) {
        return { status: 'recovery_required', reason: 'inference_already_crossed_boundary' };
      }
      if (signal.aborted) {
        // An Abort signal alone proves nothing. Only after joining the dispatch
        // and rereading exact authority may an unstarted Attempt be cancelled.
        const current = await this.runs.transaction(transaction => transaction.loadRun(run.runId));
        if (current !== null) {
          assertAgentRunInboxOnlyMutation(run, current);
          const currentAttempt = current.turns.find(candidate => candidate.turnId === turn.turnId)
            ?.attempts.find(candidate => candidate.attemptId === attempt.attemptId);
          if (current.state.status === 'running' && currentAttempt?.state.status === 'intended') {
            return { status: 'not_started', evidence: {
              executionIntentId: request.intent.executionIntentId,
              dispatchAttemptId: request.dispatchAttemptId,
              runId: current.runId, runVersion: current.version,
              turnId: turn.turnId, attemptId: attempt.attemptId
            } };
          }
        }
      }
      throw error;
    }
    if (!['succeeded', 'failed', 'cancelled', 'uncertain'].includes(result.status)) {
      throw invariant('Inference dispatch returned a non-terminal result without recovery evidence.');
    }
    assertValidAgentRun(result.run);
    const committedTurn = result.run.turns.find(
      (candidate) => candidate.turnId === turn.turnId
    );
    const committedAttempt = committedTurn?.attempts.find(
      (candidate) => candidate.attemptId === attempt.attemptId
    );
    if (
      result.run.runId !== run.runId
      || result.run.version <= run.version
      || result.turn.turnId !== turn.turnId
      || result.turn.runId !== run.runId
      || result.attempt.attemptId !== attempt.attemptId
      || result.attempt.turnId !== turn.turnId
      || result.attempt.runId !== run.runId
      || committedTurn === undefined
      || committedAttempt === undefined
      || committedAttempt.state.status !== result.status
      || result.attempt.state.status !== result.status
      || (
        result.command !== null
        && (
          result.command.run.runId !== result.run.runId
          || result.command.run.version !== result.run.version
        )
      )
    ) {
      throw invariant('Inference dispatcher returned a result outside the exact admitted Turn.');
    }
    const completedAt = settledTimestamp(result.attempt);
    const resultCommandId = await deriveStableAgentId(
      'inference-result',
      commandId,
      run.runId,
      turn.turnId,
      attempt.attemptId
    );
    if (result.command !== null && result.command.commandId !== resultCommandId) {
      throw invariant('Inference dispatch receipt has a different result command identity.');
    }
    const externalDispatchId = await deriveStableAgentId(
      'execution-external-dispatch',
      request.intent.executionIntentId,
      request.dispatchAttemptId,
      attempt.attemptId,
      attempt.providerIdempotencyKey
    );
    const inferenceStatus = result.status as
      | 'succeeded'
      | 'failed'
      | 'cancelled'
      | 'uncertain';
    const receipt: AgentRunExecutionDispatchReceiptV1 = {
      receiptVersion: 1,
      executionIntentId: request.intent.executionIntentId,
      dispatchAttemptId: request.dispatchAttemptId,
      externalDispatchId,
      runId: result.run.runId,
      runVersion: result.run.version,
      turnId: result.turn.turnId,
      attemptId: result.attempt.attemptId,
      resultCommandId,
      inferenceStatus,
      ...(result.attempt.state.status === 'uncertain'
        ? { recoveryDecisionId: result.attempt.state.recovery.decisionId }
        : {}),
      completedAt
    };
    if (inferenceStatus === 'uncertain') {
      return {
        status: 'recovery_required',
        reason: 'inference_outcome_uncertain',
        receipt
      };
    }
    return {
      status: 'completed',
      outcome: inferenceStatus === 'succeeded' ? 'completed' : inferenceStatus,
      receipt
    };
  }
}

function settledTimestamp(attempt: AgentInferenceAttempt): string {
  if (attempt.state.status === 'succeeded' || attempt.state.status === 'failed') {
    return attempt.state.finishedAt;
  }
  if (attempt.state.status === 'cancelled') return attempt.state.cancelledAt;
  if (attempt.state.status === 'uncertain') return attempt.state.observedAt;
  throw invariant('Inference receipt requires a terminal Attempt timestamp.');
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
