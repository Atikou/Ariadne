import { describe, expect, it } from 'vitest';

import {
  DefaultAgentInboxContinuationPlanner,
  admitAgentRun,
  canonicalizeAgentTurnInput,
  digestAgentTurnInput,
  summarizeAgentTurnInput,
  type AgentRun,
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
    run = transitionAgentRun(run, {
      kind: 'run.record_inference_attempt_result',
      commandId: 'finish-inbox-response',
      runId: RUN_ID,
      expectedVersion: 4,
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
      assistantContent: 'Initial answer.',
      inputIds: ['input-next-turn', 'input-next-step']
    });
    expect(planned.artifacts.turnInputPayloads[0]?.payload.messages).toEqual([
      ...INPUT.messages,
      { kind: 'text', role: 'assistant', content: 'Initial answer.' },
      { kind: 'text', role: 'user', content: 'First queued turn.' },
      { kind: 'text', role: 'user', content: 'Urgent steering.' }
    ]);

    const claimed = transitionAgentRun(run, planned.command);
    expect(claimed.events).toContainEqual({
      type: 'inbox.inputs_claimed',
      turnId: planned.command.turn.turnId,
      inputIds: ['input-next-turn', 'input-next-step']
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
      }
    ]);
    expect(() => transitionAgentRun(claimed.run, planned.command)).toThrow();
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

function enqueue(
  run: AgentRun,
  inputId: string,
  delivery: 'next_turn' | 'next_step',
  content: string,
  second: number
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
      contentDigest: digest(inputId)
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
    authorityRef: {
      kind: 'conversation_message',
      sessionId: binding.sessionId,
      workspaceId: binding.workspace.workspaceId,
      messageId: binding.objectiveRef.kind === 'conversation_message'
        ? binding.objectiveRef.messageId
        : 'unreachable',
      messageVersion: 1,
      contentDigest: binding.objectiveRef.contentDigest
    },
    messages: JSON.parse(canonicalizeAgentTurnInput(INPUT)).messages,
    availableTools: INPUT.availableTools
  };
}

function digest(seed: string): string {
  const nibble = (seed.codePointAt(0) ?? 0) % 16;
  return `sha256:${nibble.toString(16).repeat(64)}`;
}
