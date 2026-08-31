import { describe, expect, it, vi } from 'vitest';
import type { SpeechPort } from '../src/main/speech/entity/speech-port';
import { CapabilitySpeechAdapter } from '../src/main/speech/entity/capability-speech-adapter';
import { compileSpeechEntity } from '../src/main/speech/entity/speech-entity-compiler';
import {
  NO_SPEECH_COMPONENT_IDS,
  SPEECH_COMPONENT_IDS
} from '../src/main/speech/entity/speech-components';

describe('Speech Entity compiler', () => {
  it('builds a process-free no-speech entity', async () => {
    const entity = compileSpeechEntity(NO_SPEECH_COMPONENT_IDS);
    await entity.initialize(preferences());

    expect(entity.manifest.components.map((item) => item.id)).toEqual(['speech.core']);
    expect(entity.getStatus()).toMatchObject({ availability: 'disabled', capabilities: [] });
    await expect(entity.startRecognition({ requestId: 'request-1', source: 'foreground' }))
      .rejects.toThrow('speech_capability_unavailable:stt');
    await entity.dispose();
  });

  it('rejects unknown, duplicate, missing required, and incomplete component graphs', () => {
    expect(() => compileSpeechEntity(['speech.unknown'])).toThrow('speech_component_unknown:speech.unknown');
    expect(() => compileSpeechEntity([SPEECH_COMPONENT_IDS.core, SPEECH_COMPONENT_IDS.core]))
      .toThrow('speech_component_duplicate');
    expect(() => compileSpeechEntity([])).toThrow('speech_required_component_missing:speech.core');
    expect(() => compileSpeechEntity([SPEECH_COMPONENT_IDS.core, SPEECH_COMPONENT_IDS.stt]))
      .toThrow('speech_component_dependency_missing:speech.driver.sidecar');
  });

  it('allows STT and TTS to be independently selected and fails closed', () => {
    const driver = speechDriver();
    const sttOnly = new CapabilitySpeechAdapter(driver, ['stt']);
    expect(sttOnly.getStatus().capabilities).toEqual(['stt']);
    expect(sttOnly.getStatus().voices).toEqual([]);
    expect(() => sttOnly.synthesize({ turnId: 'turn', sequence: 0, text: 'hello', final: true }))
      .toThrow('speech_capability_unavailable:tts');

    const ttsOnly = new CapabilitySpeechAdapter(driver, ['tts', 'voice-pack']);
    expect(ttsOnly.getStatus().capabilities).toEqual(['tts', 'voice-pack']);
    expect(() => ttsOnly.startRecognition({ requestId: 'request-2', source: 'foreground' }))
      .toThrow('speech_capability_unavailable:stt');
  });
});

function speechDriver(): SpeechPort {
  return {
    initialize: vi.fn(async () => undefined),
    getStatus: () => ({
      protocolVersion: 1,
      availability: 'available',
      activity: 'idle',
      detail: 'test',
      moduleRoot: 'test',
      capabilities: ['stt', 'tts', 'kws', 'voice-pack'],
      inputDevices: [],
      outputDevices: [],
      voices: [{
        voiceId: 'test', version: '1.0.0', displayName: 'Test', languages: ['en'],
        sampleRate: 24_000, active: true
      }]
    }),
    onEvent: () => () => undefined,
    applyPreferences: vi.fn(async () => undefined),
    setBackground: vi.fn(),
    setLockedOrSuspended: vi.fn(),
    startRecognition: vi.fn(async () => undefined),
    stopRecognition: vi.fn(async () => undefined),
    cancelRecognition: vi.fn(async () => undefined),
    synthesize: vi.fn(async () => undefined),
    cancelSynthesis: vi.fn(async () => undefined),
    installVoicePack: vi.fn(async () => ({
      installed: true,
      voice: {
        voiceId: 'test', version: '1.0.0', displayName: 'Test', languages: ['en'],
        sampleRate: 24_000, active: true
      },
      detail: 'installed'
    })),
    activateVoice: vi.fn(async () => ({
      voiceId: 'test', version: '1.0.0', displayName: 'Test', languages: ['en'],
      sampleRate: 24_000, active: true
    })),
    dispose: vi.fn(async () => undefined)
  };
}

function preferences() {
  return {
    enabled: false,
    moduleRoot: 'E:\\AI\\AriadneSpeech',
    foregroundSttMode: 'compose' as const,
    backgroundWakeEnabled: false,
    wakeKeywords: ['Ariadne'],
    listenWhenLocked: false,
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    activeVoiceId: null,
    activeVoiceVersion: null
  };
}
