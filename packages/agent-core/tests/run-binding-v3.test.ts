import { describe, expect, it } from 'vitest';
import {
  AgentRunCommandService,
  assertAgentChildRunBindingSubset,
  assertValidAgentRunBinding,
  type AgentRunBinding
} from '../src/index.js';
import {
  bindingForRun,
  startCommand
} from './fixtures.js';
import { InMemoryAgentRunUnitOfWork } from './support/in-memory-unit-of-work.js';

describe('AgentRunBinding v3', () => {
  it('requires the exact versioned objective, workspace, capability, catalog, policy, and Budget shape', () => {
    const valid = bindingForRun('run-binding-v3');
    expect(() => assertValidAgentRunBinding(valid)).not.toThrow();

    const { bindingVersion: _removed, ...oldBinding } = valid;
    expect(() => assertValidAgentRunBinding(oldBinding as AgentRunBinding))
      .toThrow(/bindingVersion/);
    expect(() => assertValidAgentRunBinding({
      ...valid,
      policy: { ...valid.policy, maxTurns: 20 }
    } as AgentRunBinding)).toThrow(/maxTurns/);
    expect(() => assertValidAgentRunBinding({
      ...valid,
      objectiveRef: {
        ...valid.objectiveRef,
        contentDigest: 'not-a-digest'
      }
    } as AgentRunBinding)).toThrow(/SHA-256/);
    expect(() => assertValidAgentRunBinding({
      ...valid,
      budget: { ...valid.budget, deadlineAt: '2026-08-01T00:00:00Z' }
    })).toThrow(/timestamp/i);
  });

  it('uses stable Unicode code-unit order and rejects duplicates or reordering in every Binding grant array', () => {
    const valid = bindingForRun('run-binding-order');
    expect(() => assertValidAgentRunBinding({
      ...valid,
      toolCatalog: {
        ...valid.toolCatalog,
        allowedToolNames: ['Z', 'a']
      }
    })).not.toThrow();

    const invalid: AgentRunBinding[] = [
      {
        ...valid,
        workspace: { ...valid.workspace, scopeIds: ['workspace', 'scope'] }
      },
      {
        ...valid,
        workspace: { ...valid.workspace, scopeIds: ['workspace', 'workspace'] }
      },
      {
        ...valid,
        capabilities: [...valid.capabilities].reverse()
      },
      {
        ...valid,
        capabilities: [{
          capabilityId: 'workspace.read',
          scopeIds: ['workspace', 'scope']
        }]
      },
      {
        ...valid,
        toolCatalog: {
          ...valid.toolCatalog,
          allowedToolNames: ['a', 'Z']
        }
      },
      {
        ...valid,
        toolCatalog: {
          ...valid.toolCatalog,
          allowedToolNames: ['workspace.read', 'workspace.read']
        }
      }
    ];
    for (const candidate of invalid) {
      expect(() => assertValidAgentRunBinding(candidate)).toThrow(/sorted/);
    }
  });

  it('binds the Budget grant to its containing Run and rejects a self-parent objective', async () => {
    const wrongBudget = startCommand('start-wrong-budget', 'run-budget-owner');
    const unit = new InMemoryAgentRunUnitOfWork();
    await expect(new AgentRunCommandService(unit).execute({
      ...wrongBudget,
      binding: {
        ...wrongBudget.binding,
        budget: { ...wrongBudget.binding.budget, runId: 'different-run' }
      }
    })).rejects.toThrow(/budget\.runId/);

    const selfParent = startCommand('start-self-parent', 'run-self-parent');
    await expect(new AgentRunCommandService(new InMemoryAgentRunUnitOfWork()).execute({
      ...selfParent,
      binding: {
        ...selfParent.binding,
        objectiveRef: {
          kind: 'parent_delegation',
          parentRunId: selfParent.runId,
          delegationId: 'delegation-self',
          objectiveDigest: `sha256:${'f'.repeat(64)}`,
          mode: 'one_shot',
          providerId: 'ariadne.in_process'
        }
      }
    })).rejects.toThrow(/cannot be its own parent/);
  });

  it('accepts a canonical non-expanding child allocation', () => {
    const parent = parentBinding();
    const child = childBinding(parent);
    expect(() => assertAgentChildRunBindingSubset(
      parent.budget.runId,
      parent,
      child
    )).not.toThrow();
  });

  it('rejects every child expansion or parent/delegation mismatch', () => {
    const parent = parentBinding();
    const child = childBinding(parent);
    const expansions: readonly AgentRunBinding[] = [
      { ...child, sessionId: 'different-session' },
      {
        ...child,
        workspace: { ...child.workspace, revision: child.workspace.revision + 1 }
      },
      {
        ...child,
        workspace: {
          ...child.workspace,
          scopeIds: ['scope.read', 'scope.zzz']
        }
      },
      {
        ...child,
        capabilities: [
          { capabilityId: 'workspace.admin', scopeIds: ['scope.read'] },
          ...child.capabilities
        ]
      },
      {
        ...child,
        capabilities: [{
          capabilityId: 'workspace.read',
          scopeIds: ['scope.read', 'scope.zzz']
        }]
      },
      {
        ...child,
        toolCatalog: {
          ...child.toolCatalog,
          digest: `sha256:${'9'.repeat(64)}`
        }
      },
      {
        ...child,
        toolCatalog: {
          ...child.toolCatalog,
          allowedToolNames: ['workspace.execute', 'workspace.read']
        }
      },
      {
        ...child,
        model: { ...child.model, modelId: 'different-model' }
      },
      {
        ...child,
        budget: {
          ...child.budget,
          vector: {
            ...child.budget.vector,
            toolCalls: parent.budget.vector.toolCalls + 1
          }
        }
      },
      {
        ...child,
        budget: { ...child.budget, deadlineAt: '2026-08-02T00:00:00.000Z' }
      },
      {
        ...child,
        objectiveRef: {
          ...child.objectiveRef,
          parentRunId: 'different-parent'
        }
      },
      {
        ...child,
        budget: {
          ...child.budget,
          source: {
            kind: 'parent_allocation',
            parentRunId: parent.budget.runId,
            parentGrantId: 'different-grant',
            delegationId: 'delegation-child'
          }
        }
      },
      {
        ...child,
        budget: {
          ...child.budget,
          source: {
            kind: 'parent_allocation',
            parentRunId: parent.budget.runId,
            parentGrantId: parent.budget.grantId,
            delegationId: 'different-delegation'
          }
        }
      }
    ];

    for (const candidate of expansions) {
      expect(() => assertAgentChildRunBindingSubset(
        parent.budget.runId,
        parent,
        candidate
      )).toThrow();
    }

    const readParent: AgentRunBinding = {
      ...parent,
      workspace: { ...parent.workspace, access: 'read' }
    };
    expect(() => assertAgentChildRunBindingSubset(
      readParent.budget.runId,
      readParent,
      { ...child, workspace: { ...child.workspace, access: 'write' } }
    )).toThrow(/access/);

    const askParent: AgentRunBinding = {
      ...parent,
      policy: { ...parent.policy, permissionMode: 'ask' }
    };
    expect(() => assertAgentChildRunBindingSubset(
      askParent.budget.runId,
      askParent,
      { ...child, policy: { ...child.policy, permissionMode: 'trusted' } }
    )).toThrow(/policy/);
  });
});

function parentBinding(): AgentRunBinding {
  const parent = bindingForRun('run-parent');
  return {
    ...parent,
    workspace: {
      ...parent.workspace,
      scopeIds: ['scope.read', 'scope.write', 'workspace']
    },
    policy: { ...parent.policy, permissionMode: 'trusted' },
    capabilities: [
      {
        capabilityId: 'workspace.read',
        scopeIds: ['scope.read', 'workspace']
      },
      {
        capabilityId: 'workspace.write',
        scopeIds: ['scope.write', 'workspace']
      }
    ]
  };
}

function childBinding(parent: AgentRunBinding): AgentRunBinding {
  return {
    ...parent,
    objectiveRef: {
      kind: 'parent_delegation',
      parentRunId: parent.budget.runId,
      delegationId: 'delegation-child',
      objectiveDigest: `sha256:${'7'.repeat(64)}`,
      mode: 'one_shot',
      providerId: 'ariadne.in_process'
    },
    workspace: {
      ...parent.workspace,
      access: 'read',
      scopeIds: ['scope.read']
    },
    policy: { ...parent.policy, permissionMode: 'ask' },
    capabilities: [{
      capabilityId: 'workspace.read',
      scopeIds: ['scope.read']
    }],
    toolCatalog: {
      ...parent.toolCatalog,
      allowedToolNames: ['workspace.read']
    },
    budget: {
      grantId: 'grant-run-child',
      runId: 'run-child',
      vector: {
        modelTurns: 5,
        toolCalls: 3,
        readCalls: 3,
        writeCalls: 0,
        shellCalls: 0,
        costMicrousd: 100_000
      },
      deadlineAt: '2026-07-31T12:00:00.000Z',
      source: {
        kind: 'parent_allocation',
        parentRunId: parent.budget.runId,
        parentGrantId: parent.budget.grantId,
        delegationId: 'delegation-child'
      }
    }
  };
}
