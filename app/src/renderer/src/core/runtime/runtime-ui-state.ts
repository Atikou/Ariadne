import type { RuntimeMessage } from './runtime-projection-presenter';
import type { PublicRunCatalogSummary } from '@ariadne/protocol/public';
import { compareConversationMessages } from './conversation-message-order';
import { memoizeInputs } from './memoize-inputs';

const NEW_SESSION_PLAN_MODE_KEY = '__new_session__';

interface PendingChatOverlay {
  readonly overlayId: string;
  readonly clientMessageId: string;
  readonly assistantPlaceholderId: string;
  readonly provisionalSessionId: string;
  readonly sourceSessionId: string | null;
  readonly draftOwnerKey: string | null;
  readonly actualSessionId?: string;
  readonly user: RuntimeMessage;
  readonly assistant: RuntimeMessage;
}

export class RuntimeUiState {
  selectedSessionId: string | null = null;
  readonly planModeSessionIds = new Set<string>();
  private pendingChats = new Map<string, PendingChatOverlay>();
  private selectedDraftOwnerKey: string | null = null;
  private planModes: string[] = [];
  private readonly messageView = memoizeInputs((authoritative: readonly RuntimeMessage[], runs: readonly PublicRunCatalogSummary[],
    _selected: string | null, _draftOwner: string | null, _pending: ReadonlyMap<string, PendingChatOverlay>, ordered: boolean) => this.deriveMessages(authoritative, runs, ordered));

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

  selectDraftOwner(key: string | null): void { this.selectedDraftOwnerKey = key; }

  beginPendingChat(message: string, now: string, clientMessageId: string = crypto.randomUUID(), sessionId: string | null = this.selectedSessionId,
    draftOwnerKey: string | null = this.selectedDraftOwnerKey): PendingChatOverlay {
    const pendingChats = new Map(this.pendingChats);
    for (const [id, row] of pendingChats) {
      const sameOwner = sessionId === null ? row.sourceSessionId === null && row.draftOwnerKey === draftOwnerKey && row.actualSessionId === undefined
        : (row.actualSessionId ?? row.provisionalSessionId) === sessionId;
      if (!sameOwner) continue;
      if (row.user.deliveryState !== 'failed') throw new Error('chat_pending_overlay_exists');
      pendingChats.delete(id);
    }
    if (pendingChats.has(clientMessageId)) throw new Error('chat_pending_identity_exists');
    if (pendingChats.size >= 64) throw new Error('chat_pending_overlay_capacity_exceeded');
    const overlayId = `pending-chat:${clientMessageId}`;
    const provisionalSessionId = sessionId ?? `pending:${clientMessageId}`;
    const assistantPlaceholderId = `pending-assistant:${clientMessageId}`;
    const pending: PendingChatOverlay = {
      overlayId,
      clientMessageId,
      assistantPlaceholderId,
      provisionalSessionId,
      sourceSessionId: sessionId,
      draftOwnerKey,
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
    pendingChats.set(clientMessageId, pending); this.pendingChats = pendingChats;
    return pending;
  }

  acceptPendingChat(clientMessageId: string, sessionId: string): void {
    const pending = this.pendingChats.get(clientMessageId);
    if (!pending) return;
    this.pendingChats = new Map(this.pendingChats).set(clientMessageId, {
      ...pending,
      actualSessionId: sessionId,
      user: { ...pending.user, sessionId },
      assistant: { ...pending.assistant, sessionId }
    });
  }

  failPendingChat(clientMessageId: string, message: string): void {
    const pending = this.pendingChats.get(clientMessageId);
    if (!pending) return;
    this.pendingChats = new Map(this.pendingChats).set(clientMessageId, {
      ...pending,
      user: { ...pending.user, deliveryState: 'failed' },
      assistant: {
        ...pending.assistant,
        status: 'failed',
        error: { code: 'chat_delivery_failed', message, retryable: true }
      }
    });
  }

  projectedMessages(
    authoritative: readonly RuntimeMessage[],
    runs: readonly PublicRunCatalogSummary[],
    ordered = false
  ): RuntimeMessage[] {
    return this.messageView(authoritative, runs, this.selectedSessionId, this.selectedDraftOwnerKey, this.pendingChats, ordered);
  }

  private deriveMessages(
    authoritative: readonly RuntimeMessage[],
    runs: readonly PublicRunCatalogSummary[],
    ordered: boolean
  ): RuntimeMessage[] {
    const selected = this.selectedSessionId;
    const visible = authoritative.filter((message) => (
      selected !== null && message.sessionId === selected
    ));
    if (!ordered) visible.sort(compareConversationMessages);
    const pending = this.visiblePending();
    if (!pending) return [...visible];

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
    if (userProjected && assistantProjected) {
      this.pendingChats = new Map(this.pendingChats); this.pendingChats.delete(pending.clientMessageId);
    }

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
    this.pendingChats = new Map();
  }

  private visiblePending(): PendingChatOverlay | undefined {
    return [...this.pendingChats.values()].find(row => this.selectedSessionId === null
      ? row.sourceSessionId === null && row.actualSessionId === undefined && row.draftOwnerKey === this.selectedDraftOwnerKey
      : (row.actualSessionId ?? row.provisionalSessionId) === this.selectedSessionId);
  }

  get pendingChatOverlayId(): string | null {
    return this.visiblePending()?.overlayId ?? null;
  }
}
