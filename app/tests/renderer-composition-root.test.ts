import { describe, expect, it, vi } from 'vitest';
import type { AriadneApi } from '@shared/contract';
import { successfulRuntimeApi } from './support/runtime-api';
import { getWindowRendererCompositionRoot } from '../src/renderer/src/core/services/renderer-composition-root';

describe('RendererCompositionRoot', () => {
  it('keeps one RuntimeStore for the window and disposes it only with the window lifecycle', async () => {
    const getStatus = vi.fn(async () => ({
      availability: 'stopped' as const,
      capabilities: [],
      observedAt: '2026-08-07T00:00:00.000Z'
    }));
    const removeStatus = vi.fn();
    const removeEvent = vi.fn();
    const api = {
      runtime: successfulRuntimeApi({
        getStatus,
        onStatus: () => removeStatus,
        request: async () => { throw new Error('Runtime request was not expected.'); },
        onEvent: () => removeEvent
      }),
      agentSettings: {},
      workspace: {}
    } as unknown as AriadneApi;
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn()
    } as unknown as Storage;
    const windowLifecycle = new EventTarget();
    const global = {};

    const first = getWindowRendererCompositionRoot(api, storage, global);
    const second = getWindowRendererCompositionRoot(api, storage, global);
    expect(second).toBe(first);
    expect(second.services.runtime).toBe(first.services.runtime);

    first.installWindowLifecycle(windowLifecycle as unknown as Window);
    first.installWindowLifecycle(windowLifecycle as unknown as Window);
    await Promise.all([first.start(), second.start()]);
    expect(getStatus).toHaveBeenCalledTimes(1);

    windowLifecycle.dispatchEvent(new Event('pagehide'));
    expect(removeStatus).toHaveBeenCalledTimes(1);
    expect(removeEvent).toHaveBeenCalledTimes(1);
    expect(() => first.start()).toThrow('renderer_composition_root_disposed');
  });
});
