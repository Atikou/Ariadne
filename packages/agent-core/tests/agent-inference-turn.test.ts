import { describe, expect, it, vi } from 'vitest';
import {
  AgentInferenceCancellationAcknowledgedError,
  AgentInferenceDeterministicFailureError,
  AgentInferenceDispatchRecoveryRequiredError,
  AgentInferenceDispatchService,
  DefaultAgentInferenceDirectivePlanner,
  AgentRunCommandService,
  assertValidAgentRun,
  digestAgentCommittedDirective,
  digestAgentTurnInput,
  sha256AgentControlData,
  summarizeAgentTurnInput,
  type AgentCommittedDirective,
  type AgentRun,
  type AgentRunCheckpointCommit,
  type AgentTurnInput,
  type AgentTurnInputModelData
} from '../src/index.js';
import {
  at,
  binding,
  startCommand,
  TEST_EFFECT_INPUT_DIGEST,
  testAvailableTool
} from './fixtures.js';
import {
  InMemoryAgentRunUnitOfWork,
  TestAgentRunCommandService
} from './support/in-memory-unit-of-work.js';

const TURN_ID = 'turn-1';
const ATTEMPT_ID = 'attempt-1';
const INPUT: AgentTurnInputModelData = {
  messages: [{ kind: 'text', role: 'user', content: 'Solve the bounded task.' }],
  availableTools: [
    testAvailableTool('workspace.read'),
    testAvailableTool('workspace.write')
  ]
};
const OBJECTIVE_CAUSE = {
  kind: 'conversation_objective',
  messageId: 'message-1',
  messageVersion: 1,
  contentDigest: `sha256:${'d'.repeat(64)}`
} as const;

describe('durable Agent Turn and inference attempts', () => {
  it('requires the new serialized shape and exact tool-catalog snapshot', async () => {
    const unit = new InMemoryAgentRunUnitOfWork();
    const commands = new AgentRunCommandService(unit);
    const invalid = startCommand('start-invalid-catalog', 'run-invalid-catalog');
    await expect(commands.execute({
      ...invalid,
      binding: {
        ...invalid.binding,
        toolCatalog: {
          ...invalid.binding.toolCatalog,
          digest: 'sha256:not-a-digest'
        }
      }
    })).rejects.toMatchObject({ code: 'AGENT_RUN_INVARIANT' });
    expect(unit.loadRun(invalid.runId)).toBeNull();

    const created = await commands.execute(
      startCommand(),
      { turnInputPayloads: [], effectPayloads: [] }
    );
    const { turns: _removed, ...oldShape } = created.run;
    expect(() => assertValidAgentRun(oldShape as AgentRun)).toThrow(/run\.turns/);

    const unsupportedCatalog = {
      ...created.run,
      binding: {
        ...created.run.binding,
        toolCatalog: {
          ...created.run.binding.toolCatalog,
          providerPayload: 'must-not-enter-the-binding'
        }
      }
    } as AgentRun;
    expect(() => assertValidAgentRun(unsupportedCatalog)).toThrow(
      /unsupported field "providerPayload"/
    );
  });

  it('commits immutable Turn intention before a successful inference result', async () => {
    const setup = await createIntendedAttempt();
    const turn = setup.unit.loadRun('run-1')?.turns[0];
    expect(turn).toMatchObject({
      turnId: TURN_ID,
      intention: {
        expectedRunVersion: 2,
        checkpointVersion: 2,
        bindingVersion: 3,
        sessionId: binding.sessionId,
        objectiveRef: binding.objectiveRef,
        workspace: binding.workspace,
        model: binding.model,
        policy: binding.policy,
        capabilities: binding.capabilities,
        toolCatalog: binding.toolCatalog,
        budget: binding.budget,
        inputDigest: setup.inputDigest,
        inputSummary: summarizeAgentTurnInput(INPUT)
      },
      attempts: [{
        attemptId: ATTEMPT_ID,
        providerIdempotencyKey: 'provider-key-run-1',
        cause: { kind: 'initial' },
        state: { status: 'intended' }
      }]
    });

    const started = await setup.commands.execute({
      kind: 'run.start_inference_attempt',
      commandId: 'start-attempt-1',
      runId: 'run-1',
      expectedVersion: 3,
      occurredAt: at(3),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID
    });
    expect(started.run.turns[0]?.attempts[0]?.state.status).toBe('started');

    const directive: AgentCommittedDirective = {
      kind: 'respond',
      contentRef: 'directive-artifact-bounded-answer',
      contentDigest: `sha256:${'a'.repeat(64)}`
    };
    const directiveDigest = await digestAgentCommittedDirective(directive);
    await expect(setup.commands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId: 'result-bad-digest',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(4),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: {
        status: 'succeeded',
        directive,
        directiveDigest: `sha256:${'f'.repeat(64)}`
      }
    })).rejects.toThrow(/directive digest/);
    expect(setup.unit.loadRun('run-1')?.version).toBe(4);

    const succeeded = await setup.commands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId: 'result-attempt-1',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(4),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: { status: 'succeeded', directive, directiveDigest }
    });
    expect(succeeded.run.turns[0]?.attempts[0]?.state).toEqual({
      status: 'succeeded',
      finishedAt: at(4),
      directive,
      directiveDigest
    });
    expect(succeeded.events.map((event) => event.payload.type)).toContain(
      'inference_attempt.transitioned'
    );
  });

  it('commits one Turn for concurrent command replay and rejects digest drift before mutation', async () => {
    const unit = new InMemoryAgentRunUnitOfWork();
    const commands = new TestAgentRunCommandService(unit, [INPUT]);
    await commands.execute(startCommand());
    await commands.execute({
      kind: 'run.begin',
      commandId: 'begin-before-concurrent-turn',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(1)
    });
    const inputDigest = await digestAgentTurnInput(INPUT);
    const register = {
      kind: 'run.register_turn',
      commandId: 'register-concurrent-turn',
      runId: 'run-1',
      expectedVersion: 2,
      occurredAt: at(2),
      turn: {
        cause: OBJECTIVE_CAUSE,
        turnId: TURN_ID,
        attemptId: ATTEMPT_ID,
        providerIdempotencyKey: 'provider-concurrent-command',
        inputDigest,
        inputSummary: summarizeAgentTurnInput(INPUT)
      }
    } as const;
    const [first, replay] = await Promise.all([
      commands.execute(register),
      commands.execute(register)
    ]);
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
    expect(unit.loadRun('run-1')?.turns).toHaveLength(1);

    await expect(commands.execute({
      ...register,
      turn: {
        ...register.turn,
        inputDigest: `sha256:${'b'.repeat(64)}`
      }
    })).rejects.toMatchObject({
      code: 'AGENT_RUN_COMMAND_CONFLICT',
      reason: 'command_mismatch'
    });
    expect(unit.loadRun('run-1')).toMatchObject({
      version: 3,
      turns: [{ attempts: [{ attemptId: ATTEMPT_ID }] }]
    });
  });

  it('rejects a Turn when the immutable model-turn budget is exhausted', async () => {
    const unit = new InMemoryAgentRunUnitOfWork();
    const commands = new TestAgentRunCommandService(unit, [INPUT]);
    const start = startCommand('start-model-turn-budget', 'run-model-turn-budget');
    await commands.execute({
      ...start,
      binding: {
        ...start.binding,
        budget: {
          ...start.binding.budget,
          vector: { ...start.binding.budget.vector, modelTurns: 0 }
        }
      }
    });
    await commands.execute({
      kind: 'run.begin',
      commandId: 'begin-model-turn-budget',
      runId: start.runId,
      expectedVersion: 1,
      occurredAt: at(1)
    });
    const inputDigest = await digestAgentTurnInput(INPUT);
    await expect(commands.execute({
      kind: 'run.register_turn',
      commandId: 'register-over-budget-turn',
      runId: start.runId,
      expectedVersion: 2,
      occurredAt: at(2),
      turn: {
        cause: OBJECTIVE_CAUSE,
        turnId: 'turn-budget-overflow',
        attemptId: 'attempt-budget-overflow',
        providerIdempotencyKey: 'provider-budget-overflow',
        inputDigest,
        inputSummary: summarizeAgentTurnInput(INPUT)
      }
    })).rejects.toThrow(/model-turn budget/);
    expect(unit.loadRun(start.runId)?.turns).toHaveLength(0);
    const running = unit.loadRun(start.runId);
    if (running === null) throw new Error('budget fixture run missing');
    expect(() => assertValidAgentRun({
      ...running,
      turns: [{
        turnId: 'turn-invalid-budget',
        runId: running.runId,
        intention: {
          expectedRunVersion: running.version,
          checkpointVersion: running.state.checkpointVersion,
          cause: OBJECTIVE_CAUSE,
          bindingVersion: running.binding.bindingVersion,
          sessionId: running.binding.sessionId,
          objectiveRef: running.binding.objectiveRef,
          workspace: running.binding.workspace,
          model: running.binding.model,
          policy: running.binding.policy,
          capabilities: running.binding.capabilities,
          toolCatalog: running.binding.toolCatalog,
          budget: running.binding.budget,
          inputDigest,
          inputSummary: summarizeAgentTurnInput(INPUT)
        },
        attempts: [{
          attemptId: 'attempt-invalid-budget',
          turnId: 'turn-invalid-budget',
          runId: running.runId,
          providerIdempotencyKey: 'provider-invalid-budget',
          cause: { kind: 'initial' },
          state: { status: 'intended', intendedAt: at(2) }
        }],
        createdAt: at(2)
      }]
    })).toThrow(/model-turn budget/);
  });

  it('does not treat aborting a started inference as cancellation without Provider evidence', async () => {
    const setup = await createIntendedAttempt();
    await startAttempt(setup.commands);

    const missingEvidence = {
      kind: 'run.record_inference_attempt_result',
      commandId: 'cancel-without-evidence',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(4),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: { status: 'cancelled', reason: 'abort_signal' }
    } as Parameters<TestAgentRunCommandService['execute']>[0];
    await expect(setup.commands.execute(missingEvidence)).rejects.toThrow();
    expect(setup.unit.loadRun('run-1')?.turns[0]?.attempts[0]?.state.status)
      .toBe('started');

    const cancelled = await setup.commands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId: 'cancel-with-provider-evidence',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(4),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: {
        status: 'cancelled',
        reason: 'provider_confirmed_not_executed',
        providerCancellationAcknowledgementId: 'provider-cancel-ack-1'
      }
    });
    expect(cancelled.run.turns[0]?.attempts[0]?.state).toMatchObject({
      status: 'cancelled',
      cancellation: {
        kind: 'provider_acknowledged',
        acknowledgementId: 'provider-cancel-ack-1'
      }
    });
  });

  it('requires an exact recovery decision and new causal identity for retry', async () => {
    const setup = await createUncertainAttempt();
    await expect(setup.commands.execute({
      kind: 'run.start_inference_attempt',
      commandId: 'blind-retry-old-attempt',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID
    })).rejects.toThrow();

    await expect(setup.commands.execute({
      kind: 'run.retry_inference_attempt',
      commandId: 'retry-wrong-decision',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      turnId: TURN_ID,
      causedByAttemptId: ATTEMPT_ID,
      recoveryDecisionId: 'wrong-decision',
      attemptId: 'attempt-2',
      providerIdempotencyKey: 'provider-key-2'
    })).rejects.toThrow(/exact persisted recovery decision/);

    await expect(setup.commands.execute({
      kind: 'run.retry_inference_attempt',
      commandId: 'retry-reused-identity',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      turnId: TURN_ID,
      causedByAttemptId: ATTEMPT_ID,
      recoveryDecisionId: 'recovery-attempt-1',
      attemptId: ATTEMPT_ID,
      providerIdempotencyKey: 'provider-key-run-1'
    })).rejects.toMatchObject({ code: 'AGENT_RUN_INVARIANT' });
    expect(setup.unit.loadRun('run-1')?.version).toBe(5);

    const retried = await setup.commands.execute({
      kind: 'run.retry_inference_attempt',
      commandId: 'retry-distinct-identity',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      turnId: TURN_ID,
      causedByAttemptId: ATTEMPT_ID,
      recoveryDecisionId: 'recovery-attempt-1',
      attemptId: 'attempt-2',
      providerIdempotencyKey: 'provider-key-2'
    });
    expect(retried.run.turns[0]?.attempts).toHaveLength(2);
    expect(retried.run.turns[0]?.attempts[1]).toMatchObject({
      attemptId: 'attempt-2',
      providerIdempotencyKey: 'provider-key-2',
      cause: {
        kind: 'recovery_retry',
        causedByAttemptId: ATTEMPT_ID,
        recoveryDecisionId: 'recovery-attempt-1'
      },
      state: { status: 'intended' }
    });
  });

  it('cancels a Run with an uncertain inference only through its exact recovery decision', async () => {
    const setup = await createUncertainAttempt();
    await expect(setup.commands.execute({
      kind: 'run.cancel',
      commandId: 'cancel-uncertain-without-decision',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      reason: 'user_cancelled'
    })).rejects.toThrow(/exact uncertain-inference recovery decision/);
    expect(setup.unit.loadRun('run-1')?.state.status).toBe('recovering');

    const cancelled = await setup.commands.execute({
      kind: 'run.cancel',
      commandId: 'cancel-uncertain-with-decision',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      reason: 'user_cancelled',
      recoveryDecisionId: 'recovery-attempt-1'
    });
    expect(cancelled.run.state).toMatchObject({
      status: 'cancelled',
      inferenceRecovery: {
        turnId: TURN_ID,
        attemptId: ATTEMPT_ID,
        recoveryDecisionId: 'recovery-attempt-1'
      }
    });
    expect(cancelled.run.turns[0]?.attempts[0]?.state.status).toBe('uncertain');
  });

  it('collapses concurrent duplicate inference dispatch before Engine I/O', async () => {
    const setup = await createIntendedAttempt('run-concurrent');
    let release: ((directive: AgentDirective) => void) | undefined;
    const engine = {
      decide: vi.fn(() => new Promise<AgentDirective>((resolve) => {
        release = resolve;
      }))
    };
    const dispatcher = new AgentInferenceDispatchService(
      setup.unit,
      executionInputReader(
        setup.unit,
        setup.inputDigest,
        ATTEMPT_ID,
        'run-concurrent'
      ),
      preparedEngine(engine),
      directivePlanner(),
      checkpointFactory(),
      { now: () => at(4) }
    );
    const request = {
      commandId: 'dispatch-concurrent',
      runId: 'run-concurrent',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 3,
      occurredAt: at(3)
    } as const;
    const first = dispatcher.dispatch(request);
    const duplicate = dispatcher.dispatch(request);
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(engine.decide).toHaveBeenCalledTimes(1));
    release?.({ kind: 'respond', content: 'exactly once' });
    const [left, right] = await Promise.all([first, duplicate]);
    expect(left).toEqual(right);
    expect(left.status).toBe('succeeded');
    expect(engine.decide).toHaveBeenCalledTimes(1);
  });

  it('crosses the durable start boundary with prepared model-context evidence', async () => {
    const setup = await createIntendedAttempt('run-context-checkpoint');
    const marker = {
      format: 'ariadne.model-context',
      schemaVersion: 1,
      lifecycle: 'compacted',
      primaryRequestDigest: `sha256:${'a'.repeat(64)}`
    } as const;
    const observed: unknown[] = [];
    const baseFactory = checkpointFactory();
    const dispatcher = new AgentInferenceDispatchService(
      setup.unit,
      executionInputReader(
        setup.unit,
        setup.inputDigest,
        ATTEMPT_ID,
        'run-context-checkpoint'
      ),
      {
        prepare: async () => ({
          modelContext: marker,
          decide: async () => ({ kind: 'respond', content: 'checkpointed' } as const)
        })
      },
      directivePlanner(),
      {
        create(input) {
          if (input.phase === 'inference_started') observed.push(input.modelContext);
          return baseFactory.create(input);
        }
      },
      { now: () => at(4) }
    );

    await expect(dispatcher.dispatch({
      commandId: 'dispatch-context-checkpoint',
      runId: 'run-context-checkpoint',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 3,
      occurredAt: at(3)
    })).resolves.toMatchObject({ status: 'succeeded' });
    expect(observed).toEqual([marker]);
  });

  it('persists a user question and resumes through one exact durable inbox answer', async () => {
    const setup = await createIntendedAttempt('run-user-question');
    const dispatcher = new AgentInferenceDispatchService(
      setup.unit,
      executionInputReader(
        setup.unit,
        setup.inputDigest,
        ATTEMPT_ID,
        'run-user-question'
      ),
      preparedEngine({
        decide: async () => ({
          kind: 'ask_user',
          question: {
            prompt: 'Which deployment target should be used?',
            options: [
              { optionId: 'local', label: 'Local only' },
              {
                optionId: 'remote',
                label: 'Remote host',
                description: 'Requires network access.'
              }
            ]
          }
        })
      }),
      directivePlanner(),
      checkpointFactory(),
      { now: () => at(4) }
    );

    const asked = await dispatcher.dispatch({
      commandId: 'dispatch-user-question',
      runId: 'run-user-question',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 3,
      occurredAt: at(3)
    });
    expect(asked.run.state).toMatchObject({
      status: 'waiting',
      reason: 'user_question'
    });
    if (asked.command === null) throw new Error('expected committed inference result');
    expect(setup.unit.loadCommittedArtifacts(asked.command.commandId)?.directivePayloads)
      .toMatchObject([{
        kind: 'user_question',
        payload: {
          format: 'ariadne.user-question',
          schemaVersion: 1,
          prompt: 'Which deployment target should be used?',
          options: [
            { optionId: 'local', label: 'Local only' },
            {
              optionId: 'remote',
              label: 'Remote host',
              description: 'Requires network access.'
            }
          ]
        }
      }]);
    if (
      asked.run.state.status !== 'waiting'
      || asked.run.state.reason !== 'user_question'
    ) throw new Error('expected durable user-question decision');

    const answer = 'local: Local only';
    const answerDigest = await sha256AgentControlData(answer);
    const resolve = {
      kind: 'run.resolve_decision',
      commandId: 'resolve-user-question',
      runId: 'run-user-question',
      expectedVersion: asked.run.version,
      occurredAt: at(5),
      resolution: {
        kind: 'user_question',
        decisionId: asked.run.state.decision.decisionId,
        checkpoint: asked.run.state.decision.checkpoint,
        resolvedAt: at(5),
        questionRef: asked.run.state.decision.questionRef,
        questionDigest: asked.run.state.decision.questionDigest,
        answerInputId: 'inbox-user-question-answer',
        answerDigest
      },
      answerInput: {
        inputId: 'inbox-user-question-answer',
        messageId: 'message-user-question-answer',
        content: answer,
        contentDigest: answerDigest
      }
    } as const;
    const resumed = await setup.commands.execute(resolve);
    expect(resumed.run).toMatchObject({
      state: { status: 'running' },
      inbox: [{
        inputId: 'inbox-user-question-answer',
        delivery: 'next_step',
        content: answer,
        contentDigest: answerDigest,
        state: 'queued',
        source: {
          kind: 'user_question_answer',
          decisionId: asked.run.state.decision.decisionId,
          questionDigest: asked.run.state.decision.questionDigest
        }
      }]
    });
    expect(resumed.events.map((event) => event.payload.type)).toEqual([
      'decision.resolved',
      'inbox.input_enqueued',
      'run.state_changed'
    ]);
    await expect(setup.commands.execute(resolve)).resolves.toMatchObject({
      replayed: true,
      run: { version: resumed.run.version }
    });

    await expect(setup.commands.execute({
      ...resolve,
      answerInput: { ...resolve.answerInput, content: 'remote: Remote host' }
    })).rejects.toMatchObject({ reason: 'command_mismatch' });
  });

  it('commits exact Provider usage with the succeeded Attempt instead of a side log', async () => {
    const setup = await createIntendedAttempt('run-usage-anchor');
    const anchor = {
      anchorVersion: 1 as const,
      providerId: binding.model.providerId,
      modelId: binding.model.modelId,
      settingsRevision: binding.model.settingsRevision,
      requestHeaderDigest: `sha256:${'8'.repeat(64)}`,
      requestEnvelopeDigest: `sha256:${'9'.repeat(64)}`,
      estimatedInputTokens: 120,
      inputTokens: 137,
      outputTokens: 11,
      cacheReadInputTokens: 17,
      cacheWriteInputTokens: 5
    };
    const dispatcher = new AgentInferenceDispatchService(
      setup.unit,
      executionInputReader(
        setup.unit,
        setup.inputDigest,
        ATTEMPT_ID,
        'run-usage-anchor'
      ),
      {
        prepare: async () => ({
          modelContext: { lifecycle: 'full' },
          decide: async () => ({ kind: 'respond', content: 'usage anchored' } as const),
          readUsageAnchor: () => ({ ...anchor })
        })
      },
      directivePlanner(),
      checkpointFactory(),
      { now: () => at(4) }
    );

    const dispatched = await dispatcher.dispatch({
      commandId: 'dispatch-usage-anchor',
      runId: 'run-usage-anchor',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 3,
      occurredAt: at(3)
    });

    expect(dispatched.run.turns[0]?.attempts[0]?.state).toMatchObject({
      status: 'succeeded',
      usageAnchor: anchor
    });
  });

  it('commits sanitized response replay evidence with the exact succeeded Attempt', async () => {
    const setup = await createIntendedAttempt('run-response-envelope');
    const responseEnvelope = {
      envelopeVersion: 1 as const,
      providerId: binding.model.providerId,
      modelId: binding.model.modelId,
      settingsRevision: binding.model.settingsRevision,
      adapter: 'openai-compatible' as const,
      finishReason: 'tool_calls' as const,
      requestEnvelopeDigest: `sha256:${'7'.repeat(64)}`,
      contentBlocksDigest: `sha256:${'6'.repeat(64)}`,
      contentBlockTypes: ['reasoning', 'tool_call'] as const,
      providerResponseIdDigest: `sha256:${'5'.repeat(64)}`
    };
    const dispatcher = new AgentInferenceDispatchService(
      setup.unit,
      executionInputReader(
        setup.unit,
        setup.inputDigest,
        ATTEMPT_ID,
        'run-response-envelope'
      ),
      {
        prepare: async () => ({
          modelContext: { lifecycle: 'full' },
          decide: async () => ({ kind: 'respond', content: 'replay anchored' } as const),
          readResponseEnvelope: () => ({
            ...responseEnvelope,
            contentBlockTypes: [...responseEnvelope.contentBlockTypes]
          })
        })
      },
      directivePlanner(),
      checkpointFactory(),
      { now: () => at(4) }
    );

    const dispatched = await dispatcher.dispatch({
      commandId: 'dispatch-response-envelope',
      runId: 'run-response-envelope',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 3,
      occurredAt: at(3)
    });

    expect(dispatched.attempt.state).toMatchObject({
      status: 'succeeded',
      responseEnvelope
    });
    expect(() => assertValidAgentRun(dispatched.run)).not.toThrow();
  });

  it('does not cross the durable start boundary when already cancelled', async () => {
    const setup = await createIntendedAttempt('run-pre-cancelled');
    const engine = {
      decide: vi.fn(async () => ({ kind: 'respond', content: 'must not run' } as const))
    };
    const inputReader = executionInputReader(
      setup.unit,
      setup.inputDigest,
      ATTEMPT_ID,
      'run-pre-cancelled'
    );
    const dispatcher = new AgentInferenceDispatchService(
      setup.unit,
      inputReader,
      preparedEngine(engine),
      directivePlanner(),
      checkpointFactory(),
      { now: () => at(4) }
    );
    const controller = new AbortController();
    const cancellation = new Error('caller_cancelled_before_inference_start');
    controller.abort(cancellation);

    await expect(dispatcher.dispatch({
      commandId: 'dispatch-pre-cancelled',
      runId: 'run-pre-cancelled',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 3,
      occurredAt: at(3)
    }, controller.signal)).rejects.toBe(cancellation);
    expect(inputReader.loadInferenceExecutionInput).not.toHaveBeenCalled();
    expect(engine.decide).not.toHaveBeenCalled();
    expect(setup.unit.loadRun('run-pre-cancelled')).toMatchObject({
      version: 3,
      turns: [{ attempts: [{ state: { status: 'intended' } }] }]
    });
  });

  it('reopens a started attempt without reading input or invoking Engine, then dispatches only a new recovery attempt', async () => {
    const setup = await createIntendedAttempt();
    await startAttempt(setup.commands);
    const reopenedStarted = setup.unit.reopen();
    const engine = { decide: vi.fn(async () => ({ kind: 'respond', content: 'once' } as const)) };
    const inputReader = { loadInferenceExecutionInput: vi.fn() };
    const blockedDispatcher = new AgentInferenceDispatchService(
      reopenedStarted,
      inputReader,
      preparedEngine(engine),
      directivePlanner(),
      checkpointFactory(),
      { now: () => at(6) }
    );
    await expect(blockedDispatcher.dispatch({
      commandId: 'dispatch-reopened',
      runId: 'run-1',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 4,
      occurredAt: at(5)
    })).rejects.toBeInstanceOf(AgentInferenceDispatchRecoveryRequiredError);
    expect(inputReader.loadInferenceExecutionInput).not.toHaveBeenCalled();
    expect(engine.decide).not.toHaveBeenCalled();

    const recoveryCommands = new TestAgentRunCommandService(reopenedStarted);
    await recoveryCommands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId: 'mark-reopened-uncertain',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(5),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: {
        status: 'uncertain',
        reason: 'process_reopened_after_started',
        recoveryDecisionId: 'recovery-attempt-1',
        allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
      }
    });
    await recoveryCommands.execute({
      kind: 'run.retry_inference_attempt',
      commandId: 'create-recovery-attempt',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(6),
      turnId: TURN_ID,
      causedByAttemptId: ATTEMPT_ID,
      recoveryDecisionId: 'recovery-attempt-1',
      attemptId: 'attempt-2',
      providerIdempotencyKey: 'provider-key-2'
    });

    const reopenedRetry = reopenedStarted.reopen();
    const retryEngine = {
      decide: vi.fn(async () => ({ kind: 'respond', content: 'recovered once' } as const))
    };
    const retryReader = executionInputReader(reopenedRetry, setup.inputDigest, 'attempt-2');
    const dispatcher = new AgentInferenceDispatchService(
      reopenedRetry,
      retryReader,
      preparedEngine(retryEngine),
      directivePlanner(),
      checkpointFactory(),
      { now: () => at(8) }
    );
    const dispatched = await dispatcher.dispatch({
      commandId: 'dispatch-recovery-attempt',
      runId: 'run-1',
      turnId: TURN_ID,
      attemptId: 'attempt-2',
      expectedVersion: 6,
      occurredAt: at(7)
    });
    expect(dispatched.status).toBe('succeeded');
    expect(retryEngine.decide).toHaveBeenCalledTimes(1);
    expect(retryReader.loadInferenceExecutionInput).toHaveBeenCalledTimes(1);
    expect(dispatched.turn.attempts[0]?.state.status).toBe('uncertain');
    expect(dispatched.turn.attempts[1]?.state.status).toBe('succeeded');
  });

  it('persists generic Engine exceptions as sanitized uncertain, while typed evidence can be failed or cancelled', async () => {
    const uncertainSetup = await createIntendedAttempt('run-uncertain');
    const secret = 'provider-secret-raw-error';
    const uncertainEngine = { decide: vi.fn(async () => { throw new Error(secret); }) };
    const uncertainDispatcher = new AgentInferenceDispatchService(
      uncertainSetup.unit,
      executionInputReader(
        uncertainSetup.unit,
        uncertainSetup.inputDigest,
        ATTEMPT_ID,
        'run-uncertain'
      ),
      preparedEngine(uncertainEngine),
      directivePlanner(),
      checkpointFactory(),
      { now: () => at(4) }
    );
    const uncertain = await uncertainDispatcher.dispatch({
      commandId: 'dispatch-generic-error',
      runId: 'run-uncertain',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 3,
      occurredAt: at(3)
    });
    expect(uncertain.status).toBe('uncertain');
    expect(JSON.stringify(uncertain.run)).not.toContain(secret);
    expect(JSON.stringify(uncertain.run)).toContain(
      'inference_engine_terminated_without_durable_outcome'
    );
    await expect(uncertainDispatcher.dispatch({
      commandId: 'dispatch-generic-error',
      runId: 'run-uncertain',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 5,
      occurredAt: at(5)
    })).rejects.toBeInstanceOf(AgentInferenceDispatchRecoveryRequiredError);
    expect(uncertainEngine.decide).toHaveBeenCalledTimes(1);

    const failedSetup = await createIntendedAttempt('run-failed');
    const failedDispatcher = new AgentInferenceDispatchService(
      failedSetup.unit,
      executionInputReader(
        failedSetup.unit,
        failedSetup.inputDigest,
        ATTEMPT_ID,
        'run-failed'
      ),
      preparedEngine({
        decide: async () => {
          throw new AgentInferenceDeterministicFailureError(
            'MODEL_INPUT_REJECTED',
            'The bounded input was rejected.'
          );
        }
      }),
      directivePlanner(),
      checkpointFactory(),
      { now: () => at(4) }
    );
    await expect(failedDispatcher.dispatch({
      commandId: 'dispatch-deterministic-failure',
      runId: 'run-failed',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 3,
      occurredAt: at(3)
    })).resolves.toMatchObject({ status: 'failed' });

    const cancelledSetup = await createIntendedAttempt('run-cancelled');
    const cancelledDispatcher = new AgentInferenceDispatchService(
      cancelledSetup.unit,
      executionInputReader(
        cancelledSetup.unit,
        cancelledSetup.inputDigest,
        ATTEMPT_ID,
        'run-cancelled'
      ),
      preparedEngine({
        decide: async () => {
          throw new AgentInferenceCancellationAcknowledgedError(
            'provider-ack-2',
            'Provider confirmed non-execution.'
          );
        }
      }),
      directivePlanner(),
      checkpointFactory(),
      { now: () => at(4) }
    );
    const cancelled = await cancelledDispatcher.dispatch({
      commandId: 'dispatch-acknowledged-cancel',
      runId: 'run-cancelled',
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      expectedVersion: 3,
      occurredAt: at(3)
    });
    expect(cancelled.attempt.state).toMatchObject({
      status: 'cancelled',
      cancellation: {
        kind: 'provider_acknowledged',
        acknowledgementId: 'provider-ack-2'
      }
    });
  });
});

async function createIntendedAttempt(runId = 'run-1') {
  const unit = new InMemoryAgentRunUnitOfWork();
  const commands = new TestAgentRunCommandService(unit, [INPUT]);
  await commands.execute(startCommand(`start-${runId}`, runId));
  await commands.execute({
    kind: 'run.begin',
    commandId: `begin-${runId}`,
    runId,
    expectedVersion: 1,
    occurredAt: at(1)
  });
  const inputDigest = await digestAgentTurnInput(INPUT);
  await commands.execute({
    kind: 'run.register_turn',
    commandId: `register-turn-${runId}`,
    runId,
    expectedVersion: 2,
    occurredAt: at(2),
    turn: {
      cause: OBJECTIVE_CAUSE,
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      providerIdempotencyKey: `provider-key-${runId}`,
      inputDigest,
      inputSummary: summarizeAgentTurnInput(INPUT)
    }
  });
  return { unit, commands, inputDigest };
}

async function startAttempt(commands: TestAgentRunCommandService): Promise<void> {
  await commands.execute({
    kind: 'run.start_inference_attempt',
    commandId: 'start-attempt-1',
    runId: 'run-1',
    expectedVersion: 3,
    occurredAt: at(3),
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID
  });
}

async function createUncertainAttempt() {
  const setup = await createIntendedAttempt();
  await startAttempt(setup.commands);
  await setup.commands.execute({
    kind: 'run.record_inference_attempt_result',
    commandId: 'mark-attempt-uncertain',
    runId: 'run-1',
    expectedVersion: 4,
    occurredAt: at(4),
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    result: {
      status: 'uncertain',
      reason: 'provider_outcome_unknown',
      recoveryDecisionId: 'recovery-attempt-1',
      allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
    }
  });
  return setup;
}

function executionInputReader(
  unit: InMemoryAgentRunUnitOfWork,
  inputDigest: string,
  attemptId: string,
  runId = 'run-1'
) {
  return {
    loadInferenceExecutionInput: vi.fn(async (): Promise<{
      runId: string;
      turnId: string;
      attemptId: string;
      inputDigest: string;
      input: AgentTurnInput;
    }> => {
      const run = unit.loadRun(runId);
      if (run === null) throw new Error('fixture run missing');
      return {
        runId,
        turnId: TURN_ID,
        attemptId,
        inputDigest,
        input: { run, ...INPUT }
      };
    })
  };
}

function directivePlanner(): DefaultAgentInferenceDirectivePlanner {
  return new DefaultAgentInferenceDirectivePlanner({
    digest: () => TEST_EFFECT_INPUT_DIGEST
  }, {
    admit: async ({ invocation }) => ({
      status: 'allow',
      tool: invocation.tool,
      capabilityIds: invocation.capabilityIds,
      scope: invocation.scope,
      normalizedInput: invocation.input
    })
  });
}

function preparedEngine(engine: {
  decide(input: AgentTurnInput, signal: AbortSignal): Promise<import('../src/index.js').AgentDirective>;
}) {
  return {
    prepare: async (input: AgentTurnInput, signal: AbortSignal) => {
      signal.throwIfAborted();
      return {
        modelContext: [],
        decide: (decisionSignal: AbortSignal) => engine.decide(input, decisionSignal)
      };
    }
  };
}

function checkpointFactory() {
  return {
    create(input: {
      readonly run: AgentRun;
      readonly checkpointVersion: number;
      readonly phase: 'inference_started' | 'inference_result';
      readonly occurredAt: string;
    }): AgentRunCheckpointCommit {
      return {
        checkpointVersion: input.checkpointVersion,
        payload: {
          format: 'ariadne.agent-checkpoint',
          schemaVersion: 1,
          engineContinuation: {
            runVersion: input.run.version,
            phase: input.phase
          },
          modelContext: []
        },
        createdAt: input.occurredAt
      };
    }
  };
}
