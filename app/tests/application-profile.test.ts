import { describe, expect, it } from 'vitest';
import {
  applicationProfileComponents,
  compileApplicationProfile
} from '../src/shared/application-profile';
import {
  DESKTOP_DEFAULT_PROFILE,
  DESKTOP_NO_SPEECH_PROFILE,
  DESKTOP_STT_ONLY_PROFILE,
  DESKTOP_TTS_ONLY_PROFILE,
  resolveApplicationProfile
} from '../src/main/profiles/application-profiles';
import { compileSpeechEntity } from '../src/main/speech/entity/speech-entity-compiler';

describe('Application Profile', () => {
  it('compiles a canonical immutable digest', async () => {
    const first = await compileApplicationProfile(DESKTOP_DEFAULT_PROFILE);
    const second = await compileApplicationProfile({
      ...DESKTOP_DEFAULT_PROFILE,
      entities: [...DESKTOP_DEFAULT_PROFILE.entities].reverse()
    });

    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.entities.every((entity) => /^sha256:[a-f0-9]{64}$/u.test(entity.digest))).toBe(true);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('uses each Speech profile as the actual Speech Entity selection', async () => {
    for (const definition of [
      DESKTOP_DEFAULT_PROFILE,
      DESKTOP_NO_SPEECH_PROFILE,
      DESKTOP_STT_ONLY_PROFILE,
      DESKTOP_TTS_ONLY_PROFILE
    ]) {
      const profile = await compileApplicationProfile(definition);
      const speech = compileSpeechEntity(applicationProfileComponents(profile, 'speech'));
      expect(speech.manifest.components.length).toBeGreaterThan(0);
      await speech.dispose();
    }
    const noSpeech = await compileApplicationProfile(DESKTOP_NO_SPEECH_PROFILE);
    expect(applicationProfileComponents(noSpeech, 'speech')).toEqual(['speech.core']);
  });

  it('fails closed for an unknown configured profile', () => {
    expect(() => resolveApplicationProfile('unknown-profile'))
      .toThrow('application_profile_unknown:unknown-profile');
  });

  it('fails before readiness when a cross-entity Speech bridge dependency is missing', async () => {
    await expect(compileApplicationProfile({
      id: 'invalid-bridge',
      revision: 1,
      entities: [
        { entity: 'agent', componentIds: ['*'] },
        { entity: 'ui', componentIds: ['*'] },
        { entity: 'speech', componentIds: ['speech.core', 'speech.bridge.agent'] }
      ]
    })).rejects.toThrow('application_profile_cross_entity_missing:speech.bridge.renderer');
  });
});
