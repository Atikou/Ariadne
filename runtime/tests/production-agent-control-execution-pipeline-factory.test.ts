import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  AgentAdmissionAuthoritySource,
  RuntimeBootstrap
} from '@ariadne/protocol/host';
import { AgentPlanBudgetChildRunService } from '@ariadne/agent-core';
import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SqliteAgentRunUnitOfWork
} from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  SqliteConversationRunHandoffUnitOfWork
} from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import {
  SqlitePublicProjectionStore
} from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import {
  compileTrustedAgentToolCatalog,
  type TrustedAgentToolCatalogSnapshot
} from '../src/adapters/tool/TrustedAgentToolCatalogCompiler.js';
import {
  DefaultAgentControlRuntimeFactory
} from '../src/composition/DefaultAgentControlRuntimeFactory.js';
import {
  TestAgentEntityHandle as ComposedAgentControlRuntime
} from './support/TestAgentEntityHandle.js';
import {
  composeAgentPersistenceComponentHandle
} from '../src/composition/agent-entity/components/persistence/AgentPersistenceComponent.js';
import {
  AgentControlConversationMessageAdmissionError,
  ProductionAgentControlExecutionPipelineFactory,
  type AgentControlExecutionPipeline
} from '../src/composition/ProductionAgentControlExecutionPipelineFactory.js';
import { createConfiguredAgentLifecycleHookService } from '../src/composition/ProductionAgentLifecycleHookService.js';
import type {
  AgentToolContractDocumentV2,
  AgentToolExecutableImplementationV1
} from '../src/control/ports/AgentToolExecution.js';
import type { AgentProcessSandbox } from '../src/control/ports/AgentProcessSandbox.js';
import type { AgentInstructionAssemblyService } from '../src/control/ports/AgentInstructionAssembly.js';
import type { RuntimeCommandEnvelope } from '../src/ingress/RuntimeIngress.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots: string[] = [];
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const DEADLINE = '2099-01-01T00:00:00.000Z';
const PROVIDER_SECRET = 'pipeline-test-secret';
const RUNTIME_POLICY = createDefaultRuntimePolicySnapshot();

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ProductionAgentControlExecutionPipelineFactory', () => {
  it('represents disabled first-party authority as no execution pipeline', async () => {
    await withStores(async ({ unitOfWork, conversation }) => {
      const result = await factory([]).create({
        unitOfWork,
        conversation,
        agentAdmissionAuthoritySource: disabledSource(),
        modelProviders: []
      });

      expect(result).toBeNull();
    });
  });

  it('fails Runtime construction when enabled authority lacks its exact Catalog', async () => {
    const catalog = trustedCatalog();
    await withStores(async ({ unitOfWork, conversation }) => {
      await expect(factory([]).create({
        unitOfWork,
        conversation,
        agentAdmissionAuthoritySource: enabledSource(catalog),
        modelProviders: [provider()],
        runtimePolicy: RUNTIME_POLICY
      })).rejects.toMatchObject({
        code: 'AGENT_EXECUTION_TOOL_CATALOG_MISSING'
      });
    });
  });

  it('lets the default composition release every owner fence after pipeline construction fails', async () => {
    const root = createRoot();
    const catalog = trustedCatalog();
    const controlFactory = new DefaultAgentControlRuntimeFactory({}, factory([]));

    await expect(controlFactory.create({
      dataRoot: root,
      production: false,
      runtimeInstanceId: '00000000-0000-4000-8000-000000000041',
      agentAdmissionAuthoritySource: enabledSource(catalog),
      modelProviders: [provider()],
      runtimePolicy: RUNTIME_POLICY,
      hostCapabilities: {
        request: async () => { throw new Error('development_keyring_not_expected'); }
      }
    })).rejects.toMatchObject({ code: 'AGENT_EXECUTION_TOOL_CATALOG_MISSING' });

    const unitOfWork = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    const publicProjection = new SqlitePublicProjectionStore(root);
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await publicProjection.close(context);
      await conversation.close(context);
      await unitOfWork.close(context);
    } finally {
      context.dispose();
    }
  });

  it('gates expired, unbound, and unknown Workspace admission before any write', async () => {
    const catalog = trustedCatalog();
    await withStores(async ({ unitOfWork, conversation }) => {
      const expired = requirePipeline(await factory([catalog], {
        now: () => NOW,
        credentials: { EXACT_KEY: PROVIDER_SECRET }
      }).create({
        unitOfWork,
        conversation,
        agentAdmissionAuthoritySource: enabledSource(catalog, {
          deadlineAt: '2025-01-01T00:00:00.000Z'
        }),
        modelProviders: [provider()],
        runtimePolicy: RUNTIME_POLICY
      }));
      expectAdmissionFailure(
        () => expired.assertConversationMessageAdmission('workspace-v3'),
        'authority_expired'
      );

      const unbound = requirePipeline(await factory([catalog], {
        now: () => NOW,
        credentials: {}
      }).create({
        unitOfWork,
        conversation,
        agentAdmissionAuthoritySource: enabledSource(catalog),
        modelProviders: [provider()],
        runtimePolicy: RUNTIME_POLICY
      }));
      expectAdmissionFailure(
        () => unbound.assertConversationMessageAdmission('workspace-v3'),
        'model_binding_unavailable'
      );
      expectAdmissionFailure(
        () => unbound.assertConversationMessageAdmission('workspace-unknown'),
        'workspace_authority_missing'
      );
    });
  });

  it('rejects expired Workspace admission through Control before persisting a Message', async () => {
    const catalog = trustedCatalog();
    const harness = await createHarness(
      catalog,
      enabledSource(catalog, { deadlineAt: '2025-01-01T00:00:00.000Z' })
    );
    try {
      await harness.runtime.start();
      await createSession(harness.runtime);
      const result = await harness.runtime.executeOwnedCommand(
        messageEnvelope('message-expired')
      );

      expect(result).toMatchObject({
        settlement: 'completed',
        outcome: {
          ok: false,
          error: { code: 'agent_execution_unavailable', retryable: false }
        }
      });
      await expect(harness.conversation.authorityTransaction(
        (transaction) => transaction.loadMessageHead('message-expired')
      )).resolves.toBeNull();
      await expect(harness.conversation.countPendingHandoffOutbox()).resolves.toBe(0);
    } finally {
      await harness.runtime.shutdown(createShutdownContext(Date.now() + 5_000));
    }
  });

  it('runs accepted Conversation work through durable Handoff, exact Provider I/O, and settlement', async () => {
    const catalog = trustedCatalog();
    let admissionNow = NOW;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => providerResponse({
      protocol: 'ariadne.agent-directive.v3',
      directive: { kind: 'respond', content: 'completed by pure v3' }
    }));
    const harness = await createHarness(
      catalog,
      enabledSource(catalog),
      fetch,
      () => admissionNow
    );
    try {
      await harness.runtime.start();
      await createSession(harness.runtime);
      const acceptedEnvelope = messageEnvelope('message-e2e');
      const accepted = await harness.runtime.executeOwnedCommand(acceptedEnvelope);
      expect(accepted).toMatchObject({
        settlement: 'completed',
        outcome: {
          ok: true,
          result: { kind: 'conversation.message.accepted.v3' }
        }
      });
      const sagaId = requireAcceptedSagaId(accepted);
      await expect.poll(
        () => harness.conversation.countPendingHandoffOutbox(),
        { timeout: 2_000, interval: 5 }
      ).toBe(0);
      admissionNow = Date.parse('2100-01-01T00:00:00.000Z');
      await expect(harness.runtime.executeOwnedCommand(acceptedEnvelope))
        .resolves.toEqual(accepted);
      await harness.pipeline.executionScheduler.drainOnce();

      const saga = await harness.conversation.transaction(
        (transaction) => transaction.loadSaga(sagaId)
      );
      expect(saga?.stage.kind).toBe('agent_run_linked');
      if (saga?.stage.kind !== 'agent_run_linked') {
        throw new Error('pipeline_test_run_not_linked');
      }
      const run = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(saga.stage.runId)
      );
      expect(run).toMatchObject({
        runId: saga.stage.runId,
        state: { status: 'completed' },
        turns: [{ attempts: [{ state: { status: 'succeeded' } }] }]
      });
      await expect(harness.unitOfWork.listExecutionIntentRecovery({ limit: 10 }))
        .resolves.toEqual({ items: [] });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe('https://provider.example/v1/chat/completions');
      expect(new Headers(init?.headers).get('authorization'))
        .toBe(`Bearer ${PROVIDER_SECRET}`);
    } finally {
      await harness.runtime.shutdown(createShutdownContext(Date.now() + 5_000));
    }
  });

  it('closes the SubAgent loop through child execution, terminal observation, and parent continuation', async () => {
    const catalog = trustedCatalog();
    const responses = [
      {
        kind: 'delegate_subagent',
        subagent: {
          description: 'Inspect one bounded subsystem',
          prompt: 'Inspect the bounded subsystem and report the decisive evidence.',
          mode: 'one_shot'
        }
      },
      { kind: 'respond', content: 'child evidence' },
      { kind: 'respond', content: 'parent used child evidence' }
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const directive = responses.shift();
      if (directive === undefined) throw new Error('unexpected_subagent_provider_call');
      return providerResponse({
        protocol: 'ariadne.agent-directive.v3',
        directive
      });
    });
    const source = enabledSource(catalog);
    source.manifests[0]!.rootBudget.vector.modelTurns = 6;
    const harness = await createHarness(
      catalog,
      source,
      fetch
    );
    try {
      await harness.runtime.start();
      await createSession(harness.runtime);
      const accepted = await harness.runtime.executeOwnedCommand(
        messageEnvelope('message-subagent-e2e')
      );
      const sagaId = requireAcceptedSagaId(accepted);
      await expect.poll(
        () => harness.conversation.countPendingHandoffOutbox(),
        { timeout: 2_000, interval: 5 }
      ).toBe(0);
      const saga = await harness.conversation.transaction(
        (transaction) => transaction.loadSaga(sagaId)
      );
      if (saga?.stage.kind !== 'agent_run_linked') {
        throw new Error('pipeline_subagent_run_not_linked');
      }
      await harness.pipeline.executionScheduler.drainOnce();
      const parent = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(saga.stage.runId)
      );
      expect(parent?.state.status).toBe('waiting_children');
      const delegation = await harness.unitOfWork.transaction(async (transaction) => {
        const items = await transaction.listDelegationsByParent?.(saga.stage.runId);
        return items?.[0] ?? null;
      });
      if (parent === null || delegation === null) {
        throw new Error('pipeline_subagent_delegation_missing');
      }
      await harness.pipeline.runWorkScheduler.drainOnce();
      const child = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(delegation.childRunId)
      );
      expect(child?.state.status).toBe('completed');
      if (child === null || child.state.status !== 'completed') {
        throw new Error('pipeline_subagent_child_not_terminal');
      }
      await new AgentPlanBudgetChildRunService(harness.unitOfWork).observeChildTerminal({
        kind: 'control.children.observe_terminal',
        commandId: 'observe-subagent-child-e2e',
        runId: parent.runId,
        expectedVersion: parent.version,
        occurredAt: child.updatedAt,
        childRunId: child.runId,
        childRunVersion: child.version,
        childStatus: 'completed'
      });
      await harness.pipeline.runWorkScheduler.drainOnce();
      const completedParent = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(parent.runId)
      );
      expect(completedParent).toMatchObject({
        state: { status: 'completed' },
        turns: [
          { attempts: [{ state: { directive: { kind: 'delegate_subagent' } } }] },
          {
            intention: { cause: { kind: 'child_results' } },
            attempts: [{ state: { directive: { kind: 'respond' } } }]
          }
        ]
      });
      expect(fetch).toHaveBeenCalledTimes(3);
      const parentContinuation = JSON.stringify(requestBody(fetch.mock.calls[2]?.[1]));
      expect(parentContinuation).toContain('ariadne.subagent-results');
      expect(parentContinuation).toContain('child evidence');
    } finally {
      await harness.runtime.shutdown(createShutdownContext(Date.now() + 5_000));
    }
  });

  it('closes one atomic two-child delegation batch through one parent continuation', async () => {
    const catalog = trustedCatalog();
    const responses = [
      {
        kind: 'delegate_subagents',
        subagents: [
          {
            description: 'Inspect storage',
            prompt: 'Inspect storage ownership and report evidence.',
            mode: 'one_shot'
          },
          {
            description: 'Inspect runtime',
            prompt: 'Inspect runtime ownership and report evidence.',
            mode: 'one_shot'
          }
        ]
      },
      { kind: 'respond', content: 'storage evidence' },
      { kind: 'respond', content: 'runtime evidence' },
      { kind: 'respond', content: 'parent used both child reports' }
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const directive = responses.shift();
      if (directive === undefined) throw new Error('unexpected_batch_provider_call');
      return providerResponse({ protocol: 'ariadne.agent-directive.v3', directive });
    });
    const source = enabledSource(catalog);
    source.manifests[0]!.rootBudget.vector.modelTurns = 12;
    const harness = await createHarness(catalog, source, fetch);
    try {
      await harness.runtime.start();
      await createSession(harness.runtime);
      const accepted = await harness.runtime.executeOwnedCommand(
        messageEnvelope('message-subagent-batch-e2e')
      );
      const sagaId = requireAcceptedSagaId(accepted);
      await expect.poll(
        () => harness.conversation.countPendingHandoffOutbox(),
        { timeout: 2_000, interval: 5 }
      ).toBe(0);
      const saga = await harness.conversation.transaction(
        (transaction) => transaction.loadSaga(sagaId)
      );
      if (saga?.stage.kind !== 'agent_run_linked') {
        throw new Error('pipeline_subagent_batch_run_not_linked');
      }
      await expect(harness.pipeline.executionScheduler.drainOnce()).resolves.toBeDefined();
      const delegations = await harness.unitOfWork.transaction(async (transaction) =>
        transaction.listDelegationsByParent?.(saga.stage.runId) ?? []
      );
      expect(delegations).toHaveLength(2);
      await expect(harness.pipeline.runWorkScheduler.drainOnce()).resolves.toBeDefined();
      await expect(harness.pipeline.runWorkScheduler.drainOnce()).resolves.toBeDefined();
      const children = await harness.unitOfWork.transaction((transaction) => Promise.all(
        delegations.map((delegation) => transaction.loadRun(delegation.childRunId))
      ));
      expect(children.every((child) => child?.state.status === 'completed')).toBe(true);
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child === null || child.state.status !== 'completed') {
          throw new Error('pipeline_subagent_batch_child_not_terminal');
        }
        const parent = await harness.unitOfWork.transaction(
          (transaction) => transaction.loadRun(saga.stage.runId)
        );
        if (parent === null) throw new Error('pipeline_subagent_batch_parent_missing');
        await new AgentPlanBudgetChildRunService(harness.unitOfWork).observeChildTerminal({
          kind: 'control.children.observe_terminal',
          commandId: `observe-subagent-batch-child-${String(index + 1)}`,
          runId: parent.runId,
          expectedVersion: parent.version,
          occurredAt: child.updatedAt,
          childRunId: child.runId,
          childRunVersion: child.version,
          childStatus: 'completed'
        });
      }
      await expect(harness.pipeline.runWorkScheduler.drainOnce()).resolves.toBeDefined();
      const completedParent = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(saga.stage.runId)
      );
      expect(completedParent).toMatchObject({
        state: { status: 'completed' },
        turns: [
          { attempts: [{ state: { directive: { kind: 'delegate_subagents' } } }] },
          {
            intention: { cause: { kind: 'child_results' } },
            attempts: [{ state: { directive: { kind: 'respond' } } }]
          }
        ]
      });
      const continuation = JSON.stringify(requestBody(fetch.mock.calls[3]?.[1]));
      expect(continuation).toContain('storage evidence');
      expect(continuation).toContain('runtime evidence');
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      await harness.runtime.shutdown(createShutdownContext(Date.now() + 5_000));
    }
  });

  it('requires the shared process sandbox before publishing a configured ACP Provider', async () => {
    const catalog = trustedCatalog();
    await withStores(async ({ unitOfWork, conversation }) => {
      const input = {
        unitOfWork,
        conversation,
        agentAdmissionAuthoritySource: enabledSource(catalog),
        modelProviders: [provider()],
        runtimePolicy: RUNTIME_POLICY,
        subagentProviders: [acpProvider()],
        workspaces: [{
          workspaceId: 'workspace-v3',
          label: 'Workspace',
          rootPath: process.cwd(),
          access: 'write' as const
        }]
      };
      await expect(factory([catalog]).create(input)).rejects.toMatchObject({
        code: 'AGENT_EXECUTION_PIPELINE_OPTIONS_INVALID'
      });

      await expect(factory([catalog]).create({
        ...input,
        processSandboxForWorkspace: () => unavailableSandbox()
      })).resolves.toMatchObject({
        handoffProducer: expect.any(Object),
        runWorkScheduler: expect.any(Object)
      });
    });
  });

  it('keeps one continuable Child Run across inbox turns before explicit completion', async () => {
    const catalog = trustedCatalog();
    const responses = [
      {
        kind: 'delegate_subagent',
        subagent: {
          description: 'Investigate one subsystem across follow-up turns',
          prompt: 'Inspect the subsystem, report the first finding, then wait.',
          mode: 'continuable'
        }
      },
      { kind: 'respond', content: 'first child finding' },
      { kind: 'complete', outputRef: 'final-child-evidence' },
      { kind: 'respond', content: 'parent used final child evidence' }
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const directive = responses.shift();
      if (directive === undefined) throw new Error('unexpected_continuable_provider_call');
      return providerResponse({
        protocol: 'ariadne.agent-directive.v3',
        directive
      });
    });
    const source = enabledSource(catalog);
    source.manifests[0]!.rootBudget.vector.modelTurns = 8;
    const harness = await createHarness(catalog, source, fetch);
    try {
      await harness.runtime.start();
      await createSession(harness.runtime);
      const accepted = await harness.runtime.executeOwnedCommand(
        messageEnvelope('message-continuable-subagent-e2e')
      );
      const sagaId = requireAcceptedSagaId(accepted);
      await expect.poll(
        () => harness.conversation.countPendingHandoffOutbox(),
        { timeout: 2_000, interval: 5 }
      ).toBe(0);
      const saga = await harness.conversation.transaction(
        (transaction) => transaction.loadSaga(sagaId)
      );
      if (saga?.stage.kind !== 'agent_run_linked') {
        throw new Error('pipeline_continuable_parent_not_linked');
      }
      await harness.pipeline.executionScheduler.drainOnce();
      const parent = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(saga.stage.runId)
      );
      const delegation = await harness.unitOfWork.transaction(async (transaction) => {
        const items = await transaction.listDelegationsByParent?.(saga.stage.runId);
        return items?.[0] ?? null;
      });
      if (parent === null || delegation === null) {
        throw new Error('pipeline_continuable_delegation_missing');
      }

      await harness.pipeline.runWorkScheduler.drainOnce();
      const waitingChild = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(delegation.childRunId)
      );
      expect(waitingChild).toMatchObject({
        runId: delegation.childRunId,
        binding: {
          executionProfile: {
            subagentProviders: [{ providerId: 'ariadne.in_process' }]
          },
          objectiveRef: { kind: 'parent_delegation', mode: 'continuable' }
        },
        state: { status: 'waiting_input' },
        turns: [{ attempts: [{ state: { directive: { kind: 'respond' } } }] }]
      });
      if (waitingChild === null) throw new Error('pipeline_continuable_child_missing');

      await expect(harness.runtime.executeOwnedCommand(envelope({
        kind: 'agent.subagent.send.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        parentRunId: parent.runId,
        childRunId: waitingChild.runId,
        sessionId: waitingChild.binding.sessionId,
        inputId: 'continuable-follow-up-input',
        content: 'Use the first finding to finish and return final evidence.'
      }, 'send-continuable-follow-up'))).resolves.toMatchObject({
        outcome: {
          ok: true,
          result: {
            kind: 'agent.subagent.input.sent.v3',
            parentRunId: parent.runId,
            childRunId: waitingChild.runId
          }
        }
      });
      await harness.pipeline.runWorkScheduler.drainOnce();
      const completedChild = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(waitingChild.runId)
      );
      expect(completedChild).toMatchObject({
        state: {
          status: 'completed',
          outputRef: expect.stringMatching(/^directive-artifact:[0-9a-f]{64}$/u)
        },
        turns: [
          {},
          {
            intention: { cause: { kind: 'inbox_inputs' } },
            attempts: [{ state: { directive: { kind: 'complete' } } }]
          }
        ]
      });
      if (completedChild === null || completedChild.state.status !== 'completed') {
        throw new Error('pipeline_continuable_child_not_completed');
      }

      await new AgentPlanBudgetChildRunService(harness.unitOfWork).observeChildTerminal({
        kind: 'control.children.observe_terminal',
        commandId: 'observe-continuable-child-e2e',
        runId: parent.runId,
        expectedVersion: parent.version,
        occurredAt: completedChild.updatedAt,
        childRunId: completedChild.runId,
        childRunVersion: completedChild.version,
        childStatus: 'completed'
      });
      await harness.pipeline.runWorkScheduler.drainOnce();
      const completedParent = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(parent.runId)
      );
      expect(completedParent?.state.status).toBe('completed');
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      await harness.runtime.shutdown(createShutdownContext(Date.now() + 5_000));
    }
  });

  it('runs plan mode through one attenuated read-only binding before Provider I/O', async () => {
    const catalog = trustedPlanCatalog();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => providerResponse({
      protocol: 'ariadne.agent-directive.v3',
      directive: {
        kind: 'propose_plan',
        plan: {
          summary: 'Build a layered animated star field.',
          impactSummary: 'Approval permits the later workspace implementation.',
          steps: [{
            title: 'Implement the star field',
            summary: 'Create and verify the layered canvas animation.',
            impact: 'workspace_change'
          }]
        }
      }
    }));
    const harness = await createHarness(
      catalog,
      enabledPlanSource(catalog),
      fetch
    );
    try {
      await harness.runtime.start();
      await createSession(harness.runtime);
      const accepted = await harness.runtime.executeOwnedCommand(
        messageEnvelope('message-plan-e2e', 'plan')
      );
      const sagaId = requireAcceptedSagaId(accepted);
      await expect.poll(
        () => harness.conversation.countPendingHandoffOutbox(),
        { timeout: 2_000, interval: 5 }
      ).toBe(0);

      const saga = await harness.conversation.transaction(
        (transaction) => transaction.loadSaga(sagaId)
      );
      if (saga?.stage.kind !== 'agent_run_linked') {
        throw new Error('pipeline_plan_run_not_linked');
      }
      const admitted = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(saga.stage.runId)
      );
      expect(admitted?.binding).toMatchObject({
        workspace: { access: 'read' },
        capabilities: [{ capabilityId: 'workspace.read' }],
        toolCatalog: {
          allowedToolNames: ['workspace.list_files', 'workspace.read_file']
        },
        budget: { vector: { writeCalls: 0, shellCalls: 0 } }
      });

      await harness.pipeline.executionScheduler.drainOnce();
      expect(fetch).toHaveBeenCalledTimes(1);
      const body = JSON.stringify(requestBody(fetch.mock.calls[0]?.[1]));
      expect(body).toContain('Plan mode is read-only');
      expect(body).toContain('workspace.list_files');
      expect(body).toContain('workspace.read_file');
      expect(body).not.toContain('workspace.write_file');
      const waiting = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(saga.stage.runId)
      );
      expect(waiting).toMatchObject({
        binding: {
          bindingVersion: 4,
          executionProfile: { mode: 'plan' }
        },
        state: {
          status: 'waiting',
          reason: 'plan_approval',
          decision: { kind: 'plan' }
        }
      });
      if (
        waiting?.state.status !== 'waiting'
        || waiting.state.decision.kind !== 'plan'
      ) throw new Error('pipeline_plan_decision_missing');
      const decision = waiting.state.decision;
      await expect(harness.unitOfWork.transaction(async (transaction) => (
        transaction.loadPlanVersion?.({
          planId: decision.planId,
          version: decision.planVersion,
          contentHash: decision.planHash
        }) ?? null
      ))).resolves.toMatchObject({
        runId: waiting.runId,
        payload: {
          publicPresentation: {
            summary: 'Build a layered animated star field.'
          }
        }
      });
    } finally {
      await harness.runtime.shutdown(createShutdownContext(Date.now() + 5_000));
    }
  });

  it('terminalizes an unstartable plan as one assistant failure without calling Provider', async () => {
    const catalog = trustedPlanCatalog();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const source = enabledPlanSource(catalog);
    const manifest = source.manifests[0]!;
    manifest.capabilityGrant.capabilities = [
      { capabilityId: 'workspace.write', scopeIds: ['workspace.root'] }
    ];
    manifest.toolCatalog.allowedToolNames = ['workspace.write_file'];
    const harness = await createHarness(catalog, source, fetch);
    try {
      await harness.runtime.start();
      await createSession(harness.runtime);
      const accepted = await harness.runtime.executeOwnedCommand(
        messageEnvelope('message-plan-unstartable', 'plan')
      );
      const sagaId = requireAcceptedSagaId(accepted);
      await expect.poll(
        () => harness.conversation.countPendingHandoffOutbox(),
        { timeout: 2_000, interval: 5 }
      ).toBe(0);
      const saga = await harness.conversation.transaction(
        (transaction) => transaction.loadSaga(sagaId)
      );
      expect(saga).toMatchObject({
        version: 3,
        stage: {
          kind: 'agent_start_failed',
          failureCode: 'agent_admission_authority_missing'
        }
      });
      await expect(harness.conversation.authorityTransaction(
        (transaction) => transaction.loadSession('session-v3')
      )).resolves.toMatchObject({ version: 3 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await harness.runtime.shutdown(createShutdownContext(Date.now() + 5_000));
    }
  });

  it('runs one pure v3 Tool loop through durable Effect results and a causal follow-up Turn', async () => {
    let observedToolCallId = '';
    const execute = vi.fn<AgentToolExecutableImplementationV1['execute']>(
      async (input, context) => {
        expect(input).toEqual({ path: 'README.md' });
        expect(context.toolCallId).toMatch(/^native-[a-f0-9]{64}$/u);
        observedToolCallId = context.toolCallId;
        return {
          status: 'succeeded',
          result: { path: 'README.md', content: 'pure Ariadne v3' }
        };
      }
    );
    const catalog = trustedCatalog({ execute });
    let releaseFollowUp!: () => void;
    const followUpGate = new Promise<void>((resolve) => {
      releaseFollowUp = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const call = fetch.mock.calls.length;
      if (call === 1) {
        return providerResponse({
          protocol: 'ariadne.agent-directive.v3',
          directive: {
            kind: 'invoke_tools',
            invocations: [{
              toolCallId: 'workspace-read-call-v3',
              toolName: 'workspace.read',
              input: { path: 'README.md' },
              scope: []
            }]
          }
        }, init);
      }
      if (call !== 2) throw new Error('unexpected_provider_call');
      await followUpGate;
      return providerResponse({
        protocol: 'ariadne.agent-directive.v3',
        directive: { kind: 'respond', content: 'read completed by pure v3' }
      });
    });
    const harness = await createHarness(
      catalog,
      enabledSource(catalog, { permissionMode: 'trusted' }),
      fetch
    );
    try {
      await harness.runtime.start();
      await createSession(harness.runtime);
      const accepted = await harness.runtime.executeOwnedCommand(
        messageEnvelope('message-tool-loop-e2e')
      );
      const sagaId = requireAcceptedSagaId(accepted);
      await expect.poll(
        () => harness.conversation.countPendingHandoffOutbox(),
        { timeout: 2_000, interval: 5 }
      ).toBe(0);
      await harness.pipeline.executionScheduler.drainOnce();
      const workDrain = harness.pipeline.runWorkScheduler.drainOnce();

      await expect.poll(
        () => fetch.mock.calls.length,
        { timeout: 2_000, interval: 5 }
      ).toBe(2);

      const saga = await harness.conversation.transaction(
        (transaction) => transaction.loadSaga(sagaId)
      );
      if (saga?.stage.kind !== 'agent_run_linked') {
        throw new Error('pipeline_tool_loop_run_not_linked');
      }
      const active = await harness.unitOfWork.listActiveRuns({ limit: 10 });
      const recovery = active.items.find(
        (candidate) => candidate.run.runId === saga.stage.runId
      );
      if (recovery?.ready !== true || recovery.phase !== 'resumable') {
        throw new Error('pipeline_tool_loop_result_not_recoverable');
      }
      const effect = recovery.run.effects[0];
      if (effect === undefined) throw new Error('pipeline_tool_loop_effect_missing');
      const resultReference = recovery.effectPayloads.find(
        (reference) => reference.effectId === effect.effectId
      );
      if (resultReference?.hasResult !== true) {
        throw new Error('pipeline_tool_loop_durable_result_missing');
      }
      await expect(harness.unitOfWork.loadEffectResult(resultReference)).resolves.toEqual({
        path: 'README.md',
        content: 'pure Ariadne v3'
      });

      const secondRequest = requestBody(fetch.mock.calls[1]?.[1]);
      const messages = requireProviderMessages(secondRequest);
      const assistantTransport = messages.at(-2);
      const resultTransport = messages.at(-1);
      expect(assistantTransport?.role).toBe('assistant');
      expect(resultTransport?.role).toBe('tool');
      expect(assistantTransport?.content).toBeNull();
      expect(assistantTransport?.tool_calls).toEqual([{
        id: expect.stringMatching(/^history_[a-f0-9]{40}$/u),
        type: 'function',
        function: {
          name: expect.stringMatching(/^ariadne_[a-f0-9]{32}$/u),
          arguments: expect.any(String)
        }
      }]);
      const nativeCall = assistantTransport?.tool_calls?.[0];
      if (nativeCall === undefined) throw new Error('provider_native_tool_call_missing');
      expect(JSON.parse(nativeCall.function.arguments)).toEqual({
        input: { path: 'README.md' },
        scope: []
      });
      expect(resultTransport?.tool_call_id).toBe(nativeCall.id);
      expect(JSON.parse(String(resultTransport?.content))).toEqual({
        status: 'succeeded',
        output: { path: 'README.md', content: 'pure Ariadne v3' }
      });
      expect(JSON.stringify(messages)).not.toContain(effect.effectId);

      releaseFollowUp();
      await expect(workDrain).resolves.toMatchObject({
        dispatchedEffects: 1,
        continuedBatches: 1,
        dispatchedFollowUps: 1
      });
      const completed = await harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(saga.stage.runId)
      );
      expect(completed).toMatchObject({
        state: { status: 'completed' },
        effects: [{
          effectId: effect.effectId,
          toolCallId: observedToolCallId,
          state: { status: 'succeeded' }
        }]
      });
      expect(completed?.turns).toHaveLength(2);
      expect(completed?.turns[0]?.attempts[0]?.state).toMatchObject({
        status: 'succeeded',
        directive: { kind: 'invoke_tools' }
      });
      expect(completed?.turns[1]).toMatchObject({
        intention: {
          cause: {
            kind: 'effect_results',
            effectIds: [effect.effectId],
            toolCallIds: [observedToolCallId]
          }
        },
        attempts: [{
          state: {
            status: 'succeeded',
            directive: {
              kind: 'respond'
            }
          }
        }]
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      releaseFollowUp();
      await harness.runtime.shutdown(createShutdownContext(Date.now() + 5_000));
    }
  });

  it('durably retires an active Run when its exact Catalog is unavailable after upgrade', async () => {
    const execute = vi.fn<AgentToolExecutableImplementationV1['execute']>(
      async () => ({ status: 'succeeded', result: { mustNotRun: true } })
    );
    const originalCatalog = trustedCatalog({ execute });
    const initialFetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => providerResponse({
      protocol: 'ariadne.agent-directive.v3',
      directive: {
        kind: 'invoke_tools',
        invocations: [{
          toolCallId: 'startup-drift-call-v3',
          toolName: 'workspace.read',
          input: { path: 'README.md' },
          scope: []
        }]
      }
    }, init));
    const harness = await createHarness(
      originalCatalog,
      enabledSource(originalCatalog, { permissionMode: 'trusted' }),
      initialFetch
    );
    vi.spyOn(harness.pipeline.runWorkScheduler, 'wake')
      .mockImplementation(() => undefined);
    let retiredRunId = '';
    try {
      await harness.runtime.start();
      await createSession(harness.runtime);
      const accepted = await harness.runtime.executeOwnedCommand(
        messageEnvelope('message-startup-authority-drift')
      );
      const sagaId = requireAcceptedSagaId(accepted);
      await expect.poll(
        () => harness.conversation.countPendingHandoffOutbox(),
        { timeout: 2_000, interval: 5 }
      ).toBe(0);
      await harness.pipeline.executionScheduler.drainOnce();
      const saga = await harness.conversation.transaction(
        (transaction) => transaction.loadSaga(sagaId)
      );
      if (saga?.stage.kind !== 'agent_run_linked') {
        throw new Error('pipeline_startup_drift_run_not_linked');
      }
      retiredRunId = saga.stage.runId;
      await expect(harness.unitOfWork.transaction(
        (transaction) => transaction.loadRun(saga.stage.runId)
      )).resolves.toMatchObject({
        state: { status: 'running' },
        effects: [{ state: { status: 'authorized' } }]
      });
      expect(initialFetch).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await harness.runtime.shutdown(createShutdownContext(Date.now() + 5_000));
    }

    const replacementExecute = vi.fn<AgentToolExecutableImplementationV1['execute']>(
      async () => ({ status: 'succeeded', result: { mustNotRun: true } })
    );
    const replacementCatalog = trustedCatalog({
      catalogId: 'catalog-v3-replacement',
      revision: 4,
      execute: replacementExecute
    });
    const restartFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('startup_authority_drift_crossed_provider_boundary');
    });
    const unitOfWork = new SqliteAgentRunUnitOfWork(harness.dataRoot);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(harness.dataRoot);
    const pipeline = requirePipeline(await factory([replacementCatalog], {
      fetch: restartFetch
    }).create({
      unitOfWork,
      conversation,
      agentAdmissionAuthoritySource: enabledSource(replacementCatalog, {
        permissionMode: 'trusted'
      }),
      modelProviders: [provider()],
      runtimePolicy: RUNTIME_POLICY
    }));
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await expect(pipeline.runWorkScheduler.start()).resolves.toBeUndefined();
      pipeline.runWorkScheduler.assertHealthy();
      await expect(unitOfWork.transaction(
        (transaction) => transaction.loadRun(retiredRunId)
      )).resolves.toMatchObject({
        state: {
          status: 'failed',
          errorCode: 'agent_tool_catalog_retired',
          message: expect.stringContaining('immutable Tool Catalog')
        }
      });
      expect(restartFetch).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(replacementExecute).not.toHaveBeenCalled();
    } finally {
      await pipeline.runWorkScheduler.shutdown(
        new Date(context.deadlineAt).toISOString()
      );
      await conversation.close(context);
      await unitOfWork.close(context);
      context.dispose();
    }
  });
});

interface StoreFixture {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
}

async function withStores(
  operation: (fixture: StoreFixture) => Promise<void>
): Promise<void> {
  const root = createRoot();
  const unitOfWork = new SqliteAgentRunUnitOfWork(root);
  const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await operation({ unitOfWork, conversation });
  } finally {
    await conversation.close(context);
    await unitOfWork.close(context);
    context.dispose();
  }
}

function factory(
  catalogs: readonly TrustedAgentToolCatalogSnapshot[],
  options: {
    readonly now?: () => number;
    readonly credentials?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: typeof globalThis.fetch;
  } = {}
): ProductionAgentControlExecutionPipelineFactory {
  return new ProductionAgentControlExecutionPipelineFactory({
    toolCatalogSnapshots: catalogs,
    credentialEnvironment: options.credentials ?? { EXACT_KEY: PROVIDER_SECRET },
    instructionAssembly: testInstructionAssembly(),
    lifecycleHooks: createConfiguredAgentLifecycleHookService([]),
    recoveryReporter: {
      reportExecutionIntentRecovery: vi.fn(async () => undefined)
    },
    now: options.now ?? (() => NOW),
    handoffProducer: { drainIntervalMs: 60_000 },
    executionScheduler: { intervalMs: 60_000 },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
}

function testInstructionAssembly(): AgentInstructionAssemblyService {
  return {
    assemble: async (request) => {
      const content = request.executionMode === 'plan'
        ? 'Plan mode is read-only. Inspect with read-only tools when needed, then respond with a concrete implementation plan. Do not request or invoke write or shell tools.'
        : request.executionMode === 'chat'
          ? 'You are the local personal assistant. You may inspect and open computer resources only through the advertised read-only tools. Never modify, delete, move, create, or execute files or commands.'
          : '';
      return {
        snapshotVersion: 1,
        complete: true,
        subject: { ...request },
        blocks: content.length === 0 ? [] : [{
          blockId: request.executionMode,
          contributorId: 'test.mode-policy',
          contributorVersion: '1.0.0',
          order: 300_000,
          scope: { kind: 'mode', mode: request.executionMode },
          revision: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
          content
        }]
      };
    }
  };
}

async function createHarness(
  catalog: TrustedAgentToolCatalogSnapshot,
  source: AgentAdmissionAuthoritySource,
  fetch?: typeof globalThis.fetch,
  now: () => number = () => NOW
): Promise<{
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly pipeline: AgentControlExecutionPipeline;
  readonly runtime: ComposedAgentControlRuntime;
  readonly dataRoot: string;
}> {
  const root = createRoot();
  const unitOfWork = new SqliteAgentRunUnitOfWork(root);
  const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
  const publicProjection = new SqlitePublicProjectionStore(root);
  const pipeline = requirePipeline(await factory([catalog], {
    now,
    ...(fetch === undefined ? {} : { fetch })
  }).create({
    unitOfWork,
    conversation,
    agentAdmissionAuthoritySource: source,
    modelProviders: [provider()],
    runtimePolicy: RUNTIME_POLICY
  }));
  const runtime = new ComposedAgentControlRuntime(
    composeAgentPersistenceComponentHandle({
      dataRoot: root,
      unitOfWork,
      conversation,
      publicProjection
    }),
    {
      publishIntervalMs: 60_000,
      conversationCommandNow: () => new Date('2025-01-01T00:00:00.000Z')
    },
    pipeline
  );
  return { unitOfWork, conversation, pipeline, runtime, dataRoot: root };
}

async function createSession(runtime: ComposedAgentControlRuntime): Promise<void> {
  await expect(runtime.executeOwnedCommand(envelope({
    kind: 'conversation.session.create.v3',
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    sessionId: 'session-v3',
    workspaceId: 'workspace-v3'
  }, 'create-session'))).resolves.toMatchObject({ outcome: { ok: true } });
}

function messageEnvelope(
  messageId: string,
  mode: 'agent' | 'plan' = 'agent'
): RuntimeCommandEnvelope {
  return envelope({
    kind: 'conversation.message.accept.v3',
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    sessionId: 'session-v3',
    workspaceId: 'workspace-v3',
    expectedSessionVersion: 1,
    messageId,
    content: 'Execute the exact pure Ariadne v3 objective.',
    execution: { mode }
  }, `accept-${messageId}`);
}

function envelope(
  command: RuntimeCommandEnvelope['command'],
  commandId: string
): RuntimeCommandEnvelope {
  return {
    commandId,
    correlationId: commandId,
    deadlineAt: DEADLINE,
    signal: new AbortController().signal,
    command
  };
}

function requireAcceptedSagaId(
  result: Awaited<ReturnType<ComposedAgentControlRuntime['executeOwnedCommand']>>
): string {
  if (
    result?.outcome.ok !== true
    || result.outcome.result.kind !== 'conversation.message.accepted.v3'
  ) {
    throw new Error('pipeline_test_message_not_accepted');
  }
  return result.outcome.result.sagaId;
}

function expectAdmissionFailure(
  operation: () => void,
  reason: AgentControlConversationMessageAdmissionError['reason']
): void {
  try {
    operation();
    throw new Error('expected_admission_failure');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentControlConversationMessageAdmissionError);
    expect(error).toMatchObject({ reason });
  }
}

function requirePipeline(
  value: AgentControlExecutionPipeline | null
): AgentControlExecutionPipeline {
  if (value === null) throw new Error('pipeline_test_pipeline_missing');
  return value;
}

function enabledSource(
  catalog: TrustedAgentToolCatalogSnapshot,
  options: {
    readonly deadlineAt?: string;
    readonly permissionMode?: 'ask' | 'trusted';
  } = {}
): Extract<AgentAdmissionAuthoritySource, { readonly status: 'enabled' }> {
  return {
    sourceVersion: 1,
    status: 'enabled',
    manifests: [{
      manifestVersion: 1,
      manifestId: 'manifest-v3',
      revision: 1,
      workspace: {
        workspaceId: 'workspace-v3',
        revision: 1,
        grantDigest: `sha256:${'a'.repeat(64)}`,
        access: 'read',
        scopeIds: ['workspace.root']
      },
      model: {
        providerId: 'provider-v3',
        modelId: 'model-v3',
        settingsRevision: 7
      },
      policy: {
        policyId: 'policy-v3',
        revision: 1,
        permissionMode: options.permissionMode ?? 'ask'
      },
      capabilityGrant: {
        grantId: 'capability-grant-v3',
        revision: 1,
        capabilities: [{
          capabilityId: 'workspace.read',
          scopeIds: ['workspace.root']
        }]
      },
      toolCatalog: {
        catalogId: catalog.catalogId,
        revision: catalog.revision,
        digest: catalog.catalogDigest,
        allowedToolNames: ['workspace.read']
      },
      rootBudget: {
        authorityId: 'budget-authority-v3',
        revision: 1,
        vector: {
          modelTurns: 2,
          toolCalls: 1,
          readCalls: 1,
          writeCalls: 0,
          shellCalls: 0,
          costMicrousd: 1_000
        },
        deadlinePolicy: {
          kind: 'absolute',
          deadlineAt: options.deadlineAt ?? DEADLINE
        }
      }
    }]
  };
}

function enabledPlanSource(
  catalog: TrustedAgentToolCatalogSnapshot
): Extract<AgentAdmissionAuthoritySource, { readonly status: 'enabled' }> {
  const source = enabledSource(catalog);
  const manifest = source.manifests[0]!;
  manifest.workspace.access = 'write';
  manifest.capabilityGrant.capabilities = [
    { capabilityId: 'workspace.read', scopeIds: ['workspace.root'] },
    { capabilityId: 'workspace.write', scopeIds: ['workspace.root'] }
  ];
  manifest.toolCatalog.allowedToolNames = [
    'workspace.list_files',
    'workspace.read_file',
    'workspace.write_file'
  ];
  manifest.rootBudget.vector = {
    modelTurns: 2,
    toolCalls: 3,
    readCalls: 2,
    writeCalls: 1,
    shellCalls: 0,
    costMicrousd: 1_000
  };
  return source;
}

function disabledSource(): Extract<
AgentAdmissionAuthoritySource,
{ readonly status: 'disabled' }
> {
  return {
    sourceVersion: 1,
    status: 'disabled',
    reason: 'not_configured'
  };
}

function provider(): NonNullable<RuntimeBootstrap['modelProviders']>[number] {
  return {
    providerId: 'provider-v3',
    name: 'provider-v3',
    protocol: 'openai-compatible',
    credentialEnvironmentVariable: 'EXACT_KEY',
    enabled: true,
    baseUrl: 'https://provider.example/v1',
    model: 'model-v3',
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    inference: {}
  };
}

function trustedCatalog(options: {
  readonly catalogId?: string;
  readonly revision?: number;
  readonly execute?: AgentToolExecutableImplementationV1['execute'];
} = {}): TrustedAgentToolCatalogSnapshot {
  const artifacts = artifactBytes();
  const document: AgentToolContractDocumentV2 = {
    documentVersion: 2,
    toolName: 'workspace.read',
    toolVersion: '1.0.0',
    providerId: 'ariadne.builtin',
    model: {
      description: 'Read one approved Workspace resource.',
      guidance: ['Use only the exact approved scope.']
    },
    presentation: {
      kind: 'file_read',
      label: '读取工作区资源',
      resultVisibility: 'protected'
    },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    capabilityIds: ['workspace.read'],
    requiredWorkspaceAccess: 'read',
    permission: { authority: 'run_grant', approval: 'never' },
    scopeSemantics: 'none',
    resourceSemantics: 'none',
    lifecycleSemantics: 'bounded_invocation',
    sideEffect: 'read',
    idempotency: 'idempotency_key_required',
    recovery: 'retry_same_idempotency_key',
    timeoutMs: 30_000,
    implementationArtifacts: {
      providerDigest: digest(artifacts.provider),
      normalizerDigest: digest(artifacts.normalizer),
      preparedValidatorDigest: digest(artifacts.preparedValidator),
      executeDigest: digest(artifacts.execute)
    }
  };
  const executable: AgentToolExecutableImplementationV1 = {
    artifacts,
    normalizeAndValidate: (input) => ({ status: 'accepted', input }),
    validatePrepared: (input) => ({ status: 'accepted', input }),
    execute: options.execute
      ?? (async () => ({ status: 'succeeded', result: { ok: true } }))
  };
  return compileTrustedAgentToolCatalog({
    catalogId: options.catalogId ?? 'catalog-v3',
    revision: options.revision ?? 3,
    tools: [{ document, executable }]
  });
}

function trustedPlanCatalog(): TrustedAgentToolCatalogSnapshot {
  const artifacts = artifactBytes();
  const executable: AgentToolExecutableImplementationV1 = {
    artifacts,
    normalizeAndValidate: (input) => ({ status: 'accepted', input }),
    validatePrepared: (input) => ({ status: 'accepted', input }),
    execute: async () => ({ status: 'succeeded', result: { ok: true } })
  };
  const tool = (
    toolName: string,
    capabilityId: string,
    access: 'read' | 'write',
    sideEffect: 'read' | 'write'
  ): { document: AgentToolContractDocumentV2; executable: AgentToolExecutableImplementationV1 } => ({
    document: {
      documentVersion: 2,
      toolName,
      toolVersion: '1.0.0',
      providerId: 'ariadne.builtin',
      model: {
        description: `Use the approved ${toolName} Tool.`,
        guidance: ['Use only the exact approved scope.']
      },
      presentation: {
        kind: sideEffect === 'read' ? 'file_read' : 'file_change',
        label: toolName,
        resultVisibility: 'protected'
      },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      capabilityIds: [capabilityId],
      requiredWorkspaceAccess: access,
      permission: {
        authority: 'run_grant',
        approval: access === 'write' ? 'required' : 'never'
      },
      scopeSemantics: 'none',
      resourceSemantics: 'none',
      lifecycleSemantics: 'bounded_invocation',
      sideEffect,
      idempotency: 'idempotency_key_required',
      recovery: 'retry_same_idempotency_key',
      timeoutMs: 30_000,
      implementationArtifacts: {
        providerDigest: digest(artifacts.provider),
        normalizerDigest: digest(artifacts.normalizer),
        preparedValidatorDigest: digest(artifacts.preparedValidator),
        executeDigest: digest(artifacts.execute)
      }
    },
    executable
  });
  return compileTrustedAgentToolCatalog({
    catalogId: 'catalog-plan-v3',
    revision: 4,
    tools: [
      tool('workspace.list_files', 'workspace.read', 'read', 'read'),
      tool('workspace.read_file', 'workspace.read', 'read', 'read'),
      tool('workspace.write_file', 'workspace.write', 'write', 'write')
    ]
  });
}

function providerResponse(content: unknown, init?: RequestInit): Response {
  const directive = record(record(content)?.directive);
  const kind = typeof directive?.kind === 'string' ? directive.kind : null;
  if (kind === 'respond' && typeof directive?.content === 'string') {
    return providerStream({ content: directive.content }, 'stop');
  }
  if (kind === 'invoke_tools' && Array.isArray(directive.invocations)) {
    const body = record(requestBody(init));
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const businessTool = tools.map(record).find((tool) => {
      const fn = record(tool?.function);
      return typeof fn?.name === 'string' && !fn.name.startsWith('ariadne_control_');
    });
    const functionName = record(businessTool?.function)?.name;
    if (typeof functionName !== 'string') throw new Error('provider_business_tool_missing');
    const calls = directive.invocations.map((value, index) => {
      const invocation = record(value);
      if (
        typeof invocation?.toolCallId !== 'string'
        || invocation.input === undefined
        || !Array.isArray(invocation.scope)
      ) throw new Error('provider_invocation_invalid');
      return {
        index,
        id: invocation.toolCallId,
        type: 'function',
        function: {
          name: functionName,
          arguments: JSON.stringify({ input: invocation.input, scope: invocation.scope })
        }
      };
    });
    return providerStream({ tool_calls: calls }, 'tool_calls');
  }
  if (kind !== null && [
    'ask_user',
    'propose_plan',
    'checkpoint',
    'complete',
    'fail',
    'delegate_subagent',
    'delegate_subagents'
  ].includes(kind)) {
    const { kind: _kind, ...input } = directive!;
    return providerStream({
      tool_calls: [{
        index: 0,
        id: `native-control-${kind}`,
        type: 'function',
        function: {
          name: `ariadne_control_${kind}`,
          arguments: JSON.stringify(input)
        }
      }]
    }, 'tool_calls');
  }
  return providerStream({ content: JSON.stringify(content) }, 'stop');
}

function providerStream(
  delta: Record<string, unknown>,
  finishReason: 'stop' | 'tool_calls'
): Response {
  return new Response([
    `data: ${JSON.stringify({
      model: 'model-v3',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason
      }]
    })}\n\n`,
    'data: [DONE]\n\n'
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function acpProvider(): NonNullable<RuntimeBootstrap['subagentProviders']>[number] {
  return {
    kind: 'acp_stdio',
    providerId: 'external.acp',
    displayName: 'External ACP',
    command: process.execPath,
    args: [],
    permissionPolicy: 'reject',
    networkAccess: 'offline',
    timeoutMs: 60_000,
    disposeGraceMs: 2_000
  };
}

function unavailableSandbox(): AgentProcessSandbox {
  return {
    mode: 'read-only',
    runFile: async () => { throw new Error('sandbox_not_expected'); },
    openFileLease: () => { throw new Error('sandbox_not_expected'); }
  };
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('provider_request_body_missing');
  return JSON.parse(init.body);
}

function requireProviderMessages(
  value: unknown
): readonly {
  readonly role: string;
  readonly content: unknown;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
}[] {
  if (typeof value !== 'object' || value === null || !('messages' in value)) {
    throw new Error('provider_request_messages_missing');
  }
  const messages = (value as { readonly messages?: unknown }).messages;
  if (!Array.isArray(messages)) throw new Error('provider_request_messages_invalid');
  return messages as ReturnType<typeof requireProviderMessages>;
}

function artifactBytes(): AgentToolExecutableImplementationV1['artifacts'] {
  const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
  return {
    provider: bytes('pipeline-provider-v1'),
    normalizer: bytes('pipeline-normalizer-v1'),
    preparedValidator: bytes('pipeline-prepared-validator-v1'),
    execute: bytes('pipeline-execute-v1')
  };
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-production-pipeline-'));
  roots.push(root);
  return root;
}
