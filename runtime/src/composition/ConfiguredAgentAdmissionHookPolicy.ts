import {
  assertValidAgentRunBinding,
  cloneAgentRunBinding,
  type AgentRunBinding
} from '@ariadne/agent-core';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';

type HookDefinition = RuntimePolicySnapshot['hooks']['definitions'][number];

export class ConfiguredAgentAdmissionHookRejection extends Error {
  public constructor(
    public readonly hookId: string,
    reason: string
  ) {
    super(reason);
    this.name = 'ConfiguredAgentAdmissionHookRejection';
  }
}

/**
 * Deterministic run.pre policy. Configured hooks are declarative data, so they
 * can reject or narrow a pinned binding without executing arbitrary scripts or
 * introducing a second authority store.
 */
export class ConfiguredAgentAdmissionHookPolicy {
  private readonly hooks: readonly HookDefinition[];

  public constructor(definitions: readonly HookDefinition[]) {
    this.hooks = structuredClone(definitions).filter(
      (definition) => definition.events.includes('run.pre')
    );
  }

  public apply(binding: AgentRunBinding, occurredAt: string): AgentRunBinding {
    let current = cloneAgentRunBinding(binding);
    for (const hook of this.hooks) {
      if (hook.decision === 'reject') {
        throw new ConfiguredAgentAdmissionHookRejection(
          hook.id,
          hook.reason ?? `hook_rejected:${hook.id}`
        );
      }
      current = narrowBinding(current, hook, occurredAt);
    }
    assertValidAgentRunBinding(current);
    return current;
  }
}

function narrowBinding(
  binding: AgentRunBinding,
  hook: HookDefinition,
  occurredAt: string
): AgentRunBinding {
  const permissions = hook.constraints?.permissions;
  const allowedCapabilities = permissions === undefined
    ? null
    : new Set(permissions.flatMap(permissionCapabilities));
  const capabilities = allowedCapabilities === null
    ? binding.capabilities
    : binding.capabilities.filter((grant) => allowedCapabilities.has(grant.capabilityId));
  const allowedCapabilityIds = new Set(capabilities.map((grant) => grant.capabilityId));
  const timeoutMs = hook.constraints?.timeoutMs;
  const hookDeadline = timeoutMs === undefined
    ? binding.budget.deadlineAt
    : new Date(Date.parse(occurredAt) + timeoutMs).toISOString();
  const deadlineAt = Date.parse(hookDeadline) < Date.parse(binding.budget.deadlineAt)
    ? hookDeadline
    : binding.budget.deadlineAt;
  return cloneAgentRunBinding({
    ...binding,
    capabilities,
    toolCatalog: {
      ...binding.toolCatalog,
      allowedToolNames: [...binding.toolCatalog.allowedToolNames]
    },
    budget: {
      ...binding.budget,
      deadlineAt,
      vector: {
        ...binding.budget.vector,
        ...(!allowedCapabilityIds.has('workspace.write') ? { writeCalls: 0 } : {}),
        ...(!allowedCapabilityIds.has('workspace.shell') ? { shellCalls: 0 } : {})
      }
    }
  });
}

function permissionCapabilities(permission: string): readonly string[] {
  switch (permission) {
    case 'read': return ['workspace.read'];
    case 'write': return ['workspace.write'];
    case 'shell': return ['workspace.shell'];
    case 'network': return ['browser.use', 'mcp.use'];
    case 'dangerous': return [];
    default: return [];
  }
}
