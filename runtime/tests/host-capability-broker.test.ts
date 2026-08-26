import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type HostCapabilityResponse
} from '@ariadne/protocol/host';
import { describe, expect, it } from 'vitest';

import { IpcHostCapabilityBroker } from '../src/host/HostCapabilityBroker.js';

const runtimeInstanceId = '00000000-0000-4000-8000-000000000020';

describe('IpcHostCapabilityBroker', () => {
  it('routes Agent persistence keys through their dedicated private capability', async () => {
    const sent: Record<string, unknown>[] = [];
    const broker = new IpcHostCapabilityBroker(
      runtimeInstanceId,
      (message) => sent.push(message as Record<string, unknown>)
    );

    const pending = broker.request({
      kind: 'agent.persistence.keyring.read'
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'capability_request',
      capability: 'agent_persistence',
      operation: { kind: 'agent.persistence.keyring.read' }
    });
    const requestId = String(sent[0]?.requestId);
    expect(broker.accept(successResponse(requestId))).toBe(true);
    await expect(pending).resolves.toEqual({ accepted: true });
    broker.close();
  });
});

function successResponse(requestId: string): HostCapabilityResponse {
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId,
    type: 'capability_response',
    requestId,
    outcome: {
      ok: true,
      result: { accepted: true }
    }
  };
}
