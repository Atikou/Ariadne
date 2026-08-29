import type { AgentRunBinding } from '@ariadne/agent-core';

import type {
  AgentLifecycleHookDeliverySink,
  AgentLifecycleHookEvent
} from './AgentLifecycleObservability.js';

/** One bound, typed Hook set used by Agent admission and dispatch boundaries. */
export interface AgentLifecycleHooks {
  applyAdmission(binding: AgentRunBinding, occurredAt: string): Promise<AgentRunBinding>;
  enforce(
    event: Extract<AgentLifecycleHookEvent, `${string}.pre`>,
    eventId: string,
    occurredAt: string
  ): void;
  observe(
    event: Exclude<AgentLifecycleHookEvent, `${string}.pre`>,
    eventId: string,
    occurredAt: string
  ): void;
  close?(): void | Promise<void>;
}

/** One statically composed trusted source of Hook behavior. */
export interface AgentLifecycleHookProvider {
  readonly providerId: string;
  bind(deliverySink?: AgentLifecycleHookDeliverySink): AgentLifecycleHooks;
  close?(): void | Promise<void>;
}

/** Manifest-owned factory; binding occurs only after the durable delivery sink exists. */
export interface AgentLifecycleHookService {
  bind(deliverySink?: AgentLifecycleHookDeliverySink): AgentLifecycleHooks;
  close(): Promise<void>;
}
