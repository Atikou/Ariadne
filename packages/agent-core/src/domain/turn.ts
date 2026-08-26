import type {
  AgentExecutionProfile,
  AgentObjectiveReference,
  AgentRunBinding
} from './run-binding.js';
import type { AgentCommittedDirective } from './directive.js';
import { assertValidCommittedAgentDirective } from './directive.js';
import {
  AgentInferenceAttemptTransitionError,
  AgentRunInvariantError
} from './errors.js';
import {
  type AgentInferenceAttemptId,
  type AgentRunId,
  type AgentTurnId,
  assertBoundedNonEmpty,
  assertCanonicalPublicId,
  assertPositiveInteger,
  assertSafeNonNegativeInteger,
  assertSha256Digest,
  assertTimestamp,
  assertUniqueCanonicalPublicIds,
  assertUniqueNonEmpty
} from './values.js';

const MAX_SUMMARY_COUNT = 1_000_000_000;
const MAX_FAILURE_MESSAGE_LENGTH = 1_048_576;

export interface AgentTurnInputSummary {
  readonly messageCount: number;
  readonly toolCount: number;
  readonly contentCharacterCount: number;
}

export type AgentTurnCause =
  | {
      readonly kind: 'conversation_objective';
      readonly messageId: string;
      readonly messageVersion: number;
      readonly contentDigest: string;
    }
  | {
      readonly kind: 'delegation_objective';
      readonly parentRunId: string;
      readonly delegationId: string;
      readonly objectiveDigest: string;
    }
  | {
      readonly kind: 'effect_results';
      readonly sourceTurnId: string;
      readonly sourceAttemptId: string;
      readonly sourceDirectiveDigest: string;
      readonly effectIds: readonly string[];
      readonly toolCallIds: readonly string[];
      readonly inboxInputIds?: readonly string[];
    }
  | {
      readonly kind: 'inbox_inputs';
      readonly sourceTurnId: string;
      readonly sourceAttemptId: string;
      readonly sourceDirectiveDigest: string;
      readonly inputIds: readonly string[];
    }
  | {
      readonly kind: 'child_results';
      readonly sourceTurnId: string;
      readonly sourceAttemptId: string;
      readonly sourceDirectiveDigest: string;
      readonly delegationIds: readonly string[];
      readonly childRunIds: readonly string[];
    };

export interface AgentTurnIntention {
  /** Aggregate version compared before this intention was committed. */
  readonly expectedRunVersion: number | null;
  /** Checkpoint committed atomically with this intention. */
  readonly checkpointVersion: number;
  readonly cause: AgentTurnCause;
  readonly bindingVersion: AgentRunBinding['bindingVersion'];
  readonly executionProfile?: AgentExecutionProfile;
  readonly sessionId: string;
  readonly objectiveRef: AgentObjectiveReference;
  readonly workspace: AgentRunBinding['workspace'];
  readonly model: AgentRunBinding['model'];
  readonly policy: AgentRunBinding['policy'];
  readonly capabilities: AgentRunBinding['capabilities'];
  readonly toolCatalog: AgentRunBinding['toolCatalog'];
  readonly budget: AgentRunBinding['budget'];
  readonly inputDigest: string;
  readonly inputSummary: AgentTurnInputSummary;
}

export type AgentInferenceRecoveryAction =
  | 'retry'
  | 'mark_succeeded'
  | 'mark_failed'
  | 'cancel_run';

export interface AgentInferenceRecoveryDecision {
  readonly decisionId: string;
  readonly requestedAt: string;
  readonly allowedActions: readonly AgentInferenceRecoveryAction[];
}

export type AgentInferenceAttemptCause =
  | { readonly kind: 'initial' }
  | {
      readonly kind: 'recovery_retry';
      readonly causedByAttemptId: AgentInferenceAttemptId;
      readonly recoveryDecisionId: string;
    };

export type AgentInferenceAttemptState =
  | { readonly status: 'intended'; readonly intendedAt: string }
  | { readonly status: 'started'; readonly startedAt: string }
  | {
      readonly status: 'succeeded';
      readonly finishedAt: string;
      readonly directive: AgentCommittedDirective;
      readonly directiveDigest: string;
    }
  | {
      readonly status: 'failed';
      readonly finishedAt: string;
      readonly errorCode: string;
      readonly message: string;
    }
  | {
      readonly status: 'uncertain';
      readonly observedAt: string;
      readonly reason: string;
      readonly recovery: AgentInferenceRecoveryDecision;
    }
  | {
      readonly status: 'cancelled';
      readonly cancelledAt: string;
      readonly reason: string;
      readonly cancellation: AgentInferenceCancellation;
    };

export type AgentInferenceCancellation =
  | { readonly kind: 'before_start' }
  | {
      readonly kind: 'provider_acknowledged';
      readonly acknowledgementId: string;
    };

export interface AgentInferenceAttempt {
  readonly attemptId: AgentInferenceAttemptId;
  readonly turnId: AgentTurnId;
  readonly runId: AgentRunId;
  readonly providerIdempotencyKey: string;
  readonly cause: AgentInferenceAttemptCause;
  readonly state: AgentInferenceAttemptState;
}

export interface AgentTurn {
  readonly turnId: AgentTurnId;
  readonly runId: AgentRunId;
  readonly intention: AgentTurnIntention;
  readonly attempts: readonly AgentInferenceAttempt[];
  readonly createdAt: string;
}

export type AgentInferenceAttemptTransition =
  | { readonly type: 'start'; readonly at: string }
  | {
      readonly type: 'succeed';
      readonly at: string;
      readonly directive: AgentCommittedDirective;
      readonly directiveDigest: string;
      readonly recoveryDecisionId?: string;
    }
  | {
      readonly type: 'fail';
      readonly at: string;
      readonly errorCode: string;
      readonly message: string;
      readonly recoveryDecisionId?: string;
    }
  | {
      readonly type: 'mark_uncertain';
      readonly at: string;
      readonly reason: string;
      readonly recovery: AgentInferenceRecoveryDecision;
    }
  | {
      readonly type: 'cancel';
      readonly at: string;
      readonly reason: string;
      readonly providerCancellationAcknowledgementId?: string;
    };

export function assertValidAgentTurn(
  turn: AgentTurn,
  runBinding: AgentRunBinding
): void {
  assertExactObjectKeys(
    turn,
    ['turnId', 'runId', 'intention', 'attempts', 'createdAt'],
    'turn'
  );
  assertIdentifier(turn.turnId, 'turn.turnId');
  assertIdentifier(turn.runId, 'turn.runId');
  assertTimestamp(turn.createdAt, 'turn.createdAt');
  if (!Array.isArray(turn.attempts) || turn.attempts.length === 0) {
    throw new AgentRunInvariantError('turn.attempts must contain an initial attempt.');
  }
  assertValidTurnIntention(turn.intention, runBinding);

  const attemptIds = new Set<string>();
  const providerKeys = new Set<string>();
  let openAttempts = 0;
  turn.attempts.forEach((attempt, index) => {
    assertValidInferenceAttempt(attempt);
    const attemptTimestamp = timestampForState(attempt.state);
    const previous = turn.attempts[index - 1];
    if (
      Date.parse(attemptTimestamp) < Date.parse(turn.createdAt)
      || (
        previous !== undefined
        && Date.parse(attemptTimestamp) < Date.parse(timestampForState(previous.state))
      )
    ) {
      throw new AgentRunInvariantError(
        'Inference attempt state timestamps must follow Turn creation and causal order.'
      );
    }
    if (attempt.turnId !== turn.turnId || attempt.runId !== turn.runId) {
      throw new AgentRunInvariantError(
        'Every inference attempt must belong to its containing turn and run.'
      );
    }
    assertUnique(attemptIds, attempt.attemptId, 'attemptId');
    assertUnique(providerKeys, attempt.providerIdempotencyKey, 'providerIdempotencyKey');
    if (!isTerminalInferenceAttempt(attempt)) openAttempts += 1;

    if (index === 0) {
      if (attempt.cause.kind !== 'initial') {
        throw new AgentRunInvariantError('A turn\'s first attempt must have an initial cause.');
      }
      return;
    }
    if (attempt.cause.kind !== 'recovery_retry') {
      throw new AgentRunInvariantError('Every later attempt must be an explicit recovery retry.');
    }
    if (
      previous === undefined
      || previous.attemptId !== attempt.cause.causedByAttemptId
      || previous.state.status !== 'uncertain'
      || previous.state.recovery.decisionId !== attempt.cause.recoveryDecisionId
      || !previous.state.recovery.allowedActions.includes('retry')
    ) {
      throw new AgentRunInvariantError(
        'A retry attempt must bind the immediately preceding uncertain attempt and its recovery decision.'
      );
    }
  });
  if (openAttempts > 1) {
    throw new AgentRunInvariantError('A turn cannot contain multiple open inference attempts.');
  }
}

export function assertValidInferenceAttempt(attempt: AgentInferenceAttempt): void {
  assertExactObjectKeys(
    attempt,
    ['attemptId', 'turnId', 'runId', 'providerIdempotencyKey', 'cause', 'state'],
    'inferenceAttempt'
  );
  assertIdentifier(attempt.attemptId, 'inferenceAttempt.attemptId');
  assertIdentifier(attempt.turnId, 'inferenceAttempt.turnId');
  assertIdentifier(attempt.runId, 'inferenceAttempt.runId');
  assertIdentifier(
    attempt.providerIdempotencyKey,
    'inferenceAttempt.providerIdempotencyKey'
  );
  assertValidAttemptCause(attempt.cause);
  assertValidAttemptState(attempt.state);
}

export function transitionAgentInferenceAttempt(
  attempt: AgentInferenceAttempt,
  transition: AgentInferenceAttemptTransition
): AgentInferenceAttempt {
  assertValidInferenceAttempt(attempt);
  assertTimestamp(transition.at, 'inferenceAttempt.transition.at');
  if (Date.parse(transition.at) < Date.parse(timestampForState(attempt.state))) {
    throw new AgentInferenceAttemptTransitionError(
      `Inference attempt "${attempt.attemptId}" cannot move backwards in time.`
    );
  }

  const current = attempt.state;
  let state: AgentInferenceAttemptState;
  switch (transition.type) {
    case 'start':
      if (current.status !== 'intended') throw invalidTransition(attempt, transition.type);
      state = { status: 'started', startedAt: transition.at };
      break;
    case 'succeed':
      assertResultSource(attempt, transition.recoveryDecisionId, 'mark_succeeded');
      assertValidCommittedAgentDirective(transition.directive);
      assertSha256Digest(
        transition.directiveDigest,
        'inferenceAttempt.transition.directiveDigest'
      );
      state = {
        status: 'succeeded',
        finishedAt: transition.at,
        directive: transition.directive,
        directiveDigest: transition.directiveDigest
      };
      break;
    case 'fail':
      assertResultSource(attempt, transition.recoveryDecisionId, 'mark_failed');
      assertIdentifier(transition.errorCode, 'inferenceAttempt.transition.errorCode');
      assertBoundedNonEmpty(
        transition.message,
        'inferenceAttempt.transition.message',
        MAX_FAILURE_MESSAGE_LENGTH
      );
      state = {
        status: 'failed',
        finishedAt: transition.at,
        errorCode: transition.errorCode,
        message: transition.message
      };
      break;
    case 'mark_uncertain':
      if (current.status !== 'started') throw invalidTransition(attempt, transition.type);
      assertBoundedNonEmpty(
        transition.reason,
        'inferenceAttempt.transition.reason',
        MAX_FAILURE_MESSAGE_LENGTH
      );
      assertValidRecoveryDecision(transition.recovery, transition.at);
      state = {
        status: 'uncertain',
        observedAt: transition.at,
        reason: transition.reason,
        recovery: transition.recovery
      };
      break;
    case 'cancel': {
      if (current.status !== 'intended' && current.status !== 'started') {
        throw invalidTransition(attempt, transition.type);
      }
      assertBoundedNonEmpty(
        transition.reason,
        'inferenceAttempt.transition.reason',
        MAX_FAILURE_MESSAGE_LENGTH
      );
      if (current.status === 'intended') {
        if (transition.providerCancellationAcknowledgementId !== undefined) {
          throw new AgentInferenceAttemptTransitionError(
            'An inference cancelled before start cannot carry Provider acknowledgement evidence.'
          );
        }
        state = {
          status: 'cancelled',
          cancelledAt: transition.at,
          reason: transition.reason,
          cancellation: { kind: 'before_start' }
        };
      } else {
        const acknowledgementId = transition.providerCancellationAcknowledgementId;
        if (acknowledgementId === undefined) {
          throw new AgentInferenceAttemptTransitionError(
            'A started inference can be cancelled only with Provider non-execution acknowledgement evidence.'
          );
        }
        assertIdentifier(
          acknowledgementId,
          'inferenceAttempt.transition.providerCancellationAcknowledgementId'
        );
        state = {
          status: 'cancelled',
          cancelledAt: transition.at,
          reason: transition.reason,
          cancellation: {
            kind: 'provider_acknowledged',
            acknowledgementId
          }
        };
      }
      break;
    }
  }

  const next = { ...attempt, state };
  assertValidInferenceAttempt(next);
  return next;
}

export function isTerminalInferenceAttempt(attempt: AgentInferenceAttempt): boolean {
  return attempt.state.status === 'succeeded'
    || attempt.state.status === 'failed'
    || attempt.state.status === 'uncertain'
    || attempt.state.status === 'cancelled';
}

function assertValidTurnIntention(
  intention: AgentTurnIntention,
  runBinding: AgentRunBinding
): void {
  assertExactObjectKeys(
    intention,
    [
      'expectedRunVersion',
      'checkpointVersion',
      'cause',
      'bindingVersion',
      ...(intention.bindingVersion === 4 ? ['executionProfile'] : []),
      'sessionId',
      'objectiveRef',
      'workspace',
      'model',
      'policy',
      'capabilities',
      'toolCatalog',
      'budget',
      'inputDigest',
      'inputSummary'
    ],
    'turn.intention'
  );
  if (intention.expectedRunVersion !== null) {
    assertPositiveInteger(intention.expectedRunVersion, 'turn.intention.expectedRunVersion');
  }
  assertPositiveInteger(intention.checkpointVersion, 'turn.intention.checkpointVersion');
  assertValidTurnCause(intention.cause);
  assertSha256Digest(intention.inputDigest, 'turn.intention.inputDigest');
  assertInputSummary(intention.inputSummary);
  const causeMatchesObjective = intention.cause.kind === 'effect_results'
    || intention.cause.kind === 'inbox_inputs'
    || intention.cause.kind === 'child_results'
    || (
      intention.cause.kind === 'conversation_objective'
      && runBinding.objectiveRef.kind === 'conversation_message'
      && intention.cause.messageId === runBinding.objectiveRef.messageId
      && intention.cause.messageVersion === runBinding.objectiveRef.messageVersion
      && intention.cause.contentDigest === runBinding.objectiveRef.contentDigest
    )
    || (
      intention.cause.kind === 'delegation_objective'
      && runBinding.objectiveRef.kind === 'parent_delegation'
      && intention.cause.parentRunId === runBinding.objectiveRef.parentRunId
      && intention.cause.delegationId === runBinding.objectiveRef.delegationId
      && intention.cause.objectiveDigest === runBinding.objectiveRef.objectiveDigest
    );
  if (
    !causeMatchesObjective
    ||
    intention.bindingVersion !== runBinding.bindingVersion
    || (
      runBinding.bindingVersion === 4
      && !sameCanonicalValue(intention.executionProfile, runBinding.executionProfile)
    )
    || intention.sessionId !== runBinding.sessionId
    || !sameCanonicalValue(intention.objectiveRef, runBinding.objectiveRef)
    || !sameCanonicalValue(intention.workspace, runBinding.workspace)
    || !sameCanonicalValue(intention.model, runBinding.model)
    || !sameCanonicalValue(intention.policy, runBinding.policy)
    || !sameCanonicalValue(intention.capabilities, runBinding.capabilities)
    || !sameCanonicalValue(intention.toolCatalog, runBinding.toolCatalog)
    || !sameCanonicalValue(intention.budget, runBinding.budget)
  ) {
    throw new AgentRunInvariantError(
      'A turn intention must bind the exact immutable Run binding snapshot.'
    );
  }
}

export function assertValidAgentTurnCause(cause: AgentTurnCause): void {
  assertValidTurnCause(cause);
}

function assertValidTurnCause(cause: AgentTurnCause): void {
  if (!isPlainObject(cause)) {
    throw new AgentRunInvariantError('turn.intention.cause must be a plain object.');
  }
  switch (cause.kind) {
    case 'conversation_objective':
      assertExactObjectKeys(
        cause,
        ['kind', 'messageId', 'messageVersion', 'contentDigest'],
        'turn.intention.cause'
      );
      assertIdentifier(cause.messageId, 'turn.intention.cause.messageId');
      assertPositiveInteger(cause.messageVersion, 'turn.intention.cause.messageVersion');
      assertSha256Digest(cause.contentDigest, 'turn.intention.cause.contentDigest');
      return;
    case 'delegation_objective':
      assertExactObjectKeys(
        cause,
        ['kind', 'parentRunId', 'delegationId', 'objectiveDigest'],
        'turn.intention.cause'
      );
      assertIdentifier(cause.parentRunId, 'turn.intention.cause.parentRunId');
      assertIdentifier(cause.delegationId, 'turn.intention.cause.delegationId');
      assertSha256Digest(cause.objectiveDigest, 'turn.intention.cause.objectiveDigest');
      return;
    case 'effect_results':
      assertExactObjectKeys(
        cause,
        [
          'kind',
          'sourceTurnId',
          'sourceAttemptId',
          'sourceDirectiveDigest',
          'effectIds',
          'toolCallIds',
          ...(cause.inboxInputIds === undefined ? [] : ['inboxInputIds'])
        ],
        'turn.intention.cause'
      );
      assertIdentifier(cause.sourceTurnId, 'turn.intention.cause.sourceTurnId');
      assertIdentifier(cause.sourceAttemptId, 'turn.intention.cause.sourceAttemptId');
      assertSha256Digest(
        cause.sourceDirectiveDigest,
        'turn.intention.cause.sourceDirectiveDigest'
      );
      assertDenseDataArray(cause.effectIds, 'turn.intention.cause.effectIds');
      assertDenseDataArray(cause.toolCallIds, 'turn.intention.cause.toolCallIds');
      assertUniqueCanonicalPublicIds(cause.effectIds, 'turn.intention.cause.effectIds');
      assertUniqueCanonicalPublicIds(cause.toolCallIds, 'turn.intention.cause.toolCallIds');
      if (cause.effectIds.length !== cause.toolCallIds.length || cause.effectIds.length === 0) {
        throw new AgentRunInvariantError(
          'Effect-result Turn causes require non-empty paired Effect and Tool-call identities.'
        );
      }
      if (cause.inboxInputIds !== undefined) {
        assertDenseDataArray(cause.inboxInputIds, 'turn.intention.cause.inboxInputIds');
        assertUniqueCanonicalPublicIds(
          cause.inboxInputIds,
          'turn.intention.cause.inboxInputIds'
        );
      }
      return;
    case 'inbox_inputs':
      assertExactObjectKeys(
        cause,
        [
          'kind',
          'sourceTurnId',
          'sourceAttemptId',
          'sourceDirectiveDigest',
          'inputIds'
        ],
        'turn.intention.cause'
      );
      assertIdentifier(cause.sourceTurnId, 'turn.intention.cause.sourceTurnId');
      assertIdentifier(cause.sourceAttemptId, 'turn.intention.cause.sourceAttemptId');
      assertSha256Digest(
        cause.sourceDirectiveDigest,
        'turn.intention.cause.sourceDirectiveDigest'
      );
      assertDenseDataArray(cause.inputIds, 'turn.intention.cause.inputIds');
      assertUniqueCanonicalPublicIds(cause.inputIds, 'turn.intention.cause.inputIds');
      if (cause.inputIds.length === 0) {
        throw new AgentRunInvariantError(
          'Inbox continuation requires at least one claimed input.'
        );
      }
      return;
    case 'child_results':
      assertExactObjectKeys(
        cause,
        [
          'kind',
          'sourceTurnId',
          'sourceAttemptId',
          'sourceDirectiveDigest',
          'delegationIds',
          'childRunIds'
        ],
        'turn.intention.cause'
      );
      assertIdentifier(cause.sourceTurnId, 'turn.intention.cause.sourceTurnId');
      assertIdentifier(cause.sourceAttemptId, 'turn.intention.cause.sourceAttemptId');
      assertSha256Digest(
        cause.sourceDirectiveDigest,
        'turn.intention.cause.sourceDirectiveDigest'
      );
      assertDenseDataArray(cause.delegationIds, 'turn.intention.cause.delegationIds');
      assertDenseDataArray(cause.childRunIds, 'turn.intention.cause.childRunIds');
      assertUniqueCanonicalPublicIds(
        cause.delegationIds,
        'turn.intention.cause.delegationIds'
      );
      assertUniqueCanonicalPublicIds(cause.childRunIds, 'turn.intention.cause.childRunIds');
      if (
        cause.delegationIds.length === 0
        || cause.delegationIds.length !== cause.childRunIds.length
      ) {
        throw new AgentRunInvariantError(
          'Child-result Turn causes require non-empty paired Delegation and child Run identities.'
        );
      }
      return;
      return;
  }
}

function assertDenseDataArray(value: unknown, path: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new AgentRunInvariantError(`${path} must be an array.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (
    ownKeys.length !== expected.size
    || ownKeys.some((key) => typeof key === 'symbol' || !expected.has(key))
  ) {
    throw new AgentRunInvariantError(`${path} must be a dense data-only array.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new AgentRunInvariantError(`${path} must be a dense data-only array.`);
    }
  }
}

function assertInputSummary(summary: AgentTurnInputSummary): void {
  if (!isPlainObject(summary)) {
    throw new AgentRunInvariantError('turn.intention.inputSummary must be a plain object.');
  }
  assertExactObjectKeys(
    summary,
    ['messageCount', 'toolCount', 'contentCharacterCount'],
    'turn.intention.inputSummary'
  );
  assertSafeNonNegativeInteger(
    summary.messageCount,
    'turn.intention.inputSummary.messageCount',
    MAX_SUMMARY_COUNT
  );
  assertSafeNonNegativeInteger(
    summary.toolCount,
    'turn.intention.inputSummary.toolCount',
    MAX_SUMMARY_COUNT
  );
  assertSafeNonNegativeInteger(
    summary.contentCharacterCount,
    'turn.intention.inputSummary.contentCharacterCount',
    MAX_SUMMARY_COUNT
  );
}

function assertValidAttemptCause(cause: AgentInferenceAttemptCause): void {
  if (!isPlainObject(cause)) {
    throw new AgentRunInvariantError('inferenceAttempt.cause must be a plain object.');
  }
  if (cause.kind === 'initial') {
    assertExactObjectKeys(cause, ['kind'], 'inferenceAttempt.cause');
    return;
  }
  if (cause.kind === 'recovery_retry') {
    assertExactObjectKeys(
      cause,
      ['kind', 'causedByAttemptId', 'recoveryDecisionId'],
      'inferenceAttempt.cause'
    );
    assertIdentifier(cause.causedByAttemptId, 'inferenceAttempt.cause.causedByAttemptId');
    assertIdentifier(cause.recoveryDecisionId, 'inferenceAttempt.cause.recoveryDecisionId');
    return;
  }
  throw new AgentRunInvariantError('inferenceAttempt.cause.kind is invalid.');
}

function assertValidAttemptState(state: AgentInferenceAttemptState): void {
  if (!isPlainObject(state)) {
    throw new AgentRunInvariantError('inferenceAttempt.state must be a plain object.');
  }
  switch (state.status) {
    case 'intended':
      assertExactObjectKeys(state, ['status', 'intendedAt'], 'inferenceAttempt.state');
      assertTimestamp(state.intendedAt, 'inferenceAttempt.state.intendedAt');
      return;
    case 'started':
      assertExactObjectKeys(state, ['status', 'startedAt'], 'inferenceAttempt.state');
      assertTimestamp(state.startedAt, 'inferenceAttempt.state.startedAt');
      return;
    case 'succeeded':
      assertExactObjectKeys(
        state,
        ['status', 'finishedAt', 'directive', 'directiveDigest'],
        'inferenceAttempt.state'
      );
      assertTimestamp(state.finishedAt, 'inferenceAttempt.state.finishedAt');
      assertValidCommittedAgentDirective(state.directive);
      assertSha256Digest(state.directiveDigest, 'inferenceAttempt.state.directiveDigest');
      return;
    case 'failed':
      assertExactObjectKeys(
        state,
        ['status', 'finishedAt', 'errorCode', 'message'],
        'inferenceAttempt.state'
      );
      assertTimestamp(state.finishedAt, 'inferenceAttempt.state.finishedAt');
      assertIdentifier(state.errorCode, 'inferenceAttempt.state.errorCode');
      assertBoundedNonEmpty(
        state.message,
        'inferenceAttempt.state.message',
        MAX_FAILURE_MESSAGE_LENGTH
      );
      return;
    case 'uncertain':
      assertExactObjectKeys(
        state,
        ['status', 'observedAt', 'reason', 'recovery'],
        'inferenceAttempt.state'
      );
      assertTimestamp(state.observedAt, 'inferenceAttempt.state.observedAt');
      assertBoundedNonEmpty(
        state.reason,
        'inferenceAttempt.state.reason',
        MAX_FAILURE_MESSAGE_LENGTH
      );
      assertValidRecoveryDecision(state.recovery, state.observedAt);
      return;
    case 'cancelled':
      assertExactObjectKeys(
        state,
        ['status', 'cancelledAt', 'reason', 'cancellation'],
        'inferenceAttempt.state'
      );
      assertTimestamp(state.cancelledAt, 'inferenceAttempt.state.cancelledAt');
      assertBoundedNonEmpty(
        state.reason,
        'inferenceAttempt.state.reason',
        MAX_FAILURE_MESSAGE_LENGTH
      );
      assertValidCancellation(state.cancellation);
      return;
    default:
      throw new AgentRunInvariantError('inferenceAttempt.state.status is invalid.');
  }
}

function assertValidRecoveryDecision(
  recovery: AgentInferenceRecoveryDecision,
  requestedAt: string
): void {
  if (!isPlainObject(recovery)) {
    throw new AgentRunInvariantError('inferenceAttempt.recovery must be a plain object.');
  }
  assertExactObjectKeys(
    recovery,
    ['decisionId', 'requestedAt', 'allowedActions'],
    'inferenceAttempt.recovery'
  );
  assertIdentifier(recovery.decisionId, 'inferenceAttempt.recovery.decisionId');
  assertTimestamp(recovery.requestedAt, 'inferenceAttempt.recovery.requestedAt');
  if (recovery.requestedAt !== requestedAt) {
    throw new AgentRunInvariantError(
      'An inference recovery decision must be created with the uncertain observation.'
    );
  }
  assertUniqueNonEmpty(recovery.allowedActions, 'inferenceAttempt.recovery.allowedActions');
  if (recovery.allowedActions.length === 0) {
    throw new AgentRunInvariantError(
      'An inference recovery decision must expose at least one action.'
    );
  }
  const allowed = new Set<AgentInferenceRecoveryAction>([
    'retry',
    'mark_succeeded',
    'mark_failed',
    'cancel_run'
  ]);
  if (recovery.allowedActions.some((action) => !allowed.has(action))) {
    throw new AgentRunInvariantError('An inference recovery action is invalid.');
  }
}

function assertValidCancellation(
  cancellation: AgentInferenceCancellation
): void {
  if (!isPlainObject(cancellation)) {
    throw new AgentRunInvariantError('inferenceAttempt.cancellation must be a plain object.');
  }
  if (cancellation.kind === 'before_start') {
    assertExactObjectKeys(cancellation, ['kind'], 'inferenceAttempt.cancellation');
    return;
  }
  if (cancellation.kind === 'provider_acknowledged') {
    assertExactObjectKeys(
      cancellation,
      ['kind', 'acknowledgementId'],
      'inferenceAttempt.cancellation'
    );
    assertIdentifier(
      cancellation.acknowledgementId,
      'inferenceAttempt.cancellation.acknowledgementId'
    );
    return;
  }
  throw new AgentRunInvariantError('inferenceAttempt.cancellation.kind is invalid.');
}

function assertResultSource(
  attempt: AgentInferenceAttempt,
  recoveryDecisionId: string | undefined,
  recoveryAction: 'mark_succeeded' | 'mark_failed'
): void {
  const current = attempt.state;
  if (current.status === 'started') {
    if (recoveryDecisionId !== undefined) {
      throw new AgentInferenceAttemptTransitionError(
        'A direct inference result cannot carry a recovery decision identity.'
      );
    }
    return;
  }
  if (
    current.status === 'uncertain'
    && recoveryDecisionId === current.recovery.decisionId
    && current.recovery.allowedActions.includes(recoveryAction)
  ) {
    return;
  }
  throw invalidTransition(attempt, recoveryAction);
}

function timestampForState(state: AgentInferenceAttemptState): string {
  switch (state.status) {
    case 'intended': return state.intendedAt;
    case 'started': return state.startedAt;
    case 'succeeded':
    case 'failed': return state.finishedAt;
    case 'uncertain': return state.observedAt;
    case 'cancelled': return state.cancelledAt;
  }
}

function invalidTransition(
  attempt: AgentInferenceAttempt,
  transition: string
): AgentInferenceAttemptTransitionError {
  return new AgentInferenceAttemptTransitionError(
    `Inference attempt "${attempt.attemptId}" cannot transition from `
      + `"${attempt.state.status}" via "${transition}".`
  );
}

function assertIdentifier(value: string, field: string): void {
  assertCanonicalPublicId(value, field);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactObjectKeys(
  value: object,
  keys: readonly string[],
  field: string
): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new AgentRunInvariantError(
      `${field} contains unsupported field "${unexpected}".`
    );
  }
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing !== undefined) {
    throw new AgentRunInvariantError(`${field} is missing required field "${missing}".`);
  }
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize(record[key])}`
  ).join(',')}}`;
}

function assertUnique(values: Set<string>, value: string, field: string): void {
  if (values.has(value)) {
    throw new AgentRunInvariantError(`Turn attempts must have unique ${field} values.`);
  }
  values.add(value);
}
