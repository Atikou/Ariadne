import { describe, expect, it } from 'vitest';

import {
  AgentRunCommandService,
  DefaultAgentEffectContinuationPlanner,
  admitAgentRun,
  assertAgentTurnInputSnapshotMatchesTerminalEffectEvidence,
  assertValidAgentRun,
  canonicalizeAgentTurnInput,
  digestAgentTurnInput,
  summarizeAgentTurnInput,
  type AgentEffect,
  type AgentEffectResultContinuationAuthorityCheck,
  type AgentRun,
  type AgentRunCommandCommit,
  type AgentRunTransaction,
  type AgentRunUnitOfWork,
  type AgentTerminalEffectResultEvidence,
  type AgentTurnInputSnapshotV1
} from '../src/index.js';
import { transitionAgentRun } from '../src/application/transition-agent-run.js';
import {
  at,
  bindingForRun,
  testAvailableTool,
  testPinnedToolIdentity
} from './fixtures.js';

const RUN_ID = 'continuation-run';
const DIRECTIVE_DIGEST = `sha256:${'7'.repeat(64)}`;
const INPUT_DIGESTS = [
  `sha256:${'1'.repeat(64)}`,
  `sha256:${'2'.repeat(64)}`,
  `sha256:${'3'.repeat(64)}`
] as const;

describe('DefaultAgentEffectContinuationPlanner', () => {
  it('claims only next-step inbox entries at an Effect-result boundary', async () => {
    const fixture = await sourceFixture();
    const run: AgentRun = {
      ...fixture.run,
      version: fixture.run.version + 2,
      inbox: [{
        inputId: 'input-next-turn-after-effects',
        messageId: 'message-next-turn-after-effects',
        version: 1,
        delivery: 'next_turn',
        content: 'Wait for the response boundary.',
        contentDigest: `sha256:${'5'.repeat(64)}`,
        queuedAt: at(7),
        updatedAt: at(7),
        state: 'queued'
      }, {
        inputId: 'input-next-step-after-effects',
        messageId: 'message-next-step-after-effects',
        version: 1,
        delivery: 'next_step',
        content: 'Apply before the next model step.',
        contentDigest: `sha256:${'6'.repeat(64)}`,
        queuedAt: at(7),
        updatedAt: at(7),
        state: 'queued'
      }]
    };
    assertValidAgentRun(run);

    const planned = await new DefaultAgentEffectContinuationPlanner().plan({
      run,
      sourceTurnInput: fixture.snapshot,
      effectResults: fixture.evidence
    });
    expect(planned.command.turn.cause).toMatchObject({
      kind: 'effect_results',
      inboxInputIds: ['input-next-step-after-effects']
    });
    expect(planned.turnInput.messages.at(-1)).toEqual({
      kind: 'text',
      role: 'user',
      content: 'Apply before the next model step.'
    });
    const claimed = transitionAgentRun(run, planned.command).run;
    expect(claimed.inbox).toMatchObject([{
      inputId: 'input-next-turn-after-effects',
      state: 'queued'
    }, {
      inputId: 'input-next-step-after-effects',
      state: 'claimed',
      claimedTurnId: planned.command.turn.turnId
    }]);
  });

  it('builds one stable full-history continuation and validates protected evidence', async () => {
    const fixture = await sourceFixture();
    const planner = new DefaultAgentEffectContinuationPlanner();

    const first = await planner.plan({
      run: fixture.run,
      sourceTurnInput: fixture.snapshot,
      effectResults: fixture.evidence
    });
    const replay = await planner.plan({
      run: fixture.run,
      sourceTurnInput: fixture.snapshot,
      effectResults: fixture.evidence
    });

    expect(replay).toEqual(first);
    expect(first.command).toMatchObject({
      kind: 'run.register_turn',
      expectedVersion: fixture.run.version,
      occurredAt: fixture.run.updatedAt,
      turn: {
        cause: {
          kind: 'effect_results',
          sourceTurnId: 'source-turn',
          sourceAttemptId: 'source-attempt',
          effectIds: ['effect-1', 'effect-2', 'effect-3'],
          toolCallIds: ['call-1', 'call-2', 'call-3']
        }
      }
    });
    expect(first.turnInput.messages).toEqual([
      ...fixture.snapshot.messages,
      {
        kind: 'effect_result',
        effectId: 'effect-1',
        toolCallId: 'call-1',
        status: 'succeeded',
        result: { text: '完成：你好😀' }
      },
      {
        kind: 'effect_result',
        effectId: 'effect-2',
        toolCallId: 'call-2',
        status: 'failed',
        result: { code: 'write_denied' }
      },
      {
        kind: 'effect_result',
        effectId: 'effect-3',
        toolCallId: 'call-3',
        status: 'cancelled',
        result: {
          kind: 'ariadne.effect-cancellation',
          schemaVersion: 1,
          reason: 'user_cancelled'
        }
      }
    ]);
    expect(first.checkpoint.payload.modelContext).toBeNull();
    expect(first.turnInput.availableTools).toEqual(fixture.snapshot.availableTools);
    expect(first.turnInput.authorityRef).toEqual(fixture.snapshot.authorityRef);

    const next = transitionAgentRun(fixture.run, first.command).run;
    expect(() => assertAgentTurnInputSnapshotMatchesTerminalEffectEvidence(
      next,
      first.command.turn.turnId,
      first.turnInput,
      fixture.evidence
    )).not.toThrow();
    const drifted = fixture.evidence.map((item, index) => index === 0 && item.kind === 'protected_result'
      ? { ...item, result: { text: 'drifted' } }
      : item);
    expect(() => assertAgentTurnInputSnapshotMatchesTerminalEffectEvidence(
      next,
      first.command.turn.turnId,
      first.turnInput,
      drifted
    )).toThrow(/turn_input_digest_mismatch/);
  });

  it.each([
    ['partial', (items: readonly AgentTerminalEffectResultEvidence[]) => items.slice(0, 2)],
    ['unordered', (items: readonly AgentTerminalEffectResultEvidence[]) => [items[1]!, items[0]!, items[2]!]],
    ['duplicate', (items: readonly AgentTerminalEffectResultEvidence[]) => [items[0]!, items[0]!, items[2]!]],
    ['identity drift', (items: readonly AgentTerminalEffectResultEvidence[]) => [
      { ...items[0]!, inputDigest: `sha256:${'9'.repeat(64)}` }, items[1]!, items[2]!
    ]]
  ])('fails closed for a %s result batch', async (_name, mutate) => {
    const fixture = await sourceFixture();
    await expect(new DefaultAgentEffectContinuationPlanner().plan({
      run: fixture.run,
      sourceTurnInput: fixture.snapshot,
      effectResults: mutate(fixture.evidence)
    })).rejects.toThrow();
  });

  it('fails closed at deadline, model-turn exhaustion, and unsettled outcomes', async () => {
    const fixture = await sourceFixture();
    const planner = new DefaultAgentEffectContinuationPlanner();
    const deadlineRun = {
      ...fixture.run,
      updatedAt: fixture.run.binding.budget.deadlineAt,
      state: { ...fixture.run.state, enteredAt: fixture.run.binding.budget.deadlineAt }
    } as AgentRun;
    await expect(planner.plan({
      run: deadlineRun,
      sourceTurnInput: fixture.snapshot,
      effectResults: fixture.evidence
    })).rejects.toThrow(/deadline/);

    const exhaustedBudget = {
      ...fixture.run.binding.budget,
      vector: { ...fixture.run.binding.budget.vector, modelTurns: 1 }
    };
    const exhausted = {
      ...fixture.run,
      binding: {
        ...fixture.run.binding,
        budget: exhaustedBudget
      },
      turns: fixture.run.turns.map((turn) => ({
        ...turn,
        intention: { ...turn.intention, budget: exhaustedBudget }
      }))
    } as AgentRun;
    await expect(planner.plan({
      run: exhausted,
      sourceTurnInput: fixture.snapshot,
      effectResults: fixture.evidence
    })).rejects.toThrow(/model-turn budget/);

    const unsettled = replaceEffectState(fixture.run, 0, {
      status: 'started', startedAt: at(7), attempt: 1
    });
    await expect(planner.plan({
      run: unsettled,
      sourceTurnInput: fixture.snapshot,
      effectResults: fixture.evidence
    })).rejects.toThrow();
  });

  it('enforces the canonical UTF-8 byte boundary with multibyte result text', async () => {
    const fixture = await sourceFixture(['succeeded']);
    const base = fixture.evidence[0];
    if (base?.kind !== 'protected_result') throw new Error('expected protected result');
    const fits = (count: number): boolean => {
      try {
        canonicalizeAgentTurnInput({
          messages: [...fixture.snapshot.messages, {
            kind: 'effect_result',
            effectId: base.effectId,
            toolCallId: base.toolCallId,
            status: base.status,
            result: { text: '😀'.repeat(count) }
          }],
          availableTools: fixture.snapshot.availableTools
        });
        return true;
      } catch {
        return false;
      }
    };
    let low = 0;
    let high = 60_000;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle - 1;
    }
    expect(fits(low)).toBe(true);
    expect(fits(low + 1)).toBe(false);
    await expect(new DefaultAgentEffectContinuationPlanner().plan({
      run: fixture.run,
      sourceTurnInput: fixture.snapshot,
      effectResults: [{ ...base, result: { text: '😀'.repeat(low) } }]
    })).resolves.toBeDefined();
    await expect(new DefaultAgentEffectContinuationPlanner().plan({
      run: fixture.run,
      sourceTurnInput: fixture.snapshot,
      effectResults: [{ ...base, result: { text: '😀'.repeat(low + 1) } }]
    })).rejects.toThrow(/UTF-8 byte-size/);
  });
});

describe('AgentRunCommandService effect-result continuation authority', () => {
  it('requires the exact durable authority check after digest validation and before commit', async () => {
    const fixture = await sourceFixture();
    const plan = await new DefaultAgentEffectContinuationPlanner().plan({
      run: fixture.run,
      sourceTurnInput: fixture.snapshot,
      effectResults: fixture.evidence
    });
    const sequence: string[] = [];
    let received: AgentEffectResultContinuationAuthorityCheck | null = null;
    const unitOfWork = continuationUnitOfWork(fixture.run, {
      assertAuthority: async (check) => {
        sequence.push('authority');
        received = check;
      },
      commit: async () => {
        sequence.push('commit');
      }
    });

    await expect(new AgentRunCommandService(unitOfWork).execute(
      plan.command,
      plan.artifacts
    )).resolves.toMatchObject({ replayed: false });

    expect(sequence).toEqual(['authority', 'commit']);
    expect(received).toEqual({
      commandId: plan.command.commandId,
      runId: fixture.run.runId,
      expectedVersion: fixture.run.version,
      resultingVersion: fixture.run.version + 1,
      turnId: plan.command.turn.turnId,
      inputDigest: plan.command.turn.inputDigest,
      snapshot: plan.turnInput
    });
  });

  it('fails closed without a persistence authority implementation and performs no write', async () => {
    const fixture = await sourceFixture();
    const plan = await new DefaultAgentEffectContinuationPlanner().plan({
      run: fixture.run,
      sourceTurnInput: fixture.snapshot,
      effectResults: fixture.evidence
    });
    let commitCount = 0;
    const unitOfWork = continuationUnitOfWork(fixture.run, {
      commit: async () => {
        commitCount += 1;
      }
    });

    await expect(new AgentRunCommandService(unitOfWork).execute(
      plan.command,
      plan.artifacts
    )).rejects.toMatchObject({
      code: 'AGENT_RUN_INVARIANT',
      message: expect.stringContaining('cannot prove effect-result continuation authority')
    });
    expect(commitCount).toBe(0);
  });

  it('rejects a drifted snapshot digest before asking persistence for authority', async () => {
    const fixture = await sourceFixture();
    const plan = await new DefaultAgentEffectContinuationPlanner().plan({
      run: fixture.run,
      sourceTurnInput: fixture.snapshot,
      effectResults: fixture.evidence
    });
    let authorityCount = 0;
    let commitCount = 0;
    const unitOfWork = continuationUnitOfWork(fixture.run, {
      assertAuthority: async () => {
        authorityCount += 1;
      },
      commit: async () => {
        commitCount += 1;
      }
    });
    const driftedArtifacts = {
      ...plan.artifacts,
      turnInputPayloads: [{
        ...plan.turnInputCommit,
        payload: {
          ...plan.turnInput,
          messages: plan.turnInput.messages.map((message) => (
            message.kind === 'effect_result'
              && message.status === 'succeeded'
              && typeof message.result === 'object'
              && message.result !== null
              && !Array.isArray(message.result)
              && typeof message.result.text === 'string'
              ? {
                  ...message,
                  result: { text: 'x'.repeat(message.result.text.length) }
                }
              : message
          ))
        }
      }]
    };

    await expect(new AgentRunCommandService(unitOfWork).execute(
      plan.command,
      driftedArtifacts
    )).rejects.toMatchObject({
      code: 'AGENT_RUN_RECOVERY_CONFLICT',
      reason: 'immutable_payload_conflict',
      message: expect.stringContaining('turn_input_digest_mismatch')
    });
    expect(authorityCount).toBe(0);
    expect(commitCount).toBe(0);
  });
});

function continuationUnitOfWork(
  run: AgentRun,
  handlers: {
    readonly assertAuthority?: (
      check: AgentEffectResultContinuationAuthorityCheck
    ) => Promise<void>;
    readonly commit: (commit: AgentRunCommandCommit) => Promise<void>;
  }
): AgentRunUnitOfWork {
  return {
    async transaction<T>(
      operation: (transaction: AgentRunTransaction) => Promise<T>
    ): Promise<T> {
      const transaction: AgentRunTransaction = {
        loadRun: async (runId) => runId === run.runId ? run : null,
        loadCommittedCommand: async () => null,
        ...(handlers.assertAuthority === undefined
          ? {}
          : { assertEffectResultContinuationAuthority: handlers.assertAuthority }),
        commitCommand: handlers.commit
      };
      return operation(transaction);
    }
  };
}

type Outcome = 'succeeded' | 'failed' | 'cancelled';

async function sourceFixture(
  outcomes: readonly Outcome[] = ['succeeded', 'failed', 'cancelled']
): Promise<{
  readonly run: AgentRun;
  readonly snapshot: AgentTurnInputSnapshotV1;
  readonly evidence: readonly AgentTerminalEffectResultEvidence[];
}> {
  const binding = bindingForRun(RUN_ID);
  const modelData = {
    messages: [
      { kind: 'text' as const, role: 'system' as const, content: 'Ariadne' },
      { kind: 'text' as const, role: 'user' as const, content: '继续执行' }
    ],
    availableTools: [testAvailableTool('workspace.read'), testAvailableTool('workspace.write')]
  };
  const inputDigest = await digestAgentTurnInput(modelData);
  const admitted = admitAgentRun({
    kind: 'run.admit',
    commandId: 'admit-continuation-run',
    runId: RUN_ID,
    occurredAt: at(0),
    binding,
    turn: {
      cause: {
        kind: 'conversation_objective',
        messageId: binding.objectiveRef.kind === 'conversation_message'
          ? binding.objectiveRef.messageId : 'impossible',
        messageVersion: 1,
        contentDigest: binding.objectiveRef.kind === 'conversation_message'
          ? binding.objectiveRef.contentDigest : 'impossible'
      },
      turnId: 'source-turn',
      attemptId: 'source-attempt',
      providerIdempotencyKey: 'source-provider-key',
      inputDigest,
      inputSummary: summarizeAgentTurnInput(modelData)
    }
  }).run;
  const invocations = outcomes.map((outcome, index) => {
    const toolName = index % 2 === 0 ? 'workspace.read' : 'workspace.write';
    return {
      effectId: `effect-${String(index + 1)}`,
      toolCallId: `call-${String(index + 1)}`,
      tool: testPinnedToolIdentity(toolName),
      idempotencyKey: `effect-key-${String(index + 1)}`,
      capabilityIds: [toolName],
      scope: ['workspace'],
      inputDigest: INPUT_DIGESTS[index] ?? `sha256:${'4'.repeat(64)}`
    };
  });
  const sourceTurn = admitted.turns[0]!;
  const effects: AgentEffect[] = invocations.map((invocation, index) => ({
    ...invocation,
    runId: RUN_ID,
    origin: {
      turnId: sourceTurn.turnId,
      attemptId: sourceTurn.attempts[0]!.attemptId,
      directiveDigest: DIRECTIVE_DIGEST
    },
    state: effectState(outcomes[index]!, index)
  }));
  const run: AgentRun = {
    ...admitted,
    version: 8,
    state: { status: 'running', checkpointVersion: 8, enteredAt: at(7) },
    turns: [{
      ...sourceTurn,
      attempts: [{
        ...sourceTurn.attempts[0]!,
        state: {
          status: 'succeeded',
          finishedAt: at(2),
          directive: { kind: 'invoke_tools', invocations },
          directiveDigest: DIRECTIVE_DIGEST
        }
      }]
    }],
    effects,
    updatedAt: at(7)
  };
  assertValidAgentRun(run);
  const snapshot: AgentTurnInputSnapshotV1 = {
    format: 'ariadne.agent-turn-input',
    schemaVersion: 1,
    runId: RUN_ID,
    turnId: sourceTurn.turnId,
    cause: sourceTurn.intention.cause,
    authorityRef: {
      kind: 'conversation_message',
      sessionId: binding.sessionId,
      workspaceId: binding.workspace.workspaceId,
      messageId: binding.objectiveRef.kind === 'conversation_message'
        ? binding.objectiveRef.messageId : 'impossible',
      messageVersion: 1,
      contentDigest: binding.objectiveRef.kind === 'conversation_message'
        ? binding.objectiveRef.contentDigest : 'impossible'
    },
    messages: modelData.messages,
    availableTools: modelData.availableTools
  };
  const evidence: AgentTerminalEffectResultEvidence[] = effects.map((effect) => {
    if (effect.state.status === 'cancelled') {
      return {
        kind: 'aggregate_cancelled',
        runId: RUN_ID,
        effectId: effect.effectId,
        toolCallId: effect.toolCallId,
        inputDigest: effect.inputDigest,
        status: 'cancelled',
        reason: effect.state.reason
      };
    }
    return {
      kind: 'protected_result',
      runId: RUN_ID,
      effectId: effect.effectId,
      toolCallId: effect.toolCallId,
      inputDigest: effect.inputDigest,
      status: effect.state.status,
      result: effect.state.status === 'succeeded'
        ? { text: '完成：你好😀' }
        : { code: 'write_denied' }
    };
  });
  return { run, snapshot, evidence };
}

function effectState(outcome: Outcome, index: number): AgentEffect['state'] {
  if (outcome === 'succeeded') {
    return { status: 'succeeded', finishedAt: at(4 + index), attempt: 1 };
  }
  if (outcome === 'failed') {
    return {
      status: 'failed',
      finishedAt: at(4 + index),
      attempt: 1,
      errorCode: 'tool_failed',
      message: 'sanitized failure'
    };
  }
  return {
    status: 'cancelled',
    cancelledAt: at(4 + index),
    attempts: 1,
    reason: 'user_cancelled'
  };
}

function replaceEffectState(
  run: AgentRun,
  index: number,
  state: AgentEffect['state']
): AgentRun {
  return {
    ...run,
    effects: run.effects.map((effect, effectIndex) =>
      effectIndex === index ? { ...effect, state } : effect)
  };
}
