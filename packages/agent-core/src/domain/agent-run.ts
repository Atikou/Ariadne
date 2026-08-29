import {
  type AgentDecision,
  type PermissionDecision,
  type PlanDecision,
  type RecoveryDecision,
  type UserQuestionDecision,
  assertValidDecision
} from './decision.js';
import {
  type AgentEffect,
  assertValidEffect,
  isTerminalEffect
} from './effect.js';
import { AgentRunInvariantError } from './errors.js';
import {
  type AgentRunBinding,
  assertValidAgentRunBinding
} from './run-binding.js';
import {
  type AgentInferenceAttempt,
  type AgentTurn,
  assertValidAgentTurn,
  isTerminalInferenceAttempt
} from './turn.js';
import type { AgentCommittedToolInvocation } from './directive.js';
import {
  assertValidAgentInboxInput,
  type AgentInboxInput
} from './inbox.js';
import { sameAgentPinnedToolIdentity } from './tool.js';
import {
  type AgentRunId,
  assertCanonicalPublicId,
  assertCanonicalSortedPublicIds,
  assertNonEmpty,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertTimestamp
} from './values.js';

interface AgentRunStateBase {
  readonly checkpointVersion: number;
}

export interface QueuedAgentRunState extends AgentRunStateBase {
  readonly status: 'queued';
  readonly checkpointVersion: 0;
  readonly queuedAt: string;
}

export interface RunningAgentRunState extends AgentRunStateBase {
  readonly status: 'running';
  readonly enteredAt: string;
}

export interface PermissionWaitingAgentRunState extends AgentRunStateBase {
  readonly status: 'waiting';
  readonly reason: 'tool_permission';
  readonly decision: PermissionDecision;
}

export interface PlanWaitingAgentRunState extends AgentRunStateBase {
  readonly status: 'waiting';
  readonly reason: 'plan_approval';
  readonly decision: PlanDecision;
}

export interface UserQuestionWaitingAgentRunState extends AgentRunStateBase {
  readonly status: 'waiting';
  readonly reason: 'user_question';
  readonly decision: UserQuestionDecision;
}

export type WaitingAgentRunState =
  | PermissionWaitingAgentRunState
  | PlanWaitingAgentRunState
  | UserQuestionWaitingAgentRunState;

export interface EffectRecoveringAgentRunState extends AgentRunStateBase {
  readonly status: 'recovering';
  readonly reason: 'uncertain_effect';
  readonly decision: RecoveryDecision;
}

export interface InferenceRecoveringAgentRunState extends AgentRunStateBase {
  readonly status: 'recovering';
  readonly reason: 'uncertain_inference';
  readonly turnId: string;
  readonly attemptId: string;
}

export type RecoveringAgentRunState =
  | EffectRecoveringAgentRunState
  | InferenceRecoveringAgentRunState;

export interface WaitingChildrenAgentRunState extends AgentRunStateBase {
  readonly status: 'waiting_children';
  readonly enteredAt: string;
  readonly requiredChildRunIds: readonly string[];
  readonly terminalChildRunIds: readonly string[];
}

/** A continuable delegated Run has settled one response and is parked for inbox work. */
export interface ResponseWaitingInputAgentRunState extends AgentRunStateBase {
  readonly status: 'waiting_input';
  readonly enteredAt: string;
  readonly responseTurnId: string;
}

/** An interrupted inference was explicitly abandoned and the Child remains resumable. */
export interface InterruptedWaitingInputAgentRunState extends AgentRunStateBase {
  readonly status: 'waiting_input';
  readonly enteredAt: string;
  readonly interruptedTurnId: string;
  readonly interruptedAttemptId: string;
  readonly recoveryDecisionId: string;
}

export type WaitingInputAgentRunState =
  | ResponseWaitingInputAgentRunState
  | InterruptedWaitingInputAgentRunState;

export interface CancellingAgentRunState extends AgentRunStateBase {
  readonly status: 'cancelling';
  readonly requestedAt: string;
  readonly reason: string;
  readonly requiredChildRunIds: readonly string[];
  readonly terminalChildRunIds: readonly string[];
}

export interface CompletedAgentRunState extends AgentRunStateBase {
  readonly status: 'completed';
  readonly completedAt: string;
  readonly outputRef?: string;
}

export interface FailedAgentRunState extends AgentRunStateBase {
  readonly status: 'failed';
  readonly failedAt: string;
  readonly errorCode: string;
  readonly message: string;
}

export interface CancelledAgentRunState extends AgentRunStateBase {
  readonly status: 'cancelled';
  readonly cancelledAt: string;
  readonly reason: string;
  readonly inferenceRecovery?: {
    readonly turnId: string;
    readonly attemptId: string;
    readonly recoveryDecisionId: string;
  };
}

export type AgentRunState =
  | QueuedAgentRunState
  | RunningAgentRunState
  | WaitingAgentRunState
  | RecoveringAgentRunState
  | WaitingChildrenAgentRunState
  | WaitingInputAgentRunState
  | CancellingAgentRunState
  | CompletedAgentRunState
  | FailedAgentRunState
  | CancelledAgentRunState;

export interface AgentRun {
  readonly runId: AgentRunId;
  readonly version: number;
  readonly binding: AgentRunBinding;
  readonly state: AgentRunState;
  readonly turns: readonly AgentTurn[];
  readonly effects: readonly AgentEffect[];
  readonly inbox: readonly AgentInboxInput[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function assertValidAgentRun(run: AgentRun): void {
  assertExactObjectKeys(
    run,
    [
      'runId',
      'version',
      'binding',
      'state',
      'turns',
      'effects',
      'inbox',
      'createdAt',
      'updatedAt'
    ],
    'run'
  );
  assertCanonicalPublicId(run.runId, 'run.runId');
  assertPositiveInteger(run.version, 'run.version');
  assertTimestamp(run.createdAt, 'run.createdAt');
  assertTimestamp(run.updatedAt, 'run.updatedAt');
  assertValidAgentRunBinding(run.binding);
  if (!Array.isArray(run.turns)) {
    throw new AgentRunInvariantError('run.turns must be an array.');
  }
  if (!Array.isArray(run.effects)) {
    throw new AgentRunInvariantError('run.effects must be an array.');
  }
  if (!Array.isArray(run.inbox) || run.inbox.length > 1_000) {
    throw new AgentRunInvariantError('run.inbox must be a bounded array.');
  }
  if (run.binding.budget.runId !== run.runId) {
    throw new AgentRunInvariantError(
      'run.binding.budget.runId must match its containing run.'
    );
  }
  if (run.effects.length > run.binding.budget.vector.toolCalls) {
    throw new AgentRunInvariantError(
      'run.effects exceeds the immutable Run tool-call budget.'
    );
  }
  if (run.turns.length > run.binding.budget.vector.modelTurns) {
    throw new AgentRunInvariantError(
      'run.turns exceeds the immutable Run model-turn budget.'
    );
  }

  if (Date.parse(run.updatedAt) < Date.parse(run.createdAt)) {
    throw new AgentRunInvariantError('run.updatedAt cannot precede run.createdAt.');
  }

  const effectIds = new Set<string>();
  const toolCallIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const uncertainEffects: AgentEffect[] = [];
  const turnIds = new Set<string>();
  const attemptIds = new Set<string>();
  const inferenceIdempotencyKeys = new Set<string>();
  const uncertainInferenceAttempts: Array<{
    readonly turn: AgentTurn;
    readonly attempt: AgentInferenceAttempt;
  }> = [];
  let openInferenceAttempts = 0;
  const inboxInputIds = new Set<string>();
  const inboxMessageIds = new Set<string>();
  for (const input of run.inbox) {
    assertValidAgentInboxInput(input);
    assertUnique(inboxInputIds, input.inputId, 'inbox inputId');
    assertUnique(inboxMessageIds, input.messageId, 'inbox messageId');
    if (Date.parse(input.queuedAt) < Date.parse(run.createdAt)) {
      throw new AgentRunInvariantError('Agent inbox input cannot precede its Run.');
    }
    if (input.state === 'claimed') {
      const turn = run.turns.find((candidate) => candidate.turnId === input.claimedTurnId);
      const cause = turn?.intention.cause;
      const claimedIds = cause?.kind === 'inbox_inputs'
        ? cause.inputIds
        : cause?.kind === 'interrupted_inference'
          ? cause.inputIds
        : cause?.kind === 'effect_results'
          ? cause.inboxInputIds ?? []
          : [];
      if (!claimedIds.includes(input.inputId)) {
        throw new AgentRunInvariantError(
          'Claimed Agent inbox input must bind its exact continuation Turn.'
        );
      }
    }
  }

  for (let turnIndex = 0; turnIndex < run.turns.length; turnIndex += 1) {
    const turn = run.turns[turnIndex];
    if (turn === undefined) continue;
    assertValidAgentTurn(turn, run.binding);
    if (turn.runId !== run.runId) {
      throw new AgentRunInvariantError('Every turn must belong to its containing run.');
    }
    assertUnique(turnIds, turn.turnId, 'turnId');
    const admittedWithRun = turn.intention.expectedRunVersion === null;
    if (
      (
        turnIndex === 0
        && turn.intention.cause.kind === 'effect_results'
      )
      || (
        turnIndex > 0
        && turn.intention.cause.kind !== 'effect_results'
        && turn.intention.cause.kind !== 'inbox_inputs'
        && turn.intention.cause.kind !== 'interrupted_inference'
        && turn.intention.cause.kind !== 'child_results'
      )
    ) {
      throw new AgentRunInvariantError(
        'A Run first Turn requires its objective cause; later Turns require a continuation cause.'
      );
    }
    if (
      (
        admittedWithRun
        && (turnIndex !== 0 || turn.createdAt !== run.createdAt)
      )
      || (
        !admittedWithRun
        && turn.intention.expectedRunVersion >= run.version
      )
      || turn.intention.checkpointVersion > run.state.checkpointVersion
    ) {
      throw new AgentRunInvariantError(
        'A turn intention must bind a committed historical Run version and checkpoint.'
      );
    }
    if (Date.parse(turn.createdAt) < Date.parse(run.createdAt)) {
      throw new AgentRunInvariantError('A turn cannot precede its containing run.');
    }
    for (let index = 0; index < turn.attempts.length; index += 1) {
      const attempt = turn.attempts[index];
      if (attempt === undefined) continue;
      assertUnique(attemptIds, attempt.attemptId, 'inference attemptId');
      assertUnique(
        inferenceIdempotencyKeys,
        attempt.providerIdempotencyKey,
        'inference providerIdempotencyKey'
      );
      if (!isTerminalInferenceAttempt(attempt)) openInferenceAttempts += 1;
      const nextAttempt = turn.attempts[index + 1];
      const supersededByRecoveryRetry =
        attempt.state.status === 'uncertain'
        && nextAttempt?.cause.kind === 'recovery_retry'
        && nextAttempt.cause.causedByAttemptId === attempt.attemptId
        && nextAttempt.cause.recoveryDecisionId === attempt.state.recovery.decisionId;
      if (attempt.state.status === 'uncertain' && !supersededByRecoveryRetry) {
        uncertainInferenceAttempts.push({ turn, attempt });
      }
    }
  }
  if (openInferenceAttempts > 1) {
    throw new AgentRunInvariantError(
      'A run cannot contain multiple open inference attempts.'
    );
  }

  for (const effect of run.effects) {
    assertValidEffect(effect);
    if (effect.runId !== run.runId) {
      throw new AgentRunInvariantError('Every effect must belong to its containing run.');
    }
    assertUnique(effectIds, effect.effectId, 'effectId');
    assertUnique(toolCallIds, effect.toolCallId, 'toolCallId');
    assertUnique(idempotencyKeys, effect.idempotencyKey, 'idempotencyKey');
    if (effect.state.status === 'uncertain') {
      uncertainEffects.push(effect);
    }
  }

  const continuationCauses = new Set<string>();
  for (let continuationIndex = 1; continuationIndex < run.turns.length; continuationIndex += 1) {
    const turn = run.turns[continuationIndex];
    if (turn === undefined) continue;
    const cause = turn.intention.cause;
    if (cause.kind === 'child_results') {
      const causalKey = [
        cause.sourceTurnId,
        cause.sourceAttemptId,
        cause.sourceDirectiveDigest
      ].join('\u0000');
      const sourceTurnIndex = run.turns.findIndex(
        (candidate: AgentTurn) => candidate.turnId === cause.sourceTurnId
      );
      const sourceAttempt = run.turns[sourceTurnIndex]?.attempts.find(
        (candidate: AgentInferenceAttempt) => candidate.attemptId === cause.sourceAttemptId
      );
      if (
        continuationCauses.has(causalKey)
        || sourceTurnIndex < 0
        || sourceTurnIndex >= continuationIndex
        || sourceAttempt?.state.status !== 'succeeded'
        || sourceAttempt.state.directive.kind !== 'delegate_subagent'
        || sourceAttempt.state.directiveDigest !== cause.sourceDirectiveDigest
        || cause.delegationIds.length !== 1
        || cause.childRunIds.length !== 1
        || cause.delegationIds[0] !== sourceAttempt.state.directive.delegationId
        || cause.childRunIds[0] !== sourceAttempt.state.directive.childRunId
      ) {
        throw new AgentRunInvariantError(
          'A child-result continuation must bind one earlier succeeded SubAgent Directive.'
        );
      }
      continuationCauses.add(causalKey);
      continue;
    }
    if (cause.kind !== 'effect_results') continue;
    const causalKey = [
      cause.sourceTurnId,
      cause.sourceAttemptId,
      cause.sourceDirectiveDigest
    ].join('\u0000');
    if (continuationCauses.has(causalKey)) {
      throw new AgentRunInvariantError(
        'A source Directive can cause at most one continuation Turn.'
      );
    }
    continuationCauses.add(causalKey);
    const sourceTurn = run.turns.find(
      (candidate: AgentTurn) => candidate.turnId === cause.sourceTurnId
    );
    const sourceTurnIndex = run.turns.findIndex(
      (candidate: AgentTurn) => candidate.turnId === cause.sourceTurnId
    );
    const sourceAttempt = sourceTurn?.attempts.find(
      (candidate: AgentInferenceAttempt) => candidate.attemptId === cause.sourceAttemptId
    );
    if (
      sourceAttempt?.state.status !== 'succeeded'
      || sourceTurnIndex < 0
      || sourceTurnIndex !== continuationIndex - 1
      || sourceAttempt.state.directive.kind !== 'invoke_tools'
      || sourceAttempt.state.directiveDigest !== cause.sourceDirectiveDigest
      || sourceAttempt.state.directive.invocations.length !== cause.effectIds.length
      || sourceAttempt.state.directive.invocations.some((
        invocation: AgentCommittedToolInvocation,
        index: number
      ) => {
        const effect = run.effects.find(
          (candidate) => candidate.effectId === cause.effectIds[index]
        );
        return invocation.effectId !== cause.effectIds[index]
          || invocation.toolCallId !== cause.toolCallIds[index]
          || effect === undefined
          || effect.toolCallId !== invocation.toolCallId
          || effect.origin?.turnId !== cause.sourceTurnId
          || effect.origin?.attemptId !== cause.sourceAttemptId
          || effect.origin?.directiveDigest !== cause.sourceDirectiveDigest
          || !isTerminalEffect(effect);
      })
    ) {
      throw new AgentRunInvariantError(
        'A continuation Turn must bind its exact terminal source Effect batch in order from the immediately preceding Turn.'
      );
    }
  }

  for (const turn of run.turns) {
    for (const attempt of turn.attempts) {
      if (
        attempt.state.status !== 'succeeded'
        || attempt.state.directive.kind !== 'invoke_tools'
      ) {
        continue;
      }
      for (const invocation of attempt.state.directive.invocations) {
        const effect = run.effects.find(
          (candidate) => candidate.effectId === invocation.effectId
        );
        if (
          effect === undefined
          || effect.origin?.turnId !== turn.turnId
          || effect.origin.attemptId !== attempt.attemptId
          || effect.origin.directiveDigest !== attempt.state.directiveDigest
          || effect.toolCallId !== invocation.toolCallId
          || !sameAgentPinnedToolIdentity(effect.tool, invocation.tool)
          || effect.idempotencyKey !== invocation.idempotencyKey
          || effect.inputDigest !== invocation.inputDigest
          || !sameUniqueValues(effect.capabilityIds, invocation.capabilityIds)
          || !sameUniqueValues(effect.scope, invocation.scope)
        ) {
          throw new AgentRunInvariantError(
            'A succeeded tool Directive must bind its exact durable Effect origin.'
          );
        }
      }
    }
  }
  for (const effect of run.effects) {
    if (effect.origin === undefined) continue;
    const turn = run.turns.find(
      (candidate: AgentTurn) => candidate.turnId === effect.origin?.turnId
    );
    const attempt = turn?.attempts.find(
      (candidate: AgentInferenceAttempt) =>
        candidate.attemptId === effect.origin?.attemptId
    );
    if (
      attempt?.state.status !== 'succeeded'
      || attempt.state.directive.kind !== 'invoke_tools'
      || attempt.state.directiveDigest !== effect.origin.directiveDigest
      || !attempt.state.directive.invocations.some(
        (invocation: AgentCommittedToolInvocation) =>
          invocation.effectId === effect.effectId
      )
    ) {
      throw new AgentRunInvariantError(
        'An Engine-derived Effect must bind an exact succeeded tool Directive.'
      );
    }
  }

  assertValidState(run);

  if (
    run.state.status === 'waiting'
    && run.state.reason === 'tool_permission'
  ) {
    const decision = run.state.decision;
    const effect = run.effects.find(
      (candidate) => candidate.effectId === decision.effectId
    );
    if (
      effect === undefined
      || effect.state.status !== 'intended'
      || effect.toolCallId !== decision.toolCallId
      || !sameUniqueValues(effect.capabilityIds, decision.capabilityIds)
      || !sameUniqueValues(effect.scope, decision.scope)
    ) {
      throw new AgentRunInvariantError(
        'A permission decision must bind exactly to its intended effect.'
      );
    }
  }

  if (
    run.binding.objectiveRef.kind === 'parent_delegation'
    && run.binding.objectiveRef.parentRunId === run.runId
  ) {
    throw new AgentRunInvariantError('A delegated run cannot be its own parent.');
  }

  if (
    run.state.status === 'queued'
    && (run.effects.length > 0 || run.turns.length > 0)
  ) {
    throw new AgentRunInvariantError(
      'A queued run cannot already contain turns or effects.'
    );
  }

  if (
    run.state.status === 'recovering'
    && run.state.reason === 'uncertain_effect'
  ) {
    if (uncertainEffects.length !== 1) {
      throw new AgentRunInvariantError(
        'A recovering run must have exactly one uncertain effect.'
      );
    }
    const uncertain = uncertainEffects[0];
    if (uncertain?.effectId !== run.state.decision.effectId) {
      throw new AgentRunInvariantError(
        'A recovery decision must reference the run\'s uncertain effect.'
      );
    }
  } else if (uncertainEffects.length > 0) {
    throw new AgentRunInvariantError(
      'An uncertain effect requires the run to be in recovering state.'
    );
  }

  if (
    run.state.status === 'recovering'
    && run.state.reason === 'uncertain_inference'
  ) {
    if (uncertainInferenceAttempts.length !== 1) {
      throw new AgentRunInvariantError(
        'An inference-recovering run must have exactly one uncertain inference attempt.'
      );
    }
    const uncertain = uncertainInferenceAttempts[0];
    if (
      uncertain?.turn.turnId !== run.state.turnId
      || uncertain.attempt.attemptId !== run.state.attemptId
    ) {
      throw new AgentRunInvariantError(
        'Inference recovery must bind the Run\'s exact uncertain turn attempt.'
      );
    }
  } else if (uncertainInferenceAttempts.length > 0) {
    const uncertain = uncertainInferenceAttempts[0];
    const interruptedCause = uncertain === undefined
      ? undefined
      : run.turns.slice(1).map((turn) => turn.intention.cause).find((cause) => (
          cause.kind === 'interrupted_inference'
          && cause.sourceTurnId === uncertain.turn.turnId
          && cause.sourceAttemptId === uncertain.attempt.attemptId
        ));
    const resolution = run.state.status === 'cancelled'
      ? run.state.inferenceRecovery === undefined
        ? undefined
        : { ...run.state.inferenceRecovery, action: 'cancel_run' as const }
      : run.state.status === 'waiting_input' && 'recoveryDecisionId' in run.state
        ? {
            turnId: run.state.interruptedTurnId,
            attemptId: run.state.interruptedAttemptId,
            recoveryDecisionId: run.state.recoveryDecisionId,
            action: 'interrupt_turn' as const
          }
        : interruptedCause?.kind === 'interrupted_inference'
          ? {
              turnId: interruptedCause.sourceTurnId,
              attemptId: interruptedCause.sourceAttemptId,
              recoveryDecisionId: interruptedCause.recoveryDecisionId,
              action: 'interrupt_turn' as const
            }
        : undefined;
    if (
      uncertainInferenceAttempts.length !== 1
      || uncertain === undefined
      || resolution === undefined
      || resolution.turnId !== uncertain.turn.turnId
      || resolution.attemptId !== uncertain.attempt.attemptId
      || uncertain.attempt.state.status !== 'uncertain'
      || resolution.recoveryDecisionId !== uncertain.attempt.state.recovery.decisionId
      || !uncertain.attempt.state.recovery.allowedActions.includes(
        resolution.action
      )
    ) {
      throw new AgentRunInvariantError(
        'An unresolved uncertain inference requires recovery or an exact cancel-run resolution.'
      );
    }
  }

  if (isTerminalAgentRun(run) && run.effects.some((effect) => !isTerminalEffect(effect))) {
    throw new AgentRunInvariantError(
      'A terminal run cannot retain a non-terminal external effect.'
    );
  }
  if (
    isTerminalAgentRun(run)
    && run.turns.some((turn: AgentTurn) =>
      turn.attempts.some((attempt: AgentInferenceAttempt) =>
        !isTerminalInferenceAttempt(attempt)
      )
    )
  ) {
    throw new AgentRunInvariantError(
      'A terminal run cannot retain a non-terminal inference attempt.'
    );
  }
}

export function isTerminalAgentRun(run: AgentRun): boolean {
  return run.state.status === 'completed'
    || run.state.status === 'failed'
    || run.state.status === 'cancelled';
}

export function getActiveDecision(run: AgentRun): AgentDecision | null {
  if (
    run.state.status === 'waiting'
    || (
      run.state.status === 'recovering'
      && run.state.reason === 'uncertain_effect'
    )
  ) {
    return run.state.decision;
  }
  return null;
}

function assertExactObjectKeys(
  value: object,
  allowedKeys: readonly string[],
  field: string
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new AgentRunInvariantError(
      `${field} contains unsupported field "${unexpected}".`
    );
  }
}

function assertValidState(run: AgentRun): void {
  const state = run.state;
  assertNonNegativeInteger(state.checkpointVersion, 'run.state.checkpointVersion');

  if (state.status === 'queued') {
    if (state.checkpointVersion !== 0) {
      throw new AgentRunInvariantError('A queued run checkpoint must be zero.');
    }
    assertTimestamp(state.queuedAt, 'run.state.queuedAt');
    return;
  }

  assertPositiveInteger(state.checkpointVersion, 'run.state.checkpointVersion');

  switch (state.status) {
    case 'running':
      assertTimestamp(state.enteredAt, 'run.state.enteredAt');
      return;
    case 'waiting':
      assertValidDecision(state.decision);
      assertExactDecisionCheckpoint(run, state.decision);
      if (
        (state.reason === 'tool_permission' && state.decision.kind !== 'permission')
        || (state.reason === 'plan_approval' && state.decision.kind !== 'plan')
        || (state.reason === 'user_question' && state.decision.kind !== 'user_question')
      ) {
        throw new AgentRunInvariantError(
          'A waiting reason must match its decision kind.'
        );
      }
      return;
    case 'recovering':
      if (state.reason === 'uncertain_effect') {
        assertValidDecision(state.decision);
        assertExactDecisionCheckpoint(run, state.decision);
      } else {
        assertCanonicalPublicId(state.turnId, 'run.state.turnId');
        assertCanonicalPublicId(state.attemptId, 'run.state.attemptId');
      }
      return;
    case 'waiting_children':
      assertTimestamp(state.enteredAt, 'run.state.enteredAt');
      assertChildWaitSet(state.requiredChildRunIds, state.terminalChildRunIds);
      return;
    case 'waiting_input': {
      assertTimestamp(state.enteredAt, 'run.state.enteredAt');
      if (
        run.binding.objectiveRef.kind !== 'parent_delegation'
        || run.binding.objectiveRef.mode !== 'continuable'
      ) {
        throw new AgentRunInvariantError(
          'waiting_input requires a continuable delegated Run.'
        );
      }
      const latestTurn = run.turns.at(-1);
      const latestAttempt = latestTurn?.attempts.at(-1);
      if ('responseTurnId' in state) {
        assertCanonicalPublicId(state.responseTurnId, 'run.state.responseTurnId');
        if (
          latestTurn?.turnId !== state.responseTurnId
          || latestAttempt?.state.status !== 'succeeded'
          || latestAttempt.state.directive.kind !== 'respond'
        ) {
          throw new AgentRunInvariantError(
            'Response waiting_input must bind the latest succeeded response.'
          );
        }
      } else {
        assertCanonicalPublicId(
          state.interruptedTurnId,
          'run.state.interruptedTurnId'
        );
        assertCanonicalPublicId(
          state.interruptedAttemptId,
          'run.state.interruptedAttemptId'
        );
        assertCanonicalPublicId(
          state.recoveryDecisionId,
          'run.state.recoveryDecisionId'
        );
        if (
          latestTurn?.turnId !== state.interruptedTurnId
          || latestAttempt?.attemptId !== state.interruptedAttemptId
          || latestAttempt.state.status !== 'uncertain'
          || latestAttempt.state.recovery.decisionId !== state.recoveryDecisionId
          || !latestAttempt.state.recovery.allowedActions.includes('interrupt_turn')
        ) {
          throw new AgentRunInvariantError(
            'Interrupted waiting_input must bind the latest uncertain inference.'
          );
        }
      }
      return;
    }
    case 'cancelling':
      assertTimestamp(state.requestedAt, 'run.state.requestedAt');
      assertNonEmpty(state.reason, 'run.state.reason');
      assertChildWaitSet(state.requiredChildRunIds, state.terminalChildRunIds);
      return;
    case 'completed':
      assertTimestamp(state.completedAt, 'run.state.completedAt');
      if (state.outputRef !== undefined) {
        assertNonEmpty(state.outputRef, 'run.state.outputRef');
      }
      return;
    case 'failed':
      assertTimestamp(state.failedAt, 'run.state.failedAt');
      assertCanonicalPublicId(state.errorCode, 'run.state.errorCode');
      assertNonEmpty(state.message, 'run.state.message');
      return;
    case 'cancelled':
      assertTimestamp(state.cancelledAt, 'run.state.cancelledAt');
      assertNonEmpty(state.reason, 'run.state.reason');
      if (state.inferenceRecovery !== undefined) {
        assertCanonicalPublicId(
          state.inferenceRecovery.turnId,
          'run.state.inferenceRecovery.turnId'
        );
        assertCanonicalPublicId(
          state.inferenceRecovery.attemptId,
          'run.state.inferenceRecovery.attemptId'
        );
        assertCanonicalPublicId(
          state.inferenceRecovery.recoveryDecisionId,
          'run.state.inferenceRecovery.recoveryDecisionId'
        );
      }
  }
}

function assertChildWaitSet(
  requiredChildRunIds: readonly string[],
  terminalChildRunIds: readonly string[]
): void {
  assertCanonicalSortedPublicIds(
    requiredChildRunIds,
    'run.state.requiredChildRunIds'
  );
  assertCanonicalSortedPublicIds(
    terminalChildRunIds,
    'run.state.terminalChildRunIds'
  );
  if (
    requiredChildRunIds.length === 0
    || terminalChildRunIds.some((runId) => !requiredChildRunIds.includes(runId))
  ) {
    throw new AgentRunInvariantError(
      'Child-wait state requires at least one child and terminal children must be a subset.'
    );
  }
}

function assertExactDecisionCheckpoint(run: AgentRun, decision: AgentDecision): void {
  if (
    decision.runId !== run.runId
    || decision.checkpoint.runId !== run.runId
    || decision.checkpoint.version !== run.state.checkpointVersion
  ) {
    throw new AgentRunInvariantError(
      'An active decision must bind exactly to the current run checkpoint.'
    );
  }
}

function assertUnique(values: Set<string>, value: string, field: string): void {
  if (values.has(value)) {
    throw new AgentRunInvariantError(`Run effects must have unique ${field} values.`);
  }
  values.add(value);
}

function sameUniqueValues(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}
