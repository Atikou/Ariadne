import { expect, it, vi } from 'vitest';
import type { RuntimeResult, RuntimeStatus } from '@ariadne/protocol/public';
import { RuntimeSupervisor } from '../src/main/runtime/runtime-supervisor';
import { installProjectionCapacityMetrics, projectionCapacityMetrics, projectionCapacityLifecycle } from '../src/main/smoke/projection-capacity-metrics';

it('observes metadata while preserving one delegation, the owner, options, result and rejection', async () => {
  const original = RuntimeSupervisor.prototype.request;
  const originalOnStatus = RuntimeSupervisor.prototype.onStatus;
  const body = { kind: 'runtime.status', status: { fixtureMarker: 'body-must-not-be-retained' } } as unknown as RuntimeResult;
  const failure = new Error('fixture-request-rejected');
  const delegate = vi.fn<typeof original>().mockResolvedValueOnce(body).mockRejectedValueOnce(failure);
  const subscriptions: ((status: RuntimeStatus) => void)[] = [], unsubscribe = vi.fn();
  const statusDelegate = vi.fn<typeof originalOnStatus>().mockImplementation(listener => { subscriptions.push(listener); return unsubscribe; });
  RuntimeSupervisor.prototype.request = delegate;
  RuntimeSupervisor.prototype.onStatus = statusDelegate;
  try {
    installProjectionCapacityMetrics();
    const owner = Object.create(RuntimeSupervisor.prototype) as RuntimeSupervisor;
    const options = { commandId: 'one-identity', signal: new AbortController().signal };
    const command = { kind: 'runtime.status.get' } as const;
    await expect(owner.request(command, options)).resolves.toBe(body);
    await expect(owner.request(command, options)).rejects.toBe(failure);
    expect(delegate).toHaveBeenCalledTimes(2);
    expect(delegate.mock.contexts).toEqual([owner, owner]);
    for (const call of delegate.mock.calls) { expect(call[0]).toBe(command); expect(call[1]).toBe(options); }
    const metrics = projectionCapacityMetrics();
    expect(metrics['runtime.status.get']).toMatchObject({ count: 2, failures: 1,
      responseBytesMax: Buffer.byteLength(JSON.stringify(body)) });
    expect(JSON.stringify(metrics)).not.toContain('body-must-not-be-retained');
    metrics['runtime.status.get']!.count = 999;
    expect(projectionCapacityMetrics()['runtime.status.get']?.count).toBe(2);
    const listener = vi.fn(), dispose = owner.onStatus(listener);
    owner.onStatus(listener);
    const status: RuntimeStatus = { availability: 'crashed', capabilities: [], observedAt: '2030-01-01T00:00:00.000Z',
      detail: 'Runtime handshake timed out; body-must-not-be-retained' };
    for (const subscription of subscriptions) subscription(status);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0]?.[0]).toBe(status);
    expect(projectionCapacityLifecycle()).toHaveLength(1);
    expect(projectionCapacityLifecycle()[0]).toMatchObject({ availability: 'crashed', handshakeTimedOut: true });
    expect(JSON.stringify(projectionCapacityLifecycle())).not.toContain('body-must-not-be-retained');
    dispose(); expect(unsubscribe).toHaveBeenCalledOnce();
  } finally { RuntimeSupervisor.prototype.request = original; RuntimeSupervisor.prototype.onStatus = originalOnStatus; }
});
