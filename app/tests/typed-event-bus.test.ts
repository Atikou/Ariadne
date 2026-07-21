import { describe, expect, it, vi } from 'vitest';
import type { AppEventMap } from '@renderer/core/events/app-events';
import { TypedEventBus } from '@renderer/core/events/typed-event-bus';

describe('TypedEventBus', () => {
  it('delivers typed events and stops after unsubscribe', () => {
    const bus = new TypedEventBus<AppEventMap>();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('preferences:changed', handler);
    const preferences = {
      runInBackground: true,
      startAtLogin: false,
      theme: 'dark' as const,
      suppressAutomaticWakeDuringGames: true,
      gameDetectionRules: []
    };

    bus.emit('preferences:changed', preferences);
    unsubscribe();
    bus.emit('preferences:changed', { ...preferences, theme: 'light' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(preferences);
  });
});
