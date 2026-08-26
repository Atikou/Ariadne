import { describe, expect, it } from 'vitest';

import {
  assertValidAgentRun,
  canonicalizeAgentTurnInput,
  type AgentRun,
  type AgentTurn,
  type AgentTurnInputModelData
} from '../src/index.js';
import {
  bindingForRun,
  testPinnedToolIdentity
} from './fixtures.js';

describe('schema-v5 Turn input safety boundary', () => {
  it('rejects accessor messages without invoking their getter', () => {
    let invoked = false;
    const message = Object.defineProperties({}, {
      kind: { value: 'text', enumerable: true },
      role: { value: 'user', enumerable: true },
      content: {
        enumerable: true,
        get() {
          invoked = true;
          return 'must-not-run';
        }
      }
    });
    expect(() => canonicalizeAgentTurnInput({
      messages: [message as AgentTurnInputModelData['messages'][number]],
      availableTools: []
    })).toThrow(/data field/);
    expect(invoked).toBe(false);
  });

  it.each([
    ['effectId', 'x'.repeat(257), 'tool-call-1'],
    ['toolCallId', 'effect-1', ' tool-call-1 ']
  ])('rejects non-canonical %s identities', (_field, effectId, toolCallId) => {
    expect(() => canonicalizeAgentTurnInput({
      messages: [{
        kind: 'effect_result',
        effectId,
        toolCallId,
        status: 'succeeded',
        result: null
      }],
      availableTools: []
    })).toThrow();
  });

  it('reserves the 1024th exact-model request slot for the Engine protocol prompt', () => {
    const message = { kind: 'text', role: 'user', content: '' } as const;
    expect(() => canonicalizeAgentTurnInput({
      messages: Array.from({ length: 1_023 }, () => ({ ...message })),
      availableTools: []
    })).not.toThrow();
    expect(() => canonicalizeAgentTurnInput({
      messages: Array.from({ length: 1_024 }, () => ({ ...message })),
      availableTools: []
    })).toThrow(/collection bounds/);
  });

  it('bounds canonical UTF-8 bytes rather than JavaScript character count', () => {
    expect(() => canonicalizeAgentTurnInput({
      messages: [{ kind: 'text', role: 'user', content: 'a'.repeat(180 * 1_024) }],
      availableTools: []
    })).not.toThrow();
    expect(() => canonicalizeAgentTurnInput({
      messages: [{ kind: 'text', role: 'user', content: '汉'.repeat(70 * 1_024) }],
      availableTools: []
    })).toThrow(/UTF-8 byte-size bound/);
  });

  it('rejects a serialized continuation that references a later Turn', () => {
    expect(() => assertValidAgentRun(forwardReferenceRun())).toThrow(
      /exact terminal source Effect batch in order/
    );
  });

  it('rejects duplicate continuation causes in serialized aggregate state', () => {
    const run = duplicateContinuationRun();
    expect(() => assertValidAgentRun(run)).toThrow(
      /at most one continuation Turn/
    );
  });
});

function forwardReferenceRun(): AgentRun {
  const run = baseRun();
  const sourceA = sourceTurn(run, 'turn-objective', 'attempt-objective', 'a', null);
  const sourceB = sourceTurn(run, 'turn-source-b', 'attempt-source-b', 'b', effectCause('a'));
  const forward = terminalTurn(
    run,
    'turn-forward',
    'attempt-forward',
    effectCause('b'),
    5,
    6,
    '2026-07-31T00:00:04.000Z'
  );
  return {
    ...run,
    turns: [sourceA, forward, sourceB],
    effects: [effect(run, 'a', 'turn-objective', 'attempt-objective'),
      effect(run, 'b', 'turn-source-b', 'attempt-source-b')]
  };
}

function duplicateContinuationRun(): AgentRun {
  const run = baseRun();
  const source = sourceTurn(run, 'turn-objective', 'attempt-objective', 'a', null);
  const first = terminalTurn(
    run,
    'turn-continuation-1',
    'attempt-continuation-1',
    effectCause('a'),
    3,
    4,
    '2026-07-31T00:00:03.000Z'
  );
  const duplicate = terminalTurn(
    run,
    'turn-continuation-2',
    'attempt-continuation-2',
    effectCause('a'),
    5,
    6,
    '2026-07-31T00:00:04.000Z'
  );
  return {
    ...run,
    turns: [source, first, duplicate],
    effects: [effect(run, 'a', 'turn-objective', 'attempt-objective')]
  };
}

function baseRun(): AgentRun {
  const runId = 'run-turn-input-v5';
  return {
    runId,
    version: 7,
    binding: bindingForRun(runId),
    state: {
      status: 'running',
      checkpointVersion: 7,
      enteredAt: '2026-07-31T00:00:06.000Z'
    },
    turns: [],
    effects: [],
    inbox: [],
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:06.000Z'
  };
}

function sourceTurn(
  run: AgentRun,
  turnId: string,
  attemptId: string,
  batch: 'a' | 'b',
  cause: ReturnType<typeof effectCause> | null
): AgentTurn {
  const createdAt = batch === 'a'
    ? '2026-07-31T00:00:00.000Z'
    : '2026-07-31T00:00:03.000Z';
  return {
    turnId,
    runId: run.runId,
    intention: intention(run, cause ?? {
      kind: 'conversation_objective',
      messageId: 'message-1',
      messageVersion: 1,
      contentDigest: `sha256:${'d'.repeat(64)}`
    }, batch === 'a' ? null : 3, batch === 'a' ? 1 : 4),
    attempts: [{
      attemptId,
      turnId,
      runId: run.runId,
      providerIdempotencyKey: `provider-${batch}`,
      cause: { kind: 'initial' },
      state: {
        status: 'succeeded',
        finishedAt: createdAt,
        directive: {
          kind: 'invoke_tools',
          invocations: [{
            effectId: `effect-${batch}`,
            toolCallId: `tool-call-${batch}`,
            tool: testPinnedToolIdentity('workspace.read'),
            idempotencyKey: `effect-key-${batch}`,
            capabilityIds: ['workspace.read'],
            scope: ['workspace'],
            inputDigest: `sha256:${batch.repeat(64)}`
          }]
        },
        directiveDigest: `sha256:${batch.repeat(64)}`
      }
    }],
    createdAt
  };
}

function terminalTurn(
  run: AgentRun,
  turnId: string,
  attemptId: string,
  cause: ReturnType<typeof effectCause>,
  expectedRunVersion: number,
  checkpointVersion: number,
  createdAt: string
): AgentTurn {
  return {
    turnId,
    runId: run.runId,
    intention: intention(run, cause, expectedRunVersion, checkpointVersion),
    attempts: [{
      attemptId,
      turnId,
      runId: run.runId,
      providerIdempotencyKey: `provider-${attemptId}`,
      cause: { kind: 'initial' },
      state: {
        status: 'succeeded',
        finishedAt: createdAt,
        directive: { kind: 'complete' },
        directiveDigest: `sha256:${'c'.repeat(64)}`
      }
    }],
    createdAt
  };
}

function intention(
  run: AgentRun,
  cause: AgentTurn['intention']['cause'],
  expectedRunVersion: number | null,
  checkpointVersion: number
): AgentTurn['intention'] {
  return {
    expectedRunVersion,
    checkpointVersion,
    cause,
    bindingVersion: 3,
    sessionId: run.binding.sessionId,
    objectiveRef: run.binding.objectiveRef,
    workspace: run.binding.workspace,
    model: run.binding.model,
    policy: run.binding.policy,
    capabilities: run.binding.capabilities,
    toolCatalog: run.binding.toolCatalog,
    budget: run.binding.budget,
    inputDigest: `sha256:${'1'.repeat(64)}`,
    inputSummary: { messageCount: 1, toolCount: 2, contentCharacterCount: 1 }
  };
}

function effectCause(batch: 'a' | 'b') {
  return {
    kind: 'effect_results' as const,
    sourceTurnId: batch === 'a' ? 'turn-objective' : 'turn-source-b',
    sourceAttemptId: batch === 'a' ? 'attempt-objective' : 'attempt-source-b',
    sourceDirectiveDigest: `sha256:${batch.repeat(64)}`,
    effectIds: [`effect-${batch}`],
    toolCallIds: [`tool-call-${batch}`]
  };
}

function effect(
  run: AgentRun,
  batch: 'a' | 'b',
  turnId: string,
  attemptId: string
): AgentRun['effects'][number] {
  return {
    effectId: `effect-${batch}`,
    runId: run.runId,
    toolCallId: `tool-call-${batch}`,
    tool: testPinnedToolIdentity('workspace.read'),
    idempotencyKey: `effect-key-${batch}`,
    capabilityIds: ['workspace.read'],
    scope: ['workspace'],
    inputDigest: `sha256:${batch.repeat(64)}`,
    origin: {
      turnId,
      attemptId,
      directiveDigest: `sha256:${batch.repeat(64)}`
    },
    state: {
      status: 'succeeded',
      finishedAt: '2026-07-31T00:00:05.000Z',
      attempt: 1
    }
  };
}
