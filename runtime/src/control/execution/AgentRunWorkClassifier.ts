import {
  assertValidAgentRun,
  isTerminalEffect,
  type AgentEffect,
  type AgentInferenceAttempt,
  type AgentRun,
  type AgentTurn
} from '@ariadne/agent-core';

interface AgentRunWorkIdentity {
  readonly runId: string;
  /** Exact aggregate version that the eventual owner must compare-and-swap. */
  readonly expectedVersion: number;
  readonly checkpointVersion: number;
}

interface AgentSettledEffectBatchWorkIdentity {
  readonly sourceTurnId: string;
  readonly sourceAttemptId: string;
  readonly sourceDirectiveDigest: string;
  /** Complete source batch in committed Directive invocation order. */
  readonly effectIds: readonly string[];
  readonly toolCallIds: readonly string[];
}

export type AgentRunWorkClassification =
  | (AgentRunWorkIdentity & {
      readonly kind: 'dispatch_effect';
      readonly sourceTurnId: string;
      readonly sourceAttemptId: string;
      readonly sourceDirectiveDigest: string;
      readonly effectId: string;
      readonly toolCallId: string;
      readonly inputDigest: string;
      readonly effectAttempt: number;
    })
  | (AgentRunWorkIdentity & {
      readonly kind: 'continue_effect_results';
    } & AgentSettledEffectBatchWorkIdentity)
  | (AgentRunWorkIdentity & {
      readonly kind: 'fail_model_turn_budget';
      readonly observedModelTurns: number;
      readonly modelTurnLimit: number;
    } & AgentSettledEffectBatchWorkIdentity)
  | (AgentRunWorkIdentity & {
      readonly kind: 'fail_deadline_expired';
      readonly deadlineAt: string;
      /** Durable time at which the settled batch was last committed. */
      readonly observedAt: string;
    } & AgentSettledEffectBatchWorkIdentity)
  | (AgentRunWorkIdentity & {
      readonly kind: 'wait_permission';
      readonly effectId: string;
      readonly toolCallId: string;
      readonly decisionId: string | null;
    })
  | (AgentRunWorkIdentity & {
      readonly kind: 'recovery_uncertain_effect';
      readonly effectId: string;
      readonly toolCallId: string;
      readonly effectAttempt: number;
      readonly sourceTurnId: string | null;
      readonly sourceAttemptId: string | null;
      readonly sourceDirectiveDigest: string | null;
    })
  | (AgentRunWorkIdentity & {
      readonly kind: 'dispatch_follow_up';
      readonly turnId: string;
      readonly attemptId: string;
      readonly inputDigest: string;
      readonly sourceTurnId: string;
      readonly sourceAttemptId: string;
      readonly sourceDirectiveDigest: string;
    })
  | (AgentRunWorkIdentity & {
      readonly kind: 'recovery_uncertain_inference';
      readonly turnId: string;
      readonly attemptId: string;
      readonly inputDigest: string;
      readonly sourceTurnId: string;
      readonly sourceAttemptId: string;
      readonly sourceDirectiveDigest: string;
    })
  | (AgentRunWorkIdentity & {
      readonly kind: 'owned_by_execution_intent';
      readonly phase:
        | 'queued'
        | 'intended_initial_inference'
        | 'started_initial_inference';
      readonly turnId: string | null;
      readonly attemptId: string | null;
      readonly inputDigest: string | null;
    })
  | (AgentRunWorkIdentity & {
      readonly kind: 'wait';
      readonly reason:
        | 'waiting_plan_approval'
        | 'recovering_uncertain_effect'
        | 'recovering_uncertain_inference'
        | 'waiting_children'
        | 'cancelling';
      readonly subjectIds: readonly string[];
    })
  | (AgentRunWorkIdentity & {
      readonly kind: 'terminal';
      readonly status: 'completed' | 'failed' | 'cancelled';
    })
  | (AgentRunWorkIdentity & {
      readonly kind: 'unsupported';
      readonly reason:
        | 'delegation_objective'
        | 'plan_approval'
        | 'checkpoint_continuation'
        | 'inference_recovery_retry';
      readonly turnId: string | null;
      readonly attemptId: string | null;
      readonly decisionId: string | null;
    })
  | (AgentRunWorkIdentity & {
      readonly kind: 'health_fault';
      readonly reason:
        | 'running_without_turn'
        | 'running_without_attempt'
        | 'multiple_started_effects'
        | 'effect_batch_already_consumed'
        | 'request_decision_without_wait'
        | 'running_without_owned_work';
      readonly turnId: string | null;
      readonly attemptId: string | null;
    });

/**
 * Pure ownership classifier for one authoritative AgentRun snapshot.
 *
 * It never performs work and never scans old Turns for something convenient to
 * run: only the latest causal Turn may expose new work. This keeps a settled
 * Effect batch from being consumed twice after its continuation Turn exists.
 */
export class AgentRunWorkClassifier {
  public classify(run: AgentRun): AgentRunWorkClassification {
    return classifyAgentRunWork(run);
  }
}

export function classifyAgentRunWork(run: AgentRun): AgentRunWorkClassification {
  assertValidAgentRun(run);
  const identity = workIdentity(run);

  switch (run.state.status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
      return { ...identity, kind: 'terminal', status: run.state.status };
    case 'queued':
      return {
        ...identity,
        kind: 'owned_by_execution_intent',
        phase: 'queued',
        turnId: null,
        attemptId: null,
        inputDigest: null
      };
    case 'waiting':
      if (run.state.reason === 'plan_approval') {
        return {
          ...identity,
          kind: 'wait',
          reason: 'waiting_plan_approval',
          subjectIds: [
            run.state.decision.decisionId,
            run.state.decision.planId,
            String(run.state.decision.planVersion)
          ]
        };
      }
      return {
        ...identity,
        kind: 'wait_permission',
        effectId: run.state.decision.effectId,
        toolCallId: run.state.decision.toolCallId,
        decisionId: run.state.decision.decisionId
      };
    case 'recovering':
      if (run.state.reason === 'uncertain_effect') {
        return {
          ...identity,
          kind: 'wait',
          reason: 'recovering_uncertain_effect',
          subjectIds: [run.state.decision.effectId, run.state.decision.decisionId]
        };
      }
      return {
        ...identity,
        kind: 'wait',
        reason: 'recovering_uncertain_inference',
        subjectIds: [run.state.turnId, run.state.attemptId]
      };
    case 'waiting_children':
      return {
        ...identity,
        kind: 'wait',
        reason: 'waiting_children',
        subjectIds: [...run.state.requiredChildRunIds]
      };
    case 'cancelling':
      return {
        ...identity,
        kind: 'wait',
        reason: 'cancelling',
        subjectIds: [...run.state.requiredChildRunIds]
      };
    case 'running':
      return classifyRunningRun(run, identity);
  }
}

function classifyRunningRun(
  run: AgentRun,
  identity: AgentRunWorkIdentity
): AgentRunWorkClassification {
  const turn = latestTurn(run);
  if (turn === undefined) {
    return healthFault(identity, 'running_without_turn', null, null);
  }
  const attempt = turn.attempts.at(-1);
  if (attempt === undefined) {
    return healthFault(identity, 'running_without_attempt', turn.turnId, null);
  }

  if (attempt.state.status === 'intended') {
    return classifyIntendedInference(identity, turn, attempt);
  }
  if (attempt.state.status === 'started') {
    return classifyStartedInference(identity, turn, attempt);
  }
  if (attempt.state.status !== 'succeeded') {
    return healthFault(
      identity,
      'running_without_owned_work',
      turn.turnId,
      attempt.attemptId
    );
  }

  const directive = attempt.state.directive;
  if (directive.kind === 'checkpoint') {
    return {
      ...identity,
      kind: 'unsupported',
      reason: 'checkpoint_continuation',
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      decisionId: null
    };
  }
  if (directive.kind === 'request_decision') {
    return healthFault(
      identity,
      'request_decision_without_wait',
      turn.turnId,
      attempt.attemptId
    );
  }
  if (directive.kind !== 'invoke_tools') {
    return healthFault(
      identity,
      'running_without_owned_work',
      turn.turnId,
      attempt.attemptId
    );
  }

  const effects = directive.invocations.map((invocation) => (
    requireEffect(run, invocation.effectId)
  ));
  const started = effects.filter((effect) => effect.state.status === 'started');
  if (started.length > 1) {
    return healthFault(
      identity,
      'multiple_started_effects',
      turn.turnId,
      attempt.attemptId
    );
  }
  const startedEffect = started[0];
  if (startedEffect !== undefined && startedEffect.state.status === 'started') {
    return {
      ...identity,
      kind: 'recovery_uncertain_effect',
      effectId: startedEffect.effectId,
      toolCallId: startedEffect.toolCallId,
      effectAttempt: startedEffect.state.attempt,
      sourceTurnId: startedEffect.origin?.turnId ?? null,
      sourceAttemptId: startedEffect.origin?.attemptId ?? null,
      sourceDirectiveDigest: startedEffect.origin?.directiveDigest ?? null
    };
  }

  // Mapping through the committed invocations, rather than run.effects, is the
  // durable ordering authority for dispatch. A later authorized Effect cannot
  // overtake an earlier Effect that is still waiting for permission.
  const nextUnsettled = effects.find((effect) => !isTerminalEffect(effect));
  if (nextUnsettled?.state.status === 'authorized') {
    return {
      ...identity,
      kind: 'dispatch_effect',
      sourceTurnId: turn.turnId,
      sourceAttemptId: attempt.attemptId,
      sourceDirectiveDigest: attempt.state.directiveDigest,
      effectId: nextUnsettled.effectId,
      toolCallId: nextUnsettled.toolCallId,
      inputDigest: nextUnsettled.inputDigest,
      effectAttempt: nextUnsettled.state.attempt
    };
  }

  if (nextUnsettled?.state.status === 'intended') {
    return {
      ...identity,
      kind: 'wait_permission',
      effectId: nextUnsettled.effectId,
      toolCallId: nextUnsettled.toolCallId,
      decisionId: null
    };
  }

  if (effects.every(isTerminalEffect)) {
    if (isEffectBatchConsumed(
      run,
      turn.turnId,
      attempt.attemptId,
      attempt.state.directiveDigest
    )) {
      return healthFault(
        identity,
        'effect_batch_already_consumed',
        turn.turnId,
        attempt.attemptId
      );
    }
    const batch = {
      sourceTurnId: turn.turnId,
      sourceAttemptId: attempt.attemptId,
      sourceDirectiveDigest: attempt.state.directiveDigest,
      effectIds: directive.invocations.map((invocation) => invocation.effectId),
      toolCallIds: directive.invocations.map((invocation) => invocation.toolCallId)
    } as const;
    // Match the Core continuation boundary exactly. `updatedAt` is the durable
    // observation time of the settled batch, so classification remains pure
    // and the resulting terminal command is replayable across restarts.
    if (Date.parse(run.updatedAt) >= Date.parse(run.binding.budget.deadlineAt)) {
      return {
        ...identity,
        ...batch,
        kind: 'fail_deadline_expired',
        deadlineAt: run.binding.budget.deadlineAt,
        observedAt: run.updatedAt
      };
    }
    if (run.turns.length >= run.binding.budget.vector.modelTurns) {
      return {
        ...identity,
        ...batch,
        kind: 'fail_model_turn_budget',
        observedModelTurns: run.turns.length,
        modelTurnLimit: run.binding.budget.vector.modelTurns
      };
    }
    return {
      ...identity,
      ...batch,
      kind: 'continue_effect_results',
    };
  }

  return healthFault(
    identity,
    'running_without_owned_work',
    turn.turnId,
    attempt.attemptId
  );
}

function classifyIntendedInference(
  identity: AgentRunWorkIdentity,
  turn: AgentTurn,
  attempt: AgentInferenceAttempt
): AgentRunWorkClassification {
  if (attempt.cause.kind !== 'initial') {
    return {
      ...identity,
      kind: 'unsupported',
      reason: 'inference_recovery_retry',
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      decisionId: attempt.cause.recoveryDecisionId
    };
  }

  const cause = turn.intention.cause;
  if (cause.kind === 'conversation_objective') {
    return {
      ...identity,
      kind: 'owned_by_execution_intent',
      phase: 'intended_initial_inference',
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      inputDigest: turn.intention.inputDigest
    };
  }
  if (cause.kind === 'delegation_objective') {
    return {
      ...identity,
      kind: 'unsupported',
      reason: 'delegation_objective',
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      decisionId: null
    };
  }
  return {
    ...identity,
    kind: 'dispatch_follow_up',
    turnId: turn.turnId,
    attemptId: attempt.attemptId,
    inputDigest: turn.intention.inputDigest,
    sourceTurnId: cause.sourceTurnId,
    sourceAttemptId: cause.sourceAttemptId,
    sourceDirectiveDigest: cause.sourceDirectiveDigest
  };
}

function classifyStartedInference(
  identity: AgentRunWorkIdentity,
  turn: AgentTurn,
  attempt: AgentInferenceAttempt
): AgentRunWorkClassification {
  const cause = turn.intention.cause;
  if (cause.kind === 'conversation_objective') {
    return {
      ...identity,
      kind: 'owned_by_execution_intent',
      phase: 'started_initial_inference',
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      inputDigest: turn.intention.inputDigest
    };
  }
  if (cause.kind === 'delegation_objective') {
    return {
      ...identity,
      kind: 'unsupported',
      reason: 'delegation_objective',
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      decisionId: null
    };
  }
  return {
    ...identity,
    kind: 'recovery_uncertain_inference',
    turnId: turn.turnId,
    attemptId: attempt.attemptId,
    inputDigest: turn.intention.inputDigest,
    sourceTurnId: cause.sourceTurnId,
    sourceAttemptId: cause.sourceAttemptId,
    sourceDirectiveDigest: cause.sourceDirectiveDigest
  };
}

function isEffectBatchConsumed(
  run: AgentRun,
  sourceTurnId: string,
  sourceAttemptId: string,
  sourceDirectiveDigest: string
): boolean {
  return run.turns.some((candidate) => {
    const cause = candidate.intention.cause;
    return cause.kind === 'effect_results'
      && cause.sourceTurnId === sourceTurnId
      && cause.sourceAttemptId === sourceAttemptId
      && cause.sourceDirectiveDigest === sourceDirectiveDigest;
  });
}

function requireEffect(run: AgentRun, effectId: string): AgentEffect {
  // assertValidAgentRun proved this exact relationship before classification.
  const effect = run.effects.find((candidate) => candidate.effectId === effectId);
  if (effect === undefined) {
    throw new Error('Validated AgentRun lost its committed Effect.');
  }
  return effect;
}

function workIdentity(run: AgentRun): AgentRunWorkIdentity {
  return {
    runId: run.runId,
    expectedVersion: run.version,
    checkpointVersion: run.state.checkpointVersion
  };
}

function latestTurn(run: AgentRun): AgentTurn | undefined {
  return run.turns.at(-1);
}

function healthFault(
  identity: AgentRunWorkIdentity,
  reason: Extract<AgentRunWorkClassification, { readonly kind: 'health_fault' }>['reason'],
  turnId: string | null,
  attemptId: string | null
): AgentRunWorkClassification {
  return { ...identity, kind: 'health_fault', reason, turnId, attemptId };
}
