import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap,
  type RuntimeResponse
} from '@ariadne/protocol/host';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST, runtimeResultSchema
} from '@ariadne/protocol/public';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComposedRuntimeIngress } from '../src/composition/ComposedRuntimeIngress.js';
import { RuntimeDomainHealth } from '../src/ingress/RuntimeDomainHealth.js';
import type {
  AgentControlRuntimeFactory,
  AgentControlRuntimeFactoryInput,
  AgentControlRuntimeLifecycle
} from '../src/ingress/AgentControlLifecycle.js';
import type {
  RuntimeApplication,
  RuntimeApplicationCommandResult,
  RuntimeApplicationFactory
} from '../src/ingress/RuntimeApplication.js';
import type {
  RuntimeCommandBeginResultV2 as RuntimeCommandBeginResult,
  RuntimeCommandJournalV2 as RuntimeCommandJournal,
  RuntimeCommandReconciliationV2 as RuntimeCommandReconciliation
} from '../src/control/ports/RuntimeCommandJournalV2.js';
import type { RuntimeCommandJournalStatus } from '../src/control/ports/RuntimeCommandJournal.js';
type RuntimeCommandOutcome = RuntimeResponse['outcome'];
import type { RuntimeCommandEnvelope } from '../src/ingress/RuntimeIngress.js';
import type {
  RuntimeModelCatalogEntry,
  RuntimeModelCatalogSource
} from '../src/ingress/RuntimeModelCatalog.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import type {
  RuntimePublicEventAppend,
  RuntimePublicEventSink
} from '../src/ingress/RuntimePublicEventSink.js';

const fingerprint = 'b'.repeat(64);
const ingressFixtures: { ingress: ComposedRuntimeIngress; shutdownFailureExpected: boolean }[] = [];
function newIngress(dependencies: ConstructorParameters<typeof ComposedRuntimeIngress>[0], shutdownFailureExpected = false): ComposedRuntimeIngress {
  const ingress = new ComposedRuntimeIngress(dependencies); ingressFixtures.push({ ingress, shutdownFailureExpected }); return ingress;
}
afterEach(async () => {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    for (const fixture of ingressFixtures.splice(0)) {
      try { await fixture.ingress.shutdown(context); }
      catch (error) { if (!fixture.shutdownFailureExpected) throw error; }
    }
  } finally { context.dispose(); }
});

describe('ComposedRuntimeIngress', () => {
  it('isolates damaged inference authority from independent commands and keeps diagnostics body-free', async () => {
    let broken=false, external=false;
    const harness=await createHarness({inferenceHealth:{assertHealthy(){if(broken)throw new Error('private model database');},hasExternalFailure:()=>external}});
    const read=()=>harness.ingress.execute({...envelope('inference-health-read'),command:{kind:'runtime.health.get'}});
    external=true;
    expect(await read()).toMatchObject({ok:true,result:{health:{domains:[{domain:'inference',availability:'degraded',code:'external_unavailable'}]}}});
    await expect(harness.ingress.execute(envelope('independent-while-model-degraded'))).resolves.toMatchObject({ok:true});
    external=false;
    expect(await read()).toMatchObject({ok:true,result:{health:{domains:[{domain:'inference',availability:'healthy'}]}}});
    broken=true;
    const health=await read();
    expect(health).toMatchObject({ok:true,result:{health:{domains:[{domain:'inference',availability:'unavailable',code:'authority_unavailable'}]}}});
    expect(JSON.stringify(health)).not.toContain('private model database');
    await expect(harness.ingress.execute({...envelope('model-source-refused'),command:{kind:'model.availability.check',contractVersion:'5.0',modelId:'fixture'}}))
      .resolves.toMatchObject({ok:false,error:{code:'runtime_inference_unavailable'}});
    expect(harness.journal.getStatus('model-source-refused')).toBeNull();
    await expect(harness.ingress.execute(envelope('independent-while-model-damaged'))).resolves.toMatchObject({ok:true});
  });
  it('reports an actual journal-probe failure through independent health and rejects ordinary commands before the ledger', async () => {
    let broken = false;
    const harness = await createHarness({ journalHealth: { assertHealthy() { if (broken) throw new Error('private journal storage fault'); } } });
    broken = true;
    const read = await harness.ingress.execute({ ...envelope('health-independent-journal'), command: { kind: 'runtime.health.get' } });
    expect(read).toMatchObject({ ok: true, result: { kind: 'runtime.health', health: {
      domains: [{ domain: 'journal', availability: 'unavailable', code: 'authority_unavailable', recovery: 'repair' }]
    } } });
    expect(JSON.stringify(read)).not.toContain('private journal storage fault');
    await expect(harness.ingress.execute(envelope('journal-fenced-command'))).resolves.toMatchObject({ ok: false, error: { code: 'runtime_journal_unavailable' } });
    expect(harness.journal.getStatus('journal-fenced-command')).toBeNull();
  });
  it('constructs the model domain before Control and starts Control before the Application', async () => {
    const order: string[] = [];
    await createHarness({ order, withAgentControl: true });

    expect(order).toEqual([
      'legacy-preflight',
      'journal-open',
      'application-create',
      'agent-open',
      'agent-start',
      'application-start'
    ]);
  });

  it('passes Host authority and the bound Runtime model catalog into Control composition', async () => {
    let received: AgentControlRuntimeFactoryInput | undefined;
    const source = disabledAdmissionAuthoritySource();
    const input = bootstrap();
    const journal = new InMemoryRuntimeCommandJournal({ order: [] });
    const application = new FakeRuntimeApplication(
      [],
      async () => completed(successOutcome()),
      false,
      [{
        id: 'cloud-deepseek',
        label: 'deepseek-chat',
        location: 'remote',
        availability: 'ready',
        supportsAgent: true,
        supportsVision: false
      }]
    );
    const ingress = newIngress({
      commandJournal: journal,
      runtimeApplicationFactory: {
        create: async () => application
      },
      agentControlFactory: {
        create: async (factoryInput) => {
          received = factoryInput;
          return agentLifecycle([]);
        }
      },
      preflightCommunicationContract: () => undefined,
      preflightMemoryControlShadows: () => undefined,
      readBuildManifest: () => ({
        schemaVersion: 1,
        runtimeVersion: '0.1.0',
        fingerprint
      })
    });

    await ingress.initialize({
      bootstrap: { ...input, agentAdmissionAuthoritySource: source },
      hostCapabilities: { request: async () => ({}) },
      emitEvent: () => undefined
    });

    expect(received?.agentAdmissionAuthoritySource).toBe(source);
    expect(received?.runtimeInstanceId).toBe(input.runtimeInstanceId);
    expect(received?.modelCatalog.snapshot()).toEqual([expect.objectContaining({
      id: 'cloud-deepseek',
      availability: 'ready'
    })]);
    const wake: RuntimePublicEventAppend = {
      eventId: 'projection-wake-1',
      aggregateType: 'projection',
      aggregateId: 'model-catalog',
      aggregateVersion: 1,
      occurredAt: '2030-01-01T00:00:00.000Z',
      event: { kind: 'projection.changed', feature: 'models' }
    };
    await received?.publicEventSink.append(wake);
    await vi.waitFor(() => expect(application.publicEvents).toEqual([wake]));
    const live: RuntimePublicEventAppend = {
      eventId: 'inference-live-1',
      aggregateType: 'inference_stream',
      aggregateId: 'inference-live',
      aggregateVersion: 1,
      occurredAt: '2030-01-01T00:00:01.000Z',
      event: {
        contractVersion: '1.0',
        kind: 'inference.chunk.observed',
        sessionId: 'session-live',
        runId: 'run-live',
        turnId: 'turn-live',
        attemptId: 'attempt-live',
        sequence: 1,
        channel: 'token',
        text: 'live',
        observedAt: '2030-01-01T00:00:01.000Z'
      }
    };
    await received?.liveInferenceEventSink.append(live);
    expect(application.publicEvents).toEqual([wake, live]);
  });

  it('closes failed Control before disposing its model-domain dependency', async () => {
    const order: string[] = [];
    const journal = new InMemoryRuntimeCommandJournal({ order });
    const application = new FakeRuntimeApplication(
      order,
      async () => completed(successOutcome())
    );
    const ingress = newIngress({
      commandJournal: journal,
      runtimeApplicationFactory: {
        create: async () => {
          order.push('application-create');
          return application;
        }
      },
      agentControlFactory: {
        create: async () => {
          order.push('agent-open');
          return {
            schemaVersion: 13,
            storageSchemas: { agentControl: 13, publicProjection: 1 },
            start: async () => {
              order.push('agent-start');
              throw new Error('initial_projection_drain_failed');
            },
            assertHealthy: () => undefined,
            assertCommandHealthy: () => undefined,
            readDomainHealth: () => [],
            executeOwnedCommand: async () => null,
            reconcileUncertainCommand: async () => null,
            prepareShutdown: async () => undefined,
            shutdown: async () => { order.push('agent-close'); }
          };
        }
      },
      preflightCommunicationContract: () => undefined,
      preflightMemoryControlShadows: () => { order.push('legacy-preflight'); },
      readBuildManifest: () => ({
        schemaVersion: 1,
        runtimeVersion: '0.1.0',
        fingerprint
      })
    });

    await expect(ingress.initialize({
      bootstrap: bootstrap(),
      hostCapabilities: { request: async () => ({}) },
      emitEvent: () => undefined
    })).rejects.toMatchObject({
      phase: 'agent_control_start',
      code: 'INITIAL_PROJECTION_DRAIN_FAILED'
    });
    expect(order).toEqual([
      'legacy-preflight',
      'journal-open',
      'application-create',
      'agent-open',
      'agent-start',
      'agent-close',
      'application-initialization-dispose',
      'journal-close'
    ]);
  });

  it('preserves the deepest stable startup failure code through lifecycle wrappers', async () => {
    const ingress = newIngress({
      commandJournal: new InMemoryRuntimeCommandJournal({ order: [] }),
      runtimeApplicationFactory: {
        create: async () => new FakeRuntimeApplication(
          [],
          async () => completed(successOutcome())
        )
      },
      agentControlFactory: {
        create: async () => ({
          ...agentLifecycle([]),
          start: async () => {
            throw new Error('agent_control_public_projection_unhealthy', {
              cause: new Error('agent_control_startup_projection_not_at_fixed_point')
            });
          }
        })
      },
      preflightCommunicationContract: () => undefined,
      preflightMemoryControlShadows: () => undefined,
      readBuildManifest: () => ({
        schemaVersion: 1,
        runtimeVersion: '0.1.0',
        fingerprint
      })
    });

    await expect(ingress.initialize({
      bootstrap: bootstrap(),
      hostCapabilities: { request: async () => ({}) },
      emitEvent: () => undefined
    })).rejects.toMatchObject({
      phase: 'agent_control_start',
      code: 'AGENT_CONTROL_STARTUP_PROJECTION_NOT_AT_FIXED_POINT'
    });
  });

  it('replays one logical command without executing the application twice', async () => {
    const execute = vi.fn(async () => completed(successOutcome()));
    const harness = await createHarness({ execute });
    const command = envelope('stable-command');

    const first = await harness.ingress.execute(command);
    const replay = await harness.ingress.execute({
      ...command,
      correlationId: 'retry-attempt'
    });

    expect(first).toEqual(successOutcome());
    expect(replay).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(harness.journal.getStatus('stable-command')).toBe('completed');
  });

  it('routes v3 Projection queries only to Control and journals the result', async () => {
    const applicationExecute = vi.fn(async () => completed(successOutcome()));
    const ownedExecute = vi.fn(async () => completed({
      ok: true,
      result: {
        kind: 'projection.snapshot',
        snapshot: {
          contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
          streamId: 'projection-stream',
          cursor: 0,
          cursorDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
          capturedAt: '2026-07-31T12:00:00.000Z',
          sessions: [],
          messages: [],
          runs: [],
          decisions: [],
          models: [],
          diagnostics: [],
          inferenceStreams: [],
          tombstones: []
        }
      }
    }));
    const harness = await createHarness({
      execute: applicationExecute,
      executeAgentOwned: ownedExecute,
      withAgentControl: true
    });
    const request: RuntimeCommandEnvelope = {
      ...envelope('projection-query'),
      command: {
        kind: 'projection.snapshot.get',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION
      }
    };

    await expect(harness.ingress.execute(request)).resolves.toMatchObject({
      ok: true,
      result: { kind: 'projection.snapshot' }
    });
    expect(ownedExecute).toHaveBeenCalledTimes(1);
    expect(applicationExecute).not.toHaveBeenCalled();
    expect(harness.journal.getStatus('projection-query')).toBe('completed');
  });

  it('rejects commandId drift without invoking the application again', async () => {
    const execute = vi.fn(async () => completed(successOutcome()));
    const harness = await createHarness({ execute });
    await harness.ingress.execute(envelope('stable-command'));

    const conflict = await harness.ingress.execute({
      ...envelope('stable-command'),
      command: { kind: 'projection.snapshot.get', contractVersion: '5.0' }
    });

    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'command_id_conflict', retryable: false }
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('validates V2 journal replay at Ingress before publishing an invalid transport result', async () => {
    const execute = vi.fn(async () => completed(successOutcome()));
    const harness = await createHarness({ execute });
    vi.spyOn(harness.journal, 'begin').mockReturnValue({ kind: 'replay', outcome: {
      ok: true, result: { kind: 'projection.snapshot.page_result', page: { status: 'ok', changes: [] } }
    } });
    await expect(harness.ingress.execute(envelope('invalid-journal-replay'))).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('replays commands whose nested object keys arrive in a different order', async () => {
    const execute = vi.fn(async () => completed(successOutcome()));
    const harness = await createHarness({ execute });
    const first = {
      ...envelope('canonical-command'),
      command: {
        kind: 'agent.decision.resolve' as const,
        contractVersion: '5.0' as const,
        runId: 'run-canonical',
        decisionId: 'decision-canonical',
        action: {
          contractVersion: '1.0' as const,
          actionToken: `decision-action.v1:${'a'.repeat(64)}` as const,
          choice: 'approve' as const
        }
      }
    };
    const reordered = {
      ...envelope('canonical-command'),
      command: {
        action: {
          choice: 'approve' as const,
          actionToken: `decision-action.v1:${'a'.repeat(64)}` as const,
          contractVersion: '1.0' as const
        },
        decisionId: 'decision-canonical',
        runId: 'run-canonical',
        contractVersion: '5.0' as const,
        kind: 'agent.decision.resolve' as const
      }
    };

    const original = await harness.ingress.execute(first);
    const replay = await harness.ingress.execute(reordered);

    expect(replay).toEqual(original);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reports an overlapping logical command as uncertain', async () => {
    let resolveFirst!: (result: RuntimeApplicationCommandResult) => void;
    const execute = vi.fn(() => new Promise<RuntimeApplicationCommandResult>((resolve) => {
      resolveFirst = resolve;
    }));
    const harness = await createHarness({ execute });
    const first = harness.ingress.execute(envelope('overlap-command'));

    const overlap = await harness.ingress.execute(envelope('overlap-command'));
    expect(overlap).toMatchObject({
      ok: false,
      error: { code: 'command_outcome_uncertain', retryable: false }
    });
    expect(execute).toHaveBeenCalledTimes(1);

    resolveFirst(completed(successOutcome()));
    await expect(first).resolves.toEqual(successOutcome());
  });

  it('fails command admission closed after Agent public projection health fails', async () => {
    let unhealthy = false;
    const execute = vi.fn(async () => completed(successOutcome()));
    const harness = await createHarness({
      execute,
      withAgentControl: true,
      assertAgentHealthy: () => {
        if (unhealthy) throw new Error('agent_projection_unhealthy');
      }
    });
    unhealthy = true;

    await expect(harness.ingress.execute(envelope('health-gated-command')))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'runtime_unhealthy', retryable: false }
      });
    expect(execute).not.toHaveBeenCalled();
    expect(harness.journal.getStatus('health-gated-command')).toBeNull();
  });

  it('names the failed worker before journal admission while allowing an unrelated command', async () => {
    const health = new RuntimeDomainHealth();
    health.register('workflow', { probe() { throw new Error('private worker exception'); },
      failureCode: 'worker_failed', recovery: 'reconcile' });
    const execute = vi.fn(async () => completed(successOutcome()));
    const harness = await createHarness({ withAgentControl: true, execute,
      assertAgentCommandHealthy: command => {
        if (command.kind === 'workflow.start') health.assertAvailable(['workflow']);
      } });
    const rejected: RuntimeCommandEnvelope = { ...envelope('worker-gated'), command: { kind: 'workflow.start', contractVersion: '5.0', workspaceId: 'workspace', sessionId: 'session',
      workflowId: 'workflow', goalId: 'goal', expectedGoalVersion: 1, expectedTodoRevision: 1, todoIds: ['todo'],
      maxConcurrency: 1, maxTransitions: 1, executionMode: 'agent', deadlineAt: '2098-01-01T00:00:00.000Z' } };
    const outcome = await harness.ingress.execute(rejected);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'runtime_workflow_unavailable', retryable: false } });
    expect(JSON.stringify(outcome)).not.toContain('private worker exception');
    expect(harness.journal.getStatus('worker-gated')).toBeNull();
    await expect(harness.ingress.execute(envelope('unrelated-after-worker-failure'))).resolves.toEqual(successOutcome());
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reads bounded source health independently of damaged Projection admission and command journal', async () => {
    let damaged = false;
    const health = new RuntimeDomainHealth();
    health.register('projection', { probe() { if (damaged) throw new Error('private corrupt payload'); },
      failureCode: 'authority_unavailable', recovery: 'repair' });
    const execute = vi.fn(async () => completed(successOutcome()));
    const harness = await createHarness({ withAgentControl: true, execute,
      assertAgentHealthy: () => { if (damaged) throw new Error('corrupt'); }, readAgentDomainHealth: () => health.read() });
    damaged = true;
    const journal = vi.spyOn(harness.journal, 'begin').mockImplementation(() => { throw new Error('corrupt journal'); });
    const command: RuntimeCommandEnvelope = { ...envelope('independent-health'), command: { kind: 'runtime.health.get' } };
    const outcome = await harness.ingress.execute(command);
    expect(outcome).toMatchObject({ ok: true, result: { kind: 'runtime.health', health: {
      contractVersion: '1.0', coverage: 'registered_domains', domains: [{ domain: 'projection',
        source: 'projection', availability: 'unavailable', code: 'authority_unavailable', recovery: 'repair' }]
    } } });
    if (!outcome.ok) throw new Error('fixture_health');
    expect(() => runtimeResultSchema.parse(outcome.result)).not.toThrow();
    expect(JSON.stringify(outcome)).not.toContain('private corrupt payload');
    expect(journal).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); journal.mockRestore();
  });

  it('persists an uncertain interruption before the application observes abort', async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const harness = await createHarness({
      execute: (command) => new Promise((resolve) => {
        command.signal.addEventListener('abort', () => {
          order.push('application-aborted');
          resolve(uncertain(uncertainOutcome(command.correlationId)));
        }, { once: true });
      }),
      onMarkUncertain: () => order.push('journal-uncertain')
    });
    const execution = harness.ingress.execute({
      ...envelope('cancel-command'),
      signal: controller.signal
    });

    const forced = harness.ingress.interrupt('cancel-command', 'caller_cancelled');
    controller.abort(new Error('caller_cancelled'));
    const outcome = await execution;

    expect(order).toEqual(['journal-uncertain', 'application-aborted']);
    expect(outcome).toEqual(forced);
    expect(harness.journal.getStatus('cancel-command')).toBe('uncertain');
  });

  it('interrupts and drains active commands before freezing producers during shutdown', async () => {
    const order: string[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const harness = await createHarness({
      order,
      withAgentControl: true,
      onMarkUncertain: () => order.push('journal-uncertain'),
      execute: (command) => new Promise((resolve) => {
        order.push('application-active');
        markStarted();
        command.signal.addEventListener('abort', () => {
          order.push('application-aborted');
          resolve(uncertain(uncertainOutcome(command.correlationId)));
        }, { once: true });
      })
    });
    order.length = 0;

    const execution = harness.ingress.execute(envelope('shutdown-active-command'));
    await started;
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await harness.ingress.shutdown(context);
    } finally {
      context.dispose();
    }
    const outcome = await execution;

    expect(order).toEqual([
      'application-active',
      'journal-uncertain',
      'application-aborted',
      'application-prepare',
      'application-stop',
      'agent-prepare',
      'agent-close',
      'application-close',
      'journal-close'
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'command_outcome_uncertain', retryable: false }
    });
    expect(harness.journal.getStatus('shutdown-active-command')).toBe('uncertain');
  });

  it('settles an already-expired command without entering the application', async () => {
    const execute = vi.fn(async () => completed(successOutcome()));
    const harness = await createHarness({ execute });

    const outcome = await harness.ingress.execute({
      ...envelope('expired-command'),
      deadlineAt: new Date(Date.now() - 1).toISOString()
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'deadline_exceeded', retryable: false }
    });
    expect(execute).not.toHaveBeenCalled();
    expect(harness.journal.getStatus('expired-command')).toBe('completed');
  });

  it('aborts held application work at the absolute deadline after persisting uncertainty', async () => {
    let observedSignal: AbortSignal | undefined;
    const order: string[] = [];
    const harness = await createHarness({
      onMarkUncertain: () => order.push('journal-uncertain'),
      execute: (command) => new Promise((resolve) => {
        observedSignal = command.signal;
        command.signal.addEventListener('abort', () => {
          order.push('application-aborted');
          resolve(uncertain(uncertainOutcome(command.correlationId)));
        }, { once: true });
      })
    });

    const outcome = await harness.ingress.execute({
      ...envelope('deadline-command'),
      deadlineAt: new Date(Date.now() + 20).toISOString()
    });

    expect(order).toEqual(['journal-uncertain', 'application-aborted']);
    expect(observedSignal?.aborted).toBe(true);
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'command_outcome_uncertain', retryable: false }
    });
    expect(harness.journal.getStatus('deadline-command')).toBe('uncertain');
  });

  it('honors the application certainty when settling the journal', async () => {
    let invocation = 0;
    const harness = await createHarness({
      execute: async (command) => {
        invocation += 1;
        const outcome = errorOutcome(
          command.correlationId,
          invocation === 1 ? 'validation_failed' : 'operation_start_timeout'
        );
        return invocation === 1 ? completed(outcome) : uncertain(outcome);
      }
    });

    await harness.ingress.execute(envelope('deterministic-command'));
    await harness.ingress.execute(envelope('uncertain-command'));

    expect(harness.journal.getStatus('deterministic-command')).toBe('completed');
    expect(harness.journal.getStatus('uncertain-command')).toBe('uncertain');
  });

  it('reconciles an uncertain Control command from its durable domain receipt', async () => {
    const committedOutcome = successOutcome();
    let executions = 0;
    let reconciliations = 0;
    const harness = await createHarness({
      withAgentControl: true,
      executeAgentOwned: async () => {
        executions += 1;
        return uncertain(uncertainOutcome('receipt-command'));
      },
      reconcileAgentOwned: async () => {
        reconciliations += 1;
        return { kind: 'committed', outcome: committedOutcome };
      }
    });

    await expect(harness.ingress.execute(envelope('receipt-command')))
      .resolves.toMatchObject({ ok: false, error: { code: 'command_outcome_uncertain' } });
    await expect(harness.ingress.execute(envelope('receipt-command')))
      .resolves.toEqual(committedOutcome);
    expect(executions).toBe(1);
    expect(reconciliations).toBe(1);
    expect(harness.journal.getStatus('receipt-command')).toBe('completed');
  });

  it('tracks uncertain reconciliation before its first await and drains it before close', async () => {
    const order: string[] = [];
    let reconciliationStarted!: () => void;
    let releaseReconciliation!: () => void;
    const started = new Promise<void>((resolve) => {
      reconciliationStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const harness = await createHarness({
      order,
      withAgentControl: true,
      executeAgentOwned: async (command) => uncertain(
        uncertainOutcome(command.correlationId)
      ),
      reconcileAgentOwned: async () => {
        order.push('reconciliation-started');
        reconciliationStarted();
        await release;
        order.push('reconciliation-settled');
        return { kind: 'not_committed' };
      }
    });
    await harness.ingress.execute(envelope('held-reconciliation'));
    order.length = 0;

    const execution = harness.ingress.execute(envelope('held-reconciliation'));
    await started;
    const context = createShutdownContext(Date.now() + 5_000);
    const shutdown = harness.ingress.shutdown(context);
    await Promise.resolve();
    expect(order).toEqual(['reconciliation-started']);

    releaseReconciliation();
    try {
      await shutdown;
    } finally {
      context.dispose();
    }
    await expect(execution).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_shutting_down', retryable: false }
    });
    expect(order).toEqual([
      'reconciliation-started',
      'reconciliation-settled',
      'application-prepare',
      'application-stop',
      'agent-prepare',
      'agent-close',
      'application-close',
      'journal-close'
    ]);
  });

  it('owns producer freeze and store close ordering outside Transport', async () => {
    const order: string[] = [];
    const harness = await createHarness({ order, withAgentControl: true });
    order.length = 0;
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await harness.ingress.shutdown(context);
    } finally {
      context.dispose();
    }

    expect(order).toEqual([
      'application-prepare',
      'application-stop',
      'agent-prepare',
      'agent-close',
      'application-close',
      'journal-close'
    ]);
  });

  it('retains the command-journal owner fence when a business store close fails', async () => {
    const order: string[] = [];
    const harness = await createHarness({
      order,
      withAgentControl: true,
      failJournalClose: true,
      failAgentClose: true
    });
    order.length = 0;
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await expect(harness.ingress.shutdown(context)).rejects.toThrow(
        'runtime_shutdown_failed'
      );
    } finally {
      context.dispose();
    }

    expect(order).toEqual([
      'application-prepare',
      'application-stop',
      'agent-prepare',
      'agent-close',
      'application-close'
    ]);
  });

  it('attempts command-journal close only after every business store closes', async () => {
    const order: string[] = [];
    const harness = await createHarness({
      order,
      withAgentControl: true,
      failJournalClose: true
    });
    order.length = 0;
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await expect(harness.ingress.shutdown(context)).rejects.toThrow(
        'runtime_shutdown_failed'
      );
    } finally {
      context.dispose();
    }

    expect(order).toEqual([
      'application-prepare',
      'application-stop',
      'agent-prepare',
      'agent-close',
      'application-close',
      'journal-close'
    ]);
  });

  it('retains stores and owner fences when producer shutdown is unproven', async () => {
    const order: string[] = [];
    const harness = await createHarness({
      order,
      withAgentControl: true,
      failApplicationPrepare: true
    });
    order.length = 0;
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await expect(harness.ingress.shutdown(context)).rejects.toThrow(
        'runtime_shutdown_barrier_failed'
      );
    } finally {
      context.dispose();
    }

    expect(order).toEqual([
      'application-prepare',
      'application-stop',
      'agent-prepare'
    ]);
  });
});

interface HarnessOptions {
  readonly inferenceHealth?: {assertHealthy():void;hasExternalFailure?():boolean};
  readonly journalHealth?: { assertHealthy(): void };
  readonly execute?: (
    envelope: RuntimeCommandEnvelope
  ) => Promise<RuntimeApplicationCommandResult>;
  readonly onMarkUncertain?: () => void;
  readonly order?: string[];
  readonly withAgentControl?: boolean;
  readonly failJournalClose?: boolean;
  readonly failAgentClose?: boolean;
  readonly failApplicationPrepare?: boolean;
  readonly assertAgentHealthy?: () => void;
  readonly assertAgentCommandHealthy?: AgentControlRuntimeLifecycle['assertCommandHealthy'];
  readonly readAgentDomainHealth?: AgentControlRuntimeLifecycle['readDomainHealth'];
  readonly executeAgentOwned?: (
    envelope: RuntimeCommandEnvelope
  ) => Promise<RuntimeApplicationCommandResult | null>;
  readonly reconcileAgentOwned?: (
    envelope: RuntimeCommandEnvelope
  ) => Promise<RuntimeCommandReconciliation | null>;
}

async function createHarness(options: HarnessOptions = {}): Promise<{
  readonly ingress: ComposedRuntimeIngress;
  readonly journal: InMemoryRuntimeCommandJournal;
}> {
  const order = options.order ?? [];
  const journal = new InMemoryRuntimeCommandJournal({
    order,
    onMarkUncertain: options.onMarkUncertain,
    failClose: options.failJournalClose
  });
  const application = new FakeRuntimeApplication(
    order,
    options.execute ?? (async () => completed(successOutcome())),
    options.failApplicationPrepare ?? false
  );
  if(options.inferenceHealth!==undefined)Object.defineProperty(application,'inferenceHealth',{value:options.inferenceHealth});
  const applicationFactory: RuntimeApplicationFactory = {
    create: async () => {
      order.push('application-create');
      return application;
    }
  };
  const dependencies = {
    commandJournal: journal,
    ...(options.journalHealth === undefined ? {} : { journalHealth: options.journalHealth }),
    runtimeApplicationFactory: applicationFactory,
    preflightCommunicationContract: () => undefined,
      preflightMemoryControlShadows: () => { order.push('legacy-preflight'); },
    readBuildManifest: () => ({
      schemaVersion: 1 as const,
      runtimeVersion: '0.1.0',
      fingerprint
    }),
    ...(options.withAgentControl ? {
      agentControlFactory: agentFactory(
        order,
        options.failAgentClose,
        options.assertAgentHealthy,
        options.executeAgentOwned,
        options.reconcileAgentOwned,
        options.assertAgentCommandHealthy,
        options.readAgentDomainHealth
      )
    } : {})
  };
  const ingress = newIngress(dependencies, Boolean(options.failJournalClose || options.failAgentClose || options.failApplicationPrepare));
  await ingress.initialize({
    bootstrap: bootstrap(),
    hostCapabilities: {
      request: async () => ({})
    },
    emitEvent: () => undefined
  });
  return { ingress, journal };
}

class FakeRuntimeApplication implements RuntimeApplication {
  public readonly storageSchemas = { agentControl: 7, conversation: 4, productivity: 2 };
  public readonly publicEvents: RuntimePublicEventAppend[] = [];
  public readonly publicEventSink: RuntimePublicEventSink = {
    append: async (event) => { this.publicEvents.push(event); }
  };
  public readonly modelCatalog: RuntimeModelCatalogSource;

  public constructor(
    private readonly order: string[],
    private readonly onExecute: (
      envelope: RuntimeCommandEnvelope
    ) => Promise<RuntimeApplicationCommandResult>,
    private readonly failPrepare = false,
    models: readonly RuntimeModelCatalogEntry[] = []
  ) {
    const snapshot = Object.freeze(models.map((model) => Object.freeze({ ...model })));
    this.modelCatalog = Object.freeze({ snapshot: () => snapshot });
  }

  public async start(): Promise<void> { this.order.push('application-start'); }
  public execute(envelope: RuntimeCommandEnvelope): Promise<RuntimeApplicationCommandResult> {
    return this.onExecute(envelope);
  }
  public status() {
    return {
      availability: 'ready' as const,
      capabilities: [],
      observedAt: new Date().toISOString()
    };
  }
  public async prepareShutdown(): Promise<void> {
    this.order.push('application-prepare');
    if (this.failPrepare) throw new Error('application_prepare_failed');
  }
  public async stop(): Promise<void> { this.order.push('application-stop'); }
  public async shutdown(): Promise<void> { this.order.push('application-close'); }
  public async disposeInitialization(): Promise<void> {
    this.order.push('application-initialization-dispose');
  }
}

class InMemoryRuntimeCommandJournal implements RuntimeCommandJournal {
  public readonly schemaVersion = 17;
  private readonly records = new Map<string, {
    digest: string;
    status: RuntimeCommandJournalStatus;
    outcome?: RuntimeCommandOutcome;
  }>();

  public constructor(private readonly options: {
    readonly order: string[];
    readonly onMarkUncertain?: () => void;
    readonly failClose?: boolean;
  }) {}

  public open(): void { this.options.order.push('journal-open'); }

  public begin(commandId: string, digest: string): RuntimeCommandBeginResult {
    const record = this.records.get(commandId);
    if (!record) {
      this.records.set(commandId, { digest, status: 'executing' });
      return { kind: 'started' };
    }
    if (record.digest !== digest) return { kind: 'conflict' };
    if (record.status === 'completed' && record.outcome) {
      return { kind: 'replay', outcome: record.outcome };
    }
    return { kind: 'uncertain' };
  }

  public getStatus(commandId: string): RuntimeCommandJournalStatus | null {
    return this.records.get(commandId)?.status ?? null;
  }

  public complete(commandId: string, digest: string, outcome: RuntimeCommandOutcome): void {
    this.settle(commandId, digest, 'completed', outcome);
  }

  public markUncertain(
    commandId: string,
    digest: string,
    outcome: RuntimeCommandOutcome
  ): void {
    this.options.onMarkUncertain?.();
    this.settle(commandId, digest, 'uncertain', outcome);
  }

  public reconcileUncertain(
    commandId: string,
    digest: string,
    reconciliation: RuntimeCommandReconciliation
  ): RuntimeCommandBeginResult {
    const record = this.records.get(commandId);
    if (!record || record.digest !== digest) return { kind: 'conflict' };
    if (record.status === 'completed' && record.outcome) {
      return { kind: 'replay', outcome: record.outcome };
    }
    if (record.status !== 'uncertain') return { kind: 'uncertain' };
    if (reconciliation.kind === 'not_committed') {
      this.records.set(commandId, { digest, status: 'executing' });
      return { kind: 'started' };
    }
    this.records.set(commandId, {
      digest,
      status: 'completed',
      outcome: reconciliation.outcome
    });
    return { kind: 'replay', outcome: reconciliation.outcome };
  }

  public close(): void {
    this.options.order.push('journal-close');
    if (this.options.failClose) throw new Error('journal_close_failed');
  }

  private settle(
    commandId: string,
    digest: string,
    status: Extract<RuntimeCommandJournalStatus, 'completed' | 'uncertain'>,
    outcome: RuntimeCommandOutcome
  ): void {
    const record = this.records.get(commandId);
    if (!record || record.digest !== digest) throw new Error('journal_identity_mismatch');
    if (record.status === 'uncertain') return;
    this.records.set(commandId, { digest, status, outcome });
  }
}

function agentFactory(
  order: string[],
  failClose = false,
  assertHealthy: () => void = () => undefined,
  executeOwnedCommand: (
    envelope: RuntimeCommandEnvelope
  ) => Promise<RuntimeApplicationCommandResult | null> = async () => null,
  reconcileUncertainCommand: (
    envelope: RuntimeCommandEnvelope
  ) => Promise<RuntimeCommandReconciliation | null> = async () => null,
  assertCommandHealthy?: AgentControlRuntimeLifecycle['assertCommandHealthy'],
  readDomainHealth?: AgentControlRuntimeLifecycle['readDomainHealth']
): AgentControlRuntimeFactory {
  return {
    create: async () => {
      order.push('agent-open');
      const lifecycle = agentLifecycle(
        order,
        failClose,
        assertHealthy,
        executeOwnedCommand,
        reconcileUncertainCommand
      );
      if (assertCommandHealthy !== undefined) lifecycle.assertCommandHealthy = assertCommandHealthy;
      if (readDomainHealth !== undefined) lifecycle.readDomainHealth = readDomainHealth;
      return lifecycle;
    }
  };
}

function agentLifecycle(
  order: string[],
  failClose = false,
  assertHealthy: () => void = () => undefined,
  executeOwnedCommand: (
    envelope: RuntimeCommandEnvelope
  ) => Promise<RuntimeApplicationCommandResult | null> = async () => null,
  reconcileUncertainCommand: (
    envelope: RuntimeCommandEnvelope
  ) => Promise<RuntimeCommandReconciliation | null> = async () => null
): AgentControlRuntimeLifecycle {
  return {
    schemaVersion: 13,
    storageSchemas: { agentControl: 13, publicProjection: 1 },
    start: async () => { order.push('agent-start'); },
    assertHealthy,
    assertCommandHealthy: () => assertHealthy(),
    readDomainHealth: () => [],
    executeOwnedCommand,
    reconcileUncertainCommand,
    prepareShutdown: async () => { order.push('agent-prepare'); },
    shutdown: async () => {
      order.push('agent-close');
      if (failClose) throw new Error('agent_close_failed');
    }
  };
}

function envelope(commandId: string): RuntimeCommandEnvelope {
  return {
    commandId,
    correlationId: commandId,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    command: { kind: 'runtime.status.get' },
    signal: new AbortController().signal
  };
}

function completed(outcome: RuntimeResponse['outcome']): RuntimeApplicationCommandResult {
  return { outcome, settlement: 'completed' };
}

function uncertain(outcome: RuntimeResponse['outcome']): RuntimeApplicationCommandResult {
  return { outcome, settlement: 'uncertain' };
}

function successOutcome(): RuntimeResponse['outcome'] {
  return {
    ok: true,
    result: {
      kind: 'runtime.status',
      status: {
        availability: 'ready',
        capabilities: [],
        observedAt: '2026-07-31T12:00:00.000Z'
      }
    }
  };
}

function uncertainOutcome(correlationId: string): RuntimeResponse['outcome'] {
  return errorOutcome(correlationId, 'command_outcome_uncertain');
}

function errorOutcome(
  correlationId: string,
  code: string
): RuntimeResponse['outcome'] {
  return {
    ok: false,
    error: {
      code,
      message: code,
      retryable: false,
      correlationId
    }
  };
}

function bootstrap(): RuntimeBootstrap {
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: randomUUID(),
    type: 'bootstrap',
    appVersion: '0.1.0',
    runtimeVersion: '0.1.0',
    runtimeBuildFingerprint: fingerprint,
    installRoot: path.resolve('.'),
    // Failure-fence fixtures deliberately retain owners until process exit.
    dataRoot: path.resolve('artifacts', 'ingress-fixtures', `ingress-${randomUUID()}`),
    modelRoots: [],
    agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    profile: 'test',
    workspaces: [{
      workspaceId: 'primary',
      label: 'Project',
      rootPath: path.resolve('.'),
      access: 'write'
    }],
    production: false
  };
}

function disabledAdmissionAuthoritySource() {
  return {
    sourceVersion: 1 as const,
    status: 'disabled' as const,
    reason: 'not_configured' as const
  };
}
