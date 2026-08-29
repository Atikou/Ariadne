import type { AgentRunBinding } from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import { createConfiguredAgentLifecycleHookService } from '../src/composition/ProductionAgentLifecycleHookService.js';
import type {
  AgentLifecycleHookProvider,
  AgentLifecycleHooks
} from '../src/control/ports/AgentLifecycleHooks.js';

describe('ProductionAgentLifecycleHookService', () => {
  it('binds statically trusted Providers, isolates post failures, and closes once', async () => {
    const enforce = vi.fn();
    const applyAdmission = vi.fn(async (value: AgentRunBinding) => value);
    const closeBinding = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const hooks: AgentLifecycleHooks = {
      applyAdmission,
      enforce,
      observe: () => { throw new Error('observer failed'); },
      close: closeBinding
    };
    const provider: AgentLifecycleHookProvider = {
      providerId: 'hooks.test',
      bind: vi.fn(() => hooks),
      close
    };
    const service = createConfiguredAgentLifecycleHookService([], [provider]);
    const bound = service.bind();

    await expect(bound.applyAdmission(binding(), '2030-01-01T00:00:00.000Z'))
      .resolves.toMatchObject({ bindingVersion: 3 });
    expect(() => bound.enforce(
      'tool.dispatch.pre', 'tool-call-1', '2030-01-01T00:00:00.000Z'
    )).not.toThrow();
    expect(() => bound.observe(
      'runtime.stop', 'runtime', '2030-01-01T00:00:00.000Z'
    )).not.toThrow();
    expect(enforce).toHaveBeenCalledOnce();

    await service.close();
    await service.close();
    expect(close).toHaveBeenCalledOnce();
    expect(closeBinding).toHaveBeenCalledOnce();
    expect(() => service.bind()).toThrow('agent_lifecycle_hook_service_closed');
    expect(() => bound.enforce(
      'tool.dispatch.pre', 'tool-call-2', '2030-01-01T00:00:01.000Z'
    )).toThrow('agent_lifecycle_hook_service_closed');
  });

  it('rejects duplicate trusted Provider identities', () => {
    const provider = (): AgentLifecycleHookProvider => ({
      providerId: 'hooks.duplicate',
      bind: () => ({
        applyAdmission: async (value) => value,
        enforce: () => undefined,
        observe: () => undefined
      })
    });
    expect(() => createConfiguredAgentLifecycleHookService([], [provider(), provider()]))
      .toThrow('agent_lifecycle_hook_provider_duplicate:hooks.duplicate');
  });
});

function binding(): AgentRunBinding {
  return {
    bindingVersion: 3,
    sessionId: 'session-hook-service',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: 'message-hook-service',
      messageVersion: 1,
      contentDigest: `sha256:${'a'.repeat(64)}`
    },
    workspace: {
      workspaceId: 'workspace-hook-service', revision: 1,
      grantDigest: `sha256:${'b'.repeat(64)}`, access: 'read',
      scopeIds: ['workspace-hook-service']
    },
    model: { providerId: 'provider-hook', modelId: 'model-hook', settingsRevision: 1 },
    policy: { policyId: 'policy-hook', revision: 1, permissionMode: 'ask' },
    capabilities: [{ capabilityId: 'workspace.read', scopeIds: ['workspace-hook-service'] }],
    toolCatalog: {
      catalogId: 'catalog-hook', revision: 1,
      digest: `sha256:${'c'.repeat(64)}`,
      allowedToolNames: ['workspace.read_file']
    },
    budget: {
      grantId: 'budget-hook', runId: 'run-hook',
      vector: {
        modelTurns: 1, toolCalls: 1, readCalls: 1, writeCalls: 0,
        shellCalls: 0, costMicrousd: 1
      },
      deadlineAt: '2030-01-01T01:00:00.000Z', source: { kind: 'root' }
    }
  };
}
