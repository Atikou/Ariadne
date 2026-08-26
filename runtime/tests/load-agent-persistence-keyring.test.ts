import type {
  AgentPersistenceKeyRing,
  HostCapabilityOperation
} from '@ariadne/protocol/host';
import { describe, expect, it } from 'vitest';

import { loadAgentPersistenceKeyRing } from '../src/composition/loadAgentPersistenceKeyRing.js';
import type { HostCapabilityClient } from '../src/ingress/HostCapabilityClient.js';

const runtimeInstanceId = '00000000-0000-4000-8000-000000000010';
const keyId = 'agent-key-00000000-0000-4000-8000-000000000011';

describe('loadAgentPersistenceKeyRing', () => {
  it('requests the private capability and accepts an instance-bound key ring', async () => {
    const operations: HostCapabilityOperation[] = [];
    const broker = createBroker(operations, keyRing(runtimeInstanceId));

    await expect(loadAgentPersistenceKeyRing(
      broker,
      runtimeInstanceId
    )).resolves.toMatchObject({
      generation: 1,
      activeKeyId: keyId
    });
    expect(operations).toEqual([{
      kind: 'agent.persistence.keyring.read'
    }]);
  });

  it('fails closed for a stale Runtime instance or malformed key material', async () => {
    await expect(loadAgentPersistenceKeyRing(
      createBroker([], keyRing(
        '00000000-0000-4000-8000-000000000099'
      )),
      runtimeInstanceId
    )).rejects.toThrow(
      'agent_persistence_keyring_runtime_instance_mismatch'
    );
    await expect(loadAgentPersistenceKeyRing(
      createBroker([], {
        ...keyRing(runtimeInstanceId),
        keys: [{ keyId, keyMaterialBase64: 'plaintext-is-not-a-key' }]
      }),
      runtimeInstanceId
    )).rejects.toThrow();
  });
});

function createBroker(
  operations: HostCapabilityOperation[],
  result: Record<string, unknown>
): HostCapabilityClient {
  return {
    async request(operation) {
      operations.push(operation);
      return result;
    }
  };
}

function keyRing(instanceId: string): AgentPersistenceKeyRing {
  return {
    schemaVersion: 1,
    runtimeInstanceId: instanceId,
    generation: 1,
    activeKeyId: keyId,
    keys: [{
      keyId,
      keyMaterialBase64: Buffer.alloc(32, 13).toString('base64')
    }]
  };
}
