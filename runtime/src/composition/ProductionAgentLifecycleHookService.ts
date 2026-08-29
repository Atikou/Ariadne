import type { AgentRunBinding } from '@ariadne/agent-core';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';

import type {
  AgentLifecycleHookProvider,
  AgentLifecycleHooks,
  AgentLifecycleHookService
} from '../control/ports/AgentLifecycleHooks.js';
import type {
  AgentLifecycleHookDeliverySink,
  AgentLifecycleHookEvent
} from '../control/ports/AgentLifecycleObservability.js';
import { ConfiguredAgentLifecycleHooks } from './ConfiguredAgentLifecycleHooks.js';

type HookDefinition = RuntimePolicySnapshot['hooks']['definitions'][number];
const SAFE_PROVIDER_ID = /^[a-z][a-z0-9._-]{0,63}$/u;

export function createConfiguredAgentLifecycleHookService(
  definitions: readonly HookDefinition[],
  providers: readonly AgentLifecycleHookProvider[] = []
): AgentLifecycleHookService {
  return new ProductionAgentLifecycleHookService([
    configuredHookProvider(definitions),
    ...providers
  ]);
}

function configuredHookProvider(
  definitions: readonly HookDefinition[]
): AgentLifecycleHookProvider {
  const frozenDefinitions = Object.freeze(structuredClone(definitions));
  return Object.freeze({
    providerId: 'hooks.configured',
    bind: (deliverySink?: AgentLifecycleHookDeliverySink) => (
      new ConfiguredAgentLifecycleHooks(frozenDefinitions, deliverySink)
    )
  });
}

class ProductionAgentLifecycleHookService implements AgentLifecycleHookService {
  private readonly providers: readonly AgentLifecycleHookProvider[];
  private readonly bindings = new Set<CompositeAgentLifecycleHooks>();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  public constructor(providers: readonly AgentLifecycleHookProvider[]) {
    const ids = new Set<string>();
    for (const provider of providers) {
      if (
        provider === null
        || typeof provider !== 'object'
        || !SAFE_PROVIDER_ID.test(provider.providerId)
        || typeof provider.bind !== 'function'
        || (provider.close !== undefined && typeof provider.close !== 'function')
      ) throw new Error('agent_lifecycle_hook_provider_invalid');
      if (ids.has(provider.providerId)) {
        throw new Error(`agent_lifecycle_hook_provider_duplicate:${provider.providerId}`);
      }
      ids.add(provider.providerId);
    }
    this.providers = Object.freeze([...providers]);
  }

  public bind(deliverySink?: AgentLifecycleHookDeliverySink): AgentLifecycleHooks {
    if (this.closed) throw new Error('agent_lifecycle_hook_service_closed');
    const hooks = this.providers.map((provider) => provider.bind(deliverySink));
    if (hooks.some((hook) => !isAgentLifecycleHooks(hook))) {
      throw new Error('agent_lifecycle_hook_provider_binding_invalid');
    }
    const binding = new CompositeAgentLifecycleHooks(
      Object.freeze(hooks),
      () => this.closed
    );
    this.bindings.add(binding);
    return binding;
  }

  public close(): Promise<void> {
    this.closePromise ??= this.closeOwned();
    return this.closePromise;
  }

  private async closeOwned(): Promise<void> {
    this.closed = true;
    const failures: unknown[] = [];
    for (const binding of [...this.bindings].reverse()) {
      try { await binding.close(); } catch (error) { failures.push(error); }
    }
    this.bindings.clear();
    for (const provider of [...this.providers].reverse()) {
      try { await provider.close?.(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'agent_lifecycle_hook_provider_close_failed');
    }
  }
}

class CompositeAgentLifecycleHooks implements AgentLifecycleHooks {
  private closePromise: Promise<void> | null = null;

  public constructor(
    private readonly hooks: readonly AgentLifecycleHooks[],
    private readonly isClosed: () => boolean
  ) {}

  public async applyAdmission(
    binding: AgentRunBinding,
    occurredAt: string
  ): Promise<AgentRunBinding> {
    this.assertOpen();
    let current = binding;
    for (const hooks of this.hooks) {
      current = await hooks.applyAdmission(current, occurredAt);
      this.assertOpen();
    }
    return current;
  }

  public enforce(
    event: Extract<AgentLifecycleHookEvent, `${string}.pre`>,
    eventId: string,
    occurredAt: string
  ): void {
    this.assertOpen();
    for (const hooks of this.hooks) hooks.enforce(event, eventId, occurredAt);
  }

  public observe(
    event: Exclude<AgentLifecycleHookEvent, `${string}.pre`>,
    eventId: string,
    occurredAt: string
  ): void {
    if (this.isClosed()) return;
    for (const hooks of this.hooks) {
      try {
        hooks.observe(event, eventId, occurredAt);
      } catch {
        // Post handlers are observers and cannot change committed Agent state.
      }
    }
  }

  public close(): Promise<void> {
    this.closePromise ??= this.closeOwned();
    return this.closePromise;
  }

  private async closeOwned(): Promise<void> {
    const failures: unknown[] = [];
    for (const hooks of [...this.hooks].reverse()) {
      try { await hooks.close?.(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'agent_lifecycle_hook_binding_close_failed');
    }
  }

  private assertOpen(): void {
    if (this.isClosed()) throw new Error('agent_lifecycle_hook_service_closed');
  }
}

function isAgentLifecycleHooks(value: unknown): value is AgentLifecycleHooks {
  return value !== null
    && typeof value === 'object'
    && typeof (value as Partial<AgentLifecycleHooks>).applyAdmission === 'function'
    && typeof (value as Partial<AgentLifecycleHooks>).enforce === 'function'
    && typeof (value as Partial<AgentLifecycleHooks>).observe === 'function';
}
