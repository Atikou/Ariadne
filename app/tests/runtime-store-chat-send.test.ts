import { describe, expect, it, vi } from 'vitest';
import type {
  PublicMessageProjectionV3,
  PublicRunProjectionV3,
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResult,
  RuntimeStatus
} from '@ariadne/protocol/public';
import { RuntimeStore } from '../src/renderer/src/core/runtime/runtime-store';
import { successfulRuntimeApi } from './support/runtime-api';
import {
  NOW,
  projectionCommit,
  projectionSnapshot,
  readBatch,
  run,
  session,
  upsertChange
} from './projection-v3-fixture';
import { runtimeEnvelope } from './runtime-event-fixture';

const READY: RuntimeStatus = {
  availability: 'ready',
  capabilities: ['companion.chat'],
  observedAt: NOW
};

describe('RuntimeStore v3 chat boundary', () => {
  it('keeps the local overlay until authoritative message, run and assistant arrive', async () => {
    let resolveAccept: ((result: RuntimeResult) => void) | null = null;
    let accepted = false;
    let projected = false;
    let clientMessageId = '';
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: (command) => {
        commands.push(command);
        if (command.kind === 'projection.snapshot.get') {
          return Promise.resolve({
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({ sessions: [session('session-a')] })
          });
        }
        if (command.kind === 'projection.commits.read') {
          const commits = accepted && !projected ? [chatProjectionCommit(clientMessageId)] : [];
          projected ||= commits.length > 0;
          return Promise.resolve({
            kind: 'projection.commits',
            batch: readBatch(command.request.afterCursor, command.request.afterDigest, commits, {
              streamId: command.request.streamId
            })
          });
        }
        if (command.kind === 'conversation.message.accept.v3') {
          clientMessageId = command.messageId;
          return new Promise<RuntimeResult>((resolve) => { resolveAccept = resolve; });
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();
    await store.selectSession('session-a');

    const sending = store.sendMessage('Hello projection');
    await vi.waitFor(() => expect(resolveAccept).not.toBeNull());
    expect(store.getSnapshot().messages).toMatchObject([
      { role: 'user', content: 'Hello projection', deliveryState: 'pending' },
      { role: 'assistant', status: 'streaming' }
    ]);

    accepted = true;
    (resolveAccept as unknown as (result: RuntimeResult) => void)({
      kind: 'conversation.message.accepted.v3',
      sessionId: 'session-a',
      sessionVersion: 2,
      messageId: clientMessageId,
      messageVersion: 1,
      sagaId: 'saga-chat'
    });
    await sending;
    await vi.waitFor(() => expect(store.getSnapshot().projectionCursor).toBe(1));
    expect(store.getSnapshot().messages).toEqual([
      expect.objectContaining({ messageId: clientMessageId, role: 'user' }),
      expect.objectContaining({ messageId: 'assistant-chat', role: 'assistant' })
    ]);
    expect(store.getSnapshot().pendingOverlayIds).toEqual([]);
    expect(commands.map((command) => command.kind)).not.toContain('companion.chat.start');
  });

  it('creates a v3 Session before accepting the first message', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => ({
        ...READY,
        capabilities: ['companion.chat', 'companion.agent-plan']
      }),
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'projection.snapshot.get') {
          return { kind: 'projection.snapshot', snapshot: projectionSnapshot() };
        }
        if (command.kind === 'projection.commits.read') {
          return {
            kind: 'projection.commits',
            batch: readBatch(command.request.afterCursor, command.request.afterDigest, [], {
              streamId: command.request.streamId
            })
          };
        }
        if (command.kind === 'conversation.session.create.v3') {
          return { kind: 'conversation.session.created.v3', sessionId: command.sessionId, version: 1 };
        }
        if (command.kind === 'conversation.message.accept.v3') {
          expect(command.expectedSessionVersion).toBe(1);
          expect(command.execution).toEqual({
            mode: 'plan',
            modelId: 'model-selected',
            inference: { reasoningMode: 'on', reasoningEffort: 'high' },
            routingStrategy: 'quality-first'
          });
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
    store.setPlanModeEnabled(true);

    const result = await store.sendMessage('First message', {
      workspaceId: 'workspace-primary',
      modelId: 'model-selected',
      inference: { reasoningMode: 'on', reasoningEffort: 'high' },
      routingStrategy: 'quality-first'
    });
    expect(result.sessionId).toBeTruthy();
    expect(store.getSnapshot()).toMatchObject({ selectedSessionId: result.sessionId, sessions: [] });
    expect(commands.map((command) => command.kind)).toEqual([
      'projection.snapshot.get',
      'projection.commits.read',
      'conversation.session.create.v3',
      'conversation.message.accept.v3',
      'projection.commits.read'
    ]);
  });

  it('clears the processing overlay when a pre-Run terminal assistant message arrives', async () => {
    let accepted = false;
    let projected = false;
    let clientMessageId = '';
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        if (command.kind === 'projection.snapshot.get') {
          return { kind: 'projection.snapshot', snapshot: projectionSnapshot({ sessions: [session('session-a')] }) };
        }
        if (command.kind === 'conversation.message.accept.v3') {
          clientMessageId = command.messageId;
          accepted = true;
          return {
            kind: 'conversation.message.accepted.v3', sessionId: 'session-a',
            sessionVersion: 2, messageId: clientMessageId, messageVersion: 1,
            sagaId: 'saga-start-failed'
          };
        }
        if (command.kind === 'projection.commits.read') {
          const commits = accepted && !projected
            ? [startFailureProjectionCommit(clientMessageId)]
            : [];
          projected ||= commits.length > 0;
          return {
            kind: 'projection.commits',
            batch: readBatch(command.request.afterCursor, command.request.afterDigest, commits, {
              streamId: command.request.streamId
            })
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();
    await store.selectSession('session-a');
    await store.sendMessage('Plan this');
    await vi.waitFor(() => expect(store.getSnapshot().projectionCursor).toBe(1));
    expect(store.getSnapshot().pendingOverlayIds).toEqual([]);
    expect(store.getSnapshot().messages).toEqual([
      expect.objectContaining({ messageId: clientMessageId, role: 'user' }),
      expect.objectContaining({
        messageId: 'assistant-start-failed',
        role: 'assistant',
        content: expect.stringContaining('无法启动')
      })
    ]);
  });

  it('clears pending overlays when Runtime resets', async () => {
    let statusListener: ((status: RuntimeStatus) => void) | null = null;
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        if (command.kind === 'projection.snapshot.get') {
          return { kind: 'projection.snapshot', snapshot: projectionSnapshot({ sessions: [session('session-a')] }) };
        }
        if (command.kind === 'projection.commits.read') {
          return {
            kind: 'projection.commits',
            batch: readBatch(command.request.afterCursor, command.request.afterDigest, [], {
              streamId: command.request.streamId
            })
          };
        }
        if (command.kind === 'conversation.message.accept.v3') {
          return {
            kind: 'conversation.message.accepted.v3',
            sessionId: command.sessionId,
            sessionVersion: 2,
            messageId: command.messageId,
            messageVersion: 1,
            sagaId: 'pending-saga'
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onStatus: (next) => {
        statusListener = next;
        return () => { statusListener = null; };
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();
    await store.selectSession('session-a');
    await store.sendMessage('Pending overlay');
    expect(store.getSnapshot().messages).toHaveLength(2);

    (statusListener as unknown as (status: RuntimeStatus) => void)({
      ...READY,
      availability: 'restarting',
      observedAt: '2026-07-31T00:00:01.000Z'
    });
    expect(store.getSnapshot().messages).toEqual([]);
    expect(store.getSnapshot().pendingOverlayIds).toEqual([]);
  });

  it('routes cancellation through the authoritative projected Run version', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({ runs: [run('run-cancel', 'running', 7)] })
          };
        }
        if (command.kind === 'projection.commits.read') {
          return {
            kind: 'projection.commits',
            batch: readBatch(command.request.afterCursor, command.request.afterDigest, [], {
              streamId: command.request.streamId
            })
          };
        }
        if (command.kind === 'agent.run.cancel.v3') {
          expect(command).toMatchObject({
            runId: 'run-cancel',
            expectedVersion: 7,
            reason: 'user_requested'
          });
          return {
            kind: 'agent.run.cancelled.v3',
            runId: command.runId,
            runVersion: 8
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();

    await store.cancelRun(store.getSnapshot().runs[0]!);

    expect(commands.map((command) => command.kind)).toContain('agent.run.cancel.v3');
  });
});

function chatProjectionCommit(clientMessageId: string) {
  const user: PublicMessageProjectionV3 = {
    messageId: clientMessageId,
    sessionId: 'session-a',
    version: 1,
    role: 'user',
    content: 'Hello projection',
    status: 'completed',
    createdAt: NOW,
    updatedAt: NOW
  };
  const assistant: PublicMessageProjectionV3 = {
    messageId: 'assistant-chat',
    sessionId: 'session-a',
    runId: 'run-chat',
    version: 1,
    role: 'assistant',
    content: 'Projected answer',
    status: 'completed',
    createdAt: '2026-07-31T00:00:01.000Z',
    updatedAt: '2026-07-31T00:00:01.000Z'
  };
  const run: PublicRunProjectionV3 = {
    runId: 'run-chat',
    sessionId: 'session-a',
    sourceMessageId: clientMessageId,
    version: 1,
    title: 'Agent run',
    status: 'completed',
    label: 'Completed',
    toolActivities: [],
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: NOW
  };
  return projectionCommit('event-chat', [
    upsertChange('messages', user, user.messageId),
    upsertChange('messages', assistant, assistant.messageId),
    upsertChange('runs', run, run.runId)
  ]);
}

function startFailureProjectionCommit(clientMessageId: string) {
  const user: PublicMessageProjectionV3 = {
    messageId: clientMessageId, sessionId: 'session-a', version: 1,
    role: 'user', content: 'Plan this', status: 'completed',
    createdAt: NOW, updatedAt: NOW
  };
  const assistant: PublicMessageProjectionV3 = {
    messageId: 'assistant-start-failed', sessionId: 'session-a', version: 1,
    role: 'assistant', content: '任务无法启动：当前运行权限或工具配置不可用。',
    status: 'completed', createdAt: '2026-07-31T00:00:01.000Z',
    updatedAt: '2026-07-31T00:00:01.000Z'
  };
  return projectionCommit('event-start-failed', [
    upsertChange('messages', user, user.messageId),
    upsertChange('messages', assistant, assistant.messageId)
  ]);
}
