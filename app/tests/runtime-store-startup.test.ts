import { describe, expect, it, vi } from 'vitest';

import type { RuntimeCommand, RuntimeEventEnvelope, RuntimeResult, RuntimeStatus } from '@ariadne/protocol/public';
import type { AriadneApi } from '../src/shared/contract';
import { RuntimeStore } from '../src/renderer/src/core/runtime/runtime-store';
import { emptyRuntimeSnapshot, runtimeEnvelope } from './runtime-event-fixture';

describe('RuntimeStore startup loading', () => {
  it('keeps live Trace events that arrive while the initial Trace list is loading', async () => {
    let finishTrace!: (result: RuntimeResult) => void;
    const traceResult = new Promise<RuntimeResult>((resolve) => {
      finishTrace = resolve;
    });
    let traceRequested!: () => void;
    const traceRequestStarted = new Promise<void>((resolve) => {
      traceRequested = resolve;
    });
    let listener: ((event: RuntimeEventEnvelope) => void) | undefined;
    const store = new RuntimeStore({
      getStatus: async () => ({
        availability: 'ready',
        capabilities: [],
        observedAt: '2026-07-24T15:20:00.000Z'
      }),
      request: async (command) => {
        if (command.kind === 'runtime.snapshot.get') return emptyRuntimeSnapshot(1);
        if (command.kind === 'models.list' || command.kind === 'models.check') {
          return { kind: 'models.catalog', models: [] };
        }
        if (command.kind === 'companion.sessions.list') {
          return { kind: 'companion.sessions', sessions: [] };
        }
        if (command.kind === 'trace.list') {
          traceRequested();
          return traceResult;
        }
        return { kind: 'acknowledged' };
      },
      onEvent: (next) => {
        listener = next;
        return () => { listener = undefined; };
      }
    });

    const initialization = store.initialize();
    await traceRequestStarted;
    listener?.(runtimeEnvelope({
      kind: 'trace.appended',
      entry: {
        traceId: 'trace-live',
        level: 'error',
        category: 'companion.proposal.protocol',
        message: '实时协议错误',
        occurredAt: '2026-07-24T15:20:02.000Z'
      }
    }, 2));
    finishTrace({
      kind: 'trace',
      entries: [{
        traceId: 'trace-history',
        level: 'info',
        category: 'runtime.ready',
        message: '',
        occurredAt: '2026-07-24T15:20:01.000Z'
      }]
    });
    await initialization;

    expect(store.getSnapshot().trace).toEqual([
      expect.objectContaining({ traceId: 'trace-history' }),
      expect.objectContaining({
        traceId: 'trace-live',
        level: 'error',
        message: '实时协议错误'
      })
    ]);
  });

  it('re-subscribes after lifecycle cleanup and keeps a status event newer than the initial snapshot', async () => {
    let finishStatus!: (status: RuntimeStatus) => void;
    const status = new Promise<RuntimeStatus>((resolve) => {
      finishStatus = resolve;
    });
    const listeners = new Set<(event: RuntimeEventEnvelope) => void>();
    const store = new RuntimeStore({
      getStatus: () => status,
      request: async (command) => {
        if (command.kind === 'runtime.snapshot.get') return emptyRuntimeSnapshot(1);
        if (command.kind === 'models.list' || command.kind === 'models.check') {
          return { kind: 'models.catalog', models: [] };
        }
        if (command.kind === 'companion.sessions.list') {
          return { kind: 'companion.sessions', sessions: [] };
        }
        if (command.kind === 'trace.list') return { kind: 'trace', entries: [] };
        return { kind: 'acknowledged' };
      },
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
      listener(runtimeEnvelope({
        kind: 'runtime.status.changed',
        status: {
          availability: 'ready',
          capabilities: [],
          observedAt: '2026-07-22T00:00:01.000Z'
        }
      }, 1));
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

  it('reconciles a missing permission payload when a Run enters waiting_permission', async () => {
    const commands: RuntimeCommand[] = [];
    let listener: ((event: RuntimeEventEnvelope) => void) | undefined;
    const store = new RuntimeStore({
      getStatus: async () => ({
        availability: 'ready',
        capabilities: [],
        observedAt: '2026-07-25T04:09:00.000Z'
      }),
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'runtime.snapshot.get') return emptyRuntimeSnapshot();
        if (command.kind === 'models.list' || command.kind === 'models.check') {
          return { kind: 'models.catalog', models: [] };
        }
        if (command.kind === 'companion.sessions.list') {
          return { kind: 'companion.sessions', sessions: [] };
        }
        if (command.kind === 'trace.list') return { kind: 'trace', entries: [] };
        if (command.kind === 'permissions.list') {
          return {
            kind: 'permissions',
            requests: [{
              requestId: 'permission-1',
              runId: 'run-1',
              workspaceId: 'primary',
              workspaceLabel: 'E:\\Temp',
              approvalVersion: 'approval-1',
              title: '写入项目文件',
              reason: '需要写入文件才能继续。',
              permissionItems: [{
                itemId: 'write-1',
                capability: 'write_file',
                targetLabel: 'workspace-file.txt',
                reason: '实现用户要求',
                risk: 'medium',
                approvalScopes: ['once']
              }],
              status: 'pending',
              createdAt: '2026-07-25T04:09:01.000Z'
            }]
          };
        }
        return { kind: 'acknowledged' };
      },
      onEvent: (next) => {
        listener = next;
        return () => { listener = undefined; };
      }
    });
    await store.initialize();

    listener?.(runtimeEnvelope({
      kind: 'run.changed',
      run: {
        runId: 'run-1',
        sessionId: 'agent-session-1',
        origin: 'agent',
        title: '修改项目',
        status: 'waiting_permission',
        userFacingLabel: '等待权限确认',
        aggregateVersion: 1,
        checkpointStage: 'waiting_confirmation',
        recoveryStatus: 'none',
        timing: {
          activeDurationMs: 0,
          activeSince: '2026-07-25T04:09:00.000Z'
        },
        startedAt: '2026-07-25T04:09:00.000Z'
      }
    }, 1));

    await vi.waitFor(() => {
      expect(store.getSnapshot().permissions).toEqual([
        expect.objectContaining({ requestId: 'permission-1', runId: 'run-1', status: 'pending' })
      ]);
    });
    expect(commands.filter((command) => command.kind === 'permissions.list')).toHaveLength(1);
  });

  it('preserves the whole-turn processing clock when a Companion message binds to an Agent Run', async () => {
    let listener: ((event: RuntimeEventEnvelope) => void) | undefined;
    const store = new RuntimeStore({
      getStatus: async () => ({
        availability: 'ready',
        capabilities: [],
        observedAt: '2026-07-22T00:00:00.000Z'
      }),
      request: async (command) => {
        if (command.kind === 'runtime.snapshot.get') return emptyRuntimeSnapshot();
        if (command.kind === 'models.list' || command.kind === 'models.check') {
          return { kind: 'models.catalog', models: [] };
        }
        if (command.kind === 'companion.sessions.list') {
          return {
            kind: 'companion.sessions',
            sessions: [{
              sessionId: 'companion-session-1',
              workspaceId: 'primary',
              title: '检查项目',
              pinned: false,
              createdAt: '2026-07-22T00:00:00.000Z',
              updatedAt: '2026-07-22T00:00:00.000Z'
            }]
          };
        }
        if (command.kind === 'companion.messages.list') {
          return { kind: 'companion.messages', messages: [] };
        }
        if (command.kind === 'trace.list') return { kind: 'trace', entries: [] };
        return { kind: 'acknowledged' };
      },
      onEvent: (next) => {
        listener = next;
        return () => { listener = undefined; };
      }
    });
    await store.initialize();
    await store.selectSession('companion-session-1');

    listener?.(runtimeEnvelope({
      kind: 'companion.message.changed',
      message: {
        messageId: 'user-turn-1',
        sessionId: 'companion-session-1',
        role: 'user',
        content: '检查项目',
        status: 'completed',
        createdAt: '2026-07-22T00:00:00.000Z'
      }
    }, 1));
    listener?.(runtimeEnvelope({
      kind: 'companion.message.changed',
      message: {
        messageId: 'assistant-turn-1',
        sessionId: 'companion-session-1',
        runId: 'agent-run-1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: '2026-07-22T00:00:00.000Z'
      }
    }, 2));
    listener?.(runtimeEnvelope({
      kind: 'run.changed',
      run: {
        runId: 'agent-run-1',
        sessionId: 'companion-session-1',
        origin: 'agent',
        title: '检查项目',
        status: 'running',
        userFacingLabel: '正在处理',
        aggregateVersion: 1,
        checkpointStage: 'running',
        recoveryStatus: 'none',
        timing: {
          activeDurationMs: 2_000,
          activeSince: '2026-07-22T00:00:07.000Z'
        },
        startedAt: '2026-07-22T00:00:05.000Z'
      }
    }, 3));

    expect(store.getSnapshot().runs).toContainEqual(expect.objectContaining({
      runId: 'agent-run-1',
      origin: 'agent',
      startedAt: '2026-07-22T00:00:00.000Z',
      sourceMessageId: 'user-turn-1',
      timing: {
        activeDurationMs: 7_000,
        activeSince: '2026-07-22T00:00:07.000Z'
      }
    }));
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
        case 'runtime.snapshot.get':
          return emptyRuntimeSnapshot();
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
