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

export const NO_SPEECH_COMPONENT_IDS = Object.freeze([SPEECH_COMPONENT_IDS.core]);
