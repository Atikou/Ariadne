import { PERSONAL_ASSISTANT_WORKSPACE_ID } from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import type { MessageFeatureStore } from '../runtime/features/message-feature-store';
import type { RunFeatureStore } from '../runtime/features/run-feature-store';
import type { SessionFeatureStore } from '../runtime/features/session-feature-store';
import type { RuntimeRun } from '../runtime/runtime-projection-presenter';

const BACKGROUND_SESSION_KEY = 'ariadne.speech.background-session.v1';
const ACTIVE_RUN_STATUSES = new Set([
  'queued', 'running', 'waiting_permission', 'waiting_decision', 'waiting_budget',
  'waiting_children', 'cancelling', 'paused'
]);

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

/** Speech-to-Agent/TTS bridge. It only uses public feature stores, never Agent internals. */
export interface SpeechAgentBridgePort {
  initialize(): void;
  dispose(): void;
  onError(listener: (error: Error) => void): () => void;
  acceptVoiceText(text: string, background: boolean): void;
  cancelVoiceTurn(): void;
}

export class SpeechAgentBridge implements SpeechAgentBridgePort {
  private readonly errorListeners = new Set<(error: Error) => void>();
  private removers: Array<() => void> = [];
  private voiceTurn: VoiceTurn | null = null;
  private queuedVoiceTurn: QueuedVoiceTurn | null = null;
  private synthesisGeneration = 0;
  private synthesisQueue: Promise<void> = Promise.resolve();
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: AriadneApi['speech'],
    private readonly messages: MessageFeatureStore,
    private readonly runs: RunFeatureStore,
    private readonly sessions: SessionFeatureStore,
    private readonly storage: Storage
  ) {}

  initialize(): void {
    if (this.removers.length > 0) return;
    const accept = () => this.acceptRuntimeState();
    this.removers = [
      this.messages.view.subscribe(accept),
      this.runs.view.subscribe(accept),
      this.sessions.view.subscribe(accept)
    ];
    this.acceptRuntimeState();
  }

  dispose(): void {
    for (const remove of this.removers) remove();
    this.removers = [];
    this.cancelVoiceTurn();
    this.queuedVoiceTurn = null;
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  acceptVoiceText(text: string, background: boolean): void {
    this.commandQueue = this.commandQueue
      .then(() => this.dispatchVoiceText(text, background))
      .catch((error) => this.publishError(error));
  }

  cancelVoiceTurn(): void {
    const idleTimer = this.voiceTurn?.idleTimer;
    if (idleTimer !== null && idleTimer !== undefined) window.clearTimeout(idleTimer);
    this.voiceTurn = null;
    this.synthesisGeneration += 1;
  }

  private async dispatchVoiceText(text: string, background: boolean): Promise<void> {
    const content = text.trim();
    if (!content) return;
    const sessionSnapshot = this.sessions.view.getSnapshot();
    const runSnapshot = this.runs.view.getSnapshot();
    const sessionId = background
      ? this.resolveBackgroundSession(sessionSnapshot.sessions)
      : sessionSnapshot.selectedSessionId;
    const activeRun = runSnapshot.runs.find((run) => (
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
    const result = await this.messages.send(content, {
      ...(background ? { workspaceId: PERSONAL_ASSISTANT_WORKSPACE_ID } : {}),
      ...(sessionId ? { sessionId } : {}),
      selectSession: !background
    });
    if (background) this.storage.setItem(BACKGROUND_SESSION_KEY, result.sessionId);
    this.beginVoiceTurn(result.messageId, result.sessionId);
  }

  private resolveBackgroundSession(
    sessions: ReturnType<SessionFeatureStore['view']['getSnapshot']>['sessions']
  ): string | null {
    const stored = this.storage.getItem(BACKGROUND_SESSION_KEY);
    if (stored && sessions.some((session) => (
      session.sessionId === stored && session.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID
    ))) return stored;
    const candidate = sessions
      .filter((session) => session.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return candidate?.sessionId ?? null;
  }

  private async enqueueLatestVoiceInput(run: RuntimeRun, content: string): Promise<void> {
    const queued = run.inbox.find((input) => input.state === 'queued' && input.source === undefined);
    if (queued) {
      await this.runs.replaceInput(run, queued.inputId, queued.version, content);
      return;
    }
    const receipt = await this.runs.enqueueInput(run, content, 'next_turn');
    if (receipt.state === 'failed') throw new Error(receipt.error ?? 'Agent 输入提交失败。');
  }

  private beginVoiceTurn(sourceMessageId: string, sessionId: string, runId: string | null = null): void {
    this.cancelVoiceTurn();
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

  private acceptRuntimeState(): void {
    const runs = this.runs.view.getSnapshot().runs;
    const messages = this.messages.view.getSnapshot().messages;
    if (!this.voiceTurn && this.queuedVoiceTurn) {
      const queued = this.queuedVoiceTurn;
      const nextRun = runs
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
      turn.runId = runs.find((run) => run.sourceMessageId === turn.sourceMessageId)?.runId ?? null;
    }
    if (!turn.runId) return;
    const run = runs.find((candidate) => candidate.runId === turn.runId);
    const assistant = messages
      .filter((message) => message.runId === turn.runId && message.role === 'assistant')
      .sort((left, right) => Number(left.status === 'streaming') - Number(right.status === 'streaming'))
      .at(-1);
    if (assistant) this.acceptAssistantContent(turn, assistant.content);
    if (run && !ACTIVE_RUN_STATUSES.has(run.status) && !turn.finalQueued) this.flushTurn(turn, true);
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
    for (const text of segments.ready) this.queueSynthesis(turn, text, final, segments);
    if (final && turn.pending.trim()) {
      const text = turn.pending.trim();
      turn.pending = '';
      this.queueSynthesis(turn, text, true, { ready: [text], remainder: '' });
    }
    if (final) turn.finalQueued = true;
  }

  private queueSynthesis(
    turn: VoiceTurn,
    text: string,
    final: boolean,
    segments: { ready: string[]; remainder: string }
  ): void {
    const sequence = turn.sequence++;
    const generation = this.synthesisGeneration;
    this.synthesisQueue = this.synthesisQueue.then(() => generation === this.synthesisGeneration && turn === this.voiceTurn
      ? this.api.synthesize({
          turnId: turn.runId ?? turn.sourceMessageId,
          sequence,
          text,
          final: final && text === segments.ready.at(-1) && segments.remainder.length === 0
        })
      : undefined).catch((error) => this.publishError(error));
  }

  private publishError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.errorListeners) listener(normalized);
  }
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
