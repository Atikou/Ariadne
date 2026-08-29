import { createHash } from 'node:crypto';

import {
  assertValidAgentRunBinding,
  cloneAgentRunBinding,
  type AgentRunBinding
} from '@ariadne/agent-core';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
import type {
  AgentLifecycleHookDelivery,
  AgentLifecycleHookDeliverySink,
  AgentLifecycleHookEvent
} from '../control/ports/AgentLifecycleObservability.js';
import type { AgentLifecycleHooks } from '../control/ports/AgentLifecycleHooks.js';

type HookDefinition = RuntimePolicySnapshot['hooks']['definitions'][number];

export class ConfiguredAgentLifecycleHookRejection extends Error {
  public constructor(
    public readonly hookId: string,
    reason: string
  ) {
    super(reason);
    this.name = 'ConfiguredAgentLifecycleHookRejection';
  }
}

/**
 * Typed declarative lifecycle Hooks. Only pre events can reject; only
 * run.admission.pre can attenuate immutable authority. Post events are
 * observer-only and receive no prompt, Tool input/output, paths, or secrets.
 */
export class ConfiguredAgentLifecycleHooks implements AgentLifecycleHooks {
  private readonly hooks: readonly HookDefinition[];

  public constructor(
    definitions: readonly HookDefinition[],
    private readonly deliverySink?: AgentLifecycleHookDeliverySink
  ) {
    this.hooks = Object.freeze(structuredClone(definitions));
  }

  public async applyAdmission(
    binding: AgentRunBinding,
    occurredAt: string
  ): Promise<AgentRunBinding> {
    let current = cloneAgentRunBinding(binding);
    for (const hook of this.matching('run.admission.pre')) {
      this.rejectIfConfigured(hook, 'run.admission.pre', binding.budget.runId, occurredAt);
      current = narrowBinding(current, hook, occurredAt);
      this.deliver(hook, 'run.admission.pre', binding.budget.runId, 'allowed', occurredAt);
    }
    this.deliverSystem('run.admission.pre', binding.budget.runId, 'allowed', occurredAt);
    assertValidAgentRunBinding(current);
    return current;
  }

  public enforce(
    event: Extract<AgentLifecycleHookEvent, `${string}.pre`>,
    eventId: string,
    occurredAt: string
  ): void {
    for (const hook of this.matching(event)) {
      this.rejectIfConfigured(hook, event, eventId, occurredAt);
      this.deliver(hook, event, eventId, 'allowed', occurredAt);
    }
    this.deliverSystem(event, eventId, 'allowed', occurredAt);
  }

  public observe(
    event: Exclude<AgentLifecycleHookEvent, `${string}.pre`>,
    eventId: string,
    occurredAt: string
  ): void {
    for (const hook of this.matching(event)) {
      this.deliver(hook, event, eventId, 'observed', occurredAt);
    }
    this.deliverSystem(event, eventId, 'observed', occurredAt);
  }

  private matching(event: AgentLifecycleHookEvent): readonly HookDefinition[] {
    return this.hooks.filter((hook) => hook.events.includes(event));
  }

  private rejectIfConfigured(
    hook: HookDefinition,
    event: AgentLifecycleHookEvent,
    eventId: string,
    occurredAt: string
  ): void {
    if (hook.decision !== 'reject') return;
    this.deliver(hook, event, eventId, 'rejected', occurredAt);
    throw new ConfiguredAgentLifecycleHookRejection(
      hook.id,
      hook.reason ?? `hook_rejected:${hook.id}`
    );
  }

  private deliver(
    hook: HookDefinition,
    event: AgentLifecycleHookEvent,
    eventId: string,
    outcome: AgentLifecycleHookDelivery['outcome'],
    observedAt: string
  ): void {
    if (this.deliverySink === undefined) return;
    const delivery = Object.freeze({
      deliveryId: stableDeliveryId(hook, event, eventId),
      hookId: hook.id,
      hookVersion: hook.version,
      event,
      outcome,
      observedAt
    });
    // Observer failure is deliberately isolated from Agent authority and I/O.
    try {
      void Promise.resolve(this.deliverySink.record(delivery)).catch(() => undefined);
    } catch {
      // Synchronous observer failure is also fail-open.
    }
  }

  private deliverSystem(
    event: AgentLifecycleHookEvent,
    eventId: string,
    outcome: AgentLifecycleHookDelivery['outcome'],
    observedAt: string
  ): void {
    if (this.deliverySink === undefined) return;
    const hook: HookDefinition = {
      id: 'runtime_observer', version: '1', events: [event], timeoutMs: 1,
      failurePolicy: 'fail-open', decision: 'allow'
    };
    this.deliver(hook, event, eventId, outcome, observedAt);
  }
}

function stableDeliveryId(
  hook: HookDefinition,
  event: AgentLifecycleHookEvent,
  eventId: string
): string {
  return `hook-delivery:${createHash('sha256')
    .update(JSON.stringify([hook.id, hook.version, event, eventId]), 'utf8')
    .digest('hex')}`;
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
    case 'read': return ['skills.read', 'workspace.read'];
    case 'write': return ['workspace.write'];
    case 'shell': return ['workspace.shell'];
    case 'network': return ['browser.use', 'mcp.use'];
    case 'dangerous': return [];
    default: return [];
  }
}
