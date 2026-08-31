import { defineComponent, type ComponentDefinition } from '@ariadne/component-contracts';

export const SPEECH_COMPONENT_IDS = Object.freeze({
  core: 'speech.core',
  sidecar: 'speech.driver.sidecar',
  stt: 'speech.stt',
  tts: 'speech.tts',
  kws: 'speech.kws',
  voicePack: 'speech.voice-pack',
  rendererBridge: 'speech.bridge.renderer',
  agentBridge: 'speech.bridge.agent'
} as const);

export const SPEECH_COMPONENT_DEFINITIONS: readonly ComponentDefinition[] = Object.freeze([
  defineComponent({ id: SPEECH_COMPONENT_IDS.core, version: '1.0.0', entity: 'speech', required: true }),
  defineComponent({ id: SPEECH_COMPONENT_IDS.sidecar, version: '1.0.0', entity: 'speech', dependsOn: [SPEECH_COMPONENT_IDS.core] }),
  defineComponent({ id: SPEECH_COMPONENT_IDS.stt, version: '1.0.0', entity: 'speech', dependsOn: [SPEECH_COMPONENT_IDS.sidecar] }),
  defineComponent({ id: SPEECH_COMPONENT_IDS.tts, version: '1.0.0', entity: 'speech', dependsOn: [SPEECH_COMPONENT_IDS.sidecar] }),
  defineComponent({ id: SPEECH_COMPONENT_IDS.kws, version: '1.0.0', entity: 'speech', dependsOn: [SPEECH_COMPONENT_IDS.stt] }),
  defineComponent({ id: SPEECH_COMPONENT_IDS.voicePack, version: '1.0.0', entity: 'speech', dependsOn: [SPEECH_COMPONENT_IDS.tts] }),
  defineComponent({ id: SPEECH_COMPONENT_IDS.rendererBridge, version: '1.0.0', entity: 'speech', dependsOn: [SPEECH_COMPONENT_IDS.core] }),
  defineComponent({ id: SPEECH_COMPONENT_IDS.agentBridge, version: '1.0.0', entity: 'speech', dependsOn: [SPEECH_COMPONENT_IDS.rendererBridge] })
]);

export const DEFAULT_SPEECH_COMPONENT_IDS = Object.freeze(
  SPEECH_COMPONENT_DEFINITIONS.map((definition) => definition.id)
);

export const NO_SPEECH_COMPONENT_IDS = Object.freeze([SPEECH_COMPONENT_IDS.core]);
