import { describe, expect, it } from 'vitest';
import type { CompanionMessage } from '@ariadne/protocol/public';
import { RuntimeUiState } from '../src/renderer/src/core/runtime/runtime-ui-state';

describe('RuntimeUiState message order', () => {
  it('allows independent session submissions and keeps late A failure out of B', () => {
    const ui = new RuntimeUiState(); ui.selectSession('session-a');
    const a = ui.beginPendingChat('A', '2026-10-06T00:00:00Z');
    ui.selectSession('session-b'); const b = ui.beginPendingChat('B', '2026-10-06T00:00:01Z');
    ui.failPendingChat(a.clientMessageId, 'A rejected');
    expect(ui.projectedMessages([], []).map(row => row.content)).toEqual(['B', '']);
    expect(ui.pendingChatOverlayId).toBe(b.overlayId);
    ui.selectSession('session-a'); expect(ui.projectedMessages([], [])[0]).toMatchObject({ content: 'A', deliveryState: 'failed' });
  });
  it('distinguishes new drafts before session creation and does not expose accepted A in new B', () => {
    const ui = new RuntimeUiState(); ui.selectDraftOwner('new-a');
    const a = ui.beginPendingChat('A', '2026-10-06T00:00:00Z');
    ui.selectDraftOwner('new-b'); expect(ui.projectedMessages([], [])).toEqual([]);
    const b = ui.beginPendingChat('B', '2026-10-06T00:00:01Z');
    ui.acceptPendingChat(a.clientMessageId, 'session-a');
    expect(ui.selectedSessionId).toBeNull(); expect(ui.pendingChatOverlayId).toBe(b.overlayId);
    expect(ui.projectedMessages([], []).map(row => row.content)).toEqual(['B', '']);
    ui.selectSession('session-a'); expect(ui.projectedMessages([], [])[0]?.content).toBe('A');
  });
  it('rejects concurrent submissions only for the same editing owner and retains its first presentation', () => {
    const ui = new RuntimeUiState(); ui.selectDraftOwner('new-a'); ui.beginPendingChat('A', '2026-10-06T00:00:00Z');
    expect(() => ui.beginPendingChat('duplicate', '2026-10-06T00:00:01Z')).toThrow('chat_pending_overlay_exists');
    expect(ui.projectedMessages([], [])[0]?.content).toBe('A');
  });
  it('keeps acceptance owned by A without changing a later B selection', () => {
    const ui = new RuntimeUiState(); ui.selectSession('session-a');
    const pending = ui.beginPendingChat('A', new Date().toISOString(), 'message-original', 'session-a');
    ui.selectSession('session-b'); ui.acceptPendingChat(pending.clientMessageId, 'session-a');
    expect(ui.selectedSessionId).toBe('session-b'); expect(ui.projectedMessages([], [])).toEqual([]);
    ui.selectSession('session-a'); expect(ui.projectedMessages([], [])[0]!.messageId).toBe('message-original');
  });
  it('allows a new submission after a confirmed failed overlay instead of permanently blocking the composer', () => {
    const ui = new RuntimeUiState(); ui.selectSession('session-a');
    const first = ui.beginPendingChat('A', new Date().toISOString()); ui.failPendingChat(first.clientMessageId, 'rejected');
    expect(ui.beginPendingChat('B', new Date().toISOString()).clientMessageId).not.toBe(first.clientMessageId);
  });
  it('anchors the processing placeholder after its projected user message', () => {
    const ui = new RuntimeUiState();
    ui.selectSession('session-a');
    const pending = ui.beginPendingChat('Hello', '2026-09-02T03:18:50.180Z');
    ui.acceptPendingChat(pending.clientMessageId, 'session-a');
    const projectedUser: CompanionMessage = {
      messageId: pending.clientMessageId,
      sessionId: 'session-a',
      role: 'user',
      content: 'Hello',
      status: 'completed',
      createdAt: '2026-09-02T03:18:50.206Z'
    };

    expect(ui.projectedMessages([projectedUser], []).map((message) => ({
      role: message.role,
      createdAt: message.createdAt
    }))).toEqual([
      { role: 'user', createdAt: '2026-09-02T03:18:50.206Z' },
      { role: 'assistant', createdAt: '2026-09-02T03:18:50.180Z' }
    ]);
  });

  it('keeps the optimistic user and processing placeholder together before projection', () => {
    const ui = new RuntimeUiState();
    ui.selectSession('session-a');
    ui.beginPendingChat('Hello', '2026-09-02T03:18:50.180Z');

    expect(ui.projectedMessages([], []).map((message) => message.role))
      .toEqual(['user', 'assistant']);
  });
});
