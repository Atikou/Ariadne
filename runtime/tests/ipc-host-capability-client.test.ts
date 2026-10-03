import { describe, expect, it, vi } from 'vitest';

import { IpcHostCapabilityClient } from '../src/transport/IpcHostCapabilityClient.js';

describe('IpcHostCapabilityClient', () => {
  it('routes credential operations through the credential capability channel', async () => {
    const send = vi.fn();
    const client = new IpcHostCapabilityClient(
      'runtime-instance-credential-test',
      send
    );

    const pending = client.request({
      kind: 'credential.describe',
      credentialRef: 'model:openai'
    });
    const request = send.mock.calls[0]![0];
    expect(request).toMatchObject({
      type: 'capability_request',
      capability: 'credential',
      operation: {
        kind: 'credential.describe',
        credentialRef: 'model:openai'
      }
    });

    client.accept({
      protocol: 'ariadne-runtime-ipc',
      protocolVersion: '3.0',
      runtimeInstanceId: 'runtime-instance-credential-test',
      type: 'capability_response',
      requestId: request.requestId,
      outcome: {
        ok: true,
        result: {
          configured: true,
          source: 'os_secure_storage',
          writable: true
        }
      }
    });
    await expect(pending).resolves.toMatchObject({ configured: true });
  });
});
