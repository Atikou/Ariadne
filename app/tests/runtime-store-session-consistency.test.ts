import { describe, expect, it } from 'vitest';
import type { RuntimeStatus } from '@ariadne/protocol/public';
import { RuntimeStore } from '../src/renderer/src/core/runtime/runtime-store';
import { successfulRuntimeApi } from './support/runtime-api';
import {
  message,
  projectionSnapshot,
  readBatch,
  session
} from './projection-v3-fixture';

const READY: RuntimeStatus = {
  availability: 'ready',
  capabilities: [],
  observedAt: '2026-07-31T00:00:00.000Z'
};

describe('RuntimeStore session presentation', () => {
  it('selects messages from MessageStore without issuing a domain list query', async () => {
    const commands: string[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        commands.push(command.kind);
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({
              sessions: [session('session-a'), session('session-b')],
              messages: [message('message-a', 'session-a'), message('message-b', 'session-b')]
            })
          };
        }
        if (command.kind === 'projection.commits.read') {
          return {
            kind: 'projection.commits',
            batch: readBatch(
              command.request.afterCursor,
              command.request.afterDigest,
              [],
              { streamId: command.request.streamId }
            )
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();

    await store.selectSession('session-b');

    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: 'session-b',
      messages: [{ messageId: 'message-b', sessionId: 'session-b' }]
    });
    expect(commands).not.toContain('companion.messages.list');
  });

  it('creates the session only with the first message and waits for Projection before listing it', async () => {
    let createdSessionId = '';
    let initialized = false;
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        if (command.kind === 'projection.snapshot.get') {
          return { kind: 'projection.snapshot', snapshot: projectionSnapshot() };
        }
        if (command.kind === 'projection.commits.read') {
          if (!initialized) initialized = true;
          return {
            kind: 'projection.commits',
            batch: readBatch(
              command.request.afterCursor,
              command.request.afterDigest,
              [],
              { streamId: command.request.streamId }
            )
          };
        }
        if (command.kind === 'conversation.session.create.v3') {
          createdSessionId = command.sessionId;
          return { kind: 'conversation.session.created.v3', sessionId: command.sessionId, version: 1 };
        }
        if (command.kind === 'conversation.message.accept.v3') {
          return {
            kind: 'conversation.message.accepted.v3',
            sessionId: command.sessionId,
            sessionVersion: 2,
            messageId: command.messageId,
            messageVersion: 1,
            sagaId: 'first-message-saga'
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();

    const accepted = await store.sendMessage('Created', { workspaceId: 'workspace-primary' });
    expect(accepted.sessionId).toBe(createdSessionId);

    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: createdSessionId,
      sessions: []
    });
    expect(initialized).toBe(true);
  });
});
