import type {
  AgentRunCommand,
  AdmitAgentRunCommand,
  AuthorizeAgentEffectCommand,
  BeginAgentRunCommand,
  CancelAgentRunCommand,
  CompleteAgentRunCommand,
  FailAgentRunCommand,
  RecordAgentEffectResultCommand,
  RegisterAgentEffectCommand,
  RequestAgentDecisionCommand,
  ResolveAgentDecisionCommand,
  StartAgentEffectCommand,
  StartAgentRunCommand
} from './commands.js';
import type { AgentRunEventPayload } from './events.js';
import {
  type AgentRun,
  type AgentRunState,
  assertValidAgentRun,
  isTerminalAgentRun
} from '../domain/agent-run.js';
import {
  type AgentDecision,
  type AgentDecisionResolution,
  type PermissionDecision,
  type PlanDecision,
  type RecoveryDecision,
  assertValidDecision
} from '../domain/decision.js';
import {
  type AgentEffect,
  type AgentEffectTransition,
  assertValidEffect,
  isTerminalEffect,
  transitionAgentEffect
} from '../domain/effect.js';
import type { AgentTurn } from '../domain/turn.js';
import {
  AgentRunInvariantError,
  AgentRunTransitionError
} from '../domain/errors.js';
import {
  assertNonEmpty,
  assertCanonicalPublicId,
  assertPositiveInteger,
  assertTimestamp,
  assertUniqueNonEmpty
} from '../domain/values.js';
import {
  type AgentTurnMutation,
  assertNoOpenAgentInferenceAttempts,
  assertNoStartedAgentInferenceAttempts,
  authorizeInferenceCancelRun,
  cancelOpenAgentInferenceAttempts,
  registerAgentTurn,
  retryAgentInferenceAttempt,
  startAgentInferenceAttempt
} from './transition-agent-turn.js';
import {
  applyAgentInferenceResult,
  type AgentInferenceResultMutation
} from './apply-agent-inference-result.js';

export interface AgentRunTransition {
  readonly run: AgentRun;
  readonly events: readonly AgentRunEventPayload[];
}

type ExistingAgentRunCommand = Exclude<
  AgentRunCommand,
  StartAgentRunCommand | AdmitAgentRunCommand
>;

export function createAgentRun(
  command: StartAgentRunCommand
): AgentRunTransition {
  assertCommandMetadata(command);

  const state: AgentRunState = {
    status: 'queued',
    checkpointVersion: 0,
    queuedAt: command.occurredAt
  };
  const run: AgentRun = {
    runId: command.runId,
    version: 1,
    binding: command.binding,
    state,
    turns: [],
    effects: [],
    createdAt: command.occurredAt,
    updatedAt: command.occurredAt
  };
  assertValidAgentRun(run);

  return {
    run,
    events: [
      { type: 'run.started', binding: command.binding },
      { type: 'run.state_changed', from: 'absent', to: state }
    ]
  };
}

export function transitionAgentRun(
  run: AgentRun,
  command: ExistingAgentRunCommand
): AgentRunTransition {
  assertValidAgentRun(run);
  assertCommandMetadata(command);
  assertPositiveInteger(command.expectedVersion, 'command.expectedVersion');

  if (command.runId !== run.runId) {
    throw new AgentRunTransitionError(
      `Command run "${command.runId}" does not match aggregate "${run.runId}".`
    );
  }
  if (Date.parse(command.occurredAt) < Date.parse(run.updatedAt)) {
    throw new AgentRunTransitionError(
      `Command "${command.commandId}" cannot move run "${run.runId}" backwards in time.`
    );
  }
  if (isTerminalAgentRun(run)) {
    throw new AgentRunTransitionError(
      `Terminal run "${run.runId}" cannot handle "${command.kind}".`
    );
  }

  switch (command.kind) {
    case 'run.begin':
      return beginRun(run, command);
    case 'run.register_turn':
      return applyAgentTurnMutation(run, command.occurredAt, registerAgentTurn(run, command));
    case 'run.start_inference_attempt':
      return applyAgentTurnMutation(run, command.occurredAt, startAgentInferenceAttempt(run, command));
    case 'run.record_inference_attempt_result':
      return applyAgentInferenceResultMutation(
        run,
        command.occurredAt,
        applyAgentInferenceResult(run, command)
      );
    case 'run.retry_inference_attempt':
      return applyAgentTurnMutation(run, command.occurredAt, retryAgentInferenceAttempt(run, command));
    case 'run.request_decision':
      return requestDecision(run, command);
    case 'run.resolve_decision':
      return resolveDecision(run, command);
    case 'run.register_effect':
      return registerEffect(run, command);
    case 'run.authorize_effect':
      return authorizeEffect(run, command);
    case 'run.start_effect':
      return startEffect(run, command);
    case 'run.record_effect_result':
      return recordEffectResult(run, command);
    case 'run.complete':
      return completeRun(run, command);
    case 'run.fail':
      return failRun(run, command);
    case 'run.cancel':
      return cancelRun(run, command);
  }
}

function beginRun(
  run: AgentRun,
  command: BeginAgentRunCommand
): AgentRunTransition {
  requireState(run, 'queued', command.kind);
  const state: AgentRunState = {
    status: 'running',
    checkpointVersion: 1,
    enteredAt: command.occurredAt
  };
  return updateRun(run, command.occurredAt, state, run.effects, []);
}

function requestDecision(
  run: AgentRun,
  command: RequestAgentDecisionCommand
): AgentRunTransition {
  requireState(run, 'running', command.kind);
  assertNoStartedEffects(run, command.kind);
  assertNoOpenAgentInferenceAttempts(run, command.kind);
  const checkpointVersion = nextCheckpoint(run);
  const checkpoint = { runId: run.runId, version: checkpointVersion };
  const decision: AgentDecision = {
    ...command.decision,
    runId: run.runId,
    checkpoint
  };
  assertValidDecision(decision);
  if (decision.requestedAt !== command.occurredAt) {
    throw new AgentRunTransitionError(
      'A decision request timestamp must equal its committing command timestamp.'
    );
  }

  let state: AgentRunState;
  if (decision.kind === 'permission') {
    const effect = requireEffect(run, decision.effectId);
    if (
      effect.state.status !== 'intended'
      || effect.toolCallId !== decision.toolCallId
      || !sameValues(effect.capabilityIds, decision.capabilityIds)
      || !sameValues(effect.scope, decision.scope)
    ) {
      throw new AgentRunTransitionError(
        'A permission decision must bind exactly to an intended effect.'
      );
    }
    state = {
      status: 'waiting',
      reason: 'tool_permission',
      checkpointVersion,
      decision
    };
  } else {
    state = {
      status: 'waiting',
      reason: 'plan_approval',
      checkpointVersion,
      decision
    };
  }

  return updateRun(
    run,
    command.occurredAt,
    state,
    run.effects,
    [{ type: 'decision.requested', decision }]
  );
}

function resolveDecision(
  run: AgentRun,
  command: ResolveAgentDecisionCommand
): AgentRunTransition {
  if (
    run.state.status !== 'waiting'
    && !(
      run.state.status === 'recovering'
      && run.state.reason === 'uncertain_effect'
    )
  ) {
    throw invalidRunState(run, command.kind);
  }

  const decision = run.state.decision;
  assertExactResolution(run, decision, command.resolution, command.occurredAt);
  const checkpointVersion = nextCheckpoint(run);
  const events: AgentRunEventPayload[] = [{
    type: 'decision.resolved',
    decisionId: decision.decisionId,
    resolution: command.resolution
  }];
  let effects = run.effects;
  let state: AgentRunState = {
    status: 'running',
    checkpointVersion,
    enteredAt: command.occurredAt
  };

  if (decision.kind === 'permission' && command.resolution.kind === 'permission') {
    const effect = requireEffect(run, decision.effectId);
    const denied = command.resolution.outcome === 'deny';
    const transition: AgentEffectTransition = denied
      ? {
          type: 'cancel',
          at: command.occurredAt,
          reason: 'permission_denied'
        }
      : {
          type: 'authorize',
          at: command.occurredAt,
          decisionId: decision.decisionId
        };
    const replacement = replaceEffect(effects, effect, transition);
    effects = replacement.effects;
    events.push(replacement.event);
    if (denied) {
      state = {
        status: 'cancelled',
        checkpointVersion,
        cancelledAt: command.occurredAt,
        reason: 'permission_denied'
      };
      events.push({ type: 'run.cancelled', reason: 'permission_denied' });
    }
  } else if (
    decision.kind === 'recovery'
    && command.resolution.kind === 'recovery'
  ) {
    const effect = requireEffect(run, decision.effectId);
    if (effect.state.status !== 'uncertain') {
      throw new AgentRunTransitionError(
        'A recovery decision requires an uncertain effect.'
      );
    }

    switch (command.resolution.outcome) {
      case 'retry': {
        const replacement = replaceEffect(
          effects,
          effect,
          {
            type: 'authorize',
            at: command.occurredAt,
            decisionId: decision.decisionId
          }
        );
        effects = replacement.effects;
        events.push(replacement.event);
        break;
      }
      case 'mark_succeeded': {
        const replacement = replaceEffect(
          effects,
          effect,
          { type: 'succeed', at: command.occurredAt }
        );
        effects = replacement.effects;
        events.push(replacement.event);
        break;
      }
      case 'mark_failed': {
        const replacement = replaceEffect(
          effects,
          effect,
          {
            type: 'fail',
            at: command.occurredAt,
            errorCode: 'EFFECT_RECOVERY_MARKED_FAILED',
            message: decision.uncertainty
          }
        );
        effects = replacement.effects;
        events.push(replacement.event);
        break;
      }
      case 'cancel_run': {
        const cancelled = cancelOpenEffects(
          effects,
          command.occurredAt,
          'recovery_cancelled_run'
        );
        effects = cancelled.effects;
        events.push(...cancelled.events);
        state = {
          status: 'cancelled',
          checkpointVersion,
          cancelledAt: command.occurredAt,
          reason: 'recovery_cancelled_run'
        };
        events.push({ type: 'run.cancelled', reason: 'recovery_cancelled_run' });
        break;
      }
    }
  }

  return updateRun(run, command.occurredAt, state, effects, events);
}

function registerEffect(
  run: AgentRun,
  command: RegisterAgentEffectCommand
): AgentRunTransition {
  requireState(run, 'running', command.kind);
  assertNoStartedEffects(run, command.kind);
  assertNoOpenAgentInferenceAttempts(run, command.kind);
  const effect: AgentEffect = {
    ...command.effect,
    runId: run.runId,
    state: {
      status: 'intended',
      intendedAt: command.occurredAt
    }
  };
  assertValidEffect(effect);

  const state: AgentRunState = {
    status: 'running',
    checkpointVersion: nextCheckpoint(run),
    enteredAt: command.occurredAt
  };
  return updateRun(
    run,
    command.occurredAt,
    state,
    [...run.effects, effect],
    [{ type: 'effect.registered', effect }]
  );
}

function authorizeEffect(
  run: AgentRun,
  command: AuthorizeAgentEffectCommand
): AgentRunTransition {
  requireState(run, 'running', command.kind);
  assertNoStartedEffects(run, command.kind);
  assertNoOpenAgentInferenceAttempts(run, command.kind);
  const effect = requireEffect(run, command.effectId);
  const replacement = replaceEffect(run.effects, effect, {
    type: 'authorize',
    at: command.occurredAt
  });
  const state: AgentRunState = {
    status: 'running',
    checkpointVersion: nextCheckpoint(run),
    enteredAt: command.occurredAt
  };
  return updateRun(
    run,
    command.occurredAt,
    state,
    replacement.effects,
    [replacement.event]
  );
}

function startEffect(
  run: AgentRun,
  command: StartAgentEffectCommand
): AgentRunTransition {
  requireState(run, 'running', command.kind);
  assertNoStartedEffects(run, command.kind);
  assertNoOpenAgentInferenceAttempts(run, command.kind);
  const effect = requireEffect(run, command.effectId);
  const replacement = replaceEffect(run.effects, effect, {
    type: 'start',
    at: command.occurredAt
  });
  const state: AgentRunState = {
    status: 'running',
    checkpointVersion: nextCheckpoint(run),
    enteredAt: command.occurredAt
  };
  return updateRun(
    run,
    command.occurredAt,
    state,
    replacement.effects,
    [replacement.event]
  );
}

function recordEffectResult(
  run: AgentRun,
  command: RecordAgentEffectResultCommand
): AgentRunTransition {
  requireState(run, 'running', command.kind);
  const effect = requireEffect(run, command.effectId);
  if (effect.state.status !== 'started') {
    throw new AgentRunTransitionError(
      `Effect "${effect.effectId}" must be started before recording a result.`
    );
  }

  const checkpointVersion = nextCheckpoint(run);
  let transition: AgentEffectTransition;
  let state: AgentRunState = {
    status: 'running',
    checkpointVersion,
    enteredAt: command.occurredAt
  };
  const events: AgentRunEventPayload[] = [];

  switch (command.result.status) {
    case 'succeeded':
      transition = command.result.outputRef === undefined
        ? { type: 'succeed', at: command.occurredAt }
        : {
            type: 'succeed',
            at: command.occurredAt,
            outputRef: command.result.outputRef
          };
      break;
    case 'failed':
      transition = {
        type: 'fail',
        at: command.occurredAt,
        errorCode: command.result.errorCode,
        message: command.result.message
      };
      break;
    case 'cancelled':
      transition = {
        type: 'cancel',
        at: command.occurredAt,
        reason: command.result.reason
      };
      break;
    case 'uncertain': {
      transition = {
        type: 'mark_uncertain',
        at: command.occurredAt,
        reason: command.result.reason
      };
      const decision: RecoveryDecision = {
        kind: 'recovery',
        decisionId: command.result.recoveryDecisionId,
        runId: run.runId,
        checkpoint: {
          runId: run.runId,
          version: checkpointVersion
        },
        requestedAt: command.occurredAt,
        effectId: effect.effectId,
        uncertainty: command.result.reason,
        allowedActions: command.result.allowedActions
      };
      assertValidDecision(decision);
      state = {
        status: 'recovering',
        reason: 'uncertain_effect',
        checkpointVersion,
        decision
      };
      events.push({ type: 'decision.requested', decision });
      break;
    }
  }

  const replacement = replaceEffect(run.effects, effect, transition);
  return updateRun(
    run,
    command.occurredAt,
    state,
    replacement.effects,
    [replacement.event, ...events]
  );
}

function completeRun(
  run: AgentRun,
  command: CompleteAgentRunCommand
): AgentRunTransition {
  requireState(run, 'running', command.kind);
  assertNoOpenAgentInferenceAttempts(run, command.kind);
  if (run.effects.some((effect) => !isTerminalEffect(effect))) {
    throw new AgentRunTransitionError(
      'A run cannot complete while an external effect is unsettled.'
    );
  }
  const checkpointVersion = nextCheckpoint(run);
  const state: AgentRunState = command.outputRef === undefined
    ? {
        status: 'completed',
        checkpointVersion,
        completedAt: command.occurredAt
      }
    : {
        status: 'completed',
        checkpointVersion,
        completedAt: command.occurredAt,
        outputRef: command.outputRef
      };
  const completedEvent: AgentRunEventPayload = command.outputRef === undefined
    ? { type: 'run.completed' }
    : { type: 'run.completed', outputRef: command.outputRef };
  return updateRun(
    run,
    command.occurredAt,
    state,
    run.effects,
    [completedEvent]
  );
}

function failRun(
  run: AgentRun,
  command: FailAgentRunCommand
): AgentRunTransition {
  assertCanonicalPublicId(command.errorCode, 'command.errorCode');
  assertNonEmpty(command.message, 'command.message');
  assertNoStartedEffects(run, command.kind);
  assertNoStartedAgentInferenceAttempts(run, command.kind);
  const cancelled = cancelOpenEffects(
    run.effects,
    command.occurredAt,
    'run_failed'
  );
  const cancelledTurns = cancelOpenAgentInferenceAttempts(
    run.turns,
    command.occurredAt,
    'run_failed'
  );
  const state: AgentRunState = {
    status: 'failed',
    checkpointVersion: nextCheckpoint(run),
    failedAt: command.occurredAt,
    errorCode: command.errorCode,
    message: command.message
  };
  return updateRun(
    run,
    command.occurredAt,
    state,
    cancelled.effects,
    [
      ...cancelled.events,
      ...cancelledTurns.events,
      {
        type: 'run.failed',
        errorCode: command.errorCode,
        message: command.message
      }
    ],
    cancelledTurns.turns
  );
}

function cancelRun(
  run: AgentRun,
  command: CancelAgentRunCommand
): AgentRunTransition {
  if (run.state.status === 'waiting_children' || run.state.status === 'cancelling') {
    throw new AgentRunTransitionError(
      'A parent with required child Runs must cancel through child terminal coordination.'
    );
  }
  assertNonEmpty(command.reason, 'command.reason');
  assertNoStartedEffects(run, command.kind);
  assertNoStartedAgentInferenceAttempts(run, command.kind);
  const inferenceRecovery =
    run.state.status === 'recovering'
    && run.state.reason === 'uncertain_inference'
      ? authorizeInferenceCancelRun(run, command.recoveryDecisionId)
      : undefined;
  if (inferenceRecovery === undefined && command.recoveryDecisionId !== undefined) {
    throw new AgentRunTransitionError(
      'A Run cancellation cannot carry an unrelated inference recovery identity.'
    );
  }
  const cancelled = cancelOpenEffects(
    run.effects,
    command.occurredAt,
    command.reason
  );
  const cancelledTurns = cancelOpenAgentInferenceAttempts(
    run.turns,
    command.occurredAt,
    command.reason
  );
  const state: AgentRunState = inferenceRecovery === undefined
    ? {
        status: 'cancelled',
        checkpointVersion: nextCheckpoint(run),
        cancelledAt: command.occurredAt,
        reason: command.reason
      }
    : {
        status: 'cancelled',
        checkpointVersion: nextCheckpoint(run),
        cancelledAt: command.occurredAt,
        reason: command.reason,
        inferenceRecovery
      };
  return updateRun(
    run,
    command.occurredAt,
    state,
    cancelled.effects,
    [
      ...cancelled.events,
      ...cancelledTurns.events,
      { type: 'run.cancelled', reason: command.reason }
    ],
    cancelledTurns.turns
  );
}

function assertNoStartedEffects(
  run: AgentRun,
  commandKind: AgentRunCommand['kind']
): void {
  const started = run.effects.find((effect) => effect.state.status === 'started');
  if (started === undefined) return;
  throw new AgentRunTransitionError(
    `${commandKind} cannot terminate Run "${run.runId}" while Effect `
      + `"${started.effectId}" has an unknown external outcome; record the `
      + 'effect result or enter recovery first.'
  );
}

function applyAgentTurnMutation(
  run: AgentRun,
  occurredAt: string,
  mutation: AgentTurnMutation
): AgentRunTransition {
  return updateRun(
    run,
    occurredAt,
    mutation.state,
    run.effects,
    mutation.events,
    mutation.turns
  );
}

function applyAgentInferenceResultMutation(
  run: AgentRun,
  occurredAt: string,
  mutation: AgentInferenceResultMutation
): AgentRunTransition {
  return updateRun(
    run,
    occurredAt,
    mutation.state,
    mutation.effects,
    mutation.events,
    mutation.turns
  );
}

function updateRun(
  run: AgentRun,
  occurredAt: string,
  state: AgentRunState,
  effects: readonly AgentEffect[],
  events: readonly AgentRunEventPayload[],
  turns: readonly AgentTurn[] = run.turns
): AgentRunTransition {
  const next: AgentRun = {
    ...run,
    version: run.version + 1,
    state,
    turns,
    effects,
    updatedAt: occurredAt
  };
  assertValidAgentRun(next);
  return {
    run: next,
    events: [
      ...events,
      {
        type: 'run.state_changed',
        from: run.state.status,
        to: state
      }
    ]
  };
}

function replaceEffect(
  effects: readonly AgentEffect[],
  effect: AgentEffect,
  transition: AgentEffectTransition
): {
  readonly effects: readonly AgentEffect[];
  readonly event: AgentRunEventPayload;
} {
  const next = transitionAgentEffect(effect, transition);
  return {
    effects: effects.map((candidate) =>
      candidate.effectId === effect.effectId ? next : candidate
    ),
    event: {
      type: 'effect.transitioned',
      effectId: effect.effectId,
      from: effect.state,
      to: next.state
    }
  };
}

function cancelOpenEffects(
  effects: readonly AgentEffect[],
  occurredAt: string,
  reason: string
): {
  readonly effects: readonly AgentEffect[];
  readonly events: readonly AgentRunEventPayload[];
} {
  const events: AgentRunEventPayload[] = [];
  const next = effects.map((effect) => {
    if (isTerminalEffect(effect)) {
      return effect;
    }
    const cancelled = transitionAgentEffect(effect, {
      type: 'cancel',
      at: occurredAt,
      reason
    });
    events.push({
      type: 'effect.transitioned',
      effectId: effect.effectId,
      from: effect.state,
      to: cancelled.state
    });
    return cancelled;
  });
  return { effects: next, events };
}

function assertExactResolution(
  run: AgentRun,
  decision: AgentDecision,
  resolution: AgentDecisionResolution,
  occurredAt: string
): void {
  assertTimestamp(resolution.resolvedAt, 'resolution.resolvedAt');
  if (
    resolution.decisionId !== decision.decisionId
    || resolution.kind !== decision.kind
    || resolution.checkpoint.runId !== run.runId
    || resolution.checkpoint.version !== run.state.checkpointVersion
    || resolution.resolvedAt !== occurredAt
  ) {
    throw new AgentRunTransitionError(
      'A decision resolution must match the active decision and checkpoint exactly.'
    );
  }

  if (decision.kind === 'permission' && resolution.kind === 'permission') {
    if (resolution.effectId !== decision.effectId) {
      throw new AgentRunTransitionError(
        'A permission resolution must reference the exact requested effect.'
      );
    }
    assertUniqueNonEmpty(
      resolution.approvedCapabilityIds,
      'resolution.approvedCapabilityIds'
    );
    if (resolution.outcome === 'deny') {
      if (resolution.approvedCapabilityIds.length > 0) {
        throw new AgentRunTransitionError(
          'A denied permission cannot approve capabilities.'
        );
      }
    } else if (
      !sameValues(resolution.approvedCapabilityIds, decision.capabilityIds)
    ) {
      throw new AgentRunTransitionError(
        'An approval must cover the exact capability set requested by the effect.'
      );
    }
    return;
  }

  if (decision.kind === 'plan' && resolution.kind === 'plan') {
    if (
      resolution.planId !== decision.planId
      || resolution.planVersion !== decision.planVersion
      || resolution.planHash !== decision.planHash
    ) {
      throw new AgentRunTransitionError(
        'A plan resolution must bind the exact plan ID, version, and hash.'
      );
    }
    return;
  }

  if (decision.kind === 'recovery' && resolution.kind === 'recovery') {
    if (
      resolution.effectId !== decision.effectId
      || !decision.allowedActions.includes(resolution.outcome)
    ) {
      throw new AgentRunTransitionError(
        'A recovery resolution must reference the uncertain effect and an allowed action.'
      );
    }
  }
}

function requireEffect(run: AgentRun, effectId: string): AgentEffect {
  const effect = run.effects.find((candidate) => candidate.effectId === effectId);
  if (effect === undefined) {
    throw new AgentRunTransitionError(
      `Effect "${effectId}" does not belong to run "${run.runId}".`
    );
  }
  return effect;
}

function requireState(
  run: AgentRun,
  status: AgentRunState['status'],
  command: AgentRunCommand['kind']
): void {
  if (run.state.status !== status) {
    throw invalidRunState(run, command);
  }
}

function invalidRunState(
  run: AgentRun,
  command: AgentRunCommand['kind']
): AgentRunTransitionError {
  return new AgentRunTransitionError(
    `Run "${run.runId}" cannot handle "${command}" while "${run.state.status}".`
  );
}

function nextCheckpoint(run: AgentRun): number {
  return run.state.checkpointVersion + 1;
}

function assertCommandMetadata(command: AgentRunCommand): void {
  assertCanonicalPublicId(command.commandId, 'command.commandId');
  assertCanonicalPublicId(command.runId, 'command.runId');
  assertTimestamp(command.occurredAt, 'command.occurredAt');
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}
