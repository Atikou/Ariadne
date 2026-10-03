import type { CompanionMessage } from '@ariadne/protocol/public';
import type { RuntimeMessage } from './runtime-projection-presenter';
import type { PublicRunProjectionV3 } from '@ariadne/protocol/public';
import { compareConversationMessages } from './conversation-message-order';
import { memoizeInputs } from './memoize-inputs';

const NEW_SESSION_PLAN_MODE_KEY = '__new_session__';

interface PendingChatOverlay {
  readonly overlayId: string;
  readonly clientMessageId: string;
  readonly assistantPlaceholderId: string;
  readonly provisionalSessionId: string;
  readonly actualSessionId?: string;
  readonly user: RuntimeMessage;
  readonly assistant: RuntimeMessage;
}

export class RuntimeUiState {
  selectedSessionId: string | null = null;
  readonly planModeSessionIds = new Set<string>();
  private pendingChat: PendingChatOverlay | null = null;
  private planModes: string[] = [];
  private readonly messageView = memoizeInputs((authoritative: readonly CompanionMessage[], runs: readonly PublicRunProjectionV3[],
    _selected: string | null, _pending: PendingChatOverlay | null, ordered: boolean) => this.deriveMessages(authoritative, runs, ordered));

  planModeSnapshot(): string[] {
    if (this.planModes.length !== this.planModeSessionIds.size
      || this.planModes.some(id => !this.planModeSessionIds.has(id))) {
      this.planModes = [...this.planModeSessionIds].sort();
    }
    return this.planModes;
  }

  selectSession(sessionId: string): void {
    this.selectedSessionId = sessionId;
  }

  clearSessionSelection(): void {
    this.selectedSessionId = null;
  }

  isPlanModeEnabled(sessionId: string | null = this.selectedSessionId): boolean {
    return this.planModeSessionIds.has(sessionId ?? NEW_SESSION_PLAN_MODE_KEY);
  }

  setPlanModeEnabled(enabled: boolean, sessionId: string | null = this.selectedSessionId): void {
    const key = sessionId ?? NEW_SESSION_PLAN_MODE_KEY;
    if (enabled) this.planModeSessionIds.add(key);
    else this.planModeSessionIds.delete(key);
  }

  moveNewSessionPlanMode(sessionId: string): void {
    if (!this.planModeSessionIds.delete(NEW_SESSION_PLAN_MODE_KEY)) return;
    this.planModeSessionIds.add(sessionId);
  }

  beginPendingChat(message: string, now: string): PendingChatOverlay {
    if (this.pendingChat !== null) throw new Error('chat_pending_overlay_exists');
    const clientMessageId = crypto.randomUUID();
    const overlayId = `pending-chat:${clientMessageId}`;
    const provisionalSessionId = this.selectedSessionId ?? `pending:${clientMessageId}`;
    const assistantPlaceholderId = `pending-assistant:${clientMessageId}`;
    const pending: PendingChatOverlay = {
      overlayId,
      clientMessageId,
      assistantPlaceholderId,
      provisionalSessionId,
      user: {
        messageId: clientMessageId,
        sessionId: provisionalSessionId,
        role: 'user',
        content: message,
        status: 'completed',
        createdAt: now,
        deliveryState: 'pending'
      },
      assistant: {
        messageId: assistantPlaceholderId,
        sessionId: provisionalSessionId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: now
      }
    };
    this.pendingChat = pending;
    return pending;
  }

  acceptPendingChat(clientMessageId: string, sessionId: string): void {
    const pending = this.pendingChat;
    if (pending?.clientMessageId !== clientMessageId) return;
    this.pendingChat = {
      ...pending,
      actualSessionId: sessionId,
      user: { ...pending.user, sessionId },
      assistant: { ...pending.assistant, sessionId }
    };
    this.selectedSessionId = sessionId;
  }

  failPendingChat(clientMessageId: string, message: string): void {
    const pending = this.pendingChat;
    if (pending?.clientMessageId !== clientMessageId) return;
    this.pendingChat = {
      ...pending,
      user: { ...pending.user, deliveryState: 'failed' },
      assistant: {
        ...pending.assistant,
        status: 'failed',
        error: { code: 'chat_delivery_failed', message, retryable: true }
      }
    };
  }

  projectedMessages(
    authoritative: readonly CompanionMessage[],
    runs: readonly PublicRunProjectionV3[],
    ordered = false
  ): RuntimeMessage[] {
    return this.messageView(authoritative, runs, this.selectedSessionId, this.pendingChat, ordered);
  }

  private deriveMessages(
    authoritative: readonly CompanionMessage[],
    runs: readonly PublicRunProjectionV3[],
    ordered: boolean
  ): RuntimeMessage[] {
    const selected = this.selectedSessionId;
    const visible = authoritative.filter((message) => (
      selected !== null && message.sessionId === selected
    ));
    if (!ordered) visible.sort(compareConversationMessages);
    const pending = this.pendingChat;
    if (pending === null) return [...visible];

    const effectiveSession = pending.actualSessionId ?? pending.provisionalSessionId;
    if (selected !== null && selected !== effectiveSession) return [...visible];
    const userProjected = authoritative.some(
      (message) => message.messageId === pending.clientMessageId
    );
    const projectedUser = authoritative.find(
      (message) => message.messageId === pending.clientMessageId
    );
    const run = runs.find((candidate) => (
      candidate.sourceMessageId === pending.clientMessageId
      && candidate.sessionId === effectiveSession
    ));
    const assistantProjected = run !== undefined
      ? authoritative.some(
          (message) => message.role === 'assistant' && message.runId === run.runId
        )
      : projectedUser !== undefined && authoritative.some((message) => (
          message.role === 'assistant'
          && message.sessionId === effectiveSession
          && Date.parse(message.createdAt) >= Date.parse(projectedUser.createdAt)
        ));
    if (userProjected && assistantProjected) this.pendingChat = null;

    const projected = [...visible];
    if (!userProjected) {
      projected.push(pending.user);
      projected.sort(compareConversationMessages);
    }
    if (!assistantProjected) {
      const sourceIndex = projected.findIndex(
        (message) => message.messageId === pending.clientMessageId
      );
      projected.splice(sourceIndex < 0 ? projected.length : sourceIndex + 1, 0, pending.assistant);
    }
    return projected;
  }

  clearPendingOverlay(): void {
    this.pendingChat = null;
  }

  get pendingChatOverlayId(): string | null {
    return this.pendingChat?.overlayId ?? null;
  }
}
