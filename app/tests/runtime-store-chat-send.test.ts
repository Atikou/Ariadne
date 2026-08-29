import { describe, expect, it, vi } from 'vitest';
import type {
  PublicInferenceStreamProjectionV3,
  PublicMessageProjectionV3,
  PublicRunProjectionV3,
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResult,
  RuntimeStatus
} from '@ariadne/protocol/public';
import { PERSONAL_ASSISTANT_WORKSPACE_ID } from '@ariadne/protocol/public';
import { RuntimeStore } from '../src/renderer/src/core/runtime/runtime-store';
import type { AriadneApi } from '@shared/contract';
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
  it('sends an image-only Message through the v3 attachment command without putting bytes in projection state', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({ sessions: [session('session-image')] })
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
        if (command.kind === 'conversation.message.accept.v3') {
          expect(command.content).toBe('');
          expect(command.execution).toMatchObject({ mode: 'agent', modelId: 'vision-model' });
          expect(command.attachments).toEqual([{
            mediaType: 'image/png',
            data: 'aGVsbG8=',
            name: 'screen.png'
          }]);
          return {
            kind: 'conversation.message.accepted.v3',
            sessionId: command.sessionId,
            sessionVersion: 2,
            messageId: command.messageId,
            messageVersion: 1,
            sagaId: 'image-saga'
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();
    await store.selectSession('session-image');

    await store.sendMessage('', {
      modelId: 'vision-model',
      attachments: [{ mediaType: 'image/png', data: 'aGVsbG8=', name: 'screen.png' }]
    });
    expect(commands.some((command) => command.kind === 'conversation.message.accept.v3'))
      .toBe(true);
  });

  it('presents durable image metadata without image bytes or paths', async () => {
    const attachment = {
      attachmentId: `sha256:${'c'.repeat(64)}`,
      mediaType: 'image/webp' as const,
      bytes: 1_024,
      width: 800,
      height: 600,
      name: 'diagram.webp'
    };
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({
              sessions: [session('session-image')],
              messages: [{
                messageId: 'message-image',
                sessionId: 'session-image',
                version: 1,
                role: 'user',
                content: '',
                attachments: [attachment],
                status: 'completed',
                createdAt: NOW,
                updatedAt: NOW
              }]
            })
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
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();
    await store.selectSession('session-image');

    expect(store.getSnapshot().messages[0]?.attachments).toEqual([attachment]);
    expect(JSON.stringify(store.getSnapshot().messages)).not.toContain('data:image');
    expect(JSON.stringify(store.getSnapshot().messages)).not.toContain('localPath');
  });

  it('shows only the recoverable partial stream until the authoritative assistant message exists', async () => {
    const projectedRun = run('run-stream', 'running', 2);
    const stream: PublicInferenceStreamProjectionV3 = {
      inferenceStreamId: 'stream-run-stream-turn-stream-attempt-stream',
      runId: projectedRun.runId,
      turnId: 'turn-stream',
      attemptId: 'attempt-stream',
      version: 2,
      status: 'streaming',
      retainedFromSequence: 1,
      finalSequence: 2,
      chunks: [{
        sequence: 1,
        channel: 'reasoning',
        text: '正在核对',
        observedAt: NOW
      }, {
        sequence: 2,
        channel: 'token',
        text: '部分公开回答',
        observedAt: NOW
      }],
      updatedAt: NOW
    };
    const terminal: PublicMessageProjectionV3 = {
      messageId: 'message-terminal-stream',
      sessionId: 'session-a',
      runId: projectedRun.runId,
      version: 1,
      role: 'assistant',
      content: '最终权威回答',
      status: 'completed',
      createdAt: NOW,
      updatedAt: NOW
    };
    const createStore = (messages: PublicMessageProjectionV3[]) => new RuntimeStore(
      successfulRuntimeApi({
        getStatus: async () => READY,
        request: async (command) => {
          if (command.kind === 'projection.snapshot.get') {
            return {
              kind: 'projection.snapshot',
              snapshot: projectionSnapshot({
                sessions: [session('session-a')],
                messages,
                runs: [projectedRun],
                inferenceStreams: [stream]
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
      })
    );

    const partial = createStore([]);
    await partial.initialize();
    await partial.selectSession('session-a');
    expect(partial.getSnapshot().messages).toMatchObject([{
      messageId: stream.inferenceStreamId,
      content: '部分公开回答',
      status: 'streaming',
      reasoning: { content: '正在核对' }
    }]);

    const completed = createStore([terminal]);
    await completed.initialize();
    await completed.selectSession('session-a');
    expect(completed.getSnapshot().messages).toMatchObject([{
      messageId: terminal.messageId,
      content: '最终权威回答',
      status: 'completed'
    }]);
    expect(completed.getSnapshot().messages).toHaveLength(1);
  });

  it('creates personal-assistant chat without requiring a user workspace', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
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
          expect(command.workspaceId).toBe(PERSONAL_ASSISTANT_WORKSPACE_ID);
          return { kind: 'conversation.session.created.v3', sessionId: command.sessionId, version: 1 };
        }
        if (command.kind === 'conversation.message.accept.v3') {
          expect(command.execution).toEqual({ mode: 'chat' });
          return {
            kind: 'conversation.message.accepted.v3',
            sessionId: command.sessionId,
            sessionVersion: 2,
            messageId: command.messageId,
            messageVersion: 1,
            sagaId: 'assistant-chat-saga'
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();

    await expect(store.sendMessage('读取这台电脑上的说明文件')).resolves.toMatchObject({
      sessionId: expect.any(String)
    });
    expect(commands.map((command) => command.kind)).toContain('conversation.message.accept.v3');
  });

  it('routes rename, archive and restore through versioned Conversation authority commands', async () => {
    const observed: RuntimeCommand[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        observed.push(command);
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({ sessions: [session('session-lifecycle')] })
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
        if (
          command.kind === 'conversation.session.rename.v3'
          || command.kind === 'conversation.session.archive.v3'
          || command.kind === 'conversation.session.restore.v3'
        ) {
          return {
            kind: 'conversation.session.updated.v3',
            sessionId: command.sessionId,
            version: command.expectedSessionVersion + 1
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();
    const lifecycleSession = store.getSnapshot().sessions[0]!;

    await store.renameSession(lifecycleSession, ' Durable title ');
    await store.archiveSession(lifecycleSession);
    await store.restoreSession(lifecycleSession);

    expect(observed.filter((command) => command.kind.startsWith('conversation.session.')))
      .toEqual([
        expect.objectContaining({
          kind: 'conversation.session.rename.v3',
          expectedSessionVersion: 1,
          title: 'Durable title'
        }),
        expect.objectContaining({
          kind: 'conversation.session.archive.v3',
          expectedSessionVersion: 1
        }),
        expect.objectContaining({
          kind: 'conversation.session.restore.v3',
          expectedSessionVersion: 1
        })
      ]);
  });

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

    const deliveryReceipt = await store.enqueueAgentInput(
      projectedRun,
      'Steer before the next step.',
      'next_step'
    );
    const inputId = deliveryReceipt.inputId;
    expect(deliveryReceipt.state).toBe('accepted');
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

  it('uses one stable command identity to reconcile an uncertain Agent inbox delivery', async () => {
    const commandIds: string[] = [];
    const inboxCommands: RuntimeCommand[] = [];
    let inboxAttempts = 0;
    const api: AriadneApi['runtime'] = {
      getStatus: async () => ({
        ok: true,
        value: { ...READY, capabilities: ['companion.chat', 'agent.inbox'] }
      }),
      onStatus: () => () => undefined,
      request: async (command, options) => {
        if (command.kind === 'projection.snapshot.get') {
          return {
            ok: true,
            value: {
              kind: 'projection.snapshot',
              snapshot: projectionSnapshot({
                sessions: [session('session-a')],
                runs: [run('run-inbox-reconcile', 'running', 4)]
              })
            }
          };
        }
        if (command.kind === 'projection.commits.read') {
          return {
            ok: true,
            value: {
              kind: 'projection.commits',
              batch: readBatch(
                command.request.afterCursor,
                command.request.afterDigest,
                [],
                { streamId: command.request.streamId }
              )
            }
          };
        }
        if (command.kind !== 'agent.inbox.enqueue.v3') {
          throw new Error(`Unexpected command: ${command.kind}`);
        }
        const commandId = options?.commandId;
        if (commandId === undefined) throw new Error('command_id_missing');
        commandIds.push(commandId);
        inboxCommands.push(command);
        inboxAttempts += 1;
        if (inboxAttempts === 1) {
          return {
            ok: false,
            error: {
              code: 'command_outcome_uncertain',
              message: 'Runtime disconnected before confirming the command outcome.',
              retryable: false,
              correlationId: commandId
            }
          };
        }
        return {
          ok: true,
          value: {
            kind: 'agent.inbox.enqueued.v3',
            runId: command.runId,
            runVersion: 5,
            inputId: command.inputId,
            inputVersion: 1
          }
        };
      },
      onEvent: () => () => undefined
    };
    const store = new RuntimeStore(api);
    await store.initialize();

    const first = await store.enqueueAgentInput(
      store.getSnapshot().runs[0]!,
      'Keep the same logical command.',
      'next_turn'
    );
    expect(first).toMatchObject({ state: 'reconcile', attempt: 1 });
    expect(store.getSnapshot().agentInputDeliveries).toEqual([first]);

    const reconciled = await store.reconcileAgentInputDelivery(first.commandId);
    expect(reconciled).toMatchObject({
      commandId: first.commandId,
      inputId: first.inputId,
      state: 'accepted',
      attempt: 2
    });
    expect(commandIds).toEqual([first.commandId, first.commandId]);
    expect(inboxCommands).toHaveLength(2);
    expect(inboxCommands[1]).toEqual(inboxCommands[0]);
  });

  it('restores an unsettled encrypted sender record and reconciles the exact command after reload', async () => {
    const restoredCommand = {
      kind: 'agent.inbox.enqueue.v3' as const,
      contractVersion: '3.0' as const,
      runId: 'run-inbox-restored',
      sessionId: 'session-a',
      inputId: 'input-inbox-restored',
      delivery: 'next_turn' as const,
      content: 'Resume this exact delivery after Renderer reload.'
    };
    const sent: Array<{ command: RuntimeCommand; commandId?: string }> = [];
    const settle = vi.fn(async () => undefined);
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => ({
        ...READY,
        capabilities: ['companion.chat', 'agent.inbox']
      }),
      request: async (command, options) => {
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({
              sessions: [session('session-a')],
              runs: [run('run-inbox-restored', 'running', 4)]
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
        if (command.kind !== 'agent.inbox.enqueue.v3') {
          throw new Error(`Unexpected command: ${command.kind}`);
        }
        sent.push({
          command,
          ...(options?.commandId === undefined ? {} : { commandId: options.commandId })
        });
        return {
          kind: 'agent.inbox.enqueued.v3',
          runId: command.runId,
          runVersion: 5,
          inputId: command.inputId,
          inputVersion: 1
        };
      },
      onEvent: () => () => undefined
    }), {
      list: async () => [{
        commandId: 'command-inbox-restored',
        command: restoredCommand,
        createdAt: '2026-07-30T23:59:00.000Z'
      }],
      stage: async () => { throw new Error('stage_not_expected'); },
      settle
    });

    await store.initialize();
    const restored = store.getSnapshot().agentInputDeliveries[0]!;
    expect(restored).toMatchObject({
      commandId: 'command-inbox-restored',
      inputId: 'input-inbox-restored',
      state: 'reconcile',
      attempt: 1
    });

    const reconciled = await store.reconcileAgentInputDelivery(restored.commandId);
    expect(reconciled).toMatchObject({ state: 'accepted', attempt: 2 });
    expect(sent).toEqual([{
      command: restoredCommand,
      commandId: 'command-inbox-restored'
    }]);
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith({
      commandId: 'command-inbox-restored'
    }));
    store.dispose();
  });

  it('routes a continuable Child follow-up through direct-parent SubAgent authority', async () => {
    const commands: RuntimeCommand[] = [];
    const parent = run('run-parent-ui', 'waiting_children', 3);
    const child: PublicRunProjectionV3 = {
      ...run('run-child-ui', 'paused', 4),
      parentRunId: parent.runId,
      delegationId: 'delegation-child-ui',
      subagentMode: 'continuable',
      subagentProviderId: 'ariadne.in_process',
      title: 'SubAgent task',
      label: 'Waiting for continuation input'
    };
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => ({
        ...READY,
        capabilities: ['companion.chat', 'agent.inbox', 'agent.subagents']
      }),
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({
              sessions: [session('session-a')],
              runs: [child, parent]
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
        if (command.kind === 'agent.subagent.send.v3') {
          return {
            kind: 'agent.subagent.input.sent.v3',
            parentRunId: command.parentRunId,
            childRunId: command.childRunId,
            childRunVersion: 5,
            inputId: command.inputId,
            inputVersion: 1
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();
    const presentedParent = store.getSnapshot().runs.find(
      (candidate) => candidate.runId === parent.runId
    );
    const presentedChild = store.getSnapshot().runs.find(
      (candidate) => candidate.runId === child.runId
    );
    if (presentedParent === undefined || presentedChild === undefined) {
      throw new Error('projected_subagent_fixture_missing');
    }

    const inputId = await store.sendSubagentInput(
      presentedParent,
      presentedChild,
      'Continue with the second bounded check.'
    );

    expect(commands.find((command) => command.kind === 'agent.subagent.send.v3'))
      .toMatchObject({
        kind: 'agent.subagent.send.v3',
        parentRunId: parent.runId,
        childRunId: child.runId,
        sessionId: 'session-a',
        inputId,
        content: 'Continue with the second bounded check.'
      });
  });

  it('routes a running continuable Child interrupt through its projected aggregate version', async () => {
    const commands: RuntimeCommand[] = [];
    const parent = run('run-parent-interrupt-ui', 'waiting_children', 3);
    const child: PublicRunProjectionV3 = {
      ...run('run-child-interrupt-ui', 'running', 6),
      parentRunId: parent.runId,
      delegationId: 'delegation-child-interrupt-ui',
      subagentMode: 'continuable',
      subagentProviderId: 'ariadne.in_process',
      title: 'Running SubAgent task',
      label: 'Generating'
    };
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => ({
        ...READY,
        capabilities: ['companion.chat', 'agent.subagents']
      }),
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({
              sessions: [session('session-a')],
              runs: [child, parent]
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
        if (command.kind === 'agent.subagent.interrupt.v3') {
          return {
            kind: 'agent.subagent.interrupted.v3',
            parentRunId: command.parentRunId,
            childRunId: command.childRunId,
            childRunVersion: 8,
            previousStatus: 'active'
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();
    const presentedParent = store.getSnapshot().runs.find(
      (candidate) => candidate.runId === parent.runId
    );
    const presentedChild = store.getSnapshot().runs.find(
      (candidate) => candidate.runId === child.runId
    );
    if (presentedParent === undefined || presentedChild === undefined) {
      throw new Error('projected_interrupt_subagent_fixture_missing');
    }

    await store.interruptSubagent(presentedParent, presentedChild);

    expect(commands.find((command) => command.kind === 'agent.subagent.interrupt.v3'))
      .toMatchObject({
        kind: 'agent.subagent.interrupt.v3',
        parentRunId: parent.runId,
        childRunId: child.runId,
        sessionId: 'session-a',
        expectedChildVersion: 6,
        reason: 'user_requested'
      });
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
