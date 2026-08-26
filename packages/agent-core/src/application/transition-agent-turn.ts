import type { AgentRun, AgentRunState } from '../domain/agent-run.js';
import { cloneAgentRunBinding } from '../domain/run-binding.js';
import { isTerminalEffect } from '../domain/effect.js';
import {
  AgentRunInvariantError,
  AgentRunTransitionError
} from '../domain/errors.js';
import {
  type AgentInferenceAttempt,
  type AgentInferenceAttemptTransition,
  type AgentTurn,
  isTerminalInferenceAttempt,
  transitionAgentInferenceAttempt
} from '../domain/turn.js';
import type {
  AgentRunEventPayload
} from './events.js';
import type {
  AgentRunCommand,
  RegisterAgentTurnCommand,
  RetryAgentInferenceAttemptCommand,
  StartAgentInferenceAttemptCommand
} from './commands.js';

export interface AgentTurnMutation {
  readonly state: AgentRunState;
  readonly turns: readonly AgentTurn[];
  readonly events: readonly AgentRunEventPayload[];
}

export interface AgentInferenceCancelRunResolution {
  readonly turnId: string;
  readonly attemptId: string;
  readonly recoveryDecisionId: string;
}

export function registerAgentTurn(
  run: AgentRun,
  command: RegisterAgentTurnCommand
): AgentTurnMutation {
  requireRunning(run, command.kind);
  if (run.turns.length === 0) {
    const objective = run.binding.objectiveRef;
    if (
      !(
        command.turn.cause.kind === 'conversation_objective'
        && objective.kind === 'conversation_message'
        && command.turn.cause.messageId === objective.messageId
        && command.turn.cause.messageVersion === objective.messageVersion
        && command.turn.cause.contentDigest === objective.contentDigest
      )
      && !(
        command.turn.cause.kind === 'delegation_objective'
        && objective.kind === 'parent_delegation'
        && command.turn.cause.parentRunId === objective.parentRunId
        && command.turn.cause.delegationId === objective.delegationId
        && command.turn.cause.objectiveDigest === objective.objectiveDigest
      )
    ) {
      throw new AgentRunTransitionError(
        'A Run first Turn must bind its exact Conversation or Delegation objective.'
      );
    }
  } else if (command.turn.cause.kind === 'effect_results') {
    assertExactEffectResultCause(run, command.turn.cause);
  } else if (command.turn.cause.kind === 'inbox_inputs') {
    assertExactInboxCause(run, command.turn.cause);
  } else {
    throw new AgentRunTransitionError(
      'Every continuation Turn must bind Effect results or claimed Agent inbox inputs.'
    );
  }
  assertNoStartedEffects(run, command.kind);
  assertNoOpenAgentInferenceAttempts(run, command.kind);
  const unsettledEffect = run.effects.find((effect) => !isTerminalEffect(effect));
  if (unsettledEffect !== undefined) {
    throw new AgentRunTransitionError(
      `Turn "${command.turn.turnId}" cannot start while Effect `
        + `"${unsettledEffect.effectId}" is unsettled.`
    );
  }
  if (run.turns.length >= run.binding.budget.vector.modelTurns) {
    throw new AgentRunTransitionError(
      `Turn "${command.turn.turnId}" exceeds the immutable Run model-turn budget.`
    );
  }

  const checkpointVersion = nextCheckpoint(run);
  const binding = cloneAgentRunBinding(run.binding);
  const attempt: AgentInferenceAttempt = {
    attemptId: command.turn.attemptId,
    turnId: command.turn.turnId,
    runId: run.runId,
    providerIdempotencyKey: command.turn.providerIdempotencyKey,
    cause: { kind: 'initial' },
    state: { status: 'intended', intendedAt: command.occurredAt }
  };
  const turn: AgentTurn = {
    turnId: command.turn.turnId,
    runId: run.runId,
    intention: {
      expectedRunVersion: command.expectedVersion,
      checkpointVersion,
      cause: command.turn.cause.kind === 'effect_results'
        ? {
            ...command.turn.cause,
            effectIds: [...command.turn.cause.effectIds],
            toolCallIds: [...command.turn.cause.toolCallIds],
            ...(command.turn.cause.inboxInputIds === undefined
              ? {}
              : { inboxInputIds: [...command.turn.cause.inboxInputIds] })
          }
        : command.turn.cause.kind === 'inbox_inputs'
          ? { ...command.turn.cause, inputIds: [...command.turn.cause.inputIds] }
        : { ...command.turn.cause },
      bindingVersion: binding.bindingVersion,
      ...(binding.bindingVersion === 4
        ? { executionProfile: { ...binding.executionProfile } }
        : {}),
      sessionId: binding.sessionId,
      objectiveRef: binding.objectiveRef,
      workspace: binding.workspace,
      model: binding.model,
      policy: binding.policy,
      capabilities: binding.capabilities,
      toolCatalog: binding.toolCatalog,
      budget: binding.budget,
      inputDigest: command.turn.inputDigest,
      inputSummary: { ...command.turn.inputSummary }
    },
    attempts: [attempt],
    createdAt: command.occurredAt
  };
  return {
    state: runningState(checkpointVersion, command.occurredAt),
    turns: [...run.turns, turn],
    events: [
      { type: 'turn.registered', turn },
      { type: 'inference_attempt.registered', turnId: turn.turnId, attempt }
    ]
  };
}

function assertExactInboxCause(
  run: AgentRun,
  cause: Extract<RegisterAgentTurnCommand['turn']['cause'], { kind: 'inbox_inputs' }>
): void {
  const sourceTurn = run.turns.at(-1);
  const sourceAttempt = sourceTurn?.attempts.at(-1);
  if (
    sourceTurn === undefined
    || sourceAttempt?.state.status !== 'succeeded'
    || (sourceAttempt.state.directive.kind !== 'respond'
      && sourceAttempt.state.directive.kind !== 'complete')
    || sourceTurn.turnId !== cause.sourceTurnId
    || sourceAttempt.attemptId !== cause.sourceAttemptId
    || sourceAttempt.state.directiveDigest !== cause.sourceDirectiveDigest
  ) {
    throw new AgentRunTransitionError(
      'Inbox continuation must extend the latest succeeded response boundary.'
    );
  }
  assertExactQueuedInboxOrder(run, cause.inputIds);
}

function assertExactQueuedInboxOrder(run: AgentRun, inputIds: readonly string[]): void {
  const requested = new Set(inputIds);
  const queued = run.inbox.filter((input) => requested.has(input.inputId));
  if (
    queued.length !== inputIds.length
    || queued.some((input) => input.state !== 'queued')
    || inputIds.some((id, index) => queued[index]?.inputId !== id)
  ) {
    throw new AgentRunTransitionError(
      'Inbox continuation inputs must match the durable queue order exactly.'
    );
  }
}

function assertExactEffectResultCause(
  run: AgentRun,
  cause: Extract<RegisterAgentTurnCommand['turn']['cause'], { kind: 'effect_results' }>
): void {
  const sourceTurn = run.turns.find((turn) => turn.turnId === cause.sourceTurnId);
  const sourceAttempt = sourceTurn?.attempts.find(
    (attempt) => attempt.attemptId === cause.sourceAttemptId
  );
  if (
    sourceTurn === undefined
    || sourceAttempt === undefined
    || sourceAttempt.state.status !== 'succeeded'
    || sourceAttempt.state.directiveDigest !== cause.sourceDirectiveDigest
    || sourceAttempt.state.directive.kind !== 'invoke_tools'
  ) {
    throw new AgentRunTransitionError(
      'An Effect-result Turn must bind one succeeded invoke_tools source Attempt.'
    );
  }
  const invocations = sourceAttempt.state.directive.invocations;
  if (
    invocations.length !== cause.effectIds.length
    || invocations.length !== cause.toolCallIds.length
  ) {
    throw new AgentRunTransitionError(
      'An Effect-result Turn must contain the complete source Directive batch.'
    );
  }
  const sourceEffects = run.effects.filter((effect) => (
    effect.origin?.turnId === cause.sourceTurnId
    && effect.origin.attemptId === cause.sourceAttemptId
    && effect.origin.directiveDigest === cause.sourceDirectiveDigest
  ));
  if (sourceEffects.length !== invocations.length) {
    throw new AgentRunTransitionError(
      'An Effect-result Turn cannot continue from a partial or expanded Effect batch.'
    );
  }
  for (const [index, invocation] of invocations.entries()) {
    const effectId = cause.effectIds[index];
    const toolCallId = cause.toolCallIds[index];
    const effect = run.effects.find((candidate) => candidate.effectId === effectId);
    if (
      effect === undefined
      || invocation.effectId !== effectId
      || invocation.toolCallId !== toolCallId
      || effect.toolCallId !== toolCallId
      || effect.origin?.turnId !== cause.sourceTurnId
      || effect.origin.attemptId !== cause.sourceAttemptId
      || effect.origin.directiveDigest !== cause.sourceDirectiveDigest
      || !isTerminalEffect(effect)
    ) {
      throw new AgentRunTransitionError(
        'An Effect-result Turn batch must match terminal source Effects in invocation order.'
      );
    }
  }
  if (run.turns.some((turn) => {
    const existing = turn.intention.cause;
    return existing.kind === 'effect_results'
      && existing.sourceTurnId === cause.sourceTurnId
      && existing.sourceAttemptId === cause.sourceAttemptId
      && existing.sourceDirectiveDigest === cause.sourceDirectiveDigest;
  })) {
    throw new AgentRunTransitionError(
      'A source Directive can cause at most one continuation Turn.'
    );
  }
  if (cause.inboxInputIds !== undefined) {
    assertExactQueuedInboxOrder(run, cause.inboxInputIds);
    if (cause.inboxInputIds.some((inputId) => (
      run.inbox.find((input) => input.inputId === inputId)?.delivery !== 'next_step'
    ))) {
      throw new AgentRunTransitionError(
        'Only next-step inputs can join an Effect-result continuation.'
      );
    }
  }
}

export function startAgentInferenceAttempt(
  run: AgentRun,
  command: StartAgentInferenceAttemptCommand
): AgentTurnMutation {
  requireRunning(run, command.kind);
  assertNoStartedEffects(run, command.kind);
  const turn = requireTurn(run, command.turnId);
  const attempt = requireAttempt(turn, command.attemptId);
  const replacement = replaceAttempt(turn, attempt, {
    type: 'start',
    at: command.occurredAt
  });
  return {
    state: runningState(nextCheckpoint(run), command.occurredAt),
    turns: replaceTurn(run.turns, replacement.turn),
    events: [replacement.event]
  };
}

export function retryAgentInferenceAttempt(
  run: AgentRun,
  command: RetryAgentInferenceAttemptCommand
): AgentTurnMutation {
  if (
    run.state.status !== 'recovering'
    || run.state.reason !== 'uncertain_inference'
    || run.state.turnId !== command.turnId
    || run.state.attemptId !== command.causedByAttemptId
  ) {
    throw invalidRunState(run, command.kind);
  }
  const turn = requireTurn(run, command.turnId);
  const previous = requireAttempt(turn, command.causedByAttemptId);
  if (
    previous.state.status !== 'uncertain'
    || previous.state.recovery.decisionId !== command.recoveryDecisionId
    || !previous.state.recovery.allowedActions.includes('retry')
  ) {
    throw new AgentRunTransitionError(
      'An inference retry must use the exact persisted recovery decision that allows retry.'
    );
  }
  const attempt: AgentInferenceAttempt = {
    attemptId: command.attemptId,
    turnId: turn.turnId,
    runId: run.runId,
    providerIdempotencyKey: command.providerIdempotencyKey,
    cause: {
      kind: 'recovery_retry',
      causedByAttemptId: previous.attemptId,
      recoveryDecisionId: command.recoveryDecisionId
    },
    state: { status: 'intended', intendedAt: command.occurredAt }
  };
  const nextTurn: AgentTurn = {
    ...turn,
    attempts: [...turn.attempts, attempt]
  };
  return {
    state: runningState(nextCheckpoint(run), command.occurredAt),
    turns: replaceTurn(run.turns, nextTurn),
    events: [{ type: 'inference_attempt.registered', turnId: turn.turnId, attempt }]
  };
}

export function assertNoOpenAgentInferenceAttempts(
  run: AgentRun,
  commandKind: AgentRunCommand['kind']
): void {
  const open = findAttempt(run, (attempt) => !isTerminalInferenceAttempt(attempt));
  if (open === null) return;
  throw new AgentRunTransitionError(
    `${commandKind} cannot proceed while inference Attempt `
      + `"${open.attempt.attemptId}" is "${open.attempt.state.status}".`
  );
}

export function assertNoStartedAgentInferenceAttempts(
  run: AgentRun,
  commandKind: AgentRunCommand['kind']
): void {
  const started = findAttempt(run, (attempt) => attempt.state.status === 'started');
  if (started === null) return;
  throw new AgentRunTransitionError(
    `${commandKind} cannot terminate Run "${run.runId}" while inference Attempt `
      + `"${started.attempt.attemptId}" has an unknown Provider outcome; `
      + 'record the result or enter recovery first.'
  );
}

export function cancelOpenAgentInferenceAttempts(
  turns: readonly AgentTurn[],
  occurredAt: string,
  reason: string
): {
  readonly turns: readonly AgentTurn[];
  readonly events: readonly AgentRunEventPayload[];
} {
  const events: AgentRunEventPayload[] = [];
  const next = turns.map((turn) => {
    let changed = false;
    const attempts = turn.attempts.map((attempt) => {
      if (attempt.state.status !== 'intended') return attempt;
      const cancelled = transitionAgentInferenceAttempt(attempt, {
        type: 'cancel',
        at: occurredAt,
        reason
      });
      changed = true;
      events.push({
        type: 'inference_attempt.transitioned',
        turnId: turn.turnId,
        attemptId: attempt.attemptId,
        from: attempt.state,
        to: cancelled.state
      });
      return cancelled;
    });
    return changed ? { ...turn, attempts } : turn;
  });
  return { turns: next, events };
}

export function authorizeInferenceCancelRun(
  run: AgentRun,
  recoveryDecisionId: string | undefined
): AgentInferenceCancelRunResolution {
  if (
    run.state.status !== 'recovering'
    || run.state.reason !== 'uncertain_inference'
  ) {
    throw new AgentRunTransitionError(
      'An inference recovery identity cannot be used outside inference recovery.'
    );
  }
  const turn = requireTurn(run, run.state.turnId);
  const attempt = requireAttempt(turn, run.state.attemptId);
  if (
    attempt.state.status !== 'uncertain'
    || recoveryDecisionId !== attempt.state.recovery.decisionId
    || !attempt.state.recovery.allowedActions.includes('cancel_run')
  ) {
    throw new AgentRunTransitionError(
      'Run cancellation must use the exact uncertain-inference recovery decision.'
    );
  }
  return {
    turnId: turn.turnId,
    attemptId: attempt.attemptId,
    recoveryDecisionId
  };
}

function replaceAttempt(
  turn: AgentTurn,
  attempt: AgentInferenceAttempt,
  transition: AgentInferenceAttemptTransition
): { readonly turn: AgentTurn; readonly event: AgentRunEventPayload } {
  const next = transitionAgentInferenceAttempt(attempt, transition);
  return {
    turn: {
      ...turn,
      attempts: turn.attempts.map((candidate) =>
        candidate.attemptId === attempt.attemptId ? next : candidate
      )
    },
    event: {
      type: 'inference_attempt.transitioned',
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      from: attempt.state,
      to: next.state
    }
  };
}

function assertNoStartedEffects(run: AgentRun, commandKind: AgentRunCommand['kind']): void {
  const started = run.effects.find((effect) => effect.state.status === 'started');
  if (started === undefined) return;
  throw new AgentRunTransitionError(
    `${commandKind} cannot proceed while Effect "${started.effectId}" has an unknown outcome.`
  );
}

function requireRunning(run: AgentRun, commandKind: AgentRunCommand['kind']): void {
  if (run.state.status !== 'running') throw invalidRunState(run, commandKind);
}

function invalidRunState(
  run: AgentRun,
  commandKind: AgentRunCommand['kind']
): AgentRunTransitionError {
  return new AgentRunTransitionError(
    `Run "${run.runId}" cannot handle "${commandKind}" while "${run.state.status}".`
  );
}

function requireTurn(run: AgentRun, turnId: string): AgentTurn {
  const turn = run.turns.find((candidate) => candidate.turnId === turnId);
  if (turn === undefined) {
    throw new AgentRunTransitionError(
      `Turn "${turnId}" does not belong to Run "${run.runId}".`
    );
  }
  return turn;
}

function requireAttempt(turn: AgentTurn, attemptId: string): AgentInferenceAttempt {
  const attempt = turn.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (attempt === undefined) {
    throw new AgentRunTransitionError(
      `Inference attempt "${attemptId}" does not belong to Turn "${turn.turnId}".`
    );
  }
  return attempt;
}

function findAttempt(
  run: AgentRun,
  predicate: (attempt: AgentInferenceAttempt) => boolean
): { readonly turn: AgentTurn; readonly attempt: AgentInferenceAttempt } | null {
  for (const turn of run.turns) {
    const attempt = turn.attempts.find(predicate);
    if (attempt !== undefined) return { turn, attempt };
  }
  return null;
}

function replaceTurn(
  turns: readonly AgentTurn[],
  replacement: AgentTurn
): readonly AgentTurn[] {
  return turns.map((turn) =>
    turn.turnId === replacement.turnId ? replacement : turn
  );
}

function runningState(checkpointVersion: number, enteredAt: string): AgentRunState {
  return { status: 'running', checkpointVersion, enteredAt };
}

function nextCheckpoint(run: AgentRun): number {
  return run.state.checkpointVersion + 1;
}
