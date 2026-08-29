import { describe, expect, it } from 'vitest';

import {
  DefaultAgentInboxContinuationPlanner,
  admitAgentRun,
  canonicalizeAgentTurnInput,
  digestAgentTurnInput,
  summarizeAgentTurnInput,
  type AgentRun,
  type AgentInboxInputSource,
  type AgentTurnInputModelData,
  type AgentTurnInputSnapshotV1
} from '../src/index.js';
import { transitionAgentRun } from '../src/application/transition-agent-run.js';
import { at, bindingForRun, testAvailableTool } from './fixtures.js';

const RUN_ID = 'run-inbox';
const TURN_ID = 'turn-inbox-objective';
const ATTEMPT_ID = 'attempt-inbox-objective';
const INPUT: AgentTurnInputModelData = {
  messages: [{ kind: 'text', role: 'user', content: 'Initial objective.' }],
  availableTools: [
    testAvailableTool('workspace.read'),
    testAvailableTool('workspace.write')
  ]
};

describe('AgentRun inbox', () => {
  it('interrupts only a continuable Child Turn and resumes the same Child from preserved inbox order', async () => {
    let run = await admittedContinuableRun();
    run = transitionAgentRun(run, {
      kind: 'run.start_inference_attempt',
      commandId: 'start-child-attempt',
      runId: RUN_ID,
      expectedVersion: 1,
      occurredAt: at(1),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID
    }).run;
    run = enqueue(run, 'input-during-inference', 'next_step', 'Steer the active work.', 2);
    run = transitionAgentRun(run, {
      kind: 'run.record_inference_attempt_result',
      commandId: 'record-child-uncertain',
      runId: RUN_ID,
      expectedVersion: 3,
      occurredAt: at(3),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: {
        status: 'uncertain',
        reason: 'user_interrupted_provider_request',
        recoveryDecisionId: 'recovery-child-interrupt',
        allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'interrupt_turn', 'cancel_run']
      }
    }).run;
    run = transitionAgentRun(run, {
      kind: 'run.interrupt_continuable_turn',
      commandId: 'interrupt-child-turn',
      runId: RUN_ID,
      expectedVersion: 4,
      occurredAt: at(4),
      reason: 'user_requested',
      recoveryDecisionId: 'recovery-child-interrupt'
    }).run;
    expect(run.state).toEqual({
      status: 'waiting_input',
      checkpointVersion: 4,
      enteredAt: at(4),
      interruptedTurnId: TURN_ID,
      interruptedAttemptId: ATTEMPT_ID,
      recoveryDecisionId: 'recovery-child-interrupt'
    });
    run = enqueue(run, 'input-after-interrupt', 'next_turn', 'Continue with this change.', 5);

    const planned = await new DefaultAgentInboxContinuationPlanner().plan({
      run,
      sourceTurnInput: await sourceSnapshot(run),
      boundary: {
        kind: 'interrupted_inference',
        interruptionNotice: 'The previous assistant generation was interrupted before any response was committed.'
      },
      inputIds: ['input-during-inference', 'input-after-interrupt']
    });
    expect(planned.command.turn.cause).toEqual({
      kind: 'interrupted_inference',
      sourceTurnId: TURN_ID,
      sourceAttemptId: ATTEMPT_ID,
      recoveryDecisionId: 'recovery-child-interrupt',
      inputIds: ['input-during-inference', 'input-after-interrupt']
    });
    const resumed = transitionAgentRun(run, planned.command).run;
    expect(resumed.runId).toBe(RUN_ID);
    expect(resumed.state.status).toBe('running');
    expect(resumed.inbox.map((input) => input.state)).toEqual(['claimed', 'claimed']);
    expect(planned.artifacts.turnInputPayloads[0]?.payload.messages.slice(-3)).toEqual([
      { kind: 'text', role: 'system', content: 'The previous assistant generation was interrupted before any response was committed.' },
      { kind: 'text', role: 'user', content: 'Steer the active work.' },
      { kind: 'text', role: 'user', content: 'Continue with this change.' }
    ]);
  });

  it('keeps a response Run active and atomically claims the exact boundary batch', async () => {
    let run = await admittedRun();
    run = transitionAgentRun(run, {
      kind: 'run.start_inference_attempt',
      commandId: 'start-inbox-attempt',
      runId: RUN_ID,
      expectedVersion: 1,
      occurredAt: at(1),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID
    }).run;
    run = enqueue(run, 'input-next-turn', 'next_turn', 'First queued turn.', 2);
    run = enqueue(run, 'input-next-step', 'next_step', 'Urgent steering.', 3);
    run = enqueue(run, 'input-live-work', 'next_step', 'Job completed.', 3, {
      kind: 'live_work',
      jobId: 'job-1',
      workKind: 'process',
      status: 'completed'
    });
    run = transitionAgentRun(run, {
      kind: 'run.record_inference_attempt_result',
      commandId: 'finish-inbox-response',
      runId: RUN_ID,
      expectedVersion: 5,
      occurredAt: at(4),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: {
        status: 'succeeded',
        directive: {
          kind: 'respond',
          contentRef: 'response-inbox-objective',
          contentDigest: digest('a')
        },
        directiveDigest: digest('b')
      }
    }).run;

    expect(run.state.status).toBe('running');
    const snapshot = await sourceSnapshot(run);
    const planned = await new DefaultAgentInboxContinuationPlanner().plan({
      run,
      sourceTurnInput: snapshot,
      boundary: {
        kind: 'settled_response',
        assistantContent: 'Initial answer.'
      },
      inputIds: ['input-next-turn', 'input-next-step', 'input-live-work']
    });
    expect(planned.artifacts.turnInputPayloads[0]?.payload.messages).toEqual([
      ...INPUT.messages,
      { kind: 'text', role: 'assistant', content: 'Initial answer.' },
      { kind: 'text', role: 'user', content: 'First queued turn.' },
      { kind: 'text', role: 'user', content: 'Urgent steering.' },
      { kind: 'text', role: 'system', content: 'Job completed.' }
    ]);

    const claimed = transitionAgentRun(run, planned.command);
    expect(claimed.events).toContainEqual({
      type: 'inbox.inputs_claimed',
      turnId: planned.command.turn.turnId,
      inputIds: ['input-next-turn', 'input-next-step', 'input-live-work']
    });
    expect(claimed.run.inbox.map((input) => ({
      inputId: input.inputId,
      state: input.state,
      claimedTurnId: input.state === 'claimed' ? input.claimedTurnId : null
    }))).toEqual([
      {
        inputId: 'input-next-turn',
        state: 'claimed',
        claimedTurnId: planned.command.turn.turnId
      },
      {
        inputId: 'input-next-step',
        state: 'claimed',
        claimedTurnId: planned.command.turn.turnId
      },
      {
        inputId: 'input-live-work',
        state: 'claimed',
        claimedTurnId: planned.command.turn.turnId
      }
    ]);
    expect(() => transitionAgentRun(claimed.run, planned.command)).toThrow();
  });

  it('continues an ask-user boundary from its exact durable answer', async () => {
    let run = await admittedRun();
    run = transitionAgentRun(run, {
      kind: 'run.start_inference_attempt',
      commandId: 'start-user-question-attempt',
      runId: RUN_ID,
      expectedVersion: 1,
      occurredAt: at(1),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID
    }).run;
    run = transitionAgentRun(run, {
      kind: 'run.record_inference_attempt_result',
      commandId: 'finish-user-question-attempt',
      runId: RUN_ID,
      expectedVersion: 2,
      occurredAt: at(2),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: {
        status: 'succeeded',
        directive: {
          kind: 'ask_user',
          decisionId: 'decision-user-question',
          questionRef: 'question-user-question',
          questionDigest: digest('a')
        },
        directiveDigest: digest('b')
      }
    }).run;
    if (run.state.status !== 'waiting' || run.state.reason !== 'user_question') {
      throw new Error('expected user question');
    }
    const decision = run.state.decision;
    run = transitionAgentRun(run, {
      kind: 'run.resolve_decision',
      commandId: 'answer-user-question',
      runId: RUN_ID,
      expectedVersion: 3,
      occurredAt: at(3),
      resolution: {
        kind: 'user_question',
        decisionId: decision.decisionId,
        checkpoint: decision.checkpoint,
        resolvedAt: at(3),
        questionRef: decision.questionRef,
        questionDigest: decision.questionDigest,
        answerInputId: 'input-user-question-answer',
        answerDigest: digest('c')
      },
      answerInput: {
        inputId: 'input-user-question-answer',
        messageId: 'message-user-question-answer',
        content: 'local: Local only',
        contentDigest: digest('c')
      }
    }).run;

    const planned = await new DefaultAgentInboxContinuationPlanner().plan({
      run,
      sourceTurnInput: await sourceSnapshot(run),
      boundary: {
        kind: 'settled_response',
        assistantContent: 'Which execution path should be used?'
      },
      inputIds: ['input-user-question-answer']
    });
    const continued = transitionAgentRun(run, planned.command).run;

    expect(continued.state.status).toBe('running');
    expect(continued.inbox).toMatchObject([{
      inputId: 'input-user-question-answer',
      content: 'local: Local only',
      state: 'claimed',
      claimedTurnId: planned.command.turn.turnId,
      source: {
        kind: 'user_question_answer',
        decisionId: decision.decisionId,
        questionDigest: decision.questionDigest
      }
    }]);
    expect(planned.artifacts.turnInputPayloads[0]?.payload.messages.slice(-2)).toEqual([
      { kind: 'text', role: 'assistant', content: 'Which execution path should be used?' },
      { kind: 'text', role: 'user', content: 'local: Local only' }
    ]);
  });

  it('uses entry versions for replace/remove and rejects input without another model Turn', async () => {
    let run = await admittedRun();
    run = enqueue(run, 'input-editable', 'next_turn', 'Before.', 1);
    run = transitionAgentRun(run, {
      kind: 'run.replace_inbox_input',
      commandId: 'replace-input-editable',
      runId: RUN_ID,
      expectedVersion: 2,
      occurredAt: at(2),
      inputId: 'input-editable',
      expectedInputVersion: 1,
      content: 'After.',
      contentDigest: digest('d')
    }).run;
    expect(run.inbox[0]).toMatchObject({ version: 2, content: 'After.' });
    expect(() => transitionAgentRun(run, {
      kind: 'run.remove_inbox_input',
      commandId: 'remove-stale-input',
      runId: RUN_ID,
      expectedVersion: 3,
      occurredAt: at(3),
      inputId: 'input-editable',
      expectedInputVersion: 1
    })).toThrow(/version conflict/);
    run = transitionAgentRun(run, {
      kind: 'run.remove_inbox_input',
      commandId: 'remove-input-editable',
      runId: RUN_ID,
      expectedVersion: 3,
      occurredAt: at(3),
      inputId: 'input-editable',
      expectedInputVersion: 2
    }).run;
    expect(run.inbox).toEqual([]);

    run = enqueue(run, 'input-system', 'next_step', 'System notice.', 4, {
      kind: 'live_work',
      jobId: 'job-system',
      workKind: 'process',
      status: 'completed'
    });
    expect(() => transitionAgentRun(run, {
      kind: 'run.remove_inbox_input',
      commandId: 'remove-system-input',
      runId: RUN_ID,
      expectedVersion: run.version,
      occurredAt: at(5),
      inputId: 'input-system',
      expectedInputVersion: 1
    })).toThrow(/System Agent inbox input is immutable/);

    const exhausted = {
      ...run,
      binding: {
        ...run.binding,
        budget: {
          ...run.binding.budget,
          vector: { ...run.binding.budget.vector, modelTurns: 1 }
        }
      },
      turns: run.turns.map((turn) => ({
        ...turn,
        intention: {
          ...turn.intention,
          budget: {
            ...turn.intention.budget,
            vector: { ...turn.intention.budget.vector, modelTurns: 1 }
          }
        }
      }))
    } as AgentRun;
    expect(() => enqueue(exhausted, 'input-too-late', 'next_turn', 'Too late.', 4))
      .toThrow(/remaining model Turn/);
    expect(enqueue(exhausted, 'input-terminal-fact', 'next_step', 'Job interrupted.', 4, {
      kind: 'live_work',
      jobId: 'job-terminal-fact',
      workKind: 'process',
      status: 'interrupted'
    }).inbox).toContainEqual(expect.objectContaining({
      inputId: 'input-terminal-fact',
      state: 'queued',
      source: expect.objectContaining({ status: 'interrupted' })
    }));
  });
});

async function admittedRun(): Promise<AgentRun> {
  const binding = bindingForRun(RUN_ID);
  const inputDigest = await digestAgentTurnInput(INPUT);
  return admitAgentRun({
    kind: 'run.admit',
    commandId: 'admit-inbox-run',
    runId: RUN_ID,
    occurredAt: at(0),
    binding,
    turn: {
      cause: {
        kind: 'conversation_objective',
        messageId: binding.objectiveRef.kind === 'conversation_message'
          ? binding.objectiveRef.messageId
          : 'unreachable',
        messageVersion: 1,
        contentDigest: binding.objectiveRef.contentDigest
      },
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      providerIdempotencyKey: 'provider-inbox-objective',
      inputDigest,
      inputSummary: summarizeAgentTurnInput(INPUT)
    }
  }).run;
}

async function admittedContinuableRun(): Promise<AgentRun> {
  const parent = bindingForRun('run-parent');
  const objectiveDigest = digest('child-objective');
  const binding = {
    ...bindingForRun(RUN_ID),
    objectiveRef: {
      kind: 'parent_delegation' as const,
      parentRunId: 'run-parent',
      delegationId: 'delegation-continuable',
      objectiveDigest,
      mode: 'continuable' as const,
      providerId: 'ariadne.in_process'
    },
    budget: {
      ...bindingForRun(RUN_ID).budget,
      source: {
        kind: 'parent_allocation' as const,
        parentRunId: 'run-parent',
        parentGrantId: parent.budget.grantId,
        delegationId: 'delegation-continuable'
      }
    }
  };
  const inputDigest = await digestAgentTurnInput(INPUT);
  return admitAgentRun({
    kind: 'run.admit',
    commandId: 'admit-continuable-child',
    runId: RUN_ID,
    occurredAt: at(0),
    binding,
    turn: {
      cause: {
        kind: 'delegation_objective',
        parentRunId: 'run-parent',
        delegationId: 'delegation-continuable',
        objectiveDigest
      },
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      providerIdempotencyKey: 'provider-continuable-child',
      inputDigest,
      inputSummary: summarizeAgentTurnInput(INPUT)
    }
  }).run;
}

function enqueue(
  run: AgentRun,
  inputId: string,
  delivery: 'next_turn' | 'next_step',
  content: string,
  second: number,
  source?: AgentInboxInputSource
): AgentRun {
  return transitionAgentRun(run, {
    kind: 'run.enqueue_inbox_input',
    commandId: `enqueue-${inputId}`,
    runId: RUN_ID,
    expectedVersion: run.version,
    occurredAt: at(second),
    input: {
      inputId,
      messageId: `message-${inputId}`,
      delivery,
      content,
      contentDigest: digest(inputId),
      ...(source === undefined ? {} : { source })
    }
  }).run;
}

async function sourceSnapshot(run: AgentRun): Promise<AgentTurnInputSnapshotV1> {
  const binding = run.binding;
  const turn = run.turns[0]!;
  return {
    format: 'ariadne.agent-turn-input',
    schemaVersion: 1,
    runId: run.runId,
    turnId: turn.turnId,
    cause: turn.intention.cause,
    authorityRef: binding.objectiveRef.kind === 'conversation_message'
      ? {
          kind: 'conversation_message',
          sessionId: binding.sessionId,
          workspaceId: binding.workspace.workspaceId,
          messageId: binding.objectiveRef.messageId,
          messageVersion: binding.objectiveRef.messageVersion,
          contentDigest: binding.objectiveRef.contentDigest
        }
      : {
          kind: 'parent_delegation',
          parentRunId: binding.objectiveRef.parentRunId,
          delegationId: binding.objectiveRef.delegationId,
          objectiveDigest: binding.objectiveRef.objectiveDigest,
          mode: binding.objectiveRef.mode,
          providerId: binding.objectiveRef.providerId
        },
    messages: JSON.parse(canonicalizeAgentTurnInput(INPUT)).messages,
    availableTools: INPUT.availableTools
  };
}

function digest(seed: string): string {
  const nibble = (seed.codePointAt(0) ?? 0) % 16;
  return `sha256:${nibble.toString(16).repeat(64)}`;
}
