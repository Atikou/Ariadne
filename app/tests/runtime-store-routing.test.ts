import type { RuntimeCommand, RuntimeEvent } from '@ariadne/protocol/public';
import type { AriadneApi } from '../src/shared/contract';
import { describe, expect, it } from 'vitest';

import {
  RuntimeStore,
  runtimeRequestErrorMessage
} from '../src/renderer/src/core/runtime/runtime-store';

describe('RuntimeStore command routing', () => {
  it('keeps Companion cancellation separate from Agent cancellation', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(fakeRuntimeApi(commands));

    await store.cancelRun({ runId: 'companion-run', origin: 'companion' });
    await store.cancelRun({ runId: 'agent-run', origin: 'agent' });

    expect(commands).toEqual([
      { kind: 'companion.chat.cancel', runId: 'companion-run' },
      { kind: 'runs.cancel', runId: 'agent-run' }
    ]);
  });

  it('forwards the user-selected proposal capability subset and workspace', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(fakeRuntimeApi(commands));

    await store.respondToProposal('proposal-1', 'approve_once', {
      allowedCapabilities: ['file-read'],
      workspaceId: 'primary'
    });

    expect(commands[0]).toEqual({
      kind: 'agent.proposals.respond',
      proposalId: 'proposal-1',
      decision: 'approve_once',
      allowedCapabilities: ['file-read'],
      workspaceId: 'primary'
    });
  });

  it('refreshes pending proposals after a stale response loses the backend race', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore({
      getStatus: async () => ({ availability: 'ready', capabilities: [], observedAt: new Date().toISOString() }),
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'agent.proposals.respond') {
          throw new Error(
            "Error invoking remote method 'ariadne:runtime:request': RuntimeRequestError: Agent 提案不存在或已处理"
          );
        }
        if (command.kind === 'agent.proposals.list') {
          return { kind: 'agent.proposals', proposals: [] };
        }
        return { kind: 'acknowledged' };
      },
      onEvent: () => () => {}
    } as AriadneApi['runtime']);

    await expect(store.respondToProposal('stale-proposal', 'approve_once')).rejects.toThrow(
      'Agent 提案不存在或已处理'
    );
    expect(commands.map((command) => command.kind)).toEqual([
      'agent.proposals.respond',
      'agent.proposals.list'
    ]);
  });

  it('removes Electron IPC and Runtime error wrappers from user-facing messages', () => {
    expect(runtimeRequestErrorMessage(new Error(
      "Error invoking remote method 'ariadne:runtime:request': RuntimeRequestError: Agent 提案不存在或已处理"
    ))).toBe('Agent 提案不存在或已处理');
  });

  it('routes explicit permission and plan resume commands without creating a new Run', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(fakeRuntimeApi(commands));

    await store.resumePermission('permission-1');
    await store.resumePlan('plan-1');

    expect(commands).toEqual([
      { kind: 'permissions.resume', requestId: 'permission-1' },
      { kind: 'planHandoffs.resume', handoffId: 'plan-1' }
    ]);
  });

  it('settles unfinished activities when their Run reaches a terminal state', async () => {
    let emit!: (event: RuntimeEvent) => void;
    const store = new RuntimeStore({
      getStatus: async () => ({
        availability: 'stopped',
        capabilities: [],
        observedAt: new Date().toISOString()
      }),
      request: async () => ({ kind: 'acknowledged' }),
      onEvent: (listener) => {
        emit = listener;
        return () => {};
      }
    });
    await store.initialize();
    emit({
      kind: 'run.activity',
      activity: {
        activityId: 'tool-1',
        runId: 'agent-run',
        kind: 'tool',
        status: 'running',
        title: 'read_file',
        occurredAt: new Date().toISOString()
      }
    });
    emit({
      kind: 'run.changed',
      run: {
        runId: 'agent-run',
        origin: 'agent',
        title: '检查项目',
        status: 'cancelled',
        userFacingLabel: '已取消'
      }
    });

    expect(store.getSnapshot().activities).toEqual([
      expect.objectContaining({ activityId: 'tool-1', status: 'skipped' })
    ]);
  });
});

function fakeRuntimeApi(commands: RuntimeCommand[]): AriadneApi['runtime'] {
  return {
    getStatus: async () => ({ availability: 'ready', capabilities: [], observedAt: new Date().toISOString() }),
    request: async (command) => {
      commands.push(command);
      return { kind: 'acknowledged' };
    },
    onEvent: () => () => {}
  };
}
