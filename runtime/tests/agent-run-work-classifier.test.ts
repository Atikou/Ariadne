import {
  AgentRunVersionConflictError,
  assertValidAgentRun,
  type AgentEffect,
  type AgentInferenceAttemptState,
  type AgentRun,
  type AgentRunCommandCommit,
  type AgentRunTransaction,
  type AgentRunUnitOfWork,
  type CommittedAgentRunCommand
} from '@ariadne/agent-core';
import { describe, expect, it } from 'vitest';

import {
  AgentRunWorkClassifier,
  classifyAgentRunWork
} from '../src/control/execution/AgentRunWorkClassifier.js';
import { AgentStartedWorkRecoveryCoordinator } from
  '../src/control/execution/AgentStartedWorkRecoveryCoordinator.js';
import { AgentSettledEffectBatchTerminalizationCoordinator } from
  '../src/control/execution/AgentSettledEffectBatchTerminalizationCoordinator.js';

describe('AgentRunWorkClassifier', () => {
  it('dispatches the first authorized Effect in committed invocation order', () => {
    const run = toolBatchRun([
      { status: 'authorized', authorizedAt: at(2), attempt: 1 },
      { status: 'authorized', authorizedAt: at(2), attempt: 1 }
    ]);
    // Aggregate storage order is deliberately not the Directive authority.
    run.effects = [run.effects[1]!, run.effects[0]!];

    expect(new AgentRunWorkClassifier().classify(run)).toEqual({
      kind: 'dispatch_effect',
      runId: RUN_ID,
      expectedVersion: 4,
      checkpointVersion: 4,
      sourceTurnId: SOURCE_TURN_ID,
      sourceAttemptId: SOURCE_ATTEMPT_ID,
      sourceDirectiveDigest: DIRECTIVE_DIGEST,
      effectId: EFFECT_A_ID,
      toolCallId: TOOL_CALL_A_ID,
      inputDigest: INPUT_A_DIGEST,
      effectAttempt: 1
    });
  });

  it('does not let a later authorized Effect overtake an earlier intended Effect', () => {
    const run = toolBatchRun([
      { status: 'intended', intendedAt: at(2) },
      { status: 'authorized', authorizedAt: at(2), attempt: 1 }
    ]);

    expect(classifyAgentRunWork(run)).toEqual({
      kind: 'wait_permission',
      runId: RUN_ID,
      expectedVersion: 4,
      checkpointVersion: 4,
      effectId: EFFECT_A_ID,
      toolCallId: TOOL_CALL_A_ID,
      decisionId: null
    });
  });

  it('classifies a started Effect as uncertain recovery instead of dispatching another Effect', () => {
    const run = toolBatchRun([
      { status: 'authorized', authorizedAt: at(2), attempt: 1 },
      { status: 'started', startedAt: at(3), attempt: 1 }
    ]);

    expect(classifyAgentRunWork(run)).toEqual({
      kind: 'recovery_uncertain_effect',
      runId: RUN_ID,
      expectedVersion: 4,
      checkpointVersion: 4,
      effectId: EFFECT_B_ID,
      toolCallId: TOOL_CALL_B_ID,
      effectAttempt: 1,
      sourceTurnId: SOURCE_TURN_ID,
      sourceAttemptId: SOURCE_ATTEMPT_ID,
      sourceDirectiveDigest: DIRECTIVE_DIGEST
    });
  });

  it('continues only after the complete latest Effect batch settles', () => {
    const run = toolBatchRun([
      { status: 'succeeded', finishedAt: at(3), attempt: 1 },
      {
        status: 'failed',
        finishedAt: at(3),
        attempt: 1,
        errorCode: 'tool_failed',
        message: 'expected test failure'
      }
    ]);

    expect(classifyAgentRunWork(run)).toEqual({
      kind: 'continue_effect_results',
      runId: RUN_ID,
      expectedVersion: 4,
      checkpointVersion: 4,
      sourceTurnId: SOURCE_TURN_ID,
      sourceAttemptId: SOURCE_ATTEMPT_ID,
      sourceDirectiveDigest: DIRECTIVE_DIGEST,
      effectIds: [EFFECT_A_ID, EFFECT_B_ID],
      toolCallIds: [TOOL_CALL_A_ID, TOOL_CALL_B_ID]
    });
  });

  it('terminalizes a settled batch when the model-turn budget is exhausted', () => {
    const run = modelTurnBudgetExhaustedRun();

    expect(classifyAgentRunWork(run)).toEqual({
      kind: 'fail_model_turn_budget',
      runId: RUN_ID,
      expectedVersion: 4,
      checkpointVersion: 4,
      sourceTurnId: SOURCE_TURN_ID,
      sourceAttemptId: SOURCE_ATTEMPT_ID,
      sourceDirectiveDigest: DIRECTIVE_DIGEST,
      effectIds: [EFFECT_A_ID, EFFECT_B_ID],
      toolCallIds: [TOOL_CALL_A_ID, TOOL_CALL_B_ID],
      observedModelTurns: 1,
      modelTurnLimit: 1
    });
  });

  it('terminalizes a settled batch at its durable deadline before budget failure', () => {
    const run = deadlineExpiredRun();

    expect(classifyAgentRunWork(run)).toEqual({
      kind: 'fail_deadline_expired',
      runId: RUN_ID,
      expectedVersion: 4,
      checkpointVersion: 4,
      sourceTurnId: SOURCE_TURN_ID,
      sourceAttemptId: SOURCE_ATTEMPT_ID,
      sourceDirectiveDigest: DIRECTIVE_DIGEST,
      effectIds: [EFFECT_A_ID, EFFECT_B_ID],
      toolCallIds: [TOOL_CALL_A_ID, TOOL_CALL_B_ID],
      deadlineAt: at(3),
      observedAt: at(3)
    });
  });

  it('waits on an intended Effect and preserves the exact permission identity', () => {
    const run = toolBatchRun([
      { status: 'intended', intendedAt: at(2) },
      { status: 'cancelled', cancelledAt: at(2), attempts: 0, reason: 'not selected' }
    ]);
    run.state = {
      status: 'waiting',
      reason: 'tool_permission',
      checkpointVersion: 4,
      decision: {
        kind: 'permission',
        decisionId: 'decision-effect-a',
        runId: RUN_ID,
        checkpoint: { runId: RUN_ID, version: 4 },
        requestedAt: at(2),
        effectId: EFFECT_A_ID,
        toolCallId: TOOL_CALL_A_ID,
        capabilityIds: ['workspace.read'],
        scope: ['workspace.root']
      }
    };

    expect(classifyAgentRunWork(run)).toEqual({
      kind: 'wait_permission',
      runId: RUN_ID,
      expectedVersion: 4,
      checkpointVersion: 4,
      effectId: EFFECT_A_ID,
      toolCallId: TOOL_CALL_A_ID,
      decisionId: 'decision-effect-a'
    });
  });

  it('dispatches the intended follow-up Attempt and never re-consumes its source batch', () => {
    const run = continuationRun('intended');

    expect(classifyAgentRunWork(run)).toEqual({
      kind: 'dispatch_follow_up',
      runId: RUN_ID,
      expectedVersion: 6,
      checkpointVersion: 6,
      turnId: FOLLOW_UP_TURN_ID,
      attemptId: FOLLOW_UP_ATTEMPT_ID,
      inputDigest: FOLLOW_UP_INPUT_DIGEST,
      sourceTurnId: SOURCE_TURN_ID,
      sourceAttemptId: SOURCE_ATTEMPT_ID,
      sourceDirectiveDigest: DIRECTIVE_DIGEST
    });
  });

  it('routes a started Effect-result inference to explicit recovery', () => {
    const run = continuationRun('started');

    expect(classifyAgentRunWork(run)).toEqual({
      kind: 'recovery_uncertain_inference',
      runId: RUN_ID,
      expectedVersion: 6,
      checkpointVersion: 6,
      turnId: FOLLOW_UP_TURN_ID,
      attemptId: FOLLOW_UP_ATTEMPT_ID,
      inputDigest: FOLLOW_UP_INPUT_DIGEST,
      sourceTurnId: SOURCE_TURN_ID,
      sourceAttemptId: SOURCE_ATTEMPT_ID,
      sourceDirectiveDigest: DIRECTIVE_DIGEST
    });
  });

  it('leaves Conversation initial inference with the execution-intent owner', () => {
    const intended = objectiveRun('conversation_objective', 'intended');
    expect(classifyAgentRunWork(intended)).toMatchObject({
      kind: 'owned_by_execution_intent',
      phase: 'intended_initial_inference',
      expectedVersion: 1,
      turnId: SOURCE_TURN_ID,
      attemptId: SOURCE_ATTEMPT_ID,
      inputDigest: SOURCE_INPUT_DIGEST
    });

    const started = objectiveRun('conversation_objective', 'started');
    expect(classifyAgentRunWork(started)).toMatchObject({
      kind: 'owned_by_execution_intent',
      phase: 'started_initial_inference',
      expectedVersion: 2,
      turnId: SOURCE_TURN_ID,
      attemptId: SOURCE_ATTEMPT_ID
    });
  });

  it('fails closed for a Delegation objective without a production owner', () => {
    const run = objectiveRun('delegation_objective', 'intended');

    expect(classifyAgentRunWork(run)).toMatchObject({
      kind: 'unsupported',
      reason: 'delegation_objective',
      turnId: SOURCE_TURN_ID,
      attemptId: SOURCE_ATTEMPT_ID
    });
  });

  it('keeps queued, child-wait, cancelling, recovery, and terminal states explicit', () => {
    const queued = queuedRun();
    expect(classifyAgentRunWork(queued)).toEqual({
      kind: 'owned_by_execution_intent',
      phase: 'queued',
      runId: RUN_ID,
      expectedVersion: 1,
      checkpointVersion: 0,
      turnId: null,
      attemptId: null,
      inputDigest: null
    });

    const waitingChildren = terminalBatchRun();
    waitingChildren.version = 5;
    waitingChildren.state = {
      status: 'waiting_children',
      checkpointVersion: 5,
      enteredAt: at(4),
      requiredChildRunIds: ['run-child-a', 'run-child-b'],
      terminalChildRunIds: ['run-child-a']
    };
    waitingChildren.updatedAt = at(4);
    expect(classifyAgentRunWork(waitingChildren)).toMatchObject({
      kind: 'wait',
      reason: 'waiting_children',
      subjectIds: ['run-child-a', 'run-child-b']
    });

    const cancelling = structuredClone(waitingChildren);
    cancelling.state = {
      status: 'cancelling',
      checkpointVersion: 5,
      requestedAt: at(4),
      reason: 'user requested cancellation',
      requiredChildRunIds: ['run-child-a', 'run-child-b'],
      terminalChildRunIds: ['run-child-a']
    };
    expect(classifyAgentRunWork(cancelling)).toMatchObject({
      kind: 'wait',
      reason: 'cancelling'
    });

    const recovering = uncertainEffectRun();
    expect(classifyAgentRunWork(recovering)).toMatchObject({
      kind: 'wait',
      reason: 'recovering_uncertain_effect',
      subjectIds: [EFFECT_A_ID, 'decision-recover-a']
    });

    const terminal = terminalBatchRun();
    terminal.version = 5;
    terminal.state = {
      status: 'completed',
      checkpointVersion: 5,
      completedAt: at(4)
    };
    terminal.updatedAt = at(4);
    expect(classifyAgentRunWork(terminal)).toEqual({
      kind: 'terminal',
      status: 'completed',
      runId: RUN_ID,
      expectedVersion: 5,
      checkpointVersion: 5
    });
  });

  it('waits for plan approval but reports unresolved checkpoint continuation', () => {
    const plan = directiveRun({
      kind: 'request_decision',
      decision: {
        kind: 'plan',
        decisionId: 'decision-plan-a',
        requestedAt: at(1),
        planId: 'plan-a',
        planVersion: 1,
        planHash: digest('7')
      }
    });
    plan.state = {
      status: 'waiting',
      reason: 'plan_approval',
      checkpointVersion: 2,
      decision: {
        kind: 'plan',
        decisionId: 'decision-plan-a',
        runId: RUN_ID,
        checkpoint: { runId: RUN_ID, version: 2 },
        requestedAt: at(1),
        planId: 'plan-a',
        planVersion: 1,
        planHash: digest('7')
      }
    };
    expect(classifyAgentRunWork(plan)).toMatchObject({
      kind: 'wait',
      reason: 'waiting_plan_approval',
      subjectIds: ['decision-plan-a', 'plan-a', '1']
    });

    const checkpoint = directiveRun({
      kind: 'checkpoint',
      reasonRef: 'protected:checkpoint-reason',
      reasonDigest: digest('8')
    });
    expect(classifyAgentRunWork(checkpoint)).toMatchObject({
      kind: 'unsupported',
      reason: 'checkpoint_continuation',
      turnId: SOURCE_TURN_ID,
      attemptId: SOURCE_ATTEMPT_ID
    });
  });

  it('reports a running aggregate with no owned action as a health fault', () => {
    const run = directiveRun({ kind: 'complete' });

    expect(classifyAgentRunWork(run)).toMatchObject({
      kind: 'health_fault',
      reason: 'running_without_owned_work',
      turnId: SOURCE_TURN_ID,
      attemptId: SOURCE_ATTEMPT_ID
    });
  });
});

describe('AgentStartedWorkRecoveryCoordinator', () => {
  it('marks a crossed Effect start uncertain without dispatching it again', async () => {
    const runs = new MemoryRunUnitOfWork(toolBatchRun([
      { status: 'started', startedAt: at(3), attempt: 1 },
      { status: 'authorized', authorizedAt: at(2), attempt: 1 }
    ]));
    const work = classifyAgentRunWork(runs.current);
    if (work.kind !== 'recovery_uncertain_effect') {
      throw new Error('expected_effect_recovery_work');
    }

    const receipt = await new AgentStartedWorkRecoveryCoordinator(runs)
      .recover(work, new AbortController().signal);

    expect(receipt).toMatchObject({
      receiptVersion: 1,
      runId: RUN_ID,
      runVersion: 5,
      subjectKind: 'effect',
      subjectId: EFFECT_A_ID,
      replayed: false
    });
    expect(runs.current).toMatchObject({
      version: 5,
      state: {
        status: 'recovering',
        reason: 'uncertain_effect',
        decision: {
          effectId: EFFECT_A_ID,
          allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
        }
      }
    });
    expect(runs.current.effects.find((effect) => effect.effectId === EFFECT_A_ID))
      .toMatchObject({
        effectId: EFFECT_A_ID,
        state: {
          status: 'uncertain',
          reason: 'effect_started_without_durable_outcome_after_restart'
        }
      });
  });

  it('marks a crossed follow-up inference start uncertain without provider re-entry', async () => {
    const runs = new MemoryRunUnitOfWork(continuationRun('started'));
    const work = classifyAgentRunWork(runs.current);
    if (work.kind !== 'recovery_uncertain_inference') {
      throw new Error('expected_inference_recovery_work');
    }

    const receipt = await new AgentStartedWorkRecoveryCoordinator(runs)
      .recover(work, new AbortController().signal);

    expect(receipt).toMatchObject({
      receiptVersion: 1,
      runId: RUN_ID,
      runVersion: 7,
      subjectKind: 'inference',
      subjectId: FOLLOW_UP_ATTEMPT_ID,
      replayed: false
    });
    expect(runs.current).toMatchObject({
      version: 7,
      state: {
        status: 'recovering',
        reason: 'uncertain_inference',
        turnId: FOLLOW_UP_TURN_ID,
        attemptId: FOLLOW_UP_ATTEMPT_ID
      },
      turns: [expect.anything(), {
        attempts: [{
          state: {
            status: 'uncertain',
            reason: 'inference_started_without_durable_outcome_after_restart',
            recovery: {
              allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
            }
          }
        }]
      }]
    });
  });
});

describe('AgentSettledEffectBatchTerminalizationCoordinator', () => {
  it('commits a stable model-turn-budget failure and bounded checkpoint', async () => {
    const firstRuns = new MemoryRunUnitOfWork(modelTurnBudgetExhaustedRun());
    const secondRuns = new MemoryRunUnitOfWork(modelTurnBudgetExhaustedRun());
    const firstWork = classifyAgentRunWork(firstRuns.current);
    const secondWork = classifyAgentRunWork(secondRuns.current);
    if (
      firstWork.kind !== 'fail_model_turn_budget'
      || secondWork.kind !== 'fail_model_turn_budget'
    ) {
      throw new Error('expected_model_turn_terminal_work');
    }

    const first = await new AgentSettledEffectBatchTerminalizationCoordinator(firstRuns)
      .terminalize(firstWork, new AbortController().signal);
    const second = await new AgentSettledEffectBatchTerminalizationCoordinator(secondRuns)
      .terminalize(secondWork, new AbortController().signal);

    expect(first).toEqual({
      receiptVersion: 1,
      commandId: second.commandId,
      runId: RUN_ID,
      runVersion: 5,
      checkpointVersion: 5,
      status: 'failed',
      reason: 'model_turn_budget_exhausted',
      errorCode: 'agent_model_turn_budget_exhausted',
      replayed: false
    });
    expect(firstRuns.current.state).toEqual({
      status: 'failed',
      checkpointVersion: 5,
      failedAt: at(3),
      errorCode: 'agent_model_turn_budget_exhausted',
      message:
        'The immutable Agent Run model-turn budget was exhausted after the Effect batch settled.'
    });
    expect(firstRuns.lastCommit?.mutations[0]?.artifacts.checkpoint).toEqual({
      checkpointVersion: 5,
      createdAt: at(3),
      payload: {
        format: 'ariadne.agent-checkpoint',
        schemaVersion: 1,
        engineContinuation: {
          phase: 'effect_results_terminalized',
          reason: 'model_turn_budget_exhausted',
          sourceTurnId: SOURCE_TURN_ID,
          sourceAttemptId: SOURCE_ATTEMPT_ID,
          sourceDirectiveDigest: DIRECTIVE_DIGEST,
          effectIds: [EFFECT_A_ID, EFFECT_B_ID],
          toolCallIds: [TOOL_CALL_A_ID, TOOL_CALL_B_ID]
        },
        modelContext: null
      }
    });
  });

  it('commits the deterministic deadline failure at the durable observation time', async () => {
    const runs = new MemoryRunUnitOfWork(deadlineExpiredRun());
    const work = classifyAgentRunWork(runs.current);
    if (work.kind !== 'fail_deadline_expired') {
      throw new Error('expected_deadline_terminal_work');
    }

    const receipt = await new AgentSettledEffectBatchTerminalizationCoordinator(runs)
      .terminalize(work, new AbortController().signal);

    expect(receipt).toMatchObject({
      runVersion: 5,
      checkpointVersion: 5,
      status: 'failed',
      reason: 'deadline_expired',
      errorCode: 'agent_run_deadline_expired'
    });
    expect(runs.current.state).toEqual({
      status: 'failed',
      checkpointVersion: 5,
      failedAt: at(3),
      errorCode: 'agent_run_deadline_expired',
      message:
        'The immutable Agent Run deadline expired after the Effect batch settled.'
    });
  });

  it('reports a typed version conflict for stale terminal work', async () => {
    const runs = new MemoryRunUnitOfWork(modelTurnBudgetExhaustedRun());
    const work = classifyAgentRunWork(runs.current);
    if (work.kind !== 'fail_model_turn_budget') {
      throw new Error('expected_model_turn_terminal_work');
    }
    const coordinator = new AgentSettledEffectBatchTerminalizationCoordinator(runs);
    await coordinator.terminalize(work, new AbortController().signal);

    await expect(coordinator.terminalize(work, new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({
        constructor: AgentRunVersionConflictError,
        code: 'AGENT_RUN_VERSION_CONFLICT',
        expectedVersion: 4,
        actualVersion: 5
      }));
  });
});

const RUN_ID = 'run-work-classifier';
const SOURCE_TURN_ID = 'turn-source';
const SOURCE_ATTEMPT_ID = 'attempt-source';
const FOLLOW_UP_TURN_ID = 'turn-follow-up';
const FOLLOW_UP_ATTEMPT_ID = 'attempt-follow-up';
const EFFECT_A_ID = 'effect-a';
const EFFECT_B_ID = 'effect-b';
const TOOL_CALL_A_ID = 'tool-call-a';
const TOOL_CALL_B_ID = 'tool-call-b';
const DIRECTIVE_DIGEST = digest('a');
const SOURCE_INPUT_DIGEST = digest('b');
const FOLLOW_UP_INPUT_DIGEST = digest('c');
const INPUT_A_DIGEST = digest('d');
const INPUT_B_DIGEST = digest('e');
const TOOL = {
  catalogId: 'catalog-work',
  revision: 1,
  digest: digest('f'),
  toolName: 'workspace.read',
  toolVersion: '1.0.0',
  providerId: 'ariadne.builtin',
  contractDigest: digest('1')
} as const;

function toolBatchRun(states: readonly AgentEffect['state'][]): MutableAgentRun {
  if (states.length !== 2) throw new Error('The fixture requires two Effect states.');
  const binding = conversationBinding();
  const invocations = [
    committedInvocation(EFFECT_A_ID, TOOL_CALL_A_ID, INPUT_A_DIGEST, 'idempotency-a'),
    committedInvocation(EFFECT_B_ID, TOOL_CALL_B_ID, INPUT_B_DIGEST, 'idempotency-b')
  ];
  const run: MutableAgentRun = {
    runId: RUN_ID,
    version: 4,
    binding,
    state: { status: 'running', checkpointVersion: 4, enteredAt: at(0) },
    turns: [{
      turnId: SOURCE_TURN_ID,
      runId: RUN_ID,
      intention: intention(binding, {
        kind: 'conversation_objective',
        messageId: 'message-work',
        messageVersion: 1,
        contentDigest: digest('2')
      }, null, 1, SOURCE_INPUT_DIGEST),
      attempts: [{
        attemptId: SOURCE_ATTEMPT_ID,
        turnId: SOURCE_TURN_ID,
        runId: RUN_ID,
        providerIdempotencyKey: 'provider-source',
        cause: { kind: 'initial' },
        state: {
          status: 'succeeded',
          finishedAt: at(1),
          directive: { kind: 'invoke_tools', invocations },
          directiveDigest: DIRECTIVE_DIGEST
        }
      }],
      createdAt: at(0)
    }],
    effects: [
      effect(EFFECT_A_ID, TOOL_CALL_A_ID, INPUT_A_DIGEST, 'idempotency-a', states[0]!),
      effect(EFFECT_B_ID, TOOL_CALL_B_ID, INPUT_B_DIGEST, 'idempotency-b', states[1]!)
    ],
    createdAt: at(0),
    updatedAt: at(3)
  };
  assertValidAgentRun(run);
  return run;
}

function terminalBatchRun(): MutableAgentRun {
  return toolBatchRun([
    { status: 'succeeded', finishedAt: at(3), attempt: 1 },
    { status: 'cancelled', cancelledAt: at(3), attempts: 0, reason: 'cancelled' }
  ]);
}

function modelTurnBudgetExhaustedRun(): MutableAgentRun {
  const run = terminalBatchRun();
  replaceRunBudget(run, {
    ...run.binding.budget,
    vector: { ...run.binding.budget.vector, modelTurns: 1 }
  });
  assertValidAgentRun(run);
  return run;
}

function deadlineExpiredRun(): MutableAgentRun {
  const run = modelTurnBudgetExhaustedRun();
  replaceRunBudget(run, { ...run.binding.budget, deadlineAt: at(3) });
  assertValidAgentRun(run);
  return run;
}

function replaceRunBudget(
  run: MutableAgentRun,
  budget: AgentRun['binding']['budget']
): void {
  run.binding = { ...run.binding, budget };
  run.turns = run.turns.map((turn) => ({
    ...turn,
    intention: { ...turn.intention, budget }
  }));
}

function continuationRun(status: 'intended' | 'started'): MutableAgentRun {
  const run = terminalBatchRun();
  run.version = 6;
  run.state = { status: 'running', checkpointVersion: 6, enteredAt: at(4) };
  run.turns = [...run.turns, {
    turnId: FOLLOW_UP_TURN_ID,
    runId: RUN_ID,
    intention: intention(run.binding, {
      kind: 'effect_results',
      sourceTurnId: SOURCE_TURN_ID,
      sourceAttemptId: SOURCE_ATTEMPT_ID,
      sourceDirectiveDigest: DIRECTIVE_DIGEST,
      effectIds: [EFFECT_A_ID, EFFECT_B_ID],
      toolCallIds: [TOOL_CALL_A_ID, TOOL_CALL_B_ID]
    }, 4, 6, FOLLOW_UP_INPUT_DIGEST),
    attempts: [{
      attemptId: FOLLOW_UP_ATTEMPT_ID,
      turnId: FOLLOW_UP_TURN_ID,
      runId: RUN_ID,
      providerIdempotencyKey: 'provider-follow-up',
      cause: { kind: 'initial' },
      state: status === 'intended'
        ? { status: 'intended', intendedAt: at(4) }
        : { status: 'started', startedAt: at(5) }
    }],
    createdAt: at(4)
  }];
  run.updatedAt = status === 'started' ? at(5) : at(4);
  assertValidAgentRun(run);
  return run;
}

function objectiveRun(
  causeKind: 'conversation_objective' | 'delegation_objective',
  status: 'intended' | 'started'
): MutableAgentRun {
  const binding = causeKind === 'conversation_objective'
    ? conversationBinding()
    : delegationBinding();
  const cause = causeKind === 'conversation_objective'
    ? {
        kind: 'conversation_objective' as const,
        messageId: 'message-work',
        messageVersion: 1,
        contentDigest: digest('2')
      }
    : {
        kind: 'delegation_objective' as const,
        parentRunId: 'run-parent',
        delegationId: 'delegation-work',
        objectiveDigest: digest('9')
      };
  const run: MutableAgentRun = {
    runId: RUN_ID,
    version: status === 'intended' ? 1 : 2,
    binding,
    state: {
      status: 'running',
      checkpointVersion: status === 'intended' ? 1 : 2,
      enteredAt: at(0)
    },
    turns: [{
      turnId: SOURCE_TURN_ID,
      runId: RUN_ID,
      intention: intention(binding, cause, null, 1, SOURCE_INPUT_DIGEST),
      attempts: [{
        attemptId: SOURCE_ATTEMPT_ID,
        turnId: SOURCE_TURN_ID,
        runId: RUN_ID,
        providerIdempotencyKey: 'provider-source',
        cause: { kind: 'initial' },
        state: status === 'intended'
          ? { status: 'intended', intendedAt: at(0) }
          : { status: 'started', startedAt: at(1) }
      }],
      createdAt: at(0)
    }],
    effects: [],
    createdAt: at(0),
    updatedAt: status === 'intended' ? at(0) : at(1)
  };
  assertValidAgentRun(run);
  return run;
}

function queuedRun(): MutableAgentRun {
  const run: MutableAgentRun = {
    runId: RUN_ID,
    version: 1,
    binding: conversationBinding(),
    state: { status: 'queued', checkpointVersion: 0, queuedAt: at(0) },
    turns: [],
    effects: [],
    createdAt: at(0),
    updatedAt: at(0)
  };
  assertValidAgentRun(run);
  return run;
}

function uncertainEffectRun(): MutableAgentRun {
  const run = toolBatchRun([
    { status: 'authorized', authorizedAt: at(2), attempt: 1 },
    { status: 'cancelled', cancelledAt: at(3), attempts: 0, reason: 'blocked' }
  ]);
  run.effects = [{
    ...run.effects[0]!,
    state: { status: 'uncertain', observedAt: at(3), attempt: 1, reason: 'process lost' }
  }, run.effects[1]!];
  run.version = 5;
  run.state = {
    status: 'recovering',
    reason: 'uncertain_effect',
    checkpointVersion: 5,
    decision: {
      kind: 'recovery',
      decisionId: 'decision-recover-a',
      runId: RUN_ID,
      checkpoint: { runId: RUN_ID, version: 5 },
      requestedAt: at(3),
      effectId: EFFECT_A_ID,
      uncertainty: 'process lost',
      allowedActions: ['mark_succeeded', 'mark_failed']
    }
  };
  run.updatedAt = at(3);
  assertValidAgentRun(run);
  return run;
}

function directiveRun(
  directive: Extract<
    AgentInferenceAttemptState,
    { readonly status: 'succeeded' }
  >['directive']
): MutableAgentRun {
  const run = objectiveRun('conversation_objective', 'intended');
  run.version = 2;
  run.state = { status: 'running', checkpointVersion: 2, enteredAt: at(0) };
  run.turns = [{
    ...run.turns[0]!,
    attempts: [{
      ...run.turns[0]!.attempts[0]!,
      state: {
        status: 'succeeded',
        finishedAt: at(1),
        directive,
        directiveDigest: digest('6')
      }
    }]
  }];
  run.updatedAt = at(1);
  assertValidAgentRun(run);
  return run;
}

function conversationBinding(): AgentRun['binding'] {
  return binding({
    kind: 'conversation_message',
    messageId: 'message-work',
    messageVersion: 1,
    contentDigest: digest('2')
  });
}

function delegationBinding(): AgentRun['binding'] {
  return binding({
    kind: 'parent_delegation',
    parentRunId: 'run-parent',
    delegationId: 'delegation-work',
    objectiveDigest: digest('9')
  });
}

function binding(
  objectiveRef: AgentRun['binding']['objectiveRef']
): AgentRun['binding'] {
  return {
    bindingVersion: 3,
    sessionId: 'session-work',
    objectiveRef,
    workspace: {
      workspaceId: 'workspace-work',
      revision: 1,
      grantDigest: digest('3'),
      access: 'read',
      scopeIds: ['workspace.root']
    },
    model: {
      providerId: 'provider-work',
      modelId: 'model-work',
      settingsRevision: 1
    },
    policy: {
      policyId: 'policy-work',
      revision: 1,
      permissionMode: 'trusted'
    },
    capabilities: [{
      capabilityId: 'workspace.read',
      scopeIds: ['workspace.root']
    }],
    toolCatalog: {
      catalogId: TOOL.catalogId,
      revision: TOOL.revision,
      digest: TOOL.digest,
      allowedToolNames: [TOOL.toolName]
    },
    budget: {
      grantId: 'grant-work',
      runId: RUN_ID,
      vector: {
        modelTurns: 5,
        toolCalls: 4,
        readCalls: 4,
        writeCalls: 0,
        shellCalls: 0,
        costMicrousd: 100_000
      },
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' }
    }
  };
}

function intention(
  bound: AgentRun['binding'],
  cause: AgentRun['turns'][number]['intention']['cause'],
  expectedRunVersion: number | null,
  checkpointVersion: number,
  inputDigest: string
): AgentRun['turns'][number]['intention'] {
  return {
    expectedRunVersion,
    checkpointVersion,
    cause,
    bindingVersion: 3,
    sessionId: bound.sessionId,
    objectiveRef: bound.objectiveRef,
    workspace: bound.workspace,
    model: bound.model,
    policy: bound.policy,
    capabilities: bound.capabilities,
    toolCatalog: bound.toolCatalog,
    budget: bound.budget,
    inputDigest,
    inputSummary: {
      messageCount: cause.kind === 'effect_results' ? 4 : 1,
      toolCount: 1,
      contentCharacterCount: 32
    }
  };
}

function committedInvocation(
  effectId: string,
  toolCallId: string,
  inputDigest: string,
  idempotencyKey: string
) {
  return {
    effectId,
    toolCallId,
    tool: TOOL,
    idempotencyKey,
    capabilityIds: ['workspace.read'],
    scope: ['workspace.root'],
    inputDigest
  };
}

function effect(
  effectId: string,
  toolCallId: string,
  inputDigest: string,
  idempotencyKey: string,
  state: AgentEffect['state']
): AgentEffect {
  return {
    effectId,
    runId: RUN_ID,
    toolCallId,
    tool: TOOL,
    idempotencyKey,
    capabilityIds: ['workspace.read'],
    scope: ['workspace.root'],
    inputDigest,
    origin: {
      turnId: SOURCE_TURN_ID,
      attemptId: SOURCE_ATTEMPT_ID,
      directiveDigest: DIRECTIVE_DIGEST
    },
    state
  };
}

type MutableAgentRun = {
  -readonly [Key in keyof AgentRun]: AgentRun[Key];
};

class MemoryRunUnitOfWork implements AgentRunUnitOfWork {
  private readonly committed = new Map<string, CommittedAgentRunCommand>();
  public lastCommit: AgentRunCommandCommit | null = null;

  public constructor(public current: AgentRun) {}

  public transaction<T>(
    operation: (transaction: AgentRunTransaction) => Promise<T>
  ): Promise<T> {
    const transaction: AgentRunTransaction = {
      loadRun: async (runId) => runId === this.current.runId ? this.current : null,
      loadCommittedCommand: async (commandId) => this.committed.get(commandId) ?? null,
      commitCommand: async (commit: AgentRunCommandCommit) => {
        const mutation = commit.mutations[0];
        if (
          commit.mutations.length !== 1
          || mutation === undefined
          || mutation.runId !== this.current.runId
          || mutation.expectedVersion !== this.current.version
        ) {
          throw new Error('memory_run_commit_conflict');
        }
        this.lastCommit = commit;
        this.current = mutation.run;
        this.committed.set(commit.commandId, {
          commandId: commit.commandId,
          commandDigest: commit.commandDigest,
          mutations: [{
            runId: mutation.runId,
            resultingVersion: mutation.resultingVersion,
            run: mutation.run,
            events: mutation.events
          }]
        });
      }
    };
    return operation(transaction);
  }
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function at(second: number): string {
  return `2030-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
}
