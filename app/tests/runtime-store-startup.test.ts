import { describe, expect, it } from 'vitest';

import type { RuntimeCommand, RuntimeEvent, RuntimeResult, RuntimeStatus } from '@ariadne/protocol/public';
import type { AriadneApi } from '../src/shared/contract';
import { RuntimeStore } from '../src/renderer/src/core/runtime/runtime-store';

describe('RuntimeStore startup loading', () => {
  it('re-subscribes after lifecycle cleanup and keeps a status event newer than the initial snapshot', async () => {
    let finishStatus!: (status: RuntimeStatus) => void;
    const status = new Promise<RuntimeStatus>((resolve) => {
      finishStatus = resolve;
    });
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const store = new RuntimeStore({
      getStatus: () => status,
      request: async () => ({ kind: 'acknowledged' }),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    });

    const firstInitialization = store.initialize();
    expect(listeners.size).toBe(1);
    store.dispose();
    expect(listeners.size).toBe(0);

    const secondInitialization = store.initialize();
    expect(listeners.size).toBe(1);
    for (const listener of listeners) {
      listener({
        kind: 'runtime.status.changed',
        status: {
          availability: 'ready',
          capabilities: [],
          observedAt: '2026-07-22T00:00:01.000Z'
        }
      });
    }
    finishStatus({
      availability: 'starting',
      capabilities: [],
      observedAt: '2026-07-22T00:00:00.000Z'
    });

    await Promise.all([firstInitialization, secondInitialization]);
    expect(store.getSnapshot()).toMatchObject({
      initialized: true,
      status: { availability: 'ready' }
    });

    store.dispose();
    expect(listeners.size).toBe(0);
  });

  it('publishes session metadata without waiting for model health and does not load messages', async () => {
    let finishModelCheck!: (result: RuntimeResult) => void;
    const modelCheck = new Promise<RuntimeResult>((resolve) => {
      finishModelCheck = resolve;
    });
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(runtimeApi(commands, modelCheck));

    await store.initialize();

    expect(store.getSnapshot()).toMatchObject({
      initialized: true,
      selectedSessionId: null,
      messages: [],
      sessions: [{ sessionId: 'session-1', workspaceId: 'primary', title: '历史会话' }]
    });
    expect(commands).toContainEqual({ kind: 'models.check' });
    expect(commands).not.toContainEqual(expect.objectContaining({ kind: 'companion.messages.list' }));

    finishModelCheck({
      kind: 'models.catalog',
      models: [{
        id: 'local-model',
        label: 'Local model',
        location: 'local',
        availability: 'ready',
        supportsAgent: false,
        supportsVision: false
      }]
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot().models[0]?.availability).toBe('ready');
  });

  it('loads message history only after the user selects a session', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(runtimeApi(
      commands,
      Promise.resolve({ kind: 'models.catalog', models: [] })
    ));
    await store.initialize();

    expect(store.getSnapshot().messages).toEqual([]);
    await store.selectSession('session-1');

    expect(commands).toContainEqual({
      kind: 'companion.messages.list',
      sessionId: 'session-1',
      limit: 500
    });
    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: 'session-1',
      messages: [{ messageId: 'message-1', sessionId: 'session-1', content: '按需加载' }]
    });
  });

  it('reloads only the currently selected session after Runtime refresh', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(runtimeApi(
      commands,
      Promise.resolve({ kind: 'models.catalog', models: [] })
    ));
    await store.initialize();
    await store.selectSession('session-1');
    const beforeRefresh = commands.filter((command) =>
      command.kind === 'companion.messages.list').length;

    await store.refresh();

    expect(beforeRefresh).toBe(1);
    expect(commands.filter((command) =>
      command.kind === 'companion.messages.list')).toHaveLength(2);
    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: 'session-1',
      messages: [{ messageId: 'message-1', sessionId: 'session-1', content: '按需加载' }]
    });
  });
});

function runtimeApi(
  commands: RuntimeCommand[],
  modelCheck: Promise<RuntimeResult>
): AriadneApi['runtime'] {
  return {
    getStatus: async () => ({
      availability: 'ready',
      capabilities: [],
      observedAt: '2026-07-22T00:00:00.000Z'
    }),
    request: async (command) => {
      commands.push(command);
      switch (command.kind) {
        case 'models.check':
          return modelCheck;
        case 'models.list':
          return {
            kind: 'models.catalog',
            models: [{
              id: 'local-model',
              label: 'Local model',
              location: 'local',
              availability: 'checking',
              supportsAgent: false,
              supportsVision: false
            }]
          };
        case 'companion.sessions.list':
          return {
            kind: 'companion.sessions',
            sessions: [{
              sessionId: 'session-1',
              workspaceId: 'primary',
              title: '历史会话',
              pinned: false,
              createdAt: '2026-07-22T00:00:00.000Z',
              updatedAt: '2026-07-22T00:00:00.000Z'
            }]
          };
        case 'companion.messages.list':
          return {
            kind: 'companion.messages',
            messages: [{
              messageId: 'message-1',
              sessionId: command.sessionId,
              role: 'assistant',
              content: '按需加载',
              status: 'completed',
              createdAt: '2026-07-22T00:00:01.000Z'
            }]
          };
        case 'agent.proposals.list':
          return { kind: 'agent.proposals', proposals: [] };
        case 'runs.list':
          return { kind: 'runs', runs: [] };
        case 'permissions.list':
          return { kind: 'permissions', requests: [] };
        case 'planHandoffs.list':
          return { kind: 'planHandoffs', handoffs: [] };
        case 'trace.list':
          return { kind: 'trace', entries: [] };
        default:
          return { kind: 'acknowledged' };
      }
    },
    onEvent: () => () => undefined
  };
}
