import { describe, expect, it } from 'vitest';

import {
  agentRunExecutionMode,
  assertAgentChildRunBindingSubset,
  assertValidAgentRunBinding,
  cloneAgentRunBinding,
  type AgentRunBinding
} from '../src/index.js';
import { bindingForRun } from './fixtures.js';

describe('AgentRunBinding v4 execution profile', () => {
  it('persists an exact execution profile while retaining v3 read compatibility', () => {
    const legacy = bindingForRun('run-legacy-binding');
    const plan: AgentRunBinding = {
      ...bindingForRun('run-plan-binding'),
      bindingVersion: 4,
      executionProfile: { mode: 'plan' }
    };

    expect(() => assertValidAgentRunBinding(legacy)).not.toThrow();
    expect(() => assertValidAgentRunBinding(plan)).not.toThrow();
    expect(agentRunExecutionMode(legacy)).toBe('agent');
    expect(agentRunExecutionMode(plan)).toBe('plan');
    expect(cloneAgentRunBinding(plan)).toEqual(plan);
    expect(() => assertValidAgentRunBinding({
      ...plan,
      executionProfile: { mode: 'invalid' }
    } as unknown as AgentRunBinding)).toThrow(/executionProfile/u);
  });

  it('does not let a child expand a plan parent back into agent execution', () => {
    const parent: AgentRunBinding = {
      ...bindingForRun('run-plan-parent'),
      bindingVersion: 4,
      executionProfile: { mode: 'plan' }
    };
    const childBase = bindingForRun('run-plan-child');
    const child: AgentRunBinding = {
      ...childBase,
      bindingVersion: 4,
      executionProfile: { mode: 'plan' },
      sessionId: parent.sessionId,
      objectiveRef: {
        kind: 'parent_delegation',
        parentRunId: parent.budget.runId,
        delegationId: 'delegation-plan-child',
        objectiveDigest: `sha256:${'d'.repeat(64)}`,
        mode: 'one_shot',
        providerId: 'ariadne.in_process'
      },
      workspace: { ...parent.workspace },
      model: { ...parent.model },
      policy: { ...parent.policy },
      capabilities: parent.capabilities.map((grant) => ({
        capabilityId: grant.capabilityId,
        scopeIds: [...grant.scopeIds]
      })),
      toolCatalog: {
        ...parent.toolCatalog,
        allowedToolNames: [...parent.toolCatalog.allowedToolNames]
      },
      budget: {
        ...childBase.budget,
        source: {
          kind: 'parent_allocation',
          parentRunId: parent.budget.runId,
          parentGrantId: parent.budget.grantId,
          delegationId: 'delegation-plan-child'
        }
      }
    };

    expect(() => assertAgentChildRunBindingSubset(
      parent.budget.runId,
      parent,
      child
    )).not.toThrow();
    expect(() => assertAgentChildRunBindingSubset(
      parent.budget.runId,
      parent,
      { ...child, executionProfile: { mode: 'agent' } }
    )).toThrow(/execution profile/u);
  });
});
