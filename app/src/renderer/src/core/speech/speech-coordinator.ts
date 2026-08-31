import { useSyncExternalStore } from 'react';
import { PERSONAL_ASSISTANT_WORKSPACE_ID } from '@ariadne/protocol/public';
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
import type { RuntimeRun, RuntimeSnapshot, RuntimeStore } from '../runtime/runtime-store';

const BACKGROUND_SESSION_KEY = 'ariadne.speech.background-session.v1';
const ACTIVE_RUN_STATUSES = new Set([
  'queued', 'running', 'waiting_permission', 'waiting_decision', 'waiting_budget',
  'waiting_children', 'cancelling', 'paused'
]);

export interface SpeechCoordinatorSnapshot {
  initialized: boolean;
  status: SpeechStatus;
  foregroundRequestId: string | null;
  lastError: string | null;
}

interface VoiceTurn {
  sourceMessageId: string;
  sessionId: string;
  runId: string | null;
  observed: string;
  pending: string;
  sequence: number;
  finalQueued: boolean;
  idleTimer: number | null;
}

interface QueuedVoiceTurn {
  sessionId: string;
  afterRunId: string;
  enqueuedAt: string;
}

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
  private removeRuntimeListener: (() => void) | null = null;
  private removePreferenceListener: (() => void) | null = null;
  private voiceTurn: VoiceTurn | null = null;
  private queuedVoiceTurn: QueuedVoiceTurn | null = null;
  private synthesisGeneration = 0;
  private synthesisQueue: Promise<void> = Promise.resolve();
  private commandQueue: Promise<void> = Promise.resolve();
  private snapshot: SpeechCoordinatorSnapshot;

  constructor(
    private readonly api: AriadneApi['speech'],
    private readonly preferencesApi: AriadneApi['preferences'],
    private readonly runtime: RuntimeStore,
    private readonly events: TypedEventBus<AppEventMap>,
    private readonly storage: Storage
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
    this.removeRuntimeListener = this.runtime.subscribe(() => this.acceptRuntimeSnapshot(this.runtime.getSnapshot()));
    this.removePreferenceListener = this.events.subscribe('preferences:changed', (preferences) => {
      this.preferences = structuredClone(preferences);
      this.publish();
    });
    const [status, preferences] = await Promise.all([this.api.getStatus(), this.preferencesApi.load()]);
    this.status = status;
    this.preferences = preferences;
    this.initialized = true;
    this.publish();
  }

  dispose(): void {
    this.removeSpeechListener?.();
    this.removeRuntimeListener?.();
    this.removePreferenceListener?.();
    this.removeSpeechListener = null;
    this.removeRuntimeListener = null;
    this.removePreferenceListener = null;
    this.abandonVoiceTurn();
    this.queuedVoiceTurn = null;
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
      this.abandonVoiceTurn();
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

  async activateVoice(voiceId: string, version: string): Promise<SpeechVoiceSummary> {
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
    if (event.kind === 'transcript.final') {
      if (event.requestId === this.foregroundRequestId) this.foregroundRequestId = null;
      this.publish();
      this.abandonVoiceTurn();
      void this.api.cancelSynthesis().catch(() => undefined);
      const mode = this.preferences?.speech.foregroundSttMode ?? 'compose';
      if (event.source === 'foreground' && mode === 'compose') {
        this.events.emit('speech:composer-transcript', { requestId: event.requestId, text: event.text, final: true });
      } else {
        this.commandQueue = this.commandQueue
          .then(() => this.dispatchVoiceText(event.text, event.source === 'background-wake'))
          .catch((error) => {
            this.lastError = errorMessage(error);
            this.publish();
          });
      }
    }
  }

  private async dispatchVoiceText(text: string, background: boolean): Promise<void> {
    const content = text.trim();
    if (!content) return;
    const snapshot = this.runtime.getSnapshot();
    const sessionId = background ? this.resolveBackgroundSession(snapshot) : snapshot.selectedSessionId;
    const activeRun = snapshot.runs.find((run) => (
      run.parentRunId === undefined
      && run.sessionId === sessionId
      && ACTIVE_RUN_STATUSES.has(run.status)
    ));
    if (activeRun) {
      await this.enqueueLatestVoiceInput(activeRun, content);
      this.queuedVoiceTurn = {
        sessionId: activeRun.sessionId ?? sessionId ?? '',
        afterRunId: activeRun.runId,
        enqueuedAt: new Date().toISOString()
      };
      this.storage.setItem(BACKGROUND_SESSION_KEY, activeRun.sessionId ?? '');
      return;
    }
    const result = await this.runtime.messages.send(content, {
      ...(background ? { workspaceId: PERSONAL_ASSISTANT_WORKSPACE_ID } : {}),
      ...(sessionId ? { sessionId } : {}),
      selectSession: !background
    });
    if (background) this.storage.setItem(BACKGROUND_SESSION_KEY, result.sessionId);
    this.beginVoiceTurn(result.messageId, result.sessionId);
  }

  private resolveBackgroundSession(snapshot: RuntimeSnapshot): string | null {
    const stored = this.storage.getItem(BACKGROUND_SESSION_KEY);
    if (stored && snapshot.sessions.some((session) => (
      session.sessionId === stored && session.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID
    ))) return stored;
    const candidate = snapshot.sessions
      .filter((session) => session.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return candidate?.sessionId ?? null;
  }

  private async enqueueLatestVoiceInput(run: RuntimeRun, content: string): Promise<void> {
    const queued = run.inbox.find((input) => input.state === 'queued' && input.source === undefined);
    if (queued) {
      await this.runtime.runs.replaceInput(run, queued.inputId, queued.version, content);
      return;
    }
    const receipt = await this.runtime.runs.enqueueInput(run, content, 'next_turn');
    if (receipt.state === 'failed') {
      throw new Error(receipt.error ?? 'Agent 输入提交失败。');
    }
  }

  private beginVoiceTurn(sourceMessageId: string, sessionId: string, runId: string | null = null): void {
    this.abandonVoiceTurn();
    this.voiceTurn = {
      sourceMessageId,
      sessionId,
      runId,
      observed: '',
      pending: '',
      sequence: 0,
      finalQueued: false,
      idleTimer: null
    };
  }

  private acceptRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
    if (!this.voiceTurn && this.queuedVoiceTurn) {
      const queued = this.queuedVoiceTurn;
      const nextRun = snapshot.runs
        .filter((run) => run.parentRunId === undefined
          && run.sessionId === queued.sessionId
          && run.runId !== queued.afterRunId
          && run.startedAt !== undefined
          && run.startedAt >= queued.enqueuedAt)
        .sort((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''))[0];
      if (nextRun) {
        this.beginVoiceTurn(nextRun.sourceMessageId ?? `queued:${nextRun.runId}`, queued.sessionId, nextRun.runId);
        this.queuedVoiceTurn = null;
      }
    }
    const turn = this.voiceTurn;
    if (!turn) return;
    if (!turn.runId) {
      turn.runId = snapshot.runs.find((run) => run.sourceMessageId === turn.sourceMessageId)?.runId ?? null;
    }
    if (!turn.runId) return;
    const run = snapshot.runs.find((candidate) => candidate.runId === turn.runId);
    const assistant = snapshot.messages
      .filter((message) => message.runId === turn.runId && message.role === 'assistant')
      .sort((left, right) => Number(left.status === 'streaming') - Number(right.status === 'streaming'))
      .at(-1);
    if (assistant) this.acceptAssistantContent(turn, assistant.content);
    if (run && !ACTIVE_RUN_STATUSES.has(run.status) && !turn.finalQueued) {
      this.flushTurn(turn, true);
    }
  }

  private acceptAssistantContent(turn: VoiceTurn, content: string): void {
    if (content === turn.observed) return;
    const delta = content.startsWith(turn.observed) ? content.slice(turn.observed.length) : content;
    turn.observed = content;
    turn.pending += delta;
    this.flushTurn(turn, false);
    if (turn.idleTimer !== null) window.clearTimeout(turn.idleTimer);
    if (turn.pending.length >= 32) {
      turn.idleTimer = window.setTimeout(() => this.flushTurn(turn, false, true), 350);
    }
  }

  private flushTurn(turn: VoiceTurn, final: boolean, idle = false): void {
    if (turn !== this.voiceTurn || turn.finalQueued) return;
    const segments = splitSpeakableSegments(turn.pending, final, idle);
    turn.pending = segments.remainder;
    for (const text of segments.ready) {
      const sequence = turn.sequence++;
      const generation = this.synthesisGeneration;
      this.synthesisQueue = this.synthesisQueue.then(() => generation === this.synthesisGeneration && turn === this.voiceTurn
        ? this.api.synthesize({
            turnId: turn.runId ?? turn.sourceMessageId,
            sequence,
            text,
            final: final && text === segments.ready.at(-1) && segments.remainder.length === 0
          })
        : undefined).catch((error) => {
        this.lastError = errorMessage(error);
        this.publish();
      });
    }
    if (final) {
      turn.finalQueued = true;
      if (turn.pending.trim()) {
        const text = turn.pending.trim();
        turn.pending = '';
        const sequence = turn.sequence++;
        const generation = this.synthesisGeneration;
        this.synthesisQueue = this.synthesisQueue.then(() => generation === this.synthesisGeneration && turn === this.voiceTurn
          ? this.api.synthesize({
              turnId: turn.runId ?? turn.sourceMessageId,
              sequence,
              text,
              final: true
            })
          : undefined).catch(() => undefined);
      }
    }
  }

  private abandonVoiceTurn(): void {
    const idleTimer = this.voiceTurn?.idleTimer;
    if (idleTimer !== null && idleTimer !== undefined) window.clearTimeout(idleTimer);
    this.voiceTurn = null;
    this.synthesisGeneration += 1;
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

export function splitSpeakableSegments(
  input: string,
  final: boolean,
  idle = false
): { ready: string[]; remainder: string } {
  const ready: string[] = [];
  let remainder = input;
  const boundary = /[。！？!?；;\n]/u;
  while (remainder.length > 0) {
    const match = boundary.exec(remainder);
    if (match?.index !== undefined) {
      const end = match.index + match[0].length;
      const segment = remainder.slice(0, end).trim();
      remainder = remainder.slice(end);
      if (segment) ready.push(segment);
      continue;
    }
    if (remainder.length >= 80) {
      ready.push(remainder.slice(0, 80).trim());
      remainder = remainder.slice(80);
      continue;
    }
    if ((final || idle) && remainder.trim()) {
      ready.push(remainder.trim());
      remainder = '';
    }
    break;
  }
  return { ready, remainder };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
