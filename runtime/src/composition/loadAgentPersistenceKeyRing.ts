import {
  agentPersistenceKeyRingSchema,
  type AgentPersistenceKeyRing
} from '@ariadne/protocol/host';

import type { HostCapabilityClient } from '../ingress/HostCapabilityClient.js';

/**
 * Loads process-scoped Agent recovery keys through the private Main/Runtime
 * capability channel. The result is rejected unless it is bound to the exact
 * Runtime instance that requested it.
 */
export async function loadAgentPersistenceKeyRing(
  hostCapabilities: HostCapabilityClient,
  runtimeInstanceId: string
): Promise<AgentPersistenceKeyRing> {
  const result = await hostCapabilities.request({
    kind: 'agent.persistence.keyring.read'
  });
  const keyRing = agentPersistenceKeyRingSchema.parse(result);
  if (keyRing.runtimeInstanceId !== runtimeInstanceId) {
    throw new Error('agent_persistence_keyring_runtime_instance_mismatch');
  }
  return keyRing;
}
