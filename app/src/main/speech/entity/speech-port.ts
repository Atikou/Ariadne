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

/** Main-process boundary for one compiled Speech Entity. */
export interface SpeechPort {
  initialize(preferences: SpeechPreferences): Promise<void>;
  getStatus(): SpeechStatus;
  onEvent(listener: (event: SpeechEvent) => void): () => void;
  applyPreferences(previous: SpeechPreferences, next: SpeechPreferences): Promise<void>;
  setBackground(background: boolean): void;
  setLockedOrSuspended(value: boolean): void;
  startRecognition(request: StartSpeechRecognitionRequest): Promise<void>;
  stopRecognition(request: StopSpeechRecognitionRequest): Promise<void>;
  cancelRecognition(): Promise<void>;
  synthesize(request: SpeechSynthesisSegmentRequest): Promise<void>;
  cancelSynthesis(request?: CancelSpeechSynthesisRequest): Promise<void>;
  installVoicePack(archivePath: string): Promise<VoicePackInstallResult>;
  activateVoice(request: ActivateSpeechVoiceRequest): Promise<SpeechVoiceSummary>;
  dispose(): Promise<void>;
}
