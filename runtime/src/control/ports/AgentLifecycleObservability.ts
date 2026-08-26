import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';

export type AgentLifecycleHookEvent = RuntimePolicySnapshot['hooks']['definitions'][number]['events'][number];

export interface AgentLifecycleHookDelivery {
  readonly deliveryId: string;
  readonly hookId: string;
  readonly hookVersion: string;
  readonly event: AgentLifecycleHookEvent;
  readonly outcome: 'allowed' | 'rejected' | 'observed';
  readonly observedAt: string;
}

export interface AgentLifecycleHookDeliverySink {
  record(delivery: AgentLifecycleHookDelivery): void | Promise<void>;
}

export interface AgentLifecycleTelemetry {
  recordLifecycle(record: { readonly operation: string; readonly outcome: string }): void;
}
