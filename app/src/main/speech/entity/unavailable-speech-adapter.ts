import { EventEmitter } from 'node:events';
import type {
  ActivateSpeechVoiceRequest,
  CancelSpeechSynthesisRequest,
  SpeechEvent,
  SpeechPreferences,
  SpeechStatus,
  SpeechSynthesisSegmentRequest,
  SpeechVoiceSummary,
  StartSpeechRecognitionRequest,
  StopSpeechRecognitionRequest,
  VoicePackInstallResult
} from '@shared/contract';
import type { SpeechPort } from './speech-port';

/** Stable no-process implementation used when a profile omits Speech drivers. */
export class UnavailableSpeechAdapter implements SpeechPort {
  private readonly events = new EventEmitter();
  private status = unavailableStatus('E:\\AI\\AriadneSpeech');

  async initialize(preferences: SpeechPreferences): Promise<void> {
    this.status = unavailableStatus(preferences.moduleRoot);
  }

  getStatus(): SpeechStatus {
    return structuredClone(this.status);
  }

  onEvent(listener: (event: SpeechEvent) => void): () => void {
    this.events.on('speech', listener);
    return () => this.events.off('speech', listener);
  }

  async applyPreferences(_previous: SpeechPreferences, next: SpeechPreferences): Promise<void> {
    this.status = unavailableStatus(next.moduleRoot);
    this.events.emit('speech', { kind: 'status', status: this.getStatus() } satisfies SpeechEvent);
  }

  setBackground(_background: boolean): void {}
  setLockedOrSuspended(_value: boolean): void {}

  startRecognition(_request: StartSpeechRecognitionRequest): Promise<void> {
    return unavailable('stt');
  }

  stopRecognition(_request: StopSpeechRecognitionRequest): Promise<void> {
    return unavailable('stt');
  }

  cancelRecognition(): Promise<void> {
    return unavailable('stt');
  }

  synthesize(_request: SpeechSynthesisSegmentRequest): Promise<void> {
    return unavailable('tts');
  }

  cancelSynthesis(_request: CancelSpeechSynthesisRequest = {}): Promise<void> {
    return unavailable('tts');
  }

  installVoicePack(_archivePath: string): Promise<VoicePackInstallResult> {
    return unavailable('voice-pack');
  }

  activateVoice(_request: ActivateSpeechVoiceRequest): Promise<SpeechVoiceSummary> {
    return unavailable('voice-pack');
  }

  async dispose(): Promise<void> {
    this.events.removeAllListeners();
  }
}

function unavailableStatus(moduleRoot: string): SpeechStatus {
  return {
    protocolVersion: 1,
    availability: 'disabled',
    activity: 'idle',
    detail: 'Speech drivers are not enabled by the application profile.',
    moduleRoot,
    capabilities: [],
    inputDevices: [],
    outputDevices: [],
    voices: []
  };
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new Error(`speech_capability_unavailable:${capability}`));
}
