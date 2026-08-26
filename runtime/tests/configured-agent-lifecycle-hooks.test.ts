import type { AgentRunBinding } from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  ConfiguredAgentLifecycleHooks,
  ConfiguredAgentLifecycleHookRejection
} from '../src/composition/ConfiguredAgentLifecycleHooks.js';

describe('ConfiguredAgentLifecycleHooks', () => {
  it('narrows admission authority and emits one stable delivery', async () => {
    const record = vi.fn();
    const hooks = new ConfiguredAgentLifecycleHooks([{
      id: 'read_only',
      version: '1',
      events: ['run.admission.pre'],
      timeoutMs: 1_000,
      failurePolicy: 'fail-closed',
      decision: 'allow',
      constraints: { permissions: ['read'], timeoutMs: 60_000 }
    }], { record });
    const result = await hooks.applyAdmission(binding(), '2030-01-01T00:00:00.000Z');

    expect(result.capabilities).toEqual([{
      capabilityId: 'workspace.read',
      scopeIds: ['workspace-hook']
    }]);
    expect(result.budget.vector.writeCalls).toBe(0);
    expect(result.budget.vector.shellCalls).toBe(0);
    expect(result.budget.deadlineAt).toBe('2030-01-01T00:01:00.000Z');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: expect.stringMatching(/^hook-delivery:[a-f0-9]{64}$/u),
      event: 'run.admission.pre',
      outcome: 'allowed'
    }));
  });

  it('rejects only at typed pre boundaries and keeps post observers non-mutating', async () => {
    const hooks = new ConfiguredAgentLifecycleHooks([{
      id: 'deny_run',
      version: '1',
      events: ['run.admission.pre'],
      timeoutMs: 1_000,
      failurePolicy: 'fail-closed',
      decision: 'reject',
      reason: 'policy denied this run'
    }]);
    await expect(hooks.applyAdmission(binding(), '2030-01-01T00:00:00.000Z'))
      .rejects.toThrow(ConfiguredAgentLifecycleHookRejection);
  });
});

function binding(): AgentRunBinding {
  return {
    bindingVersion: 3,
    sessionId: 'session-hook',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: 'message-hook',
      messageVersion: 1,
      contentDigest: `sha256:${'a'.repeat(64)}`
    },
    workspace: {
      workspaceId: 'workspace-hook', revision: 1,
      grantDigest: `sha256:${'b'.repeat(64)}`, access: 'write', scopeIds: ['workspace-hook']
    },
    model: { providerId: 'provider-hook', modelId: 'model-hook', settingsRevision: 1 },
    policy: { policyId: 'policy-hook', revision: 1, permissionMode: 'ask' },
    capabilities: [
      { capabilityId: 'workspace.read', scopeIds: ['workspace-hook'] },
      { capabilityId: 'workspace.shell', scopeIds: ['workspace-hook'] },
      { capabilityId: 'workspace.write', scopeIds: ['workspace-hook'] }
    ],
    toolCatalog: {
      catalogId: 'catalog-hook', revision: 1,
      digest: `sha256:${'c'.repeat(64)}`,
      allowedToolNames: ['workspace.read_file', 'workspace.run_command', 'workspace.write_file']
    },
    budget: {
      grantId: 'budget-hook', runId: 'run-hook',
      vector: {
        modelTurns: 8, toolCalls: 8, readCalls: 4, writeCalls: 2,
        shellCalls: 2, costMicrousd: 1_000_000
      },
      deadlineAt: '2030-01-01T01:00:00.000Z', source: { kind: 'root' }
    }
  };
}
