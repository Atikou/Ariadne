import type { ApplicationProfileDefinition } from '@shared/application-profile';
import {
  DEFAULT_SPEECH_COMPONENT_IDS,
  NO_SPEECH_COMPONENT_IDS,
  SPEECH_COMPONENT_IDS
} from '../speech/entity/speech-components';

const UI_COMPONENT_IDS = Object.freeze([
  'agent.plan', 'agent.status', 'chat.main', 'files.explorer', 'logs',
  'permissions', 'productivity.control', 'session.activity', 'settings',
  'terminal', 'tools.output', 'runtime.health'
]);

export const DESKTOP_DEFAULT_PROFILE = profile('desktop-default', DEFAULT_SPEECH_COMPONENT_IDS);
export const DESKTOP_NO_SPEECH_PROFILE = profile('desktop-no-speech', NO_SPEECH_COMPONENT_IDS);
export const DESKTOP_STT_ONLY_PROFILE = profile('desktop-stt-only', [
  SPEECH_COMPONENT_IDS.core,
  SPEECH_COMPONENT_IDS.sidecar,
  SPEECH_COMPONENT_IDS.stt,
  SPEECH_COMPONENT_IDS.rendererBridge,
  SPEECH_COMPONENT_IDS.agentBridge
]);
export const DESKTOP_TTS_ONLY_PROFILE = profile('desktop-tts-only', [
  SPEECH_COMPONENT_IDS.core,
  SPEECH_COMPONENT_IDS.sidecar,
  SPEECH_COMPONENT_IDS.tts,
  SPEECH_COMPONENT_IDS.voicePack,
  SPEECH_COMPONENT_IDS.rendererBridge,
  SPEECH_COMPONENT_IDS.agentBridge
]);

const PROFILES = new Map([
  DESKTOP_DEFAULT_PROFILE,
  DESKTOP_NO_SPEECH_PROFILE,
  DESKTOP_STT_ONLY_PROFILE,
  DESKTOP_TTS_ONLY_PROFILE
].map((item) => [item.id, item]));

export function resolveApplicationProfile(
  id = process.env.ARIADNE_APPLICATION_PROFILE ?? DESKTOP_DEFAULT_PROFILE.id
): ApplicationProfileDefinition {
  const profile = PROFILES.get(id);
  if (!profile) throw new Error(`application_profile_unknown:${id}`);
  return profile;
}

function profile(
  id: string,
  speechComponentIds: readonly string[]
): ApplicationProfileDefinition {
  return Object.freeze({
    id,
    revision: 1,
    entities: Object.freeze([
      Object.freeze({ entity: 'agent' as const, componentIds: Object.freeze(['*']) }),
      Object.freeze({ entity: 'ui' as const, componentIds: UI_COMPONENT_IDS }),
      Object.freeze({ entity: 'speech' as const, componentIds: Object.freeze([...speechComponentIds]) })
    ])
  });
}
