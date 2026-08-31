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

    await store.sessions.select('session-b');

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

  it('queries Sessions and forks from a projected immutable message reference', async () => {
    const reference = {
      sessionId: 'session-source',
      messageId: 'message-source',
      messageVersion: 1,
      contentDigest: `sha256:${'a'.repeat(64)}`
    } as const;
    const observed: string[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        observed.push(command.kind);
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({
              sessions: [session('session-source')],
              messages: [{ ...message('message-source', 'session-source'), reference }]
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
        if (command.kind === 'conversation.sessions.query.v3') {
          return {
            kind: 'conversation.sessions.query_result.v3',
            items: [{
              sessionId: 'session-source',
              workspaceId: command.workspaceId,
              version: 1,
              title: 'Conversation',
              status: 'active',
              updatedAt: '2026-07-31T00:00:00.000Z',
              lineage: null,
              matches: [{ reference, role: 'user', snippet: 'needle' }]
            }]
          };
        }
        if (command.kind === 'conversation.message.resolve.v3') {
          return {
            kind: 'conversation.message.resolved.v3',
            reference: command.reference,
            workspaceId: 'workspace-primary',
            role: 'user',
            content: 'needle',
            createdAt: '2026-07-31T00:00:00.000Z'
          };
        }
        if (command.kind === 'conversation.session.fork.v3') {
          expect(command).toMatchObject({
            sourceSessionId: 'session-source',
            expectedSourceSessionVersion: 1,
            boundary: reference
          });
          return {
            kind: 'conversation.session.forked.v3',
            sessionId: command.sessionId,
            version: 1,
            sourceSessionId: command.sourceSessionId,
            boundary: command.boundary
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();

    await expect(store.sessions.query('workspace-primary', 'needle', 'all'))
      .resolves.toMatchObject([{ sessionId: 'session-source', matches: [{ reference }] }]);
    await expect(store.sessions.resolveMessage(reference))
      .resolves.toMatchObject({ content: 'needle', reference });
    const forkedId = await store.sessions.forkFromMessage('session-source', reference);
    expect(store.getSnapshot().selectedSessionId).toBe(forkedId);
    expect(observed).toContain('conversation.session.fork.v3');
  });
});
