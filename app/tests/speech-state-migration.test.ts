import { describe, expect, it } from 'vitest';
import { parsePersistedState } from '../src/main/persistence/state-schema';

describe('speech preference migration', () => {
  it('migrates v1 state without discarding layout or desktop preferences', () => {
    const migrated = parsePersistedState({
      schemaVersion: 1,
      window: { bounds: { x: 1, y: 2, width: 900, height: 700 }, isMaximized: true },
      layout: { schemaVersion: 1, layout: { selected: 'chat' }, savedAt: '2026-08-28T00:00:00.000Z' },
      preferences: {
        runInBackground: false,
        startAtLogin: true,
        theme: 'dark',
        suppressAutomaticWakeDuringGames: false,
        gameDetectionRules: []
      }
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.window.isMaximized).toBe(true);
    expect(migrated.layout?.layout).toEqual({ selected: 'chat' });
    expect(migrated.preferences.theme).toBe('dark');
    expect(migrated.preferences.speech).toMatchObject({
      enabled: false,
      moduleRoot: 'E:\\AI\\AriadneSpeech',
      backgroundWakeEnabled: false,
      listenWhenLocked: false,
      activeVoiceId: 'zh-cn-melo-official',
      activeVoiceVersion: '1.0.0'
    });
  });
});
