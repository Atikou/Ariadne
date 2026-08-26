import type { AgentRun, AgentRunState } from '../domain/agent-run.js';
import {
  type AgentDecision,
  type PermissionDecision,
  assertValidDecision
} from '../domain/decision.js';
import type { AgentCommittedDirective } from '../domain/directive.js';
import {
  type AgentEffect,
  type AgentEffectOrigin,
  assertValidEffect,
  transitionAgentEffect
} from '../domain/effect.js';
import { AgentRunTransitionError } from '../domain/errors.js';
import {
  type AgentInferenceAttempt,
  type AgentInferenceAttemptTransition,
  type AgentTurn,
  transitionAgentInferenceAttempt
} from '../domain/turn.js';
import type { RecordAgentInferenceAttemptResultCommand } from './commands.js';
import type { AgentRunEventPayload } from './events.js';

export interface AgentInferenceResultMutation {
  readonly state: AgentRunState;
  readonly turns: readonly AgentTurn[];
  readonly effects: readonly AgentEffect[];
  readonly events: readonly AgentRunEventPayload[];
}

/** Applies an inference result and its complete downstream meaning atomically. */
export function applyAgentInferenceResult(
  run: AgentRun,
  command: RecordAgentInferenceAttemptResultCommand
): AgentInferenceResultMutation {
  const turn = requireTurn(run, command.turnId);
  const attempt = requireAttempt(turn, command.attemptId);
  assertResultRunState(run, turn, attempt, command);

  const checkpointVersion = run.state.checkpointVersion + 1;
  const transition = attemptTransition(command);
  const nextAttempt = transitionAgentInferenceAttempt(attempt, transition);
  const nextTurn: AgentTurn = {
    ...turn,
    attempts: turn.attempts.map((candidate) =>
      candidate.attemptId === attempt.attemptId ? nextAttempt : candidate
    )
  };
  const events: AgentRunEventPayload[] = [{
    type: 'inference_attempt.transitioned',
    turnId: turn.turnId,
    attemptId: attempt.attemptId,
    from: attempt.state,
    to: nextAttempt.state
  }];
  const turns = run.turns.map((candidate) =>
    candidate.turnId === turn.turnId ? nextTurn : candidate
  );

  switch (command.result.status) {
    case 'uncertain':
      return {
        state: {
          status: 'recovering',
          reason: 'uncertain_inference',
          checkpointVersion,
          turnId: turn.turnId,
          attemptId: attempt.attemptId
        },
        turns,
        effects: run.effects,
        events
      };
    case 'failed':
      events.push({
        type: 'run.failed',
        errorCode: command.result.errorCode,
        message: command.result.message
      });
      return {
        state: {
          status: 'failed',
          checkpointVersion,
          failedAt: command.occurredAt,
          errorCode: command.result.errorCode,
          message: command.result.message
        },
        turns,
        effects: run.effects,
        events
      };
    case 'cancelled':
      events.push({ type: 'run.cancelled', reason: command.result.reason });
      return {
        state: {
          status: 'cancelled',
          checkpointVersion,
          cancelledAt: command.occurredAt,
          reason: command.result.reason
        },
        turns,
        effects: run.effects,
        events
      };
    case 'succeeded':
      return applySucceededDirective(
        run,
        command.occurredAt,
        checkpointVersion,
        turns,
        events,
        command.result.directive,
        {
          turnId: turn.turnId,
          attemptId: attempt.attemptId,
          directiveDigest: command.result.directiveDigest
        }
      );
  }
}

function applySucceededDirective(
  run: AgentRun,
  occurredAt: string,
  checkpointVersion: number,
  turns: readonly AgentTurn[],
  events: AgentRunEventPayload[],
  directive: AgentCommittedDirective,
  origin: AgentEffectOrigin
): AgentInferenceResultMutation {
  switch (directive.kind) {
    case 'respond':
      if (run.inbox.some((input) => input.state === 'queued')) {
        return {
          state: { status: 'running', checkpointVersion, enteredAt: occurredAt },
          turns,
          effects: run.effects,
          events
        };
      }
      events.push({ type: 'run.completed' });
      return terminalMutation(
        {
          status: 'completed',
          checkpointVersion,
          completedAt: occurredAt
        },
        run.effects,
        turns,
        events
      );
    case 'complete': {
      if (run.inbox.some((input) => input.state === 'queued')) {
        return {
          state: { status: 'running', checkpointVersion, enteredAt: occurredAt },
          turns,
          effects: run.effects,
          events
        };
      }
      const state: AgentRunState = directive.outputRef === undefined
        ? {
            status: 'completed',
            checkpointVersion,
            completedAt: occurredAt
          }
        : {
            status: 'completed',
            checkpointVersion,
            completedAt: occurredAt,
            outputRef: directive.outputRef
          };
      events.push(
        directive.outputRef === undefined
          ? { type: 'run.completed' }
          : { type: 'run.completed', outputRef: directive.outputRef }
      );
      return terminalMutation(state, run.effects, turns, events);
    }
    case 'fail':
      events.push({
        type: 'run.failed',
        errorCode: directive.errorCode,
        message: directive.messageRef
      });
      return terminalMutation(
        {
          status: 'failed',
          checkpointVersion,
          failedAt: occurredAt,
          errorCode: directive.errorCode,
          message: directive.messageRef
        },
        run.effects,
        turns,
        events
      );
    case 'checkpoint':
      return {
        state: { status: 'running', checkpointVersion, enteredAt: occurredAt },
        turns,
        effects: run.effects,
        events
      };
    case 'request_decision': {
      if (directive.decision.requestedAt !== occurredAt) {
        throw new AgentRunTransitionError(
          'A planned decision timestamp must equal its result commit timestamp.'
        );
      }
      const decision: AgentDecision = {
        ...directive.decision,
        runId: run.runId,
        checkpoint: { runId: run.runId, version: checkpointVersion }
      };
      assertValidDecision(decision);
      events.push({ type: 'decision.requested', decision });
      return {
        state: {
          status: 'waiting',
          reason: 'plan_approval',
          checkpointVersion,
          decision
        },
        turns,
        effects: run.effects,
        events
      };
    }
    case 'invoke_tools':
      return applyToolInvocations(
        run,
        occurredAt,
        checkpointVersion,
        turns,
        events,
        directive,
        origin
      );
  }
}

function applyToolInvocations(
  run: AgentRun,
  occurredAt: string,
  checkpointVersion: number,
  turns: readonly AgentTurn[],
  events: AgentRunEventPayload[],
  directive: Extract<AgentCommittedDirective, { readonly kind: 'invoke_tools' }>,
  origin: AgentEffectOrigin
): AgentInferenceResultMutation {
  if (
    run.effects.length + directive.invocations.length
    > run.binding.budget.vector.toolCalls
  ) {
    throw new AgentRunTransitionError(
      'A committed Directive exceeds the immutable Run tool-call budget.'
    );
  }
  const introduced = directive.invocations.map((invocation): AgentEffect => {
    const effect: AgentEffect = {
      effectId: invocation.effectId,
      runId: run.runId,
      toolCallId: invocation.toolCallId,
      tool: invocation.tool,
      idempotencyKey: invocation.idempotencyKey,
      capabilityIds: [...invocation.capabilityIds],
      scope: [...invocation.scope],
      inputDigest: invocation.inputDigest,
      origin,
      state: { status: 'intended', intendedAt: occurredAt }
    };
    assertValidEffect(effect);
    events.push({ type: 'effect.registered', effect });
    return effect;
  });
  let effects = [...run.effects, ...introduced];

  const waitingInvocation = directive.invocations.find(
    (invocation) => invocation.permissionDecisionId !== undefined
  );
  if (waitingInvocation === undefined) {
    if (run.binding.policy.permissionMode !== 'trusted') {
      throw new AgentRunTransitionError(
        'An ask-mode tool Directive requires a stable permission decision identity.'
      );
    }
    for (const invocation of directive.invocations) {
      const effect = requireEffect(effects, invocation.effectId);
      const authorized = transitionAgentEffect(effect, {
        type: 'authorize',
        at: occurredAt
      });
      effects = effects.map((candidate) =>
        candidate.effectId === effect.effectId ? authorized : candidate
      );
      events.push({
        type: 'effect.transitioned',
        effectId: effect.effectId,
        from: effect.state,
        to: authorized.state
      });
    }
    return {
      state: { status: 'running', checkpointVersion, enteredAt: occurredAt },
      turns,
      effects,
      events
    };
  }

  if (directive.invocations.length !== 1) {
    throw new AgentRunTransitionError(
      'A waiting tool admission requires exactly one atomic invocation.'
    );
  }
  const invocation = directive.invocations[0];
  if (
    invocation === undefined
    || invocation !== waitingInvocation
    || invocation.permissionDecisionId === undefined
  ) {
    throw new AgentRunTransitionError(
      'A waiting tool Directive requires a stable permission decision identity.'
    );
  }
  const effect = requireEffect(effects, invocation.effectId);
  const decision: PermissionDecision = {
    kind: 'permission',
    decisionId: invocation.permissionDecisionId,
    runId: run.runId,
    checkpoint: { runId: run.runId, version: checkpointVersion },
    requestedAt: occurredAt,
    effectId: effect.effectId,
    toolCallId: effect.toolCallId,
    capabilityIds: [...effect.capabilityIds],
    scope: [...effect.scope]
  };
  assertValidDecision(decision);
  events.push({ type: 'decision.requested', decision });
  return {
    state: {
      status: 'waiting',
      reason: 'tool_permission',
      checkpointVersion,
      decision
    },
    turns,
    effects,
    events
  };
}

function attemptTransition(
  command: RecordAgentInferenceAttemptResultCommand
): AgentInferenceAttemptTransition {
  switch (command.result.status) {
    case 'succeeded':
      return {
        type: 'succeed',
        at: command.occurredAt,
        directive: command.result.directive,
        directiveDigest: command.result.directiveDigest,
        ...(command.recoveryDecisionId === undefined
          ? {}
          : { recoveryDecisionId: command.recoveryDecisionId })
      };
    case 'failed':
      return {
        type: 'fail',
        at: command.occurredAt,
        errorCode: command.result.errorCode,
        message: command.result.message,
        ...(command.recoveryDecisionId === undefined
          ? {}
          : { recoveryDecisionId: command.recoveryDecisionId })
      };
    case 'uncertain':
      if (command.recoveryDecisionId !== undefined) {
        throw new AgentRunTransitionError(
          'A fresh uncertain result cannot carry a prior recovery decision identity.'
        );
      }
      return {
        type: 'mark_uncertain',
        at: command.occurredAt,
        reason: command.result.reason,
        recovery: {
          decisionId: command.result.recoveryDecisionId,
          requestedAt: command.occurredAt,
          allowedActions: command.result.allowedActions
        }
      };
    case 'cancelled':
      if (command.recoveryDecisionId !== undefined) {
        throw new AgentRunTransitionError(
          'A Provider-acknowledged cancellation cannot resolve an uncertain inference.'
        );
      }
      return {
        type: 'cancel',
        at: command.occurredAt,
        reason: command.result.reason,
        providerCancellationAcknowledgementId:
          command.result.providerCancellationAcknowledgementId
      };
  }
}

function assertResultRunState(
  run: AgentRun,
  turn: AgentTurn,
  attempt: AgentInferenceAttempt,
  command: RecordAgentInferenceAttemptResultCommand
): void {
  if (attempt.state.status === 'uncertain') {
    if (
      run.state.status !== 'recovering'
      || run.state.reason !== 'uncertain_inference'
      || run.state.turnId !== turn.turnId
      || run.state.attemptId !== attempt.attemptId
    ) {
      throw invalidRunState(run, command.kind);
    }
    return;
  }
  if (run.state.status !== 'running') throw invalidRunState(run, command.kind);
}

function terminalMutation(
  state: AgentRunState,
  effects: readonly AgentEffect[],
  turns: readonly AgentTurn[],
  events: readonly AgentRunEventPayload[]
): AgentInferenceResultMutation {
  return { state, effects, turns, events };
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

function requireAttempt(
  turn: AgentTurn,
  attemptId: string
): AgentInferenceAttempt {
  const attempt = turn.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (attempt === undefined) {
    throw new AgentRunTransitionError(
      `Inference attempt "${attemptId}" does not belong to Turn "${turn.turnId}".`
    );
  }
  return attempt;
}

function requireEffect(
  effects: readonly AgentEffect[],
  effectId: string
): AgentEffect {
  const effect = effects.find((candidate) => candidate.effectId === effectId);
  if (effect === undefined) {
    throw new AgentRunTransitionError(`Effect "${effectId}" is missing.`);
  }
  return effect;
}

function invalidRunState(
  run: AgentRun,
  commandKind: RecordAgentInferenceAttemptResultCommand['kind']
): AgentRunTransitionError {
  return new AgentRunTransitionError(
    `Run "${run.runId}" cannot handle "${commandKind}" while "${run.state.status}".`
  );
}
