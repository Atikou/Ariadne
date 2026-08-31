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

export type SpeechCapability = SpeechStatus['capabilities'][number];

/** Fail-closed capability view over a concrete Speech driver. */
export class CapabilitySpeechAdapter implements SpeechPort {
  private readonly capabilities: ReadonlySet<SpeechCapability>;

  constructor(
    private readonly driver: SpeechPort,
    capabilities: readonly SpeechCapability[]
  ) {
    this.capabilities = new Set(capabilities);
  }

  initialize(preferences: SpeechPreferences): Promise<void> {
    return this.driver.initialize(preferences);
  }

  getStatus(): SpeechStatus {
    const status = this.driver.getStatus();
    return {
      ...status,
      capabilities: status.capabilities.filter((item) => this.capabilities.has(item)),
      voices: this.capabilities.has('voice-pack') ? status.voices : []
    };
  }

  onEvent(listener: (event: SpeechEvent) => void): () => void {
    return this.driver.onEvent((event) => {
      listener(event.kind === 'status' ? { kind: 'status', status: this.getStatus() } : event);
    });
  }

  applyPreferences(previous: SpeechPreferences, next: SpeechPreferences): Promise<void> {
    return this.driver.applyPreferences(previous, next);
  }

  setBackground(background: boolean): void {
    this.driver.setBackground(background);
  }

  setLockedOrSuspended(value: boolean): void {
    this.driver.setLockedOrSuspended(value);
  }

  startRecognition(request: StartSpeechRecognitionRequest): Promise<void> {
    this.require('stt');
    return this.driver.startRecognition(request);
  }

  stopRecognition(request: StopSpeechRecognitionRequest): Promise<void> {
    this.require('stt');
    return this.driver.stopRecognition(request);
  }

  cancelRecognition(): Promise<void> {
    this.require('stt');
    return this.driver.cancelRecognition();
  }

  synthesize(request: SpeechSynthesisSegmentRequest): Promise<void> {
    this.require('tts');
    return this.driver.synthesize(request);
  }

  cancelSynthesis(request: CancelSpeechSynthesisRequest = {}): Promise<void> {
    this.require('tts');
    return this.driver.cancelSynthesis(request);
  }

  installVoicePack(archivePath: string): Promise<VoicePackInstallResult> {
    this.require('voice-pack');
    return this.driver.installVoicePack(archivePath);
  }

  activateVoice(request: ActivateSpeechVoiceRequest): Promise<SpeechVoiceSummary> {
    this.require('voice-pack');
    return this.driver.activateVoice(request);
  }

  dispose(): Promise<void> {
    return this.driver.dispose();
  }

  private require(capability: SpeechCapability): void {
    if (!this.capabilities.has(capability)) {
      throw new Error(`speech_capability_unavailable:${capability}`);
    }
  }
}
