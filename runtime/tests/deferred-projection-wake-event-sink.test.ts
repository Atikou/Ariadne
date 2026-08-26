import { describe, expect, it, vi } from 'vitest';

import { DeferredProjectionWakeEventSink } from '../src/composition/DeferredProjectionWakeEventSink.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import type { RuntimePublicEventAppend } from '../src/ingress/RuntimePublicEventSink.js';

describe('DeferredProjectionWakeEventSink', () => {
  it('does not touch the Runtime event journal before bootstrap enables delivery', async () => {
    const delivered: RuntimePublicEventAppend[] = [];
    const sink = new DeferredProjectionWakeEventSink();
    sink.bind({ append: async (event) => { delivered.push(event); } });

    await sink.append(wake(1));
    await Promise.resolve();
    expect(delivered).toEqual([]);

    sink.enable();
    await vi.waitFor(() => expect(delivered).toEqual([wake(1)]));
    await close(sink);
  });

  it('coalesces bootstrap commits because one post-ready hint replays the full Projection tail', async () => {
    const delivered: RuntimePublicEventAppend[] = [];
    const sink = new DeferredProjectionWakeEventSink();
    sink.bind({ append: async (event) => { delivered.push(event); } });

    await sink.append(wake(1));
    await sink.append(wake(2));
    expect(sink.status()).toMatchObject({ enabled: false, pending: 1 });

    sink.enable();
    await vi.waitFor(() => expect(delivered).toEqual([wake(2)]));
    await close(sink);
  });

  it('retries the exact failed event independently without poisoning its caller', async () => {
    const attempts: RuntimePublicEventAppend[] = [];
    let fail = true;
    const sink = new DeferredProjectionWakeEventSink();
    sink.bind({
      append: async (event) => {
        attempts.push(structuredClone(event));
        if (fail) {
          fail = false;
          throw new Error('journal_ack_lost');
        }
      }
    });
    sink.enable();

    await expect(sink.append(wake(1))).resolves.toBeUndefined();
    await vi.waitFor(() => expect(attempts).toHaveLength(2), { timeout: 1_000 });
    expect(attempts[1]).toEqual(attempts[0]);
    expect(sink.status()).toEqual({ enabled: true, pending: 0, failedAttempts: 0 });
    await close(sink);
  });

  it('drops non-authoritative pending hints during shutdown', async () => {
    const append = vi.fn(async () => undefined);
    const sink = new DeferredProjectionWakeEventSink();
    sink.bind({ append });
    await sink.append(wake(1));

    await close(sink);
    sink.enable();
    await sink.append(wake(2));
    expect(append).not.toHaveBeenCalled();
    expect(sink.status()).toEqual({ enabled: false, pending: 0, failedAttempts: 0 });
  });
});

function wake(version: number): RuntimePublicEventAppend {
  return {
    eventId: `projection.changed:${String(version)}`,
    aggregateType: 'projection',
    aggregateId: 'model-catalog',
    aggregateVersion: version,
    causationId: `model-catalog.changed:${String(version)}`,
    occurredAt: new Date(Date.UTC(2030, 0, 1, 0, 0, version)).toISOString(),
    event: { kind: 'projection.changed', feature: 'models' }
  };
}

async function close(sink: DeferredProjectionWakeEventSink): Promise<void> {
  const context = createShutdownContext(Date.now() + 2_000);
  try {
    await sink.close(context);
  } finally {
    context.dispose();
  }
}
