import { useSyncExternalStore } from 'react';
import type {
  AriadneApi,
  SpeechEvent,
  SpeechStatus,
  UserPreferences,
  VoicePackInstallResult,
  SpeechVoiceSummary
} from '@shared/contract';
import type { TypedEventBus } from '../events/typed-event-bus';
import type { AppEventMap } from '../events/app-events';
import type { SpeechAgentBridgePort } from './speech-agent-bridge';

export interface SpeechCoordinatorSnapshot {
  initialized: boolean;
  status: SpeechStatus;
  foregroundRequestId: string | null;
  lastError: string | null;
}

/** Renderer-facing Speech UI state and foreground Composer bridge. */
export class SpeechCoordinator {
  private readonly listeners = new Set<() => void>();
  private initialized = false;
  private status: SpeechStatus = {
    protocolVersion: 1,
    availability: 'unavailable',
    activity: 'idle',
    detail: 'Speech has not initialized.',
    moduleRoot: 'E:\\AI\\AriadneSpeech',
    capabilities: [],
    inputDevices: [],
    outputDevices: [],
    voices: []
  };
  private foregroundRequestId: string | null = null;
  private preferences: UserPreferences | null = null;
  private lastError: string | null = null;
  private removeSpeechListener: (() => void) | null = null;
  private removePreferenceListener: (() => void) | null = null;
  private removeBridgeErrorListener: (() => void) | null = null;
  private snapshot: SpeechCoordinatorSnapshot;

  constructor(
    private readonly api: AriadneApi['speech'],
    private readonly preferencesApi: AriadneApi['preferences'],
    private readonly agentBridge: SpeechAgentBridgePort,
    private readonly events: TypedEventBus<AppEventMap>
  ) {
    this.snapshot = this.createSnapshot();
  }

  getSnapshot = (): SpeechCoordinatorSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.removeSpeechListener = this.api.onEvent((event) => this.acceptSpeechEvent(event));
    this.removePreferenceListener = this.events.subscribe('preferences:changed', (preferences) => {
      this.preferences = structuredClone(preferences);
      this.publish();
    });
    this.removeBridgeErrorListener = this.agentBridge.onError((error) => {
      this.lastError = error.message;
      this.publish();
    });
    this.agentBridge.initialize();
    const [status, preferences] = await Promise.all([this.api.getStatus(), this.preferencesApi.load()]);
    this.status = status;
    this.preferences = preferences;
    this.initialized = true;
    this.publish();
  }

  dispose(): void {
    this.removeSpeechListener?.();
    this.removePreferenceListener?.();
    this.removeBridgeErrorListener?.();
    this.removeSpeechListener = null;
    this.removePreferenceListener = null;
    this.removeBridgeErrorListener = null;
    this.agentBridge.dispose();
    this.initialized = false;
    this.publish();
  }

  async toggleForegroundRecognition(): Promise<void> {
    if (this.foregroundRequestId) {
      const requestId = this.foregroundRequestId;
      this.foregroundRequestId = null;
      this.publish();
      await this.api.stopRecognition({ requestId });
      return;
    }
    const requestId = crypto.randomUUID();
    this.foregroundRequestId = requestId;
    this.lastError = null;
    this.publish();
    try {
      this.agentBridge.cancelVoiceTurn();
      await this.api.cancelSynthesis();
      await this.api.startRecognition({ requestId, source: 'foreground' });
    } catch (error) {
      this.foregroundRequestId = null;
      this.lastError = errorMessage(error);
      this.publish();
      throw error;
    }
  }

  async cancelRecognition(): Promise<void> {
    this.foregroundRequestId = null;
    this.publish();
    await this.api.cancelRecognition();
  }

  importVoicePack(): Promise<VoicePackInstallResult | null> {
    return this.api.importVoicePack();
  }

  activateVoice(voiceId: string, version: string): Promise<SpeechVoiceSummary> {
    return this.api.activateVoice({ voiceId, version });
  }

  private acceptSpeechEvent(event: SpeechEvent): void {
    if (event.kind === 'status') {
      this.status = event.status;
      this.publish();
      return;
    }
    if (event.kind === 'error') {
      this.lastError = event.message;
      this.publish();
      return;
    }
    if (event.kind === 'transcript.partial' && event.requestId === this.foregroundRequestId) {
      this.events.emit('speech:composer-transcript', { requestId: event.requestId, text: event.text, final: false });
      return;
    }
    if (event.kind !== 'transcript.final') return;
    if (event.requestId === this.foregroundRequestId) this.foregroundRequestId = null;
    this.publish();
    this.agentBridge.cancelVoiceTurn();
    void this.api.cancelSynthesis().catch(() => undefined);
    const mode = this.preferences?.speech.foregroundSttMode ?? 'compose';
    if (event.source === 'foreground' && mode === 'compose') {
      this.events.emit('speech:composer-transcript', { requestId: event.requestId, text: event.text, final: true });
    } else {
      this.agentBridge.acceptVoiceText(event.text, event.source === 'background-wake');
    }
  }

  private publish(): void {
    this.snapshot = this.createSnapshot();
    for (const listener of this.listeners) listener();
  }

  private createSnapshot(): SpeechCoordinatorSnapshot {
    return {
      initialized: this.initialized,
      status: structuredClone(this.status),
      foregroundRequestId: this.foregroundRequestId,
      lastError: this.lastError
    };
  }
}

export function useSpeechSnapshot(coordinator: SpeechCoordinator): SpeechCoordinatorSnapshot {
  return useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
}

export { splitSpeakableSegments } from './speech-agent-bridge';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
