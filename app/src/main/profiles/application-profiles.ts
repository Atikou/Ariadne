import type { ApplicationProfileDefinition } from '@shared/application-profile';
import {
  NO_SPEECH_COMPONENT_IDS,
  SPEECH_COMPONENT_IDS
} from '../speech/entity/speech-component-ids';
import { speechComponentDefinitions } from '../speech/entity/SpeechComponentCatalog.generated';

const UI_COMPONENT_IDS = Object.freeze([
  'agent.plan', 'agent.status', 'chat.main', 'files.explorer', 'logs',
  'permissions', 'productivity.control', 'session.activity',
  'settings', 'terminal', 'tools.output'
]);
// Preview-only modules stay registered for development and future completion,
// but must not enter the formal desktop product profiles by default.
const PREVIEW_UI_COMPONENT_IDS = Object.freeze([
  ...UI_COMPONENT_IDS,
  'review.visual'
]);

export const DESKTOP_DEFAULT_PROFILE = profile(
  'desktop-default',
  speechComponentDefinitions().map((definition) => definition.id)
);
export const DESKTOP_PREVIEW_PROFILE = profile(
  'desktop-preview',
  speechComponentDefinitions().map((definition) => definition.id),
  PREVIEW_UI_COMPONENT_IDS
);
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
  DESKTOP_PREVIEW_PROFILE,
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
  speechComponentIds: readonly string[],
  uiComponentIds: readonly string[] = UI_COMPONENT_IDS
): ApplicationProfileDefinition {
  return Object.freeze({
    id,
    revision: 4,
    entities: Object.freeze([
      Object.freeze({ entity: 'agent' as const, componentIds: Object.freeze(['*']) }),
      Object.freeze({ entity: 'ui' as const, componentIds: Object.freeze([...uiComponentIds]) }),
      Object.freeze({ entity: 'speech' as const, componentIds: Object.freeze([...speechComponentIds]) })
    ])
  });
}
