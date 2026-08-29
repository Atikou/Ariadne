import {
  assertValidAgentRun,
  type AgentRun,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentSubagentExecutionProviderRouter,
  ImmutableAgentSubagentExecutionProviderCatalog,
  ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR,
  type AgentSubagentExecutionProvider
} from '../src/composition/AgentSubagentExecutionProviders.js';

const AT = '2026-08-28T00:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('SubAgent execution Provider seam', () => {
  it('freezes startup selection by provider identity and supported mode', () => {
    const catalog = new ImmutableAgentSubagentExecutionProviderCatalog([
      ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR,
      externalDescriptor()
    ]);

    const parentRun = delegatedInitialRun('external.codex');
    expect(catalog.select({
      requestedProviderId: undefined,
      mode: 'continuable',
      parentRun
    }))
      .toBe('ariadne.in_process');
    expect(catalog.select({
      requestedProviderId: 'external.codex',
      mode: 'one_shot',
      parentRun
    }))
      .toBe('external.codex');
    expect(catalog.select({
      requestedProviderId: 'external.codex',
      mode: 'continuable',
      parentRun
    }))
      .toBeNull();
    expect(catalog.list()).toHaveLength(2);
    expect(Object.isFrozen(catalog.list()[1]?.supportedModes)).toBe(true);
    expect(catalog.isRestorable(parentRun.binding)).toBe(true);
    expect(catalog.isRestorable({
      ...parentRun.binding,
      executionProfile: {
        ...parentRun.binding.executionProfile,
        subagentProviders: parentRun.binding.executionProfile.subagentProviders?.map(
          (provider) => provider.providerId === 'external.codex'
            ? { ...provider, configurationDigest: `sha256:${'e'.repeat(64)}` }
            : provider
        )
      }
    })).toBe(false);

    expect(() => new ImmutableAgentSubagentExecutionProviderCatalog([
      ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR,
      { ...externalDescriptor(), providerId: 'invalid provider id' }
    ])).toThrow(/descriptor is invalid/i);
    expect(() => new ImmutableAgentSubagentExecutionProviderCatalog([
      ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR,
      ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR
    ])).toThrow(/duplicate/i);
  });

  it('routes from durable Child identity and rejects a forged external receipt', async () => {
    const run = delegatedInitialRun('external.codex');
    const dispatchDelegatedInitial = vi.fn(async () => ({
      status: 'completed' as const,
      inferenceStatus: 'succeeded' as const,
      result: {
        status: 'succeeded',
        run: { runId: run.runId, version: 2 },
        turn: { turnId: run.turns[0]!.turnId },
        attempt: {
          attemptId: run.turns[0]!.attempts[0]!.attemptId,
          state: { status: 'succeeded' }
        }
      }
    }));
    const external: AgentSubagentExecutionProvider = {
      descriptor: externalDescriptor(),
      dispatchDelegatedInitial,
      dispatchFollowUp: vi.fn()
    };
    const router = new AgentSubagentExecutionProviderRouter(
      unitOfWorkFor(run),
      [external]
    );

    await expect(router.delegatedInitial.dispatchOwned({
      runId: run.runId,
      turnId: run.turns[0]!.turnId,
      attemptId: run.turns[0]!.attempts[0]!.attemptId,
      expectedVersion: run.version,
      occurredAt: AT
    }, new AbortController().signal)).rejects.toThrow(/matching durable Attempt/i);
    expect(dispatchDelegatedInitial).toHaveBeenCalledTimes(1);
  });

  it('fails closed before I/O when a durable provider is unavailable', async () => {
    const run = delegatedInitialRun('external.codex');
    const ordinary: AgentSubagentExecutionProvider = {
      descriptor: ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR,
      dispatchDelegatedInitial: vi.fn(),
      dispatchFollowUp: vi.fn()
    };
    const router = new AgentSubagentExecutionProviderRouter(
      unitOfWorkFor(run),
      [ordinary]
    );

    await expect(router.delegatedInitial.dispatchOwned({
      runId: run.runId,
      turnId: run.turns[0]!.turnId,
      attemptId: run.turns[0]!.attempts[0]!.attemptId,
      expectedVersion: run.version,
      occurredAt: AT
    }, new AbortController().signal)).rejects.toThrow(/provider is unavailable/i);
    expect(ordinary.dispatchDelegatedInitial).not.toHaveBeenCalled();
  });
});

function externalDescriptor() {
  return {
    providerId: 'external.codex',
    displayName: 'External Codex worker',
    configurationDigest: `sha256:${'f'.repeat(64)}`,
    transport: 'external_process' as const,
    supportedModes: ['one_shot'] as const,
    supportsStructuredReport: true,
    inheritsParentContext: false,
    usesParentTools: false
  };
}

function unitOfWorkFor(run: AgentRun): AgentRunUnitOfWork {
  return {
    transaction: async (operation: (transaction: {
      loadRun(runId: string): Promise<AgentRun | null>;
    }) => unknown) => operation({
      loadRun: async (runId: string) => runId === run.runId ? run : null
    })
  } as unknown as AgentRunUnitOfWork;
}

function delegatedInitialRun(providerId: string): AgentRun {
  const objectiveRef = {
    kind: 'parent_delegation' as const,
    parentRunId: 'run-parent-provider',
    delegationId: 'delegation-provider',
    objectiveDigest: DIGEST,
    providerId,
    mode: 'one_shot' as const
  };
  const binding: AgentRun['binding'] = {
    bindingVersion: 4,
    executionProfile: {
      mode: 'agent',
      subagentProviders: [
        ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR,
        externalDescriptor()
      ]
    },
    sessionId: 'session-provider',
    objectiveRef,
    workspace: {
      workspaceId: 'workspace-provider',
      revision: 1,
      grantDigest: DIGEST,
      access: 'read',
      scopeIds: ['workspace.root']
    },
    model: {
      providerId: 'model-provider',
      modelId: 'model-provider-v1',
      settingsRevision: 1
    },
    policy: {
      policyId: 'policy-provider',
      revision: 1,
      permissionMode: 'trusted'
    },
    capabilities: [],
    toolCatalog: {
      catalogId: 'catalog-provider',
      revision: 1,
      digest: DIGEST,
      allowedToolNames: []
    },
    budget: {
      grantId: 'grant-child-provider',
      runId: 'run-child-provider',
      vector: {
        modelTurns: 5,
        toolCalls: 0,
        readCalls: 0,
        writeCalls: 0,
        shellCalls: 0,
        costMicrousd: 100_000
      },
      deadlineAt: '2026-08-29T00:00:00.000Z',
      source: {
        kind: 'parent_allocation',
        parentRunId: objectiveRef.parentRunId,
        parentGrantId: 'grant-parent-provider',
        delegationId: objectiveRef.delegationId
      }
    }
  };
  const run: AgentRun = {
    runId: binding.budget.runId,
    version: 1,
    binding,
    state: { status: 'running', checkpointVersion: 1, enteredAt: AT },
    turns: [{
      turnId: 'turn-child-provider',
      runId: binding.budget.runId,
      intention: {
        expectedRunVersion: null,
        checkpointVersion: 1,
        cause: {
          kind: 'delegation_objective',
          parentRunId: objectiveRef.parentRunId,
          delegationId: objectiveRef.delegationId,
          objectiveDigest: objectiveRef.objectiveDigest
        },
        bindingVersion: binding.bindingVersion,
        executionProfile: binding.executionProfile,
        sessionId: binding.sessionId,
        objectiveRef: binding.objectiveRef,
        workspace: binding.workspace,
        model: binding.model,
        policy: binding.policy,
        capabilities: binding.capabilities,
        toolCatalog: binding.toolCatalog,
        budget: binding.budget,
        inputDigest: DIGEST,
        inputSummary: { messageCount: 1, toolCount: 0, contentCharacterCount: 24 }
      },
      attempts: [{
        attemptId: 'attempt-child-provider',
        turnId: 'turn-child-provider',
        runId: binding.budget.runId,
        providerIdempotencyKey: 'provider-child-provider',
        cause: { kind: 'initial' },
        state: { status: 'intended', intendedAt: AT }
      }],
      createdAt: AT
    }],
    effects: [],
    inbox: [],
    createdAt: AT,
    updatedAt: AT
  };
  assertValidAgentRun(run);
  return run;
}
