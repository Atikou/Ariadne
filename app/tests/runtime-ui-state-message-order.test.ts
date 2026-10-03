import { describe, expect, it } from 'vitest';
import type { CompanionMessage } from '@ariadne/protocol/public';
import { RuntimeUiState } from '../src/renderer/src/core/runtime/runtime-ui-state';

describe('RuntimeUiState message order', () => {
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
