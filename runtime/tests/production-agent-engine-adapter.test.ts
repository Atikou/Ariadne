import {
  AgentInferenceDeterministicFailureError,
  assertValidAgentRun,
  type AgentAvailableTool,
  type AgentCommittedDirective,
  type AgentJsonValue,
  type AgentPinnedToolIdentity,
  type AgentRun,
  type AgentTurnInput
} from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  ProductionAgentEngineAdapter,
  type AgentInferenceToolContractReader
} from '../src/adapters/model/ProductionAgentEngineAdapter.js';
import type {
  DispatchExactAgentModelInferenceRequest,
  ExactAgentModelInferenceRuntime,
  ExactAgentModelInferenceResult
} from '../src/control/ports/AgentModelInference.js';

const PROTOCOL = 'ariadne.agent-directive.v3';
const EFFECT_RESULTS_PROTOCOL = 'ariadne.agent-effect-results.v3';

describe('ProductionAgentEngineAdapter', () => {
  it('uses one exact-bound transport-only client and returns a strict response Directive', async () => {
    const fixture = createFixture();
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: { kind: 'respond', content: 'completed from v3' }
    }));
    const gateway = exactInferenceGateway(inference);
    const contracts = exactContracts(fixture.available);
    const adapter = new ProductionAgentEngineAdapter(gateway, contracts);
    const controller = new AbortController();

    await expect(decide(adapter, fixture.input, controller.signal)).resolves.toEqual({
      kind: 'respond',
      content: 'completed from v3'
    });

    expect(gateway.inferExact).toHaveBeenCalledTimes(1);
    expect(contracts.readInferenceToolContracts).toHaveBeenCalledTimes(1);
    const request = inference.mock.calls[0]![0];
    expect(request.binding).toEqual(fixture.input.run.binding.model);
    expect(request.signal).toBe(controller.signal);
    expect(request).not.toHaveProperty('tools');
    expect(request.messages.slice(1)).toEqual([{
      role: 'user',
      content: 'Write the result under src.'
    }]);
    expect(JSON.parse(request.messages[0]!.content)).toMatchObject({
      protocol: PROTOCOL,
      tools: [{
        toolName: fixture.tool.toolName,
        toolVersion: fixture.tool.toolVersion,
        capabilityIds: ['workspace.write'],
        scopeSemantics: 'all_requested_workspace_scopes_must_be_granted',
        allowedScopes: ['src'],
        inputSchema: { type: 'object' }
      }]
    });
  });

  it('derives a deterministic pressure compaction while retaining the latest objective', async () => {
    const fixture = createFixture();
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: { kind: 'respond', content: 'compacted safely' }
    }));
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference, {
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096
      }),
      exactContracts(fixture.available)
    );
    const input: AgentTurnInput = {
      ...fixture.input,
      messages: [
        ...Array.from({ length: 1_100 }, (_, index) => ({
          kind: 'text' as const,
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: `bounded historical message ${String(index)}`
        })),
        { kind: 'text', role: 'user', content: 'LATEST_OBJECTIVE_MUST_SURVIVE' }
      ]
    };
    const signal = new AbortController().signal;
    const prepared = await adapter.prepare(input, signal);

    expect(prepared.modelContext).toMatchObject({
      format: 'ariadne.model-context',
      schemaVersion: 1,
      lifecycle: 'compacted',
      overflowRecoveryPrepared: true
    });
    await expect(prepared.decide(signal)).resolves.toEqual({
      kind: 'respond',
      content: 'compacted safely'
    });
    const sent = inference.mock.calls[0]![0].messages;
    expect(sent.some((message) => message.content.includes('ariadne.context-compaction.v1')))
      .toBe(true);
    expect(sent.at(-1)).toEqual({
      role: 'user',
      content: 'LATEST_OBJECTIVE_MUST_SURVIVE'
    });
  });

  it('uses the separately prepared projection once after canonical Provider overflow', async () => {
    const fixture = createFixture();
    const inference = vi.fn()
      .mockResolvedValueOnce({ status: 'context_overflow' } as const)
      .mockResolvedValueOnce(inferenceResponse({
        protocol: PROTOCOL,
        directive: { kind: 'respond', content: 'recovered from overflow' }
      }));
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      exactContracts(fixture.available)
    );
    const signal = new AbortController().signal;
    const prepared = await adapter.prepare(fixture.input, signal);

    expect(prepared.modelContext).toMatchObject({ overflowRecoveryPrepared: true });
    await expect(prepared.decide(signal)).resolves.toEqual({
      kind: 'respond',
      content: 'recovered from overflow'
    });
    expect(inference).toHaveBeenCalledTimes(2);
    expect(inference.mock.calls[0]![0].messages)
      .not.toEqual(inference.mock.calls[1]![0].messages);
  });

  it('prunes one oversized latest Tool result without separating its committed Directive', async () => {
    const fixture = createContinuationFixture([[
      { status: 'succeeded', result: { content: 'z'.repeat(100_000) } }
    ]]);
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: { kind: 'respond', content: 'used pruned result reference' }
    }));
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference, {
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096
      }),
      exactContracts(fixture.available)
    );
    const signal = new AbortController().signal;
    const prepared = await adapter.prepare(fixture.input, signal);

    expect(prepared.modelContext).toMatchObject({
      lifecycle: 'compacted',
      prunedToolResults: 1
    });
    await prepared.decide(signal);
    const sent = inference.mock.calls[0]![0].messages;
    expect(sent.at(-2)?.content).toContain('ariadne.agent-directive.v3');
    expect(sent.at(-1)?.content).toContain('ariadne.tool-result-pruning.v1');
  });

  it('exposes only bounded plan directives and parses plan content without model-owned IDs', async () => {
    const fixture = createPlanFixture();
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: {
        kind: 'propose_plan',
        plan: {
          summary: 'Build the effect from layered canvas stars.',
          impactSummary: 'Approval permits later workspace changes.',
          steps: [{
            title: 'Create the star field',
            summary: 'Render deterministic layers and verify animation.',
            impact: 'workspace_change'
          }]
        }
      }
    }));
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      exactContracts(fixture.available)
    );

    await expect(decide(adapter,
      fixture.input,
      new AbortController().signal
    )).resolves.toMatchObject({
      kind: 'propose_plan',
      plan: { summary: 'Build the effect from layered canvas stars.' }
    });

    const prompt = JSON.parse(inference.mock.calls[0]![0].messages[0]!.content);
    expect(prompt.executionMode).toBe('plan');
    expect(prompt.directiveShapes).toHaveProperty('propose_plan');
    expect(prompt.directiveShapes).not.toHaveProperty('respond');
    expect(prompt.directiveShapes).not.toHaveProperty('complete');
    expect(prompt.directiveShapes).not.toHaveProperty('request_decision');
  });

  it('renders every cumulative causal Effect batch as exact canonical text-only v3 history', async () => {
    const fixture = createContinuationFixture([
      [{ status: 'succeeded', result: { z: 2, a: 'first' } }],
      [
        { status: 'failed', result: { message: 'bounded failure' } },
        { status: 'cancelled', result: { reason: 'bounded cancellation' } }
      ]
    ]);
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: { kind: 'respond', content: 'continued exactly' }
    }));
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      exactContracts(fixture.available)
    );

    await expect(decide(adapter,
      fixture.input,
      new AbortController().signal
    )).resolves.toEqual({ kind: 'respond', content: 'continued exactly' });

    const request = inference.mock.calls[0]![0];
    expect(request).not.toHaveProperty('tools');
    expect(request.messages.slice(1)).toEqual([
      { role: 'user', content: 'Write the result under src.' },
      ...fixture.batches.flatMap((batch) => [
        {
          role: 'assistant' as const,
          content: canonicalTestJson({
            protocol: PROTOCOL,
            directive: batch.directive
          })
        },
        {
          role: 'user' as const,
          content: canonicalTestJson({
            protocol: EFFECT_RESULTS_PROTOCOL,
            sourceDirectiveDigest: batch.sourceDirectiveDigest,
            results: batch.messages.map((message) => ({
              effectId: message.effectId,
              toolCallId: message.toolCallId,
              status: message.status,
              result: message.result
            }))
          })
        }
      ])
    ]);
    expect(request.messages.every((message) => (
      message.role === 'system'
      || message.role === 'user'
      || message.role === 'assistant'
    ))).toBe(true);
    for (const message of request.messages.slice(2)) {
      expect(message.content).toBe(canonicalTestJson(JSON.parse(message.content)));
    }
  });

  it('renders a same-Run inbox continuation as exact assistant and user history', async () => {
    const fixture = createInboxContinuationFixture();
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: { kind: 'respond', content: 'continued after steering' }
    }));
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      exactContracts(fixture.available)
    );

    await expect(decide(adapter,
      fixture.input,
      new AbortController().signal
    )).resolves.toEqual({ kind: 'respond', content: 'continued after steering' });
    expect(inference.mock.calls[0]![0].messages.slice(1)).toEqual([
      { role: 'user', content: 'Write the result under src.' },
      { role: 'assistant', content: 'First response.' },
      { role: 'user', content: 'Apply this additional constraint.' }
    ]);
  });

  it('rejects an Effect result on the initial objective Turn before any dependency read or Provider I/O', async () => {
    const fixture = createFixture();
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: { kind: 'respond', content: 'must not be used' }
    }));
    const contracts = exactContracts(fixture.available);
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      contracts
    );

    await expect(decide(adapter, {
      ...fixture.input,
      messages: [{
        kind: 'effect_result',
        effectId: 'orphan-effect',
        toolCallId: 'orphan-call',
        status: 'succeeded',
        result: { value: true }
      }]
    }, new AbortController().signal)).rejects.toMatchObject({
      providerErrorCode: 'agent_model_binding_unavailable'
    });
    expect(contracts.readInferenceToolContracts).not.toHaveBeenCalled();
    expect(inference).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'orphan tail result',
      mutate: (fixture: ContinuationFixture): AgentTurnInput => ({
        ...fixture.input,
        messages: [...fixture.input.messages, {
          kind: 'effect_result',
          effectId: 'orphan-effect',
          toolCallId: 'orphan-call',
          status: 'succeeded',
          result: null
        }]
      })
    },
    {
      name: 'missing final result',
      mutate: (fixture: ContinuationFixture): AgentTurnInput => ({
        ...fixture.input,
        messages: fixture.input.messages.slice(0, -1)
      })
    },
    {
      name: 'duplicate result identity',
      mutate: (fixture: ContinuationFixture): AgentTurnInput => ({
        ...fixture.input,
        messages: [...fixture.input.messages, fixture.input.messages.at(-1)!]
      })
    },
    {
      name: 'text interleaved inside a result batch',
      mutate: (fixture: ContinuationFixture): AgentTurnInput => ({
        ...fixture.input,
        messages: [
          fixture.input.messages[0]!,
          fixture.input.messages[1]!,
          { kind: 'text', role: 'user', content: 'interleaved' },
          ...fixture.input.messages.slice(2)
        ]
      })
    },
    {
      name: 'terminal status drift',
      mutate: (fixture: ContinuationFixture): AgentTurnInput => ({
        ...fixture.input,
        messages: fixture.input.messages.map((message, index) => (
          index === 1 && message.kind === 'effect_result'
            ? { ...message, status: 'failed' as const }
            : message
        ))
      })
    }
  ])('rejects $name without crossing the Provider boundary', async ({ mutate }) => {
    const fixture = createContinuationFixture([[
      { status: 'succeeded', result: { first: true } },
      { status: 'succeeded', result: { second: true } }
    ]]);
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: { kind: 'respond', content: 'must not be used' }
    }));
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      exactContracts(fixture.available)
    );

    await expect(decide(adapter,
      mutate(fixture),
      new AbortController().signal
    )).rejects.toMatchObject({
      providerErrorCode: 'agent_model_binding_unavailable'
    });
    expect(inference).not.toHaveBeenCalled();
  });

  it('rejects cross-batch reordering in cumulative history', async () => {
    const fixture = createContinuationFixture([
      [{ status: 'succeeded', result: { batch: 1 } }],
      [{ status: 'succeeded', result: { batch: 2 } }]
    ]);
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: { kind: 'respond', content: 'must not be used' }
    }));
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      exactContracts(fixture.available)
    );

    await expect(decide(adapter, {
      ...fixture.input,
      messages: [
        fixture.input.messages[0]!,
        fixture.input.messages[2]!,
        fixture.input.messages[1]!
      ]
    }, new AbortController().signal)).rejects.toMatchObject({
      providerErrorCode: 'agent_model_binding_unavailable'
    });
    expect(inference).not.toHaveBeenCalled();
  });

  it.each(['nonterminal Effect', 'source Directive drift'] as const)(
    'rejects aggregate %s before rendering protected result bodies',
    async (scenario) => {
      const fixture = createContinuationFixture([[
        { status: 'succeeded', result: { protected: 'result body' } }
      ]]);
      const sourceRun = fixture.input.run;
      const run: AgentRun = scenario === 'nonterminal Effect'
        ? {
            ...sourceRun,
            effects: sourceRun.effects.map((effect, index) => index === 0
              ? {
                  ...effect,
                  state: {
                    status: 'started',
                    startedAt: '2030-01-01T00:00:02.000Z',
                    attempt: 1
                  }
                }
              : effect)
          }
        : {
            ...sourceRun,
            turns: sourceRun.turns.map((turn, index) => {
              if (index !== sourceRun.turns.length - 1) return turn;
              const cause = turn.intention.cause;
              if (cause.kind !== 'effect_results') return turn;
              return {
                ...turn,
                intention: {
                  ...turn.intention,
                  cause: {
                    ...cause,
                    sourceDirectiveDigest: `sha256:${'f'.repeat(64)}`
                  }
                }
              };
            })
          };
      const inference = vi.fn(async () => inferenceResponse({
        protocol: PROTOCOL,
        directive: { kind: 'respond', content: 'must not be used' }
      }));
      const adapter = new ProductionAgentEngineAdapter(
        exactInferenceGateway(inference),
        exactContracts(fixture.available)
      );

      await expect(decide(adapter, { ...fixture.input, run }, new AbortController().signal))
        .rejects.toMatchObject({ providerErrorCode: 'agent_model_binding_unavailable' });
      expect(inference).not.toHaveBeenCalled();
    }
  );

  it('maps a model Tool request back to the exact pinned identity and authoritative capabilities', async () => {
    const fixture = createFixture();
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: {
        kind: 'invoke_tools',
        invocations: [{
          toolCallId: 'call-v3-1',
          toolName: fixture.tool.toolName,
          input: { path: 'src/result.ts' },
          scope: ['src']
        }]
      }
    }));
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      exactContracts(fixture.available)
    );

    await expect(decide(adapter,
      fixture.input,
      new AbortController().signal
    )).resolves.toEqual({
      kind: 'invoke_tools',
      invocations: [{
        toolCallId: 'call-v3-1',
        tool: fixture.tool,
        input: { path: 'src/result.ts' },
        capabilityIds: ['workspace.write'],
        scope: ['src']
      }]
    });
    expect(inference.mock.calls[0]![0]).not.toHaveProperty('tools');
  });

  it.each([
    {
      name: 'legacy AgentAction JSON',
      response: inferenceResponse({ action: 'final', answer: 'legacy result' })
    },
    {
      name: 'unexpected native tool calls',
      response: {
        ...inferenceResponse({
          protocol: PROTOCOL,
          directive: { kind: 'respond', content: 'text' }
        }),
        nativeToolCallCount: 1
      }
    },
    {
      name: 'extra protocol fields',
      response: inferenceResponse({
        protocol: PROTOCOL,
        directive: { kind: 'respond', content: 'text', extra: true }
      })
    }
  ])('fails closed for $name without executing any Tool', async ({ response }) => {
    const fixture = createFixture();
    const inference = vi.fn(async () => response);
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      exactContracts(fixture.available)
    );

    await expect(decide(adapter,
      fixture.input,
      new AbortController().signal
    )).rejects.toMatchObject({
      code: 'AGENT_INFERENCE_DETERMINISTIC_FAILURE',
      providerErrorCode: 'agent_model_directive_invalid'
    });
  });

  it('fails closed when composition cannot prove the exact model binding', async () => {
    const fixture = createFixture();
    const inference = vi.fn(async (): Promise<ExactAgentModelInferenceResult> => ({
      status: 'binding_unavailable'
    }));
    const contracts = exactContracts(fixture.available);
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      contracts
    );

    await expect(decide(adapter,
      fixture.input,
      new AbortController().signal
    )).rejects.toMatchObject({
      providerErrorCode: 'agent_model_binding_unavailable'
    });
    expect(contracts.readInferenceToolContracts).toHaveBeenCalledTimes(1);
    expect(inference).toHaveBeenCalledTimes(1);
  });

  it('rejects Tool contract drift before the Provider boundary', async () => {
    const fixture = createFixture();
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: { kind: 'respond', content: 'must not be used' }
    }));
    const contracts: AgentInferenceToolContractReader = {
      readInferenceToolContracts: vi.fn(async () => [{
        descriptorVersion: 1,
        tool: { ...fixture.tool, contractDigest: `sha256:${'f'.repeat(64)}` },
        inputSchema: { type: 'object' },
        scopeSemantics: 'all_requested_workspace_scopes_must_be_granted'
      }])
    };
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      contracts
    );

    await expect(decide(adapter,
      fixture.input,
      new AbortController().signal
    )).rejects.toMatchObject({
      providerErrorCode: 'agent_tool_contract_unavailable'
    });
    expect(inference).not.toHaveBeenCalled();
  });

  it('propagates Provider uncertainty unchanged instead of disguising it as deterministic failure', async () => {
    const fixture = createFixture();
    const providerFailure = new Error('transport outcome unknown');
    const inference = vi.fn(async (): Promise<ExactAgentModelInferenceResult> => {
      throw providerFailure;
    });
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      exactContracts(fixture.available)
    );

    await expect(decide(adapter,
      fixture.input,
      new AbortController().signal
    )).rejects.toBe(providerFailure);
    expect(providerFailure).not.toBeInstanceOf(AgentInferenceDeterministicFailureError);
  });

  it('rejects a model-requested scope outside the exact Run grants', async () => {
    const fixture = createFixture();
    const inference = vi.fn(async () => inferenceResponse({
      protocol: PROTOCOL,
      directive: {
        kind: 'invoke_tools',
        invocations: [{
          toolCallId: 'call-v3-1',
          toolName: fixture.tool.toolName,
          input: { path: 'other/result.ts' },
          scope: ['other']
        }]
      }
    }));
    const adapter = new ProductionAgentEngineAdapter(
      exactInferenceGateway(inference),
      exactContracts(fixture.available)
    );

    await expect(decide(adapter,
      fixture.input,
      new AbortController().signal
    )).rejects.toMatchObject({
      providerErrorCode: 'agent_model_directive_invalid'
    });
  });
});

type TerminalEffectStatus = 'succeeded' | 'failed' | 'cancelled';

interface ContinuationResultSpec {
  readonly status: TerminalEffectStatus;
  readonly result: AgentJsonValue;
}

interface ContinuationBatchFixture {
  readonly sourceDirectiveDigest: string;
  readonly directive: Extract<
    AgentCommittedDirective,
    { readonly kind: 'invoke_tools' }
  >;
  readonly messages: readonly Extract<
    AgentTurnInput['messages'][number],
    { readonly kind: 'effect_result' }
  >[];
}

interface ContinuationFixture {
  readonly tool: AgentPinnedToolIdentity;
  readonly available: AgentAvailableTool;
  readonly input: AgentTurnInput;
  readonly batches: readonly ContinuationBatchFixture[];
}

function createContinuationFixture(
  specs: readonly (readonly ContinuationResultSpec[])[]
): ContinuationFixture {
  if (specs.length === 0 || specs.some((batch) => batch.length === 0)) {
    throw new Error('continuation_fixture_requires_nonempty_batches');
  }
  const initial = createFixture();
  const runId = 'run-engine-v3';
  const effectCount = specs.reduce((sum, batch) => sum + batch.length, 0);
  const binding = runBinding(initial.tool, specs.length + 1, effectCount);
  const effects: AgentRun['effects'][number][] = [];
  const batches: ContinuationBatchFixture[] = specs.map((batch, batchIndex) => {
    const sourceDirectiveDigest = digestFor(1 + batchIndex);
    const messages = batch.map((spec, resultIndex) => {
      const effectId = `effect-${String(batchIndex)}-${String(resultIndex)}`;
      const toolCallId = `call-${String(batchIndex)}-${String(resultIndex)}`;
      const invocation = {
        effectId,
        toolCallId,
        tool: initial.tool,
        idempotencyKey: `effect-key-${String(batchIndex)}-${String(resultIndex)}`,
        capabilityIds: ['workspace.write'],
        scope: ['src'],
        inputDigest: digestFor(4 + batchIndex + resultIndex)
      };
      const finishedAt = timeAt(batchIndex * 3 + 2);
      effects.push({
        effectId,
        runId,
        toolCallId,
        tool: initial.tool,
        idempotencyKey: invocation.idempotencyKey,
        capabilityIds: invocation.capabilityIds,
        scope: invocation.scope,
        inputDigest: invocation.inputDigest,
        origin: {
          turnId: `turn-engine-v3-${String(batchIndex)}`,
          attemptId: `attempt-engine-v3-${String(batchIndex)}`,
          directiveDigest: sourceDirectiveDigest
        },
        state: terminalEffectState(spec.status, finishedAt)
      });
      return {
        invocation,
        message: {
          kind: 'effect_result' as const,
          effectId,
          toolCallId,
          status: spec.status,
          result: spec.result
        }
      };
    });
    return {
      sourceDirectiveDigest,
      directive: {
        kind: 'invoke_tools',
        invocations: messages.map((entry) => entry.invocation)
      },
      messages: messages.map((entry) => entry.message)
    };
  });

  const turns: AgentRun['turns'][number][] = [];
  for (let turnIndex = 0; turnIndex <= batches.length; turnIndex += 1) {
    const turnId = `turn-engine-v3-${String(turnIndex)}`;
    const attemptId = `attempt-engine-v3-${String(turnIndex)}`;
    const createdAt = timeAt(turnIndex * 3);
    const priorBatch = batches[turnIndex - 1];
    const cause = turnIndex === 0
      ? {
          kind: 'conversation_objective' as const,
          messageId: 'message-engine-v3',
          messageVersion: 1,
          contentDigest: digestFor(12)
        }
      : {
          kind: 'effect_results' as const,
          sourceTurnId: `turn-engine-v3-${String(turnIndex - 1)}`,
          sourceAttemptId: `attempt-engine-v3-${String(turnIndex - 1)}`,
          sourceDirectiveDigest: priorBatch!.sourceDirectiveDigest,
          effectIds: priorBatch!.messages.map((message) => message.effectId),
          toolCallIds: priorBatch!.messages.map((message) => message.toolCallId)
        };
    const sourceBatch = batches[turnIndex];
    turns.push({
      turnId,
      runId,
      intention: {
        expectedRunVersion: turnIndex === 0 ? null : turnIndex * 4 + 1,
        checkpointVersion: turnIndex * 3 + 1,
        cause,
        bindingVersion: 3,
        sessionId: binding.sessionId,
        objectiveRef: binding.objectiveRef,
        workspace: binding.workspace,
        model: binding.model,
        policy: binding.policy,
        capabilities: binding.capabilities,
        toolCatalog: binding.toolCatalog,
        budget: binding.budget,
        inputDigest: digestFor(8 + turnIndex),
        inputSummary: {
          messageCount: 1 + batches.slice(0, turnIndex)
            .reduce((sum, batch) => sum + batch.messages.length, 0),
          toolCount: 1,
          contentCharacterCount: 1
        }
      },
      attempts: [{
        attemptId,
        turnId,
        runId,
        providerIdempotencyKey: `provider-key-engine-v3-${String(turnIndex)}`,
        cause: { kind: 'initial' },
        state: sourceBatch === undefined
          ? { status: 'intended', intendedAt: createdAt }
          : {
              status: 'succeeded',
              finishedAt: timeAt(turnIndex * 3 + 1),
              directive: sourceBatch.directive,
              directiveDigest: sourceBatch.sourceDirectiveDigest
            }
      }],
      createdAt
    });
  }

  const run: AgentRun = {
    runId,
    version: specs.length * 5 + 2,
    binding,
    state: {
      status: 'running',
      checkpointVersion: specs.length * 3 + 1,
      enteredAt: timeAt(specs.length * 3)
    },
    turns,
    effects,
    inbox: [],
    createdAt: timeAt(0),
    updatedAt: timeAt(specs.length * 3)
  };
  return {
    tool: initial.tool,
    available: initial.available,
    input: {
      run,
      messages: [
        { kind: 'text', role: 'user', content: 'Write the result under src.' },
        ...batches.flatMap((batch) => batch.messages)
      ],
      availableTools: [initial.available]
    },
    batches
  };
}

function terminalEffectState(
  status: TerminalEffectStatus,
  at: string
): AgentRun['effects'][number]['state'] {
  switch (status) {
    case 'succeeded':
      return { status, finishedAt: at, attempt: 1 };
    case 'failed':
      return {
        status,
        finishedAt: at,
        attempt: 1,
        errorCode: 'tool_failed',
        message: 'bounded failure'
      };
    case 'cancelled':
      return {
        status,
        cancelledAt: at,
        attempts: 1,
        reason: 'bounded cancellation'
      };
  }
}

function timeAt(seconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, seconds)).toISOString();
}

function digestFor(seed: number): string {
  return `sha256:${(seed % 16).toString(16).repeat(64)}`;
}

function canonicalTestJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`
  ).join(',')}}`;
}

function createFixture(): {
  readonly tool: AgentPinnedToolIdentity;
  readonly available: AgentAvailableTool;
  readonly input: AgentTurnInput;
} {
  const tool: AgentPinnedToolIdentity = {
    catalogId: 'catalog-v3',
    revision: 7,
    digest: `sha256:${'a'.repeat(64)}`,
    toolName: 'workspace.write',
    toolVersion: '1.0.0',
    providerId: 'workspace-provider',
    contractDigest: `sha256:${'b'.repeat(64)}`
  };
  const available: AgentAvailableTool = {
    tool,
    capabilityIds: ['workspace.write']
  };
  const run = initialTurnRun(tool);
  return {
    tool,
    available,
    input: {
      run,
      messages: [{ kind: 'text', role: 'user', content: 'Write the result under src.' }],
      availableTools: [available]
    }
  };
}

function createPlanFixture(): ReturnType<typeof createFixture> {
  const fixture = createFixture();
  const binding = {
    ...fixture.input.run.binding,
    bindingVersion: 4 as const,
    executionProfile: { mode: 'plan' as const }
  };
  const firstTurn = fixture.input.run.turns[0]!;
  return {
    ...fixture,
    input: {
      ...fixture.input,
      run: {
        ...fixture.input.run,
        binding,
        turns: [{
          ...firstTurn,
          intention: {
            ...firstTurn.intention,
            bindingVersion: 4,
            executionProfile: { mode: 'plan' }
          }
        }]
      }
    }
  };
}

function createInboxContinuationFixture(): ReturnType<typeof createFixture> {
  const fixture = createFixture();
  const source = fixture.input.run.turns[0]!;
  const binding = {
    ...fixture.input.run.binding,
    budget: {
      ...fixture.input.run.binding.budget,
      vector: {
        ...fixture.input.run.binding.budget.vector,
        modelTurns: 3
      }
    }
  };
  const directiveDigest = digestFor(12);
  const continuationMessages = [
    ...fixture.input.messages,
    { kind: 'text' as const, role: 'assistant' as const, content: 'First response.' },
    {
      kind: 'text' as const,
      role: 'user' as const,
      content: 'Apply this additional constraint.'
    }
  ];
  const continuationTurnId = 'turn-engine-v3-inbox';
  const run: AgentRun = {
    ...fixture.input.run,
    version: 4,
    binding,
    state: {
      status: 'running',
      checkpointVersion: 4,
      enteredAt: timeAt(2)
    },
    turns: [{
      ...source,
      intention: { ...source.intention, budget: binding.budget },
      attempts: [{
        ...source.attempts[0]!,
        state: {
          status: 'succeeded',
          finishedAt: timeAt(1),
          directive: {
            kind: 'respond',
            contentRef: 'response-engine-v3-first',
            contentDigest: digestFor(13)
          },
          directiveDigest
        }
      }]
    }, {
      turnId: continuationTurnId,
      runId: fixture.input.run.runId,
      intention: {
        ...source.intention,
        budget: binding.budget,
        expectedRunVersion: 3,
        checkpointVersion: 4,
        cause: {
          kind: 'inbox_inputs',
          sourceTurnId: source.turnId,
          sourceAttemptId: source.attempts[0]!.attemptId,
          sourceDirectiveDigest: directiveDigest,
          inputIds: ['input-engine-v3-inbox']
        },
        inputDigest: digestFor(14),
        inputSummary: {
          messageCount: continuationMessages.length,
          toolCount: fixture.input.availableTools.length,
          contentCharacterCount: continuationMessages.reduce(
            (count, message) => count + message.content.length,
            0
          )
        }
      },
      attempts: [{
        attemptId: 'attempt-engine-v3-inbox',
        turnId: continuationTurnId,
        runId: fixture.input.run.runId,
        providerIdempotencyKey: 'provider-key-engine-v3-inbox',
        cause: { kind: 'initial' },
        state: { status: 'intended', intendedAt: timeAt(2) }
      }],
      createdAt: timeAt(2)
    }],
    inbox: [{
      inputId: 'input-engine-v3-inbox',
      messageId: 'message-engine-v3-inbox',
      version: 1,
      delivery: 'next_turn',
      content: 'Apply this additional constraint.',
      contentDigest: digestFor(15),
      queuedAt: timeAt(1),
      updatedAt: timeAt(2),
      state: 'claimed',
      claimedAt: timeAt(2),
      claimedTurnId: continuationTurnId
    }],
    updatedAt: timeAt(2)
  };
  assertValidAgentRun(run);
  return {
    ...fixture,
    input: {
      ...fixture.input,
      run,
      messages: continuationMessages
    }
  };
}

function exactInferenceGateway(
  infer: (
    request: DispatchExactAgentModelInferenceRequest
  ) => Promise<ExactAgentModelInferenceResult>,
  capacity = { contextWindowTokens: 128_000, maxOutputTokens: 4_096 }
): ExactAgentModelInferenceRuntime & {
  inferExact: ReturnType<typeof vi.fn>;
} {
  return {
    inferExact: vi.fn(infer),
    hasExactBinding: () => true,
    resolveBinding: () => null,
    describeContextCapacity: () => ({ ...capacity })
  };
}

async function decide(
  adapter: ProductionAgentEngineAdapter,
  input: AgentTurnInput,
  signal: AbortSignal
): Promise<import('@ariadne/agent-core').AgentDirective> {
  const prepared = await adapter.prepare(input, signal);
  return prepared.decide(signal);
}

function exactContracts(
  available: AgentAvailableTool
): AgentInferenceToolContractReader & {
  readInferenceToolContracts: ReturnType<typeof vi.fn>;
} {
  return {
    readInferenceToolContracts: vi.fn(async () => [{
      descriptorVersion: 1 as const,
      tool: available.tool,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      },
      scopeSemantics: 'all_requested_workspace_scopes_must_be_granted' as const
    }])
  };
}

function inferenceResponse(content: unknown): ExactAgentModelInferenceResult {
  return {
    status: 'completed',
    content: JSON.stringify(content),
    nativeToolCallCount: 0
  };
}

function initialTurnRun(tool: AgentPinnedToolIdentity): AgentRun {
  const binding = runBinding(tool, 1, 0);
  return {
    runId: 'run-engine-v3',
    version: 1,
    binding,
    state: {
      status: 'running',
      checkpointVersion: 1,
      enteredAt: '2030-01-01T00:00:00.000Z'
    },
    turns: [{
      turnId: 'turn-engine-v3-0',
      runId: 'run-engine-v3',
      intention: {
        expectedRunVersion: null,
        checkpointVersion: 1,
        cause: {
          kind: 'conversation_objective',
          messageId: 'message-engine-v3',
          messageVersion: 1,
          contentDigest: `sha256:${'c'.repeat(64)}`
        },
        bindingVersion: 3,
        sessionId: binding.sessionId,
        objectiveRef: binding.objectiveRef,
        workspace: binding.workspace,
        model: binding.model,
        policy: binding.policy,
        capabilities: binding.capabilities,
        toolCatalog: binding.toolCatalog,
        budget: binding.budget,
        inputDigest: `sha256:${'e'.repeat(64)}`,
        inputSummary: {
          messageCount: 1,
          toolCount: 1,
          contentCharacterCount: 'Write the result under src.'.length
        }
      },
      attempts: [{
        attemptId: 'attempt-engine-v3-0',
        turnId: 'turn-engine-v3-0',
        runId: 'run-engine-v3',
        providerIdempotencyKey: 'provider-key-engine-v3-0',
        cause: { kind: 'initial' },
        state: {
          status: 'intended',
          intendedAt: '2030-01-01T00:00:00.000Z'
        }
      }],
      createdAt: '2030-01-01T00:00:00.000Z'
    }],
    effects: [],
    inbox: [],
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z'
  };
}

function runBinding(
  tool: AgentPinnedToolIdentity,
  modelTurns: number,
  toolCalls: number
): AgentRun['binding'] {
  return {
    bindingVersion: 3,
    sessionId: 'session-engine-v3',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: 'message-engine-v3',
      messageVersion: 1,
      contentDigest: `sha256:${'c'.repeat(64)}`
    },
    workspace: {
      workspaceId: 'workspace-engine-v3',
      revision: 1,
      grantDigest: `sha256:${'d'.repeat(64)}`,
      access: 'write',
      scopeIds: ['src']
    },
    model: {
      providerId: 'provider-v3',
      modelId: 'model-v3',
      settingsRevision: 1
    },
    policy: {
      policyId: 'policy-engine-v3',
      revision: 1,
      permissionMode: 'trusted'
    },
    capabilities: [{
      capabilityId: 'workspace.write',
      scopeIds: ['src']
    }],
    toolCatalog: {
      catalogId: tool.catalogId,
      revision: tool.revision,
      digest: tool.digest,
      allowedToolNames: [tool.toolName]
    },
    budget: {
      grantId: 'grant-engine-v3',
      runId: 'run-engine-v3',
      vector: {
        modelTurns,
        toolCalls,
        readCalls: 0,
        writeCalls: toolCalls,
        shellCalls: 0,
        costMicrousd: 100_000
      },
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' }
    }
  };
}
