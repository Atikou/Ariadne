import {
  AgentInferenceDispatchRecoveryRequiredError,
  AgentRunInvariantError,
  AgentRunVersionConflictError,
  assertValidAgentRun,
  deriveStableAgentId,
  type AgentInferenceDispatchResult,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';

import type { AgentInferenceDispatcher } from './AgentRunExecutionDispatchController.js';
import type {
  AgentFollowUpInferenceDispatchOutcome,
  DispatchAgentFollowUpInferenceRequest
} from './AgentFollowUpInferenceDispatchController.js';

/** Owns exactly the first inference of an ordinary child Run. */
export class AgentDelegatedInferenceDispatchController {
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
    if (run === null) throw invariant('The delegated Agent Run does not exist.');
    assertValidAgentRun(run);
    if (run.version !== request.expectedVersion) {
      throw new AgentRunVersionConflictError(run.runId, request.expectedVersion, run.version);
    }
    const turn = run.turns.find((candidate) => candidate.turnId === request.turnId);
    const attempt = turn?.attempts.find(
      (candidate) => candidate.attemptId === request.attemptId
    );
    const cause = turn?.intention.cause;
    if (
      run.state.status !== 'running'
      || run.binding.objectiveRef.kind !== 'parent_delegation'
      || run.turns.length !== 1
      || turn === undefined
      || attempt === undefined
      || cause?.kind !== 'delegation_objective'
      || cause.parentRunId !== run.binding.objectiveRef.parentRunId
      || cause.delegationId !== run.binding.objectiveRef.delegationId
      || cause.objectiveDigest !== run.binding.objectiveRef.objectiveDigest
      || turn.attempts.length !== 1
      || attempt.cause.kind !== 'initial'
      || attempt.state.status !== 'intended'
    ) {
      throw invariant('Delegated inference requires the exact admitted child objective Turn.');
    }
    const commandId = await deriveStableAgentId(
      'delegated-inference-dispatch',
      run.runId,
      turn.turnId,
      attempt.attemptId,
      turn.intention.inputDigest,
      cause.delegationId,
      cause.objectiveDigest
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
        return { status: 'waiting_recovery', reason: 'inference_already_crossed_boundary' };
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
    if (!['succeeded', 'failed', 'cancelled'].includes(result.status)) {
      throw invariant('Delegated inference returned a nonterminal result without recovery evidence.');
    }
    if (
      result.run.runId !== run.runId
      || result.run.version <= run.version
      || result.turn.turnId !== turn.turnId
      || result.attempt.attemptId !== attempt.attemptId
    ) {
      throw invariant('Delegated inference returned a result outside its exact child Turn.');
    }
    return {
      status: 'completed',
      inferenceStatus: result.status as 'succeeded' | 'failed' | 'cancelled',
      result
    };
  }
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
