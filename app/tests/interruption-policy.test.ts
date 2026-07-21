import { describe, expect, it } from 'vitest';
import type { GameActivitySnapshot, UserPreferences } from '@shared/contract';
import { InterruptionPolicy } from '../src/main/services/interruption-policy';
import { DEFAULT_PREFERENCES } from '../src/main/persistence/state-schema';

const activeGame: GameActivitySnapshot = {
  status: 'active',
  confidence: 0.98,
  reason: 'exclusive fullscreen',
  observedAt: '2026-07-17T00:00:00.000Z'
};

describe('InterruptionPolicy', () => {
  const policy = new InterruptionPolicy();
  const preferences: UserPreferences = structuredClone(DEFAULT_PREFERENCES);

  it('never blocks an explicit user action', () => {
    expect(policy.evaluate(
      { source: 'user', allowTemporaryTopmost: true },
      activeGame,
      preferences
    )).toEqual({ allow: true, allowTemporaryTopmost: true });
  });

  it('suppresses automatic wake while a game is active', () => {
    const decision = policy.evaluate(
      { source: 'voice', allowTemporaryTopmost: true },
      activeGame,
      preferences
    );
    expect(decision.allow).toBe(false);
    expect(decision.allowTemporaryTopmost).toBe(false);
  });

  it('allows an unknown detector result without forcing topmost', () => {
    const decision = policy.evaluate(
      { source: 'system', allowTemporaryTopmost: true },
      { ...activeGame, status: 'unknown', confidence: 0 },
      preferences
    );
    expect(decision).toEqual({ allow: true, allowTemporaryTopmost: false });
  });
});
