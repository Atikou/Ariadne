import { describe, expect, it, vi } from 'vitest';
import {
  AgentInferenceDispatchRecoveryRequiredError,
  AgentInferenceDispatchService,
  AgentRunAdmissionService,
  AgentRunCommandService,
  DefaultAgentInferenceDirectivePlanner,
  assertValidAgentRun,
  deriveStableAgentId,
  digestAgentCommittedDirective,
  digestAgentTurnInput,
  summarizeAgentTurnInput,
  type AgentDirective,
  type AgentEffectInputDigester,
  type AgentInferenceDispatchCheckpointRequest,
  type AgentJsonValue,
  type AgentRunCheckpointCommit,
  type AgentRunTransaction,
  type AgentRunUnitOfWork,
  type AgentToolAdmissionPolicy,
  type AgentTurnInput,
  type AgentTurnInputModelData
} from '../src/index.js';
import {
  at,
  binding,
  bindingForRun,
  testAvailableTool,
  testPinnedToolIdentity
} from './fixtures.js';
import { InMemoryAgentRunUnitOfWork } from './support/in-memory-unit-of-work.js';

const TURN_ID = 'turn-atomic-result';
const ATTEMPT_ID = 'attempt-atomic-result';
const PROVIDER_KEY = 'provider-atomic-result';
const DEFAULT_TOOLS = [testAvailableTool('workspace.write')];

describe('atomic inference result application', () => {
  it('rebases the durable start checkpoint over inbox input queued during preparation', async () => {
    const setup = await admittedSetup({
      runId: 'run-inference-preparation-inbox-concurrency',
      permissionMode: 'trusted'
    });
    const engine = {
      prepare: vi.fn(async () => {
        const current = setup.unit.loadRun(setup.runId);
        if (current === null) throw new Error('concurrent inbox fixture Run missing');
        await new AgentRunCommandService(setup.unit).execute({
          kind: 'run.enqueue_inbox_input',
          commandId: 'enqueue-during-inference-preparation',
          runId: setup.runId,
          expectedVersion: current.version,
          occurredAt: at(1),
          input: {
            inputId: 'input-during-inference-preparation',
            messageId: 'message-during-inference-preparation',
            delivery: 'next_step',
            content: 'Use this after the prepared response.',
            contentDigest: `sha256:${'8'.repeat(64)}`
          }
        }, { turnInputPayloads: [], effectPayloads: [] });
      }),
      decide: vi.fn(async () => ({ kind: 'respond' as const, content: 'Prepared response.' }))
    };

    const dispatched = await createDispatcher(setup, engine).dispatch(
      dispatchRequest('dispatch-with-preparation-inbox', setup.runId)
    );

    expect(dispatched.run).toMatchObject({
      version: 4,
      state: { status: 'running' },
      inbox: [{
        inputId: 'input-during-inference-preparation',
        state: 'queued',
        delivery: 'next_step'
      }],
      turns: [{ attempts: [{ state: { status: 'succeeded' } }] }]
    });
    expect(engine.prepare).toHaveBeenCalledOnce();
    expect(engine.decide).toHaveBeenCalledOnce();
  });

  it('commits a Provider result on top of an inbox mutation made during inference', async () => {
    const setup = await admittedSetup({
      runId: 'run-inference-inbox-concurrency',
      permissionMode: 'trusted'
    });
    const engine = {
      decide: vi.fn(async () => {
        const current = setup.unit.loadRun(setup.runId);
        if (current === null) throw new Error('concurrent inbox fixture Run missing');
        await new AgentRunCommandService(setup.unit).execute({
          kind: 'run.enqueue_inbox_input',
          commandId: 'enqueue-during-inference',
          runId: setup.runId,
          expectedVersion: current.version,
          occurredAt: at(2),
          input: {
            inputId: 'input-during-inference',
            messageId: 'message-during-inference',
            delivery: 'next_step',
            content: 'Use this before your next model step.',
            contentDigest: `sha256:${'9'.repeat(64)}`
          }
        }, { turnInputPayloads: [], effectPayloads: [] });
        return { kind: 'respond' as const, content: 'First response.' };
      })
    };

    const dispatched = await createDispatcher(setup, engine).dispatch(
      dispatchRequest('dispatch-with-concurrent-inbox', setup.runId)
    );

    expect(dispatched.run).toMatchObject({
      version: 4,
      state: { status: 'running' },
      inbox: [{
        inputId: 'input-during-inference',
        state: 'queued',
        delivery: 'next_step'
      }],
      turns: [{ attempts: [{ state: { status: 'succeeded' } }] }]
    });
    expect(engine.decide).toHaveBeenCalledOnce();
  });

  it('commits a trusted tool Directive, authorized Effect, payload, checkpoint, receipt, and outbox in one result version', async () => {
    const setup = await admittedSetup({
      runId: 'run-trusted-tool',
      permissionMode: 'trusted'
    });
    const secret = 'raw-tool-input-secret';
    const directive = invokeDirective('call-trusted', 'workspace.write', {
      path: 'src/atomic.ts',
      token: secret
    });
    const beforeCommits = setup.unit.commitCount;
    const engine = { decide: vi.fn(async () => directive) };
    const dispatched = await createDispatcher(setup, engine).dispatch(
      dispatchRequest('dispatch-trusted-tool', setup.runId)
    );

    expect(setup.unit.commitCount - beforeCommits).toBe(2);
    expect(engine.decide).toHaveBeenCalledTimes(1);
    expect(dispatched.run).toMatchObject({
      version: 3,
      state: { status: 'running', checkpointVersion: 3 },
      effects: [{ state: { status: 'authorized', attempt: 1 } }]
    });
    const attempt = dispatched.attempt;
    expect(attempt.state.status).toBe('succeeded');
    if (attempt.state.status !== 'succeeded') throw new Error('fixture result');
    expect(attempt.state.directive.kind).toBe('invoke_tools');
    if (attempt.state.directive.kind !== 'invoke_tools') throw new Error('fixture directive');
    const committedInvocation = attempt.state.directive.invocations[0];
    const effect = dispatched.run.effects[0];
    expect(committedInvocation).not.toHaveProperty('input');
    expect(effect).toMatchObject({
      effectId: committedInvocation?.effectId,
      idempotencyKey: committedInvocation?.idempotencyKey,
      inputDigest: committedInvocation?.inputDigest,
      origin: {
        turnId: TURN_ID,
        attemptId: ATTEMPT_ID,
        directiveDigest: attempt.state.directiveDigest
      }
    });
    expect(effect?.effectId).toBe(effect?.effectId.trim());
    expect(effect?.effectId.length).toBeLessThanOrEqual(256);
    expect(effect?.idempotencyKey.length).toBeLessThanOrEqual(256);

    const resultCommand = dispatched.command;
    expect(resultCommand).not.toBeNull();
    if (resultCommand === null) throw new Error('result command missing');
    expect(resultCommand.events.map((event) => event.payload.type)).toEqual([
      'inference_attempt.transitioned',
      'effect.registered',
      'effect.transitioned',
      'run.state_changed'
    ]);
    expect(resultCommand.events.every(
      (event) => event.commandId === resultCommand.commandId && event.runVersion === 3
    )).toBe(true);

    const artifacts = setup.unit.loadCommittedArtifacts(resultCommand.commandId);
    expect(artifacts).toMatchObject({
      checkpoint: { checkpointVersion: 3 },
      effectPayloads: [{
        kind: 'record_input',
        effectId: effect?.effectId,
        inputDigest: effect?.inputDigest,
        input: { path: 'src/atomic.ts', token: secret }
      }]
    });
    expect(JSON.stringify(artifacts?.checkpoint)).not.toContain(secret);
    expect(JSON.stringify(dispatched.run)).not.toContain(secret);
    expect(JSON.stringify(resultCommand.events)).not.toContain(secret);
    expect(JSON.stringify(setup.unit.loadCommittedReceipt(resultCommand.commandId)))
      .not.toContain(secret);
    expect(JSON.stringify(setup.unit.events())).not.toContain(secret);

    const tampered = JSON.parse(JSON.stringify(dispatched.run));
    tampered.effects[0].origin.attemptId = 'different-attempt';
    expect(() => assertValidAgentRun(tampered)).toThrow(/exact durable Effect origin/);
  });

  it('commits one exact ask-mode Permission Decision with its intended Effect', async () => {
    const setup = await admittedSetup({
      runId: 'run-ask-tool',
      permissionMode: 'ask'
    });
    const dispatched = await createDispatcher(setup, {
      decide: async () => invokeDirective(
        'call-ask',
        'workspace.write',
        { path: 'src/ask.ts' }
      )
    }).dispatch(dispatchRequest('dispatch-ask-tool', setup.runId));

    expect(dispatched.run.state).toMatchObject({
      status: 'waiting',
      reason: 'tool_permission',
      checkpointVersion: 3,
      decision: {
        kind: 'permission',
        requestedAt: at(2),
        checkpoint: { runId: setup.runId, version: 3 }
      }
    });
    expect(dispatched.run.effects).toHaveLength(1);
    expect(dispatched.run.effects[0]?.state.status).toBe('intended');
    if (
      dispatched.run.state.status !== 'waiting'
      || dispatched.run.state.reason !== 'tool_permission'
    ) {
      throw new Error('permission state missing');
    }
    const decision = dispatched.run.state.decision;
    const effect = dispatched.run.effects[0];
    expect(decision).toMatchObject({
      effectId: effect?.effectId,
      toolCallId: effect?.toolCallId,
      capabilityIds: effect?.capabilityIds,
      scope: effect?.scope
    });
    const attempt = dispatched.attempt;
    if (
      attempt.state.status !== 'succeeded'
      || attempt.state.directive.kind !== 'invoke_tools'
    ) {
      throw new Error('committed tool directive missing');
    }
    expect(attempt.state.directive.invocations[0]?.permissionDecisionId)
      .toBe(decision.decisionId);
    expect(dispatched.command?.events.map((event) => event.payload.type)).toEqual([
      'inference_attempt.transitioned',
      'effect.registered',
      'decision.requested',
      'run.state_changed'
    ]);
  });

  it('admits each invocation before planning and digests only its canonical normalized input', async () => {
    const setup = await admittedSetup({
      runId: 'run-normalized-admission',
      permissionMode: 'trusted'
    });
    const rawSecret = 'raw-input-must-not-be-committed';
    const normalizedInput = {
      z: -0,
      a: { path: 'src/normalized.ts' }
    };
    const policy: AgentToolAdmissionPolicy = {
      admit: vi.fn(async (request) => {
        expect(request.run.runId).toBe(setup.runId);
        expect(request.turn.turnId).toBe(TURN_ID);
        expect(request.attempt.attemptId).toBe(ATTEMPT_ID);
        expect(request.availableTools).toEqual(DEFAULT_TOOLS);
        expect(request.invocation.tool).toEqual(
          testPinnedToolIdentity('workspace.write')
        );
        return {
          status: 'allow',
          tool: request.invocation.tool,
          capabilityIds: request.invocation.capabilityIds,
          scope: ['src/normalized.ts'],
          normalizedInput
        };
      })
    };
    const dispatched = await createDispatcher(
      setup,
      {
        decide: async () => {
          const directive = invokeDirective(
            'call-normalized',
            'workspace.write',
            { rawSecret }
          );
          return {
            kind: 'invoke_tools',
            invocations: [{
              ...directive.invocations[0]!,
              scope: ['src/normalized.ts', 'workspace']
            }]
          };
        }
      },
      setup.unit,
      policy
    ).dispatch(dispatchRequest('dispatch-normalized-admission', setup.runId));

    expect(policy.admit).toHaveBeenCalledTimes(1);
    const effect = dispatched.run.effects[0];
    const attempt = dispatched.attempt;
    if (
      effect === undefined
      || attempt.state.status !== 'succeeded'
      || attempt.state.directive.kind !== 'invoke_tools'
    ) {
      throw new Error('normalized admission fixture missing');
    }
    const committedInvocation = attempt.state.directive.invocations[0];
    expect(effect.tool).toBe(committedInvocation?.tool);
    expect(effect.tool).toEqual(testPinnedToolIdentity('workspace.write'));
    expect(effect.scope).toEqual(['src/normalized.ts']);
    expect(committedInvocation?.scope).toEqual(['src/normalized.ts']);
    const artifacts = setup.unit.loadCommittedArtifacts(dispatched.command!.commandId);
    const payload = artifacts?.effectPayloads[0];
    expect(payload).toMatchObject({
      kind: 'record_input',
      input: { a: { path: 'src/normalized.ts' }, z: 0 }
    });
    if (payload?.kind !== 'record_input') throw new Error('normalized payload missing');
    expect(Object.keys(payload.input as object)).toEqual(['a', 'z']);
    expect(Object.is((payload.input as { readonly z: number }).z, -0)).toBe(false);
    expect(effect.inputDigest).toBe(TEST_EFFECT_DIGESTER.digest(payload.input, {
      runId: setup.runId,
      effectId: effect.effectId
    }));
    expect(JSON.stringify(dispatched.run)).not.toContain(rawSecret);
    expect(JSON.stringify(artifacts)).not.toContain(rawSecret);
  });

  it('atomically authorizes every catalog-valid trusted invocation', async () => {
    const tools = [
      ...DEFAULT_TOOLS,
      testAvailableTool('workspace.read')
    ];
    const setup = await admittedSetup({
      runId: 'run-trusted-multi',
      permissionMode: 'trusted',
      tools,
      budgetToolCalls: 2
    });
    const directive: AgentDirective = {
      kind: 'invoke_tools',
      invocations: [
        invokeDirective('call-write', 'workspace.write', { path: 'src/a.ts' })
          .invocations[0]!,
        {
          toolCallId: 'call-read',
          tool: testPinnedToolIdentity('workspace.read'),
          input: { path: 'src/b.ts' },
          capabilityIds: ['workspace.read'],
          scope: ['workspace']
        }
      ]
    };
    const dispatched = await createDispatcher(setup, {
      decide: async () => directive
    }).dispatch(dispatchRequest('dispatch-trusted-multi', setup.runId));

    expect(dispatched.run.effects).toHaveLength(2);
    expect(dispatched.run.effects.every(
      (effect) => effect.state.status === 'authorized'
    )).toBe(true);
    expect(setup.unit.loadCommittedArtifacts(dispatched.command!.commandId)
      ?.effectPayloads).toHaveLength(2);
    expect(dispatched.command?.events.filter(
      (event) => event.payload.type === 'effect.registered'
    )).toHaveLength(2);
    expect(dispatched.command?.events.filter(
      (event) => event.payload.type === 'effect.transitioned'
    )).toHaveLength(2);
  });

  it('fails ask-mode multi-tool permission atomically without a partial first Effect', async () => {
    const tools = [
      ...DEFAULT_TOOLS,
      testAvailableTool('workspace.read')
    ];
    const setup = await admittedSetup({
      runId: 'run-ask-multi',
      permissionMode: 'ask',
      tools,
      budgetToolCalls: 2
    });
    const secret = 'multi-tool-secret';
    const directive: AgentDirective = {
      kind: 'invoke_tools',
      invocations: [
        invokeDirective('call-first', 'workspace.write', { token: secret })
          .invocations[0]!,
        {
          toolCallId: 'call-second',
          tool: testPinnedToolIdentity('workspace.read'),
          input: { token: secret },
          capabilityIds: ['workspace.read'],
          scope: ['workspace']
        }
      ]
    };
    const dispatched = await createDispatcher(setup, {
      decide: async () => directive
    }).dispatch(dispatchRequest('dispatch-ask-multi', setup.runId));

    expect(dispatched.status).toBe('failed');
    expect(dispatched.run).toMatchObject({
      version: 3,
      state: {
        status: 'failed',
        errorCode: 'AGENT_DIRECTIVE_MULTI_PERMISSION_UNSUPPORTED'
      },
      effects: []
    });
    expect(setup.unit.loadCommittedArtifacts(dispatched.command!.commandId)
      ?.effectPayloads).toEqual([]);
    expect(JSON.stringify(dispatched.command?.events)).not.toContain(secret);
  });

  it.each([
    ['wait', 'AGENT_DIRECTIVE_MULTI_PERMISSION_UNSUPPORTED'],
    ['deny', 'AGENT_DIRECTIVE_TOOL_ADMISSION_DENIED']
  ] as const)(
    'fails a trusted multi-tool batch atomically when one admission is %s',
    async (decision, errorCode) => {
      const setup = await admittedSetup({
        runId: `run-trusted-multi-${decision}`,
        permissionMode: 'trusted',
        tools: [
          testAvailableTool('workspace.write'),
          testAvailableTool('workspace.read')
        ],
        budgetToolCalls: 2
      });
      const policy: AgentToolAdmissionPolicy = {
        admit: vi.fn(async ({ invocation }) => {
          if (invocation.tool.toolName === 'workspace.write') {
            return {
              status: 'allow',
              tool: invocation.tool,
              capabilityIds: invocation.capabilityIds,
              scope: invocation.scope,
              normalizedInput: invocation.input
            };
          }
          return decision === 'wait'
            ? {
                status: 'wait',
                tool: invocation.tool,
                capabilityIds: invocation.capabilityIds,
                scope: invocation.scope,
                normalizedInput: invocation.input
              }
            : { status: 'deny', reason: 'scope_denied' };
        })
      };
      const directive: AgentDirective = {
        kind: 'invoke_tools',
        invocations: [
          invokeDirective('call-batch-write', 'workspace.write', {
            secret: `${decision}-write-secret`
          }).invocations[0]!,
          invokeDirective('call-batch-read', 'workspace.read', {
            secret: `${decision}-read-secret`
          }).invocations[0]!
        ]
      };
      const dispatched = await createDispatcher(
        setup,
        { decide: async () => directive },
        setup.unit,
        policy
      ).dispatch(dispatchRequest(`dispatch-trusted-multi-${decision}`, setup.runId));

      expect(policy.admit).toHaveBeenCalledTimes(2);
      expect(dispatched.run).toMatchObject({
        state: { status: 'failed', errorCode },
        effects: []
      });
      expect(setup.unit.loadCommittedArtifacts(dispatched.command!.commandId)
        ?.effectPayloads).toEqual([]);
      expect(JSON.stringify(dispatched.run)).not.toContain(`${decision}-read-secret`);
    }
  );

  it('lets admission infrastructure exceptions reach the dispatcher uncertain path', async () => {
    const setup = await admittedSetup({
      runId: 'run-admission-infrastructure-error',
      permissionMode: 'trusted'
    });
    const infrastructureSecret = 'admission-infrastructure-secret';
    const policy: AgentToolAdmissionPolicy = {
      admit: vi.fn(async () => {
        throw new Error(infrastructureSecret);
      })
    };
    const dispatched = await createDispatcher(
      setup,
      {
        decide: async () => invokeDirective(
          'call-admission-error',
          'workspace.write',
          { raw: 'must-not-commit' }
        )
      },
      setup.unit,
      policy
    ).dispatch(dispatchRequest('dispatch-admission-infrastructure-error', setup.runId));

    expect(policy.admit).toHaveBeenCalledTimes(1);
    expect(dispatched.status).toBe('uncertain');
    expect(dispatched.run).toMatchObject({
      state: {
        status: 'recovering',
        reason: 'uncertain_inference'
      },
      effects: []
    });
    expect(setup.unit.loadCommittedArtifacts(dispatched.command!.commandId)
      ?.effectPayloads).toEqual([]);
    expect(JSON.stringify(dispatched.run)).not.toContain(infrastructureSecret);
  });

  it.each(['identity', 'capability', 'scope'] as const)(
    'treats admitted %s drift as infrastructure failure with zero payloads',
    async (drift) => {
      const setup = await admittedSetup({
        runId: `run-admission-${drift}-drift`,
        permissionMode: 'trusted'
      });
      const policy: AgentToolAdmissionPolicy = {
        admit: vi.fn(async ({ invocation }) => ({
          status: 'allow',
          tool: drift === 'identity'
            ? { ...invocation.tool, toolVersion: '2.0.0' }
            : invocation.tool,
          capabilityIds: drift === 'capability'
            ? ['workspace.read']
            : invocation.capabilityIds,
          scope: drift === 'scope'
            ? ['outside-workspace']
            : invocation.scope,
          normalizedInput: { normalized: true }
        }))
      };
      const rawSecret = `${drift}-drift-secret`;
      const dispatched = await createDispatcher(
        setup,
        {
          decide: async () => invokeDirective(
            `call-${drift}-drift`,
            'workspace.write',
            { rawSecret }
          )
        },
        setup.unit,
        policy
      ).dispatch(dispatchRequest(`dispatch-${drift}-drift`, setup.runId));

      expect(policy.admit).toHaveBeenCalledTimes(1);
      expect(dispatched.status).toBe('uncertain');
      expect(dispatched.run).toMatchObject({
        state: { status: 'recovering', reason: 'uncertain_inference' },
        effects: []
      });
      expect(setup.unit.loadCommittedArtifacts(dispatched.command!.commandId)
        ?.effectPayloads).toEqual([]);
      expect(JSON.stringify(dispatched.run)).not.toContain(rawSecret);
    }
  );

  it('turns unknown tools and capability drift into sanitized deterministic failure', async () => {
    const cases: readonly [string, AgentDirective][] = [
      [
        'unknown',
        invokeDirective('call-unknown', 'workspace.delete', { secret: 'unknown-secret' })
      ],
      [
        'capability',
        {
          kind: 'invoke_tools',
          invocations: [{
            toolCallId: 'call-capability-drift',
            tool: testPinnedToolIdentity('workspace.write'),
            input: { secret: 'capability-secret' },
            capabilityIds: ['workspace.read'],
            scope: ['workspace']
          }]
        }
      ]
    ];
    for (const [name, directive] of cases) {
      const setup = await admittedSetup({
        runId: `run-catalog-${name}`,
        permissionMode: 'trusted'
      });
      const dispatched = await createDispatcher(setup, {
        decide: async () => directive
      }).dispatch(dispatchRequest(`dispatch-catalog-${name}`, setup.runId));
      expect(dispatched.run).toMatchObject({
        state: {
          status: 'failed',
          errorCode: 'AGENT_DIRECTIVE_CATALOG_MISMATCH'
        },
        effects: []
      });
      expect(setup.unit.loadCommittedArtifacts(dispatched.command!.commandId)
        ?.effectPayloads).toEqual([]);
      expect(JSON.stringify(dispatched.run)).not.toContain(`${name}-secret`);
    }
  });

  it('leaves Tool budget admission to the durable Budget path instead of the Directive planner', async () => {
    const setup = await admittedSetup({
      runId: 'run-tool-budget-zero',
      permissionMode: 'trusted',
      budgetToolCalls: 0
    });
    const started = await new AgentRunCommandService(setup.unit).execute({
      kind: 'run.start_inference_attempt',
      commandId: 'start-tool-budget-zero',
      runId: setup.runId,
      expectedVersion: 1,
      occurredAt: at(1),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID
    }, {
      checkpoint: checkpointCommit(2, 'inference_started', at(1)),
      turnInputPayloads: [],
      effectPayloads: []
    });
    const plan = await new DefaultAgentInferenceDirectivePlanner(
      TEST_EFFECT_DIGESTER,
      ALLOW_TOOL_ADMISSION_POLICY
    ).plan({
      resultCommandId: 'result-tool-budget-zero',
      run: started.run,
      turn: started.run.turns[0]!,
      attempt: started.run.turns[0]!.attempts[0]!,
      directive: invokeDirective(
        'call-over-budget',
        'workspace.write',
        { secret: 'budget-secret' }
      ),
      availableTools: setup.input.availableTools,
      occurredAt: at(2)
    });

    expect(plan.result.status).toBe('succeeded');
    expect(plan.effectPayloads).toHaveLength(1);
  });

  it('gives respond, complete, fail, checkpoint, and Runtime-owned plan one explicit result-version meaning', async () => {
    const cases: readonly [string, AgentDirective][] = [
      ['respond', { kind: 'respond', content: 'Atomic response.' }],
      ['complete', { kind: 'complete', outputRef: 'output-atomic' }],
      ['fail', { kind: 'fail', errorCode: 'PLANNED_FAILURE', message: 'Planned.' }],
      ['checkpoint', { kind: 'checkpoint', reason: 'continue_after_checkpoint' }],
      ['plan', {
        kind: 'propose_plan',
        plan: {
          summary: 'Implement the requested change safely.',
          impactSummary: 'The approved execution will change the workspace.',
          steps: [{
            title: 'Implement',
            summary: 'Apply and verify the exact requested change.',
            impact: 'workspace_change'
          }]
        }
      }]
    ];
    for (const [name, directive] of cases) {
      const setup = await admittedSetup({
        runId: `run-directive-${name}`,
        permissionMode: 'trusted',
        executionMode: name === 'plan' ? 'plan' : 'agent'
      });
      const before = setup.unit.commitCount;
      const dispatched = await createDispatcher(setup, {
        decide: async () => directive
      }).dispatch(dispatchRequest(`dispatch-directive-${name}`, setup.runId));
      expect(setup.unit.commitCount - before).toBe(2);
      expect(dispatched.run.version).toBe(3);
      expect(dispatched.attempt.state.status).toBe('succeeded');
      expect(dispatched.command?.events.at(-1)?.payload.type).toBe('run.state_changed');
      switch (name) {
        case 'respond':
          expect(dispatched.run.state.status).toBe('completed');
          expect(dispatched.command?.events.some(
            (event) => event.payload.type === 'run.completed'
          )).toBe(true);
          break;
        case 'complete':
          expect(dispatched.run.state).toMatchObject({
            status: 'completed',
            outputRef: expect.stringMatching(/^directive-artifact:/)
          });
          break;
        case 'fail':
          expect(dispatched.run.state).toMatchObject({
            status: 'failed',
            errorCode: 'PLANNED_FAILURE'
          });
          break;
        case 'checkpoint':
          expect(dispatched.run.state).toMatchObject({
            status: 'running',
            checkpointVersion: 3
          });
          break;
        case 'plan':
          expect(dispatched.run.state).toMatchObject({
            status: 'waiting',
            reason: 'plan_approval',
            decision: {
              kind: 'plan',
              planId: expect.stringMatching(/^plan:/),
              requestedAt: at(2)
            }
          });
          if (
            dispatched.run.state.status !== 'waiting'
            || dispatched.run.state.decision.kind !== 'plan'
          ) throw new Error('runtime_owned_plan_decision_missing');
          await expect(setup.unit.transaction(async (transaction) => (
            transaction.loadPlanVersion?.({
              planId: dispatched.run.state.decision.planId,
              version: dispatched.run.state.decision.planVersion,
              contentHash: dispatched.run.state.decision.planHash
            }) ?? null
          ))).resolves.toMatchObject({
            runId: setup.runId,
            payload: {
              publicPresentation: {
                summary: 'Implement the requested change safely.'
              }
            }
          });
          break;
      }
    }
  });

  it('rejects a terminal response that tries to bypass plan approval', async () => {
    const setup = await admittedSetup({
      runId: 'run-plan-response-bypass',
      permissionMode: 'trusted',
      executionMode: 'plan'
    });

    const dispatched = await createDispatcher(setup, {
      decide: async () => ({ kind: 'respond', content: 'bypass approval' })
    }).dispatch(dispatchRequest('dispatch-plan-response-bypass', setup.runId));

    expect(dispatched.run.state).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_PLAN_DIRECTIVE_INVALID'
    });
    expect(dispatched.attempt.state).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_PLAN_DIRECTIVE_INVALID'
    });
  });

  it('replays the exact result receipt and rejects same-ID result drift without a new version', async () => {
    const setup = await admittedSetup({
      runId: 'run-result-replay',
      permissionMode: 'trusted'
    });
    const dispatched = await createDispatcher(setup, {
      decide: async () => ({ kind: 'checkpoint', reason: 'durable-replay' } as const)
    }).dispatch(dispatchRequest('dispatch-result-replay', setup.runId));
    if (
      dispatched.command === null
      || dispatched.attempt.state.status !== 'succeeded'
    ) {
      throw new Error('result receipt fixture missing');
    }
    const command = {
      kind: 'run.record_inference_attempt_result' as const,
      commandId: dispatched.command.commandId,
      runId: setup.runId,
      expectedVersion: 2,
      occurredAt: at(2),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: {
        status: 'succeeded' as const,
        directive: dispatched.attempt.state.directive,
        directiveDigest: dispatched.attempt.state.directiveDigest
      }
    };
    const artifacts = setup.unit.loadCommittedArtifacts(command.commandId)!;
    const before = setup.unit.commitCount;
    const reopened = setup.unit.reopen();
    const replay = await new AgentRunCommandService(reopened).execute(command, artifacts);
    expect(replay.replayed).toBe(true);
    expect(replay.run.version).toBe(3);
    expect(replay.events).toEqual(dispatched.command.events);
    expect(reopened.commitCount).toBe(0);
    expect(setup.unit.commitCount).toBe(before);

    const driftDirective = {
      kind: 'checkpoint',
      reasonRef: 'directive-artifact-different-result',
      reasonDigest: `sha256:${'d'.repeat(64)}`
    } as const;
    await expect(new AgentRunCommandService(reopened).execute({
      ...command,
      result: {
        status: 'succeeded',
        directive: driftDirective,
        directiveDigest: await digestAgentCommittedDirective(driftDirective)
      }
    }, artifacts)).rejects.toMatchObject({
      code: 'AGENT_RUN_COMMAND_CONFLICT',
      reason: 'command_mismatch'
    });
    expect(reopened.loadRun(setup.runId)?.version).toBe(3);
  });

  it('collapses concurrent delivery of the same fresh result command to one version', async () => {
    const setup = await admittedSetup({
      runId: 'run-concurrent-result',
      permissionMode: 'trusted'
    });
    const commands = new AgentRunCommandService(setup.unit);
    const started = await commands.execute({
      kind: 'run.start_inference_attempt',
      commandId: 'start-concurrent-result',
      runId: setup.runId,
      expectedVersion: 1,
      occurredAt: at(1),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID
    }, {
      checkpoint: checkpointCommit(2, 'inference_started', at(1)),
      turnInputPayloads: [],
      effectPayloads: []
    });
    const turn = started.run.turns[0]!;
    const attempt = turn.attempts[0]!;
    const resultCommandId = 'concurrent-result-command';
    const plan = await new DefaultAgentInferenceDirectivePlanner(
      TEST_EFFECT_DIGESTER,
      ALLOW_TOOL_ADMISSION_POLICY
    ).plan({
      resultCommandId,
      run: started.run,
      turn,
      attempt,
      directive: { kind: 'checkpoint', reason: 'concurrent-result' },
      availableTools: setup.input.availableTools,
      occurredAt: at(2)
    });
    const command = {
      kind: 'run.record_inference_attempt_result' as const,
      commandId: resultCommandId,
      runId: setup.runId,
      expectedVersion: 2,
      occurredAt: at(2),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: plan.result
    };
    const artifacts = {
      checkpoint: checkpointCommit(3, 'inference_result', at(2)),
      turnInputPayloads: [],
      effectPayloads: plan.effectPayloads,
      directivePayloads: plan.directivePayloads
    };
    const before = setup.unit.commitCount;
    const [first, duplicate] = await Promise.all([
      commands.execute(command, artifacts),
      commands.execute(command, artifacts)
    ]);

    expect([first.replayed, duplicate.replayed].sort()).toEqual([false, true]);
    expect(first.events).toEqual(duplicate.events);
    expect(setup.unit.commitCount - before).toBe(1);
    expect(setup.unit.loadRun(setup.runId)?.version).toBe(3);
  });

  it('applies an exact recovery mark-succeeded tool Directive in the same recovery result commit', async () => {
    const setup = await admittedSetup({
      runId: 'run-recovery-succeeded',
      permissionMode: 'trusted'
    });
    const commands = new AgentRunCommandService(setup.unit);
    await commands.execute({
      kind: 'run.start_inference_attempt',
      commandId: 'start-recovery-succeeded',
      runId: setup.runId,
      expectedVersion: 1,
      occurredAt: at(1),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID
    }, {
      checkpoint: checkpointCommit(2, 'inference_started', at(1)),
      turnInputPayloads: [],
      effectPayloads: []
    });
    await commands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId: 'mark-recovery-uncertain',
      runId: setup.runId,
      expectedVersion: 2,
      occurredAt: at(2),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      result: {
        status: 'uncertain',
        reason: 'provider_outcome_unknown',
        recoveryDecisionId: 'recovery-decision-atomic',
        allowedActions: ['mark_succeeded', 'mark_failed', 'cancel_run']
      }
    }, {
      checkpoint: checkpointCommit(3, 'inference_uncertain', at(2)),
      turnInputPayloads: [],
      effectPayloads: []
    });
    const recovering = setup.unit.loadRun(setup.runId)!;
    const turn = recovering.turns[0]!;
    const attempt = turn.attempts[0]!;
    const resultCommandId = 'recovery-succeeded-result';
    const plan = await new DefaultAgentInferenceDirectivePlanner(
      TEST_EFFECT_DIGESTER,
      ALLOW_TOOL_ADMISSION_POLICY
    ).plan({
      resultCommandId,
      run: recovering,
      turn,
      attempt,
      directive: invokeDirective(
        'call-recovery-succeeded',
        'workspace.write',
        { path: 'src/recovered.ts' }
      ),
      availableTools: setup.input.availableTools,
      occurredAt: at(3)
    });
    const recovered = await commands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId: resultCommandId,
      runId: setup.runId,
      expectedVersion: 3,
      occurredAt: at(3),
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      recoveryDecisionId: 'recovery-decision-atomic',
      result: plan.result
    }, {
      checkpoint: checkpointCommit(4, 'inference_recovered', at(3)),
      turnInputPayloads: [],
      effectPayloads: plan.effectPayloads
    });

    expect(recovered.run).toMatchObject({
      version: 4,
      state: { status: 'running', checkpointVersion: 4 },
      turns: [{ attempts: [{ state: { status: 'succeeded' } }] }],
      effects: [{ state: { status: 'authorized' } }]
    });
    expect(recovered.events.map((event) => event.payload.type)).toEqual([
      'inference_attempt.transitioned',
      'effect.registered',
      'effect.transitioned',
      'run.state_changed'
    ]);
    expect(setup.unit.loadCommittedArtifacts(resultCommandId)?.effectPayloads)
      .toHaveLength(1);
  });

  it.each(['before_commit', 'after_commit'] as const)(
    'has an all-or-nothing result kill boundary: %s',
    async (boundary) => {
      const setup = await admittedSetup({
        runId: `run-kill-${boundary}`,
        permissionMode: 'trusted'
      });
      const wrapped = new ResultBoundaryUnitOfWork(setup.unit, boundary);
      const engine = {
        decide: vi.fn(async () => invokeDirective(
          'call-kill',
          'workspace.write',
          { secret: 'kill-secret' }
        ))
      };
      const request = dispatchRequest(`dispatch-kill-${boundary}`, setup.runId);
      await expect(createDispatcher(setup, engine, wrapped).dispatch(request))
        .rejects.toThrow(`kill_${boundary}`);
      expect(engine.decide).toHaveBeenCalledTimes(1);
      const resultCommandId = await resultId(request);

      if (boundary === 'before_commit') {
        expect(setup.unit.loadRun(setup.runId)).toMatchObject({
          version: 2,
          effects: [],
          turns: [{ attempts: [{ state: { status: 'started' } }] }]
        });
        expect(setup.unit.loadCommittedReceipt(resultCommandId)).toBeNull();
        expect(setup.unit.loadCommittedArtifacts(resultCommandId)).toBeNull();
        const reopened = setup.unit.reopen();
        const retryEngine = { decide: vi.fn() };
        await expect(createDispatcher(
          { ...setup, unit: reopened },
          retryEngine
        ).dispatch(request)).rejects.toBeInstanceOf(
          AgentInferenceDispatchRecoveryRequiredError
        );
        expect(retryEngine.decide).not.toHaveBeenCalled();
      } else {
        expect(setup.unit.loadRun(setup.runId)).toMatchObject({
          version: 3,
          effects: [{ state: { status: 'authorized' } }],
          turns: [{ attempts: [{ state: { status: 'succeeded' } }] }]
        });
        expect(setup.unit.loadCommittedReceipt(resultCommandId)).not.toBeNull();
        expect(setup.unit.loadCommittedArtifacts(resultCommandId)).not.toBeNull();
        const reopened = setup.unit.reopen();
        const retryEngine = { decide: vi.fn() };
        const settled = await createDispatcher(
          { ...setup, unit: reopened },
          retryEngine
        ).dispatch(request);
        expect(settled.alreadySettled).toBe(true);
        expect(settled.command).toBeNull();
        expect(retryEngine.decide).not.toHaveBeenCalled();
      }
    }
  );
});

interface AtomicSetup {
  readonly runId: string;
  readonly unit: InMemoryAgentRunUnitOfWork;
  readonly inputDigest: string;
  readonly input: AgentTurnInputModelData;
}

async function admittedSetup(options: {
  readonly runId: string;
  readonly permissionMode: 'ask' | 'trusted';
  readonly tools?: AgentTurnInputModelData['availableTools'];
  readonly budgetToolCalls?: number;
  readonly executionMode?: 'agent' | 'plan';
}): Promise<AtomicSetup> {
  const tools = [...(options.tools ?? DEFAULT_TOOLS)].sort((left, right) =>
    left.tool.toolName < right.tool.toolName ? -1 : left.tool.toolName > right.tool.toolName ? 1 : 0
  );
  const input: AgentTurnInputModelData = {
    messages: [{
      kind: 'text',
      role: 'user',
      content: 'Apply the exact Directive atomically.'
    }],
    availableTools: tools
  };
  const inputDigest = await digestAgentTurnInput(input);
  const unit = new InMemoryAgentRunUnitOfWork();
  const runBinding = bindingForRun(options.runId);
  const admissionBinding = {
    ...runBinding,
    ...(options.executionMode === undefined
      ? {}
      : {
          bindingVersion: 4 as const,
          executionProfile: { mode: options.executionMode }
        }),
    sessionId: `session-${options.runId}`,
    policy: {
      ...runBinding.policy,
      permissionMode: options.permissionMode
    },
    toolCatalog: {
      ...runBinding.toolCatalog,
      allowedToolNames: tools.map((tool) => tool.tool.toolName)
    },
    budget: {
      ...runBinding.budget,
      vector: {
        ...runBinding.budget.vector,
        toolCalls: options.budgetToolCalls ?? runBinding.budget.vector.toolCalls
      }
    }
  };
  if (admissionBinding.objectiveRef.kind !== 'conversation_message') {
    throw new Error('Atomic inference fixture requires a Conversation objective.');
  }
  const cause = {
    kind: 'conversation_objective' as const,
    messageId: admissionBinding.objectiveRef.messageId,
    messageVersion: admissionBinding.objectiveRef.messageVersion,
    contentDigest: admissionBinding.objectiveRef.contentDigest
  };
  await new AgentRunAdmissionService(unit).admit({
    command: {
      kind: 'run.admit',
      commandId: `admit-${options.runId}`,
      runId: options.runId,
      occurredAt: at(0),
      binding: admissionBinding,
      turn: {
        cause,
        turnId: TURN_ID,
        attemptId: ATTEMPT_ID,
        providerIdempotencyKey: PROVIDER_KEY,
        inputDigest,
        inputSummary: summarizeAgentTurnInput(input)
      }
    },
    checkpoint: checkpointPayload('admitted'),
    turnInput: {
      format: 'ariadne.agent-turn-input',
      schemaVersion: 1,
      runId: options.runId,
      turnId: TURN_ID,
      cause,
      authorityRef: {
        kind: 'conversation_message',
        sessionId: admissionBinding.sessionId,
        workspaceId: admissionBinding.workspace.workspaceId,
        messageId: admissionBinding.objectiveRef.messageId,
        messageVersion: admissionBinding.objectiveRef.messageVersion,
        contentDigest: admissionBinding.objectiveRef.contentDigest
      },
      messages: input.messages,
      availableTools: input.availableTools
    }
  });
  return { runId: options.runId, unit, inputDigest, input };
}

function createDispatcher(
  setup: AtomicSetup,
  engine: {
    prepare?(input: AgentTurnInput, signal: AbortSignal): Promise<void>;
    decide(input: AgentTurnInput, signal: AbortSignal): Promise<AgentDirective>;
  },
  unitOfWork: AgentRunUnitOfWork = setup.unit,
  toolAdmissionPolicy: AgentToolAdmissionPolicy = ALLOW_TOOL_ADMISSION_POLICY
): AgentInferenceDispatchService {
  return new AgentInferenceDispatchService(
    unitOfWork,
    {
      loadInferenceExecutionInput: vi.fn(async () => {
        const run = setup.unit.loadRun(setup.runId);
        if (run === null) throw new Error('fixture Run missing');
        return {
          runId: setup.runId,
          turnId: TURN_ID,
          attemptId: ATTEMPT_ID,
          inputDigest: setup.inputDigest,
          input: { run, ...setup.input }
        };
      })
    },
    {
      prepare: async (input, signal) => {
        signal.throwIfAborted();
        await engine.prepare?.(input, signal);
        signal.throwIfAborted();
        return {
          modelContext: [],
          decide: (decisionSignal: AbortSignal) => engine.decide(input, decisionSignal)
        };
      }
    },
    new DefaultAgentInferenceDirectivePlanner(
      TEST_EFFECT_DIGESTER,
      toolAdmissionPolicy
    ),
    {
      create(input: AgentInferenceDispatchCheckpointRequest): AgentRunCheckpointCommit {
        return {
          checkpointVersion: input.checkpointVersion,
          payload: {
            format: 'ariadne.agent-checkpoint',
            schemaVersion: 1,
            engineContinuation: input.phase === 'inference_result'
              ? {
                  phase: input.phase,
                  resultStatus: input.result.status,
                  directiveKind: input.result.status === 'succeeded'
                    ? input.result.directive.kind
                    : null
                }
              : { phase: input.phase },
            modelContext: []
          },
          createdAt: input.occurredAt
        };
      }
    },
    { now: () => at(2) }
  );
}

function dispatchRequest(commandId: string, runId: string) {
  return {
    commandId,
    runId,
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    expectedVersion: 1,
    occurredAt: at(1)
  } as const;
}

function invokeDirective(
  toolCallId: string,
  toolName: string,
  input: AgentJsonValue
): Extract<AgentDirective, { readonly kind: 'invoke_tools' }> {
  return {
    kind: 'invoke_tools',
    invocations: [{
      toolCallId,
      tool: testPinnedToolIdentity(toolName),
      input,
      capabilityIds: [toolName],
      scope: ['workspace']
    }]
  };
}

const TEST_EFFECT_DIGESTER: AgentEffectInputDigester = {
  digest(input, context) {
    const source = JSON.stringify({ context, input });
    let hash = 2_166_136_261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return `sha256:${(hash >>> 0).toString(16).padStart(8, '0').repeat(8)}`;
  }
};

const ALLOW_TOOL_ADMISSION_POLICY: AgentToolAdmissionPolicy = {
  admit: async ({ invocation }) => ({
    status: 'allow',
    tool: invocation.tool,
    capabilityIds: invocation.capabilityIds,
    scope: invocation.scope,
    normalizedInput: invocation.input
  })
};

function checkpointPayload(phase: string) {
  return {
    format: 'ariadne.agent-checkpoint' as const,
    schemaVersion: 1 as const,
    engineContinuation: { phase },
    modelContext: []
  };
}

function checkpointCommit(
  checkpointVersion: number,
  phase: string,
  createdAt: string
): AgentRunCheckpointCommit {
  return {
    checkpointVersion,
    payload: checkpointPayload(phase),
    createdAt
  };
}

async function resultId(request: ReturnType<typeof dispatchRequest>): Promise<string> {
  return deriveStableAgentId(
    'inference-result',
    request.commandId,
    request.runId,
    request.turnId,
    request.attemptId
  );
}

class ResultBoundaryUnitOfWork implements AgentRunUnitOfWork {
  public constructor(
    private readonly inner: InMemoryAgentRunUnitOfWork,
    private readonly boundary: 'before_commit' | 'after_commit'
  ) {}

  public transaction<T>(
    operation: (transaction: AgentRunTransaction) => Promise<T>
  ): Promise<T> {
    return this.inner.transaction((transaction) => operation({
      ...transaction,
      commitCommand: async (commit) => {
        const resultCommit = commit.mutations.some((mutation) =>
          mutation.events.some((event) => event.payload.type === 'effect.registered')
        );
        if (!resultCommit) {
          await transaction.commitCommand(commit);
          return;
        }
        if (this.boundary === 'before_commit') {
          throw new Error('kill_before_commit');
        }
        await transaction.commitCommand(commit);
        throw new Error('kill_after_commit');
      }
    }));
  }
}
