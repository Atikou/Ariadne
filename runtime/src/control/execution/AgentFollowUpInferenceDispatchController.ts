import {
  AgentInferenceDispatchRecoveryRequiredError,
  AgentRunInvariantError,
  AgentRunVersionConflictError,
  assertValidAgentRun,
  deriveStableAgentId,
  type AgentInferenceAttempt,
  type AgentInferenceDispatchResult,
  type AgentRun,
  type AgentRunUnitOfWork,
  type AgentTurn
} from '@ariadne/agent-core';

import type { AgentInferenceDispatcher } from './AgentRunExecutionDispatchController.js';

export interface DispatchAgentFollowUpInferenceRequest {
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly occurredAt: string;
}

export type AgentFollowUpInferenceDispatchOutcome =
  | {
      readonly status: 'completed';
      readonly inferenceStatus: 'succeeded' | 'failed' | 'cancelled';
      readonly result: AgentInferenceDispatchResult;
    }
  | {
      readonly status: 'waiting_recovery';
      readonly reason:
        | 'inference_outcome_uncertain'
        | 'inference_already_crossed_boundary';
      readonly result?: AgentInferenceDispatchResult;
    };

/**
 * True only for the initial Attempt of the latest causal continuation Turn.
 * Conversation and Delegation first Turns remain exclusively owned by their
 * durable admission/execution-intent producers.
 */
export function isOwnedAgentFollowUpInference(
  run: AgentRun,
  turn: AgentTurn,
  attempt: AgentInferenceAttempt
): boolean {
  return run.turns.at(-1)?.turnId === turn.turnId
    && (
      turn.intention.cause.kind === 'effect_results'
      || turn.intention.cause.kind === 'inbox_inputs'
      || turn.intention.cause.kind === 'child_results'
    )
    && turn.attempts.length === 1
    && turn.attempts[0]?.attemptId === attempt.attemptId
    && attempt.cause.kind === 'initial'
    && attempt.state.status === 'intended';
}

/** Owns follow-up inference only; it cannot weaken or bypass first-Turn intent receipts. */
export class AgentFollowUpInferenceDispatchController {
  public constructor(
    private readonly runs: AgentRunUnitOfWork,
    private readonly inference: AgentInferenceDispatcher
  ) {}

  public async dispatchOwned(
    request: DispatchAgentFollowUpInferenceRequest,
    signal: AbortSignal
  ): Promise<AgentFollowUpInferenceDispatchOutcome> {
    const run = await this.runs.transaction((transaction) => (
      transaction.loadRun(request.runId)
    ));
    if (run === null) throw invariant('The follow-up inference Run does not exist.');
    assertValidAgentRun(run);
    if (run.version !== request.expectedVersion) {
      throw new AgentRunVersionConflictError(
        run.runId,
        request.expectedVersion,
        run.version
      );
    }
    const turn = run.turns.find((candidate) => candidate.turnId === request.turnId);
    const attempt = turn?.attempts.find(
      (candidate) => candidate.attemptId === request.attemptId
    );
    if (
      run.state.status !== 'running'
      || turn === undefined
      || attempt === undefined
      || !isOwnedAgentFollowUpInference(run, turn, attempt)
    ) {
      throw invariant(
        'Follow-up inference requires the exact latest intended Effect-result Turn.'
      );
    }

    const cause = turn.intention.cause;
    if (
      cause.kind !== 'effect_results'
      && cause.kind !== 'inbox_inputs'
      && cause.kind !== 'child_results'
    ) {
      throw invariant('Follow-up inference cannot own an objective Turn.');
    }
    const commandId = await deriveStableAgentId(
      'follow-up-inference-dispatch',
      run.runId,
      turn.turnId,
      attempt.attemptId,
      turn.intention.inputDigest,
      cause.sourceDirectiveDigest
    );
    let result: AgentInferenceDispatchResult;
    try {
      result = await this.inference.dispatch({
        commandId,
        runId: run.runId,
        turnId: turn.turnId,
        attemptId: attempt.attemptId,
        expectedVersion: run.version,
        occurredAt: request.occurredAt
      }, signal);
    } catch (error) {
      if (error instanceof AgentInferenceDispatchRecoveryRequiredError) {
        return {
          status: 'waiting_recovery',
          reason: 'inference_already_crossed_boundary'
        };
      }
      throw error;
    }

    if (result.status === 'uncertain') {
      return {
        status: 'waiting_recovery',
        reason: 'inference_outcome_uncertain',
        result
      };
    }
    if (
      result.status !== 'succeeded'
      && result.status !== 'failed'
      && result.status !== 'cancelled'
    ) {
      throw invariant(
        'Follow-up inference returned a nonterminal result without recovery evidence.'
      );
    }
    assertExactCommittedResult(run, turn, attempt, result);
    return {
      status: 'completed',
      inferenceStatus: result.status,
      result
    };
  }
}

function assertExactCommittedResult(
  previous: AgentRun,
  turn: AgentTurn,
  attempt: AgentInferenceAttempt,
  result: AgentInferenceDispatchResult
): void {
  assertValidAgentRun(result.run);
  const committedTurn = result.run.turns.find(
    (candidate) => candidate.turnId === turn.turnId
  );
  const committedAttempt = committedTurn?.attempts.find(
    (candidate) => candidate.attemptId === attempt.attemptId
  );
  if (
    result.run.runId !== previous.runId
    || result.run.version <= previous.version
    || result.turn.turnId !== turn.turnId
    || result.attempt.attemptId !== attempt.attemptId
    || committedAttempt?.state.status !== result.status
    || result.attempt.state.status !== result.status
    || (
      result.command !== null
      && (
        result.command.run.runId !== result.run.runId
        || result.command.run.version !== result.run.version
      )
    )
  ) {
    throw invariant(
      'Follow-up inference returned a result outside its exact causal Turn.'
    );
  }
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
