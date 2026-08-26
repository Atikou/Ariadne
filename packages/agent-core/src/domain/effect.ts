import { AgentEffectTransitionError, AgentRunInvariantError } from './errors.js';
import {
  type AgentPinnedToolIdentity,
  assertValidAgentPinnedToolIdentity
} from './tool.js';
import {
  type AgentDecisionId,
  type AgentEffectId,
  type AgentRunId,
  assertCanonicalSortedPublicIds,
  assertCanonicalPublicId,
  assertNonEmpty,
  assertPositiveInteger,
  assertSha256Digest,
  assertTimestamp
} from './values.js';

export type AgentEffectState =
  | {
      readonly status: 'intended';
      readonly intendedAt: string;
    }
  | {
      readonly status: 'authorized';
      readonly authorizedAt: string;
      readonly attempt: number;
      readonly decisionId?: AgentDecisionId;
    }
  | {
      readonly status: 'started';
      readonly startedAt: string;
      readonly attempt: number;
    }
  | {
      readonly status: 'succeeded';
      readonly finishedAt: string;
      readonly attempt: number;
      readonly outputRef?: string;
    }
  | {
      readonly status: 'failed';
      readonly finishedAt: string;
      readonly attempt: number;
      readonly errorCode: string;
      readonly message: string;
    }
  | {
      readonly status: 'uncertain';
      readonly observedAt: string;
      readonly attempt: number;
      readonly reason: string;
    }
  | {
      readonly status: 'cancelled';
      readonly cancelledAt: string;
      readonly attempts: number;
      readonly reason: string;
    };

export interface AgentEffectOrigin {
  readonly turnId: string;
  readonly attemptId: string;
  readonly directiveDigest: string;
}

export interface AgentEffect {
  readonly effectId: AgentEffectId;
  readonly runId: AgentRunId;
  readonly toolCallId: string;
  readonly tool: AgentPinnedToolIdentity;
  readonly idempotencyKey: string;
  readonly capabilityIds: readonly string[];
  readonly scope: readonly string[];
  readonly inputDigest: string;
  /** Exact inference fact that introduced this Effect, when Engine-derived. */
  readonly origin?: AgentEffectOrigin;
  readonly state: AgentEffectState;
}

export type AgentEffectTransition =
  | {
      readonly type: 'authorize';
      readonly at: string;
      readonly decisionId?: AgentDecisionId;
    }
  | {
      readonly type: 'start';
      readonly at: string;
    }
  | {
      readonly type: 'succeed';
      readonly at: string;
      readonly outputRef?: string;
    }
  | {
      readonly type: 'fail';
      readonly at: string;
      readonly errorCode: string;
      readonly message: string;
    }
  | {
      readonly type: 'mark_uncertain';
      readonly at: string;
      readonly reason: string;
    }
  | {
      readonly type: 'cancel';
      readonly at: string;
      readonly reason: string;
    };

export function assertValidEffect(effect: AgentEffect): void {
  assertCanonicalPublicId(effect.effectId, 'effect.effectId');
  assertCanonicalPublicId(effect.runId, 'effect.runId');
  assertCanonicalPublicId(effect.toolCallId, 'effect.toolCallId');
  assertValidAgentPinnedToolIdentity(effect.tool, 'effect.tool');
  assertCanonicalPublicId(effect.idempotencyKey, 'effect.idempotencyKey');
  assertSha256Digest(effect.inputDigest, 'effect.inputDigest');
  if (effect.origin !== undefined) {
    assertCanonicalPublicId(effect.origin.turnId, 'effect.origin.turnId');
    assertCanonicalPublicId(effect.origin.attemptId, 'effect.origin.attemptId');
    assertSha256Digest(
      effect.origin.directiveDigest,
      'effect.origin.directiveDigest'
    );
  }
  assertCanonicalSortedPublicIds(effect.capabilityIds, 'effect.capabilityIds');
  assertCanonicalSortedPublicIds(effect.scope, 'effect.scope');

  const state = effect.state;
  switch (state.status) {
    case 'intended':
      assertTimestamp(state.intendedAt, 'effect.state.intendedAt');
      return;
    case 'authorized':
      assertTimestamp(state.authorizedAt, 'effect.state.authorizedAt');
      assertPositiveInteger(state.attempt, 'effect.state.attempt');
      if (state.decisionId !== undefined) {
        assertCanonicalPublicId(state.decisionId, 'effect.state.decisionId');
      }
      return;
    case 'started':
      assertTimestamp(state.startedAt, 'effect.state.startedAt');
      assertPositiveInteger(state.attempt, 'effect.state.attempt');
      return;
    case 'succeeded':
      assertTimestamp(state.finishedAt, 'effect.state.finishedAt');
      assertPositiveInteger(state.attempt, 'effect.state.attempt');
      if (state.outputRef !== undefined) {
        assertNonEmpty(state.outputRef, 'effect.state.outputRef');
      }
      return;
    case 'failed':
      assertTimestamp(state.finishedAt, 'effect.state.finishedAt');
      assertPositiveInteger(state.attempt, 'effect.state.attempt');
      assertCanonicalPublicId(state.errorCode, 'effect.state.errorCode');
      assertNonEmpty(state.message, 'effect.state.message');
      return;
    case 'uncertain':
      assertTimestamp(state.observedAt, 'effect.state.observedAt');
      assertPositiveInteger(state.attempt, 'effect.state.attempt');
      assertNonEmpty(state.reason, 'effect.state.reason');
      return;
    case 'cancelled':
      assertTimestamp(state.cancelledAt, 'effect.state.cancelledAt');
      if (!Number.isSafeInteger(state.attempts) || state.attempts < 0) {
        throw new AgentRunInvariantError(
          'effect.state.attempts must be a non-negative safe integer.'
        );
      }
      assertNonEmpty(state.reason, 'effect.state.reason');
  }
}

export function transitionAgentEffect(
  effect: AgentEffect,
  transition: AgentEffectTransition
): AgentEffect {
  assertValidEffect(effect);
  assertTimestamp(transition.at, 'effect.transition.at');

  const current = effect.state;
  if (Date.parse(transition.at) < Date.parse(timestampForState(current))) {
    throw new AgentEffectTransitionError(
      `Effect "${effect.effectId}" cannot move backwards in time.`
    );
  }
  let state: AgentEffectState;

  switch (transition.type) {
    case 'authorize': {
      if (current.status !== 'intended' && current.status !== 'uncertain') {
        throw invalidEffectTransition(effect, transition.type);
      }
      const attempt = current.status === 'uncertain' ? current.attempt + 1 : 1;
      state = transition.decisionId === undefined
        ? { status: 'authorized', authorizedAt: transition.at, attempt }
        : {
            status: 'authorized',
            authorizedAt: transition.at,
            attempt,
            decisionId: transition.decisionId
          };
      break;
    }
    case 'start':
      if (current.status !== 'authorized') {
        throw invalidEffectTransition(effect, transition.type);
      }
      state = {
        status: 'started',
        startedAt: transition.at,
        attempt: current.attempt
      };
      break;
    case 'succeed':
      if (current.status !== 'started' && current.status !== 'uncertain') {
        throw invalidEffectTransition(effect, transition.type);
      }
      state = transition.outputRef === undefined
        ? {
            status: 'succeeded',
            finishedAt: transition.at,
            attempt: current.attempt
          }
        : {
            status: 'succeeded',
            finishedAt: transition.at,
            attempt: current.attempt,
            outputRef: transition.outputRef
          };
      break;
    case 'fail':
      if (current.status !== 'started' && current.status !== 'uncertain') {
        throw invalidEffectTransition(effect, transition.type);
      }
      assertCanonicalPublicId(transition.errorCode, 'effect.transition.errorCode');
      assertNonEmpty(transition.message, 'effect.transition.message');
      state = {
        status: 'failed',
        finishedAt: transition.at,
        attempt: current.attempt,
        errorCode: transition.errorCode,
        message: transition.message
      };
      break;
    case 'mark_uncertain':
      if (current.status !== 'started') {
        throw invalidEffectTransition(effect, transition.type);
      }
      assertNonEmpty(transition.reason, 'effect.transition.reason');
      state = {
        status: 'uncertain',
        observedAt: transition.at,
        attempt: current.attempt,
        reason: transition.reason
      };
      break;
    case 'cancel':
      if (isTerminalEffectState(current)) {
        throw invalidEffectTransition(effect, transition.type);
      }
      assertNonEmpty(transition.reason, 'effect.transition.reason');
      state = {
        status: 'cancelled',
        cancelledAt: transition.at,
        attempts: attemptsForState(current),
        reason: transition.reason
      };
      break;
  }

  const next = { ...effect, state };
  assertValidEffect(next);
  return next;
}

export function isTerminalEffect(effect: AgentEffect): boolean {
  return isTerminalEffectState(effect.state);
}

function isTerminalEffectState(state: AgentEffectState): boolean {
  return state.status === 'succeeded'
    || state.status === 'failed'
    || state.status === 'cancelled';
}

function attemptsForState(state: AgentEffectState): number {
  switch (state.status) {
    case 'intended':
      return 0;
    case 'authorized':
    case 'started':
    case 'succeeded':
    case 'failed':
    case 'uncertain':
      return state.attempt;
    case 'cancelled':
      return state.attempts;
  }
}

function timestampForState(state: AgentEffectState): string {
  switch (state.status) {
    case 'intended':
      return state.intendedAt;
    case 'authorized':
      return state.authorizedAt;
    case 'started':
      return state.startedAt;
    case 'succeeded':
    case 'failed':
      return state.finishedAt;
    case 'uncertain':
      return state.observedAt;
    case 'cancelled':
      return state.cancelledAt;
  }
}

function invalidEffectTransition(
  effect: AgentEffect,
  transition: AgentEffectTransition['type']
): AgentEffectTransitionError {
  return new AgentEffectTransitionError(
    `Effect "${effect.effectId}" cannot transition from "${effect.state.status}" via "${transition}".`
  );
}
