import { describe, expect, it } from 'vitest';

import type {
  ConversationSession,
  RuntimeCommand,
  RuntimeResult,
  RuntimeStatus
} from '@ariadne/protocol/public';
import { RuntimeStore } from '../src/renderer/src/core/runtime/runtime-store';

const stoppedStatus: RuntimeStatus = {
  availability: 'stopped',
  capabilities: [],
  observedAt: '2026-07-22T00:00:00.000Z'
};

describe('RuntimeStore session consistency', () => {
  it('ignores message history that completes after a newer session selection', async () => {
    const pending = new Map<string, (result: RuntimeResult) => void>();
    const store = new RuntimeStore({
      getStatus: async () => stoppedStatus,
      request: (command) => {
        if (command.kind !== 'companion.messages.list') throw new Error(`Unexpected command: ${command.kind}`);
        return new Promise<RuntimeResult>((resolve) => pending.set(command.sessionId, resolve));
      },
      onEvent: () => () => undefined
    });

    const first = store.selectSession('session-a');
    const second = store.selectSession('session-b');
    pending.get('session-b')?.(messageResult('session-b', 'newer'));
    await second;
    pending.get('session-a')?.(messageResult('session-a', 'stale'));
    await first;

    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: 'session-b',
      messages: [{ sessionId: 'session-b', content: 'newer' }]
    });
  });

  it('removes a deleted session locally and selects the remaining session', async () => {
    const sessions = [session('session-a'), session('session-b')];
    let createIndex = 0;
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore({
      getStatus: async () => stoppedStatus,
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'companion.sessions.create') {
          const created = sessions[createIndex++];
          if (!created) throw new Error('No fixture session available.');
          return { kind: 'companion.session', session: created };
        }
        if (command.kind === 'companion.messages.list') {
          return messageResult(command.sessionId, `history:${command.sessionId}`);
        }
        if (command.kind === 'companion.sessions.delete') return { kind: 'acknowledged' };
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    });

    await store.createSession();
    await store.createSession();
    await store.selectSession('session-a');
    await store.deleteSession('session-a');

    expect(store.getSnapshot()).toMatchObject({
      sessions: [{ sessionId: 'session-b' }],
      selectedSessionId: 'session-b',
      messages: [{ sessionId: 'session-b', content: 'history:session-b' }]
    });
    expect(commands).toContainEqual({ kind: 'companion.sessions.delete', sessionId: 'session-a' });
  });
});

function session(sessionId: string): ConversationSession {
  return {
    sessionId,
    workspaceId: 'primary',
    title: sessionId,
    pinned: false,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z'
  };
}

function messageResult(sessionId: string, content: string): RuntimeResult {
  return {
    kind: 'companion.messages',
    messages: [{
      messageId: `message:${sessionId}`,
      sessionId,
      role: 'assistant',
      content,
      status: 'completed',
      createdAt: '2026-07-22T00:00:01.000Z'
    }]
  };
}
