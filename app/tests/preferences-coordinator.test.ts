import { describe, expect, it, vi } from 'vitest';
import type { UserPreferences } from '../src/shared/contract';
import { PreferencesCoordinator } from '../src/main/services/preferences-coordinator';

const initialPreferences: UserPreferences = {
  runInBackground: true,
  startAtLogin: false,
  theme: 'system',
  suppressAutomaticWakeDuringGames: true,
  gameDetectionRules: []
};

describe('PreferencesCoordinator', () => {
  it('serializes updates so every system transition uses the committed predecessor', async () => {
    let current = structuredClone(initialPreferences);
    let releaseFirst!: () => void;
    const firstSideEffect = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const transitions: Array<[UserPreferences, UserPreferences]> = [];
    const sideEffects = {
      applyPreferences: vi.fn(async (previous: UserPreferences, next: UserPreferences) => {
        transitions.push([structuredClone(previous), structuredClone(next)]);
        if (transitions.length === 1) await firstSideEffect;
      })
    };
    const state = {
      getPreferences: () => structuredClone(current),
      savePreferences: async (next: UserPreferences) => { current = structuredClone(next); }
    };
    const coordinator = new PreferencesCoordinator(state, sideEffects);
    const first = { ...initialPreferences, startAtLogin: true };
    const second = { ...first, theme: 'dark' as const };

    const firstUpdate = coordinator.update(first);
    const secondUpdate = coordinator.update(second);
    await vi.waitFor(() => expect(sideEffects.applyPreferences).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([firstUpdate, secondUpdate]);

    expect(transitions).toEqual([
      [initialPreferences, first],
      [first, second]
    ]);
    expect(current).toEqual(second);
  });

  it('restores the external system setting when persistence fails', async () => {
    const transitions: Array<[boolean, boolean]> = [];
    const state = {
      getPreferences: () => structuredClone(initialPreferences),
      savePreferences: vi.fn(async () => { throw new Error('disk unavailable'); })
    };
    const coordinator = new PreferencesCoordinator(state, {
      applyPreferences: async (previous, next) => { transitions.push([previous.startAtLogin, next.startAtLogin]); }
    });

    await expect(coordinator.update({ ...initialPreferences, startAtLogin: true })).rejects.toThrow('disk unavailable');
    expect(transitions).toEqual([[false, true], [true, false]]);
  });

  it('reports both persistence and compensation failures', async () => {
    const coordinator = new PreferencesCoordinator({
      getPreferences: () => structuredClone(initialPreferences),
      savePreferences: async () => { throw new Error('disk unavailable'); }
    }, {
      applyPreferences: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('system rollback failed'))
    });

    const failure = await coordinator.update({ ...initialPreferences, startAtLogin: true }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
  });
});
