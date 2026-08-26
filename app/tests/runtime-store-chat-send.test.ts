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

  it('merges durable in-Run interactions between the objective and terminal response', async () => {
    const objective: PublicMessageProjectionV3 = {
      messageId: 'message-objective',
      sessionId: 'session-a',
      runId: 'run-interactions',
      version: 1,
      role: 'user',
      content: 'Initial objective.',
      status: 'completed',
      createdAt: NOW,
      updatedAt: NOW
    };
    const terminal: PublicMessageProjectionV3 = {
      messageId: 'message-terminal',
      sessionId: 'session-a',
      runId: 'run-interactions',
      version: 1,
      role: 'assistant',
      content: 'Final response.',
      status: 'completed',
      createdAt: '2026-07-31T00:00:04.000Z',
      updatedAt: '2026-07-31T00:00:04.000Z'
    };
    const projectedRun = {
      ...run('run-interactions', 'completed', 8),
      interactionMessages: [{
        messageId: 'message-intermediate-assistant',
        sessionId: 'session-a',
        runId: 'run-interactions',
        version: 1,
        role: 'assistant' as const,
        content: 'Intermediate response.',
        status: 'completed' as const,
        createdAt: '2026-07-31T00:00:01.000Z',
        updatedAt: '2026-07-31T00:00:01.000Z'
      }, {
        messageId: 'message-inbox-user',
        sessionId: 'session-a',
        runId: 'run-interactions',
        version: 1,
        role: 'user' as const,
        content: 'Continue with this.',
        status: 'completed' as const,
        createdAt: '2026-07-31T00:00:02.000Z',
        updatedAt: '2026-07-31T00:00:02.000Z'
      }],
      completedAt: '2026-07-31T00:00:04.000Z',
      updatedAt: '2026-07-31T00:00:04.000Z'
    } satisfies PublicRunProjectionV3;
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({
              sessions: [session('session-a')],
              messages: [objective, terminal],
              runs: [projectedRun]
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
    await store.selectSession('session-a');
    expect(store.getSnapshot().messages.map((message) => message.messageId)).toEqual([
      'message-objective',
      'message-intermediate-assistant',
      'message-inbox-user',
      'message-terminal'
    ]);
  });

  it('routes enqueue, replace, and remove through the unified Agent inbox protocol', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => ({
        ...READY,
        capabilities: ['companion.chat', 'agent.inbox']
      }),
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({
              sessions: [session('session-a')],
              runs: [run('run-inbox-ui', 'running', 4)]
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
        if (command.kind === 'agent.inbox.enqueue.v3') {
          return {
            kind: 'agent.inbox.enqueued.v3',
            runId: command.runId,
            runVersion: 5,
            inputId: command.inputId,
            inputVersion: 1
          };
        }
        if (command.kind === 'agent.inbox.replace.v3') {
          return {
            kind: 'agent.inbox.replaced.v3',
            runId: command.runId,
            runVersion: 6,
            inputId: command.inputId,
            inputVersion: 2
          };
        }
        if (command.kind === 'agent.inbox.remove.v3') {
          return {
            kind: 'agent.inbox.removed.v3',
            runId: command.runId,
            runVersion: 7,
            inputId: command.inputId
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();
    const projectedRun = store.getSnapshot().runs[0]!;

    const inputId = await store.enqueueAgentInput(
      projectedRun,
      'Steer before the next step.',
      'next_step'
    );
    await store.replaceAgentInput(projectedRun, inputId, 1, 'Revised steering.');
    await store.removeAgentInput(projectedRun, inputId, 2);

    expect(commands.filter((command) => command.kind.startsWith('agent.inbox.')))
      .toMatchObject([{
        kind: 'agent.inbox.enqueue.v3',
        runId: 'run-inbox-ui',
        sessionId: 'session-a',
        inputId,
        delivery: 'next_step',
        content: 'Steer before the next step.'
      }, {
        kind: 'agent.inbox.replace.v3',
        runId: 'run-inbox-ui',
        inputId,
        expectedInputVersion: 1,
        content: 'Revised steering.'
      }, {
        kind: 'agent.inbox.remove.v3',
        runId: 'run-inbox-ui',
        inputId,
        expectedInputVersion: 2
      }]);
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
        inbox: [],
        interactionMessages: [],
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
