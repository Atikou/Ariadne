import { describe, expect, it, vi } from 'vitest';

import type {
  CompanionMessage,
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResult,
  RuntimeStatus
} from '@ariadne/protocol/public';
import { RuntimeStore } from '../src/renderer/src/core/runtime/runtime-store';
import type { AriadneApi } from '../src/shared/contract';
import { emptyRuntimeSnapshot, runtimeEnvelope } from './runtime-event-fixture';

const stoppedStatus: RuntimeStatus = {
  availability: 'stopped',
  capabilities: [],
  observedAt: '2026-07-22T00:00:00.000Z'
};

describe('RuntimeStore Chat sending', () => {
  it('keeps user-authored whitespace unchanged in optimistic history and the Runtime command', async () => {
    const message = '  你好\n下一行  ';
    let resolveRequest: ((result: RuntimeResult) => void) | undefined;
    const request = vi.fn((command: RuntimeCommand): Promise<RuntimeResult> => {
      if (command.kind === 'companion.chat.start') {
        return new Promise<RuntimeResult>((resolve) => {
          resolveRequest = resolve;
        });
      }
      if (command.kind === 'companion.messages.list') {
        return Promise.resolve({ kind: 'companion.messages', messages: [] });
      }
      if (command.kind === 'companion.sessions.list') {
        return Promise.resolve({ kind: 'companion.sessions', sessions: [] });
      }
      if (command.kind === 'runs.list') return Promise.resolve({ kind: 'runs', runs: [] });
      return Promise.reject(new Error(`Unexpected command: ${command.kind}`));
    });
    const api: AriadneApi['runtime'] = {
      getStatus: async () => stoppedStatus,
      request,
      onEvent: () => () => undefined
    };
    const store = new RuntimeStore(api);

    const sending = store.sendMessage(message, {
      modelId: 'model-1',
      routingStrategy: 'privacy-first',
      workspaceId: 'primary'
    });

    expect(store.getSnapshot().messages[0]?.content).toBe(message);
    expect(store.getSnapshot().messages[1]).toMatchObject({
      role: 'assistant',
      content: '',
      status: 'streaming'
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ message, routingStrategy: 'privacy-first' }));

    resolveRequest?.({ kind: 'companion.chat.accepted', runId: 'run-exact', sessionId: 'session-exact' });
    await expect(sending).resolves.toEqual({ runId: 'run-exact', sessionId: 'session-exact' });
  });

  it('renders an assistant thinking placeholder immediately, then replaces both optimistic messages from events', async () => {
    let emit: ((event: RuntimeEventEnvelope) => void) | undefined;
    let resolveRequest: ((result: RuntimeResult) => void) | undefined;
    const pendingRequest = new Promise<RuntimeResult>((resolve) => {
      resolveRequest = resolve;
    });
    let authoritativeMessages: CompanionMessage[] = [];
    const request = vi.fn((command: RuntimeCommand): Promise<RuntimeResult> => {
      if (command.kind === 'companion.chat.start') return pendingRequest;
      if (command.kind === 'runtime.snapshot.get') return Promise.resolve(emptyRuntimeSnapshot(1));
      if (command.kind === 'models.list' || command.kind === 'models.check') {
        return Promise.resolve({ kind: 'models.catalog', models: [] });
      }
      if (command.kind === 'trace.list') return Promise.resolve({ kind: 'trace', entries: [] });
      if (command.kind === 'companion.messages.list') {
        return Promise.resolve({ kind: 'companion.messages', messages: authoritativeMessages });
      }
      if (command.kind === 'companion.sessions.list') {
        return Promise.resolve({ kind: 'companion.sessions', sessions: [] });
      }
      if (command.kind === 'runs.list') return Promise.resolve({ kind: 'runs', runs: [] });
      return Promise.reject(new Error(`Unexpected command: ${command.kind}`));
    });
    const api: AriadneApi['runtime'] = {
      getStatus: async () => stoppedStatus,
      request,
      onEvent(listener) {
        emit = listener;
        return () => undefined;
      }
    };
    const store = new RuntimeStore(api);
    await store.initialize();
    emit?.(runtimeEnvelope({
      kind: 'runtime.status.changed',
      status: {
        availability: 'ready',
        capabilities: [],
        observedAt: '2026-07-22T00:00:00.000Z'
      }
    }, 1));
    await vi.waitFor(() => {
      expect(store.getSnapshot().status.availability).toBe('ready');
    });

    const sending = store.sendMessage('发送后立即出现', { modelId: 'model-1', workspaceId: 'primary' });
    const [optimistic, thinking] = store.getSnapshot().messages;

    expect(optimistic).toMatchObject({
      role: 'user',
      content: '发送后立即出现',
      deliveryState: 'pending'
    });
    expect(thinking).toMatchObject({
      role: 'assistant',
      content: '',
      status: 'streaming'
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'companion.chat.start',
      clientMessageId: optimistic?.messageId,
      message: '发送后立即出现',
      workspaceId: 'primary'
    }));

    authoritativeMessages = [
      {
        messageId: optimistic!.messageId,
        sessionId: 'session-1',
        role: 'user',
        content: '发送后立即出现',
        status: 'completed',
        createdAt: '2026-07-22T00:00:01.000Z'
      },
      {
        messageId: 'assistant-1',
        sessionId: 'session-1',
        role: 'assistant',
        content: '开始回复',
        status: 'streaming',
        createdAt: '2026-07-22T00:00:02.000Z'
      }
    ];

    emit?.(runtimeEnvelope({
      kind: 'companion.message.changed',
      message: authoritativeMessages[0]!
    }, 2));

    expect(store.getSnapshot().selectedSessionId).toBe('session-1');
    expect(store.getSnapshot().messages).toHaveLength(2);
    expect(store.getSnapshot().messages[0]).toMatchObject({
      messageId: optimistic!.messageId,
      sessionId: 'session-1',
      content: '发送后立即出现'
    });
    expect(store.getSnapshot().messages[0]?.deliveryState).toBeUndefined();
    expect(store.getSnapshot().messages[1]).toMatchObject({
      status: 'streaming',
      content: ''
    });

    emit?.(runtimeEnvelope({
      kind: 'companion.message.changed',
      message: authoritativeMessages[1]!
    }, 3));

    expect(store.getSnapshot().messages).toEqual(authoritativeMessages);

    resolveRequest?.({ kind: 'companion.chat.accepted', runId: 'run-1', sessionId: 'session-1' });
    await expect(sending).resolves.toEqual({ runId: 'run-1', sessionId: 'session-1' });
  });

  it('recovers authoritative messages after acceptance when all live message events were missed', async () => {
    let resolveStart: ((result: RuntimeResult) => void) | undefined;
    const authoritativeMessages = [
      {
        messageId: 'runtime-user-id',
        sessionId: 'session-recovered',
        role: 'user' as const,
        content: '恢复丢失事件',
        status: 'completed' as const,
        createdAt: '2026-07-22T00:00:01.000Z'
      },
      {
        messageId: 'runtime-assistant-id',
        sessionId: 'session-recovered',
        role: 'assistant' as const,
        content: '已恢复',
        status: 'completed' as const,
        createdAt: '2026-07-22T00:00:02.000Z'
      }
    ];
    const request = vi.fn((command: RuntimeCommand): Promise<RuntimeResult> => {
      if (command.kind === 'companion.chat.start') {
        return new Promise<RuntimeResult>((resolve) => {
          resolveStart = resolve;
        });
      }
      if (command.kind === 'companion.messages.list') {
        return Promise.resolve({ kind: 'companion.messages', messages: authoritativeMessages });
      }
      if (command.kind === 'companion.sessions.list') {
        return Promise.resolve({
          kind: 'companion.sessions',
          sessions: [{
            sessionId: 'session-recovered',
            workspaceId: 'primary',
            title: 'Recovered',
            pinned: false,
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:02.000Z'
          }]
        });
      }
      if (command.kind === 'runs.list') return Promise.resolve({ kind: 'runs', runs: [] });
      return Promise.reject(new Error(`Unexpected command: ${command.kind}`));
    });
    const store = new RuntimeStore({
      getStatus: async () => stoppedStatus,
      request,
      onEvent: () => () => undefined
    });

    const sending = store.sendMessage('恢复丢失事件', { workspaceId: 'primary' });
    expect(store.getSnapshot().messages.map((item) => item.role)).toEqual(['user', 'assistant']);

    resolveStart?.({
      kind: 'companion.chat.accepted',
      runId: 'run-recovered',
      sessionId: 'session-recovered'
    });
    await expect(sending).resolves.toEqual({
      runId: 'run-recovered',
      sessionId: 'session-recovered'
    });

    expect(store.getSnapshot().selectedSessionId).toBe('session-recovered');
    expect(store.getSnapshot().messages).toEqual(authoritativeMessages);
    expect(store.getSnapshot().sessions[0]?.sessionId).toBe('session-recovered');
    expect(request).toHaveBeenCalledWith({
      kind: 'companion.messages.list',
      sessionId: 'session-recovered',
      limit: 500
    });
  });

  it('keeps both immediate messages visible and marks them failed when submission fails', async () => {
    const api: AriadneApi['runtime'] = {
      getStatus: async () => stoppedStatus,
      request: vi.fn(async () => {
        throw new Error('Runtime unavailable');
      }),
      onEvent: () => () => undefined
    };
    const store = new RuntimeStore(api);

    const sending = store.sendMessage('不要等模型回复');
    expect(store.getSnapshot().messages[0]?.deliveryState).toBe('pending');
    expect(store.getSnapshot().messages[1]).toMatchObject({
      role: 'assistant',
      status: 'streaming'
    });

    await expect(sending).rejects.toThrow('Runtime unavailable');
    expect(store.getSnapshot().messages[0]).toMatchObject({
      content: '不要等模型回复',
      deliveryState: 'failed'
    });
    expect(store.getSnapshot().messages[1]).toMatchObject({
      role: 'assistant',
      content: '未能开始回复。',
      status: 'failed',
      error: {
        code: 'RUNTIME_REQUEST_FAILED',
        message: 'Runtime unavailable',
        retryable: true
      }
    });
    expect(store.getSnapshot().trace.at(-1)).toMatchObject({
      level: 'error',
      category: 'runtime.request.error',
      message: 'Runtime unavailable'
    });
  });

  it('uses the displayed session workspace instead of an unrelated selected workspace', async () => {
    const commands: RuntimeCommand[] = [];
    const request = vi.fn(async (command: RuntimeCommand): Promise<RuntimeResult> => {
      commands.push(command);
      if (command.kind === 'companion.sessions.create') {
        return {
          kind: 'companion.session',
          session: {
            sessionId: 'session-secondary',
            workspaceId: 'secondary',
            title: 'Secondary session',
            pinned: false,
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z'
          }
        };
      }
      if (command.kind === 'companion.messages.list') return { kind: 'companion.messages', messages: [] };
      if (command.kind === 'companion.chat.start') {
        return { kind: 'companion.chat.accepted', runId: 'run-secondary', sessionId: 'session-secondary' };
      }
      if (command.kind === 'companion.sessions.list') {
        return {
          kind: 'companion.sessions',
          sessions: [{
            sessionId: 'session-secondary',
            workspaceId: 'secondary',
            title: 'Secondary session',
            pinned: false,
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z'
          }]
        };
      }
      if (command.kind === 'runs.list') return { kind: 'runs', runs: [] };
      throw new Error(`Unexpected command: ${command.kind}`);
    });
    const store = new RuntimeStore({
      getStatus: async () => stoppedStatus,
      request,
      onEvent: () => () => undefined
    });

    await store.createSession({ workspaceId: 'secondary' });
    await store.sendMessage('继续当前会话', { workspaceId: 'primary' });

    expect(commands.find((command) => command.kind === 'companion.chat.start')).toMatchObject({
      kind: 'companion.chat.start',
      sessionId: 'session-secondary',
      workspaceId: 'secondary'
    });
  });
});
