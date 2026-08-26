import { describe, expect, it, vi } from 'vitest';

import type { ModelClient } from '../src/model/types.js';
import { ModelAvailabilityRegistry } from '../src/model-router/model-availability.js';

describe('ModelAvailabilityRegistry probe coordination', () => {
  it('deduplicates concurrent probes and reuses a fresh result', async () => {
    let finishProbe!: (available: boolean) => void;
    const isAvailable = vi.fn(() => new Promise<boolean>((resolve) => {
      finishProbe = resolve;
    }));
    const client: ModelClient = {
      name: 'local-model',
      model: 'local-model',
      location: 'local',
      isAvailable,
      async chat() {
        throw new Error('not used');
      }
    };
    const availability = new ModelAvailabilityRegistry({ probeTtlMs: 60_000 });

    const first = availability.refreshModel(client.name, client);
    const second = availability.refreshModel(client.name, client);
    await Promise.resolve();
    expect(isAvailable).toHaveBeenCalledTimes(1);

    finishProbe(true);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ modelId: client.name, available: true }),
      expect.objectContaining({ modelId: client.name, available: true })
    ]);

    await expect(availability.refreshModel(client.name, client)).resolves.toMatchObject({
      modelId: client.name,
      available: true
    });
    expect(isAvailable).toHaveBeenCalledTimes(1);
  });

  it('converges rejected probes to a safe cached unavailable record', async () => {
    const isAvailable = vi.fn(async () => {
      throw new Error('Authorization: Bearer credential-that-must-not-leak');
    });
    const client: ModelClient = {
      name: 'remote-model',
      model: 'remote-model',
      location: 'remote',
      isAvailable,
      async chat() {
        throw new Error('not used');
      }
    };
    const availability = new ModelAvailabilityRegistry({ unavailableTtlMs: 60_000 });

    const [first, second] = await Promise.all([
      availability.refreshModel(client.name, client),
      availability.refreshModel(client.name, client)
    ]);

    expect(first).toMatchObject({
      modelId: client.name,
      available: false,
      reason: 'client.isAvailable() rejected'
    });
    expect(second).toEqual(first);
    expect(first.reason).not.toContain('credential-that-must-not-leak');
    expect(isAvailable).toHaveBeenCalledTimes(1);

    await expect(availability.refreshModel(client.name, client)).resolves.toEqual(first);
    expect(isAvailable).toHaveBeenCalledTimes(1);
  });
});
