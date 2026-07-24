import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeRequest
} from '@ariadne/protocol/host';
import { describe, expect, it, vi } from 'vitest';

import { NodeIpcRuntimeHost } from '../src/transport/NodeIpcRuntimeHost.js';

describe('NodeIpcRuntimeHost request draining', () => {
  it('tracks accepted requests until their handler settles and drains them before shutdown', async () => {
    const host = new NodeIpcRuntimeHost();
    let resolveRequest!: (value: unknown) => void;
    const handled = new Promise((resolve) => { resolveRequest = resolve; });
    const send = vi.fn();
    const internals = host as unknown as {
      facade: { handle(command: RuntimeRequest['command']): Promise<unknown> };
      bootstrap: { runtimeInstanceId: string };
      inFlight: Map<string, Promise<void>>;
      acceptRequest(request: RuntimeRequest): void;
      drainInFlight(deadline: number): Promise<void>;
      send(message: unknown): void;
    };
    internals.facade = { handle: () => handled };
    internals.bootstrap = { runtimeInstanceId: 'runtime-instance-1' };
    internals.send = send;

    internals.acceptRequest(request('request-1'));
    expect(internals.inFlight.size).toBe(1);
    let drained = false;
    const drain = internals.drainInFlight(Date.now() + 5_000).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveRequest({
      kind: 'runtime.status',
      status: { availability: 'ready', capabilities: [], observedAt: new Date().toISOString() }
    });
    await drain;

    expect(drained).toBe(true);
    expect(internals.inFlight.size).toBe(0);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'response',
      requestId: 'request-1',
      outcome: expect.objectContaining({ ok: true })
    }));
  });

  it('honors the shutdown deadline when a request cannot settle', async () => {
    const host = new NodeIpcRuntimeHost();
    const internals = host as unknown as {
      facade: { handle(command: RuntimeRequest['command']): Promise<unknown> };
      bootstrap: { runtimeInstanceId: string };
      inFlight: Map<string, Promise<void>>;
      acceptRequest(request: RuntimeRequest): void;
      drainInFlight(deadline: number): Promise<void>;
      send(message: unknown): void;
    };
    internals.facade = { handle: () => new Promise(() => undefined) };
    internals.bootstrap = { runtimeInstanceId: 'runtime-instance-1' };
    internals.send = vi.fn();
    internals.acceptRequest(request('request-never-settles'));

    const startedAt = Date.now();
    await internals.drainInFlight(startedAt + 20);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(internals.inFlight.size).toBe(1);
  });
});

function request(requestId: string): RuntimeRequest {
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: 'runtime-instance-1',
    type: 'request',
    requestId,
    command: { kind: 'runtime.status.get' }
  };
}
