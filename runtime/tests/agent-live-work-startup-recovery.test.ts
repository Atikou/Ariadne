import type {
  AgentRun,
  AgentRunRecoveryPage,
  AgentRunRecoveryPayloadReader,
  AgentRunRecoveryQuery
} from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentLiveWorkStartupRecovery,
  type AgentLiveWorkStartupRecoverySink
} from '../src/control/execution/AgentLiveWorkStartupRecovery.js';

describe('AgentLiveWorkStartupRecovery', () => {
  it('projects a protected running process-start result as one interrupted live-work fact', async () => {
    const run = activeRun();
    const page: AgentRunRecoveryPage = {
      items: [{
        ready: true,
        phase: 'resumable',
        run,
        checkpoint: {
          runId: run.runId,
          runVersion: run.version,
          checkpointVersion: 1,
          commandId: 'command-checkpoint-live-work-recovery',
          createdAt: at(0)
        },
        turnInputPayloads: [],
        effectPayloads: [{
          runId: run.runId,
          effectId: 'effect-process-start-recovery',
          inputDigest: digest('5'),
          inputCommandId: 'command-process-input-recovery',
          inputRunVersion: 1,
          createdAt: at(0),
          updatedAt: at(1),
          hasResult: true,
          resultCommandId: 'command-process-result-recovery',
          resultRunVersion: run.version
        }]
      }]
    };
    const store = recoveryStore(page, {
      jobId: 'job-process-start-recovery',
      kind: 'process',
      status: 'running',
      outputCursor: 19
    });
    const notify = vi.fn<AgentLiveWorkStartupRecoverySink['notify']>(async () => undefined);
    const recovery = new AgentLiveWorkStartupRecovery(
      store,
      { notify },
      () => new Date(at(9))
    );

    await recovery.reconcile();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({
      runId: run.runId,
      workspaceId: run.binding.workspace.workspaceId,
      jobId: 'job-process-start-recovery',
      workKind: 'process',
      status: 'interrupted',
      finishedAt: at(9),
      outputCursor: 19,
      detail: 'runtime_restarted_before_live_work_completion'
    });
  });

  it('fails closed when a protected process-start result does not prove a running process', async () => {
    const run = activeRun();
    const page = resumablePage(run);
    const store = recoveryStore(page, {
      jobId: 'job-process-start-recovery',
      kind: 'process',
      status: 'completed',
      outputCursor: 19
    });
    const notify = vi.fn<AgentLiveWorkStartupRecoverySink['notify']>(async () => undefined);

    await expect(new AgentLiveWorkStartupRecovery(store, { notify }).reconcile())
      .rejects.toThrow('agent_live_work_startup_result_invalid');
    expect(notify).not.toHaveBeenCalled();
  });

  it('projects a protected running terminal-start result with its terminal kind', async () => {
    const run = activeRun('workspace.terminal_start');
    const store = recoveryStore(resumablePage(run), {
      jobId: 'job-terminal-start-recovery',
      kind: 'terminal',
      status: 'running',
      outputCursor: 31
    });
    const notify = vi.fn<AgentLiveWorkStartupRecoverySink['notify']>(async () => undefined);

    await new AgentLiveWorkStartupRecovery(
      store,
      { notify },
      () => new Date(at(9))
    ).reconcile();

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-terminal-start-recovery',
      workKind: 'terminal',
      status: 'interrupted',
      outputCursor: 31
    }));
  });
});

function recoveryStore(
  page: AgentRunRecoveryPage,
  result: Awaited<ReturnType<AgentRunRecoveryPayloadReader['loadEffectResult']>>
): AgentRunRecoveryQuery & Pick<AgentRunRecoveryPayloadReader, 'loadEffectResult'> {
  return {
    listActiveRuns: vi.fn(async () => page),
    loadEffectResult: vi.fn(async () => result)
  };
}

function resumablePage(run: AgentRun): AgentRunRecoveryPage {
  return {
    items: [{
      ready: true,
      phase: 'resumable',
      run,
      checkpoint: {
        runId: run.runId,
        runVersion: run.version,
        checkpointVersion: 1,
        commandId: 'command-checkpoint-live-work-recovery',
        createdAt: at(0)
      },
      turnInputPayloads: [],
      effectPayloads: [{
        runId: run.runId,
        effectId: 'effect-process-start-recovery',
        inputDigest: digest('5'),
        inputCommandId: 'command-process-input-recovery',
        inputRunVersion: 1,
        createdAt: at(0),
        updatedAt: at(1),
        hasResult: true,
        resultCommandId: 'command-process-result-recovery',
        resultRunVersion: run.version
      }]
    }]
  };
}

function activeRun(toolName = 'workspace.process_start'): AgentRun {
  return {
    runId: 'run-live-work-startup-recovery',
    version: 2,
    binding: {
      bindingVersion: 3,
      sessionId: 'session-live-work-startup-recovery',
      objectiveRef: {
        kind: 'conversation_message',
        messageId: 'message-live-work-startup-recovery',
        messageVersion: 1,
        contentDigest: digest('1')
      },
      workspace: {
        workspaceId: 'workspace-live-work-startup-recovery',
        revision: 1,
        grantDigest: digest('2'),
        access: 'write',
        scopeIds: ['workspace-live-work-startup-recovery']
      },
      model: { providerId: 'provider-test', modelId: 'model-test', settingsRevision: 1 },
      policy: { policyId: 'policy-test', revision: 1, permissionMode: 'trusted' },
      capabilities: ['workspace.shell'],
      toolCatalog: {
        catalogId: 'catalog-live-work-startup-recovery',
        revision: 1,
        digest: digest('3'),
        allowedToolNames: [toolName]
      },
      budget: {
        grantId: 'grant-live-work-startup-recovery',
        runId: 'run-live-work-startup-recovery',
        vector: {
          modelTurns: 10,
          toolCalls: 10,
          readCalls: 10,
          writeCalls: 10,
          shellCalls: 10,
          costMicrousd: 1_000_000
        },
        deadlineAt: '2031-01-01T00:00:00.000Z',
        source: { kind: 'root' }
      }
    },
    state: { status: 'running', checkpointVersion: 1, enteredAt: at(0) },
    turns: [],
    effects: [{
      effectId: 'effect-process-start-recovery',
      runId: 'run-live-work-startup-recovery',
      toolCallId: 'tool-call-process-start-recovery',
      tool: {
        catalogId: 'catalog-live-work-startup-recovery',
        revision: 1,
        digest: digest('3'),
        toolName,
        toolVersion: '1.0.0',
        providerId: 'ariadne.builtin',
        contractDigest: digest('4')
      },
      idempotencyKey: 'idempotency-process-start-recovery',
      capabilityIds: ['workspace.shell'],
      scope: ['workspace-live-work-startup-recovery'],
      inputDigest: digest('5'),
      state: { status: 'succeeded', finishedAt: at(1), attempt: 1 }
    }],
    inbox: [],
    createdAt: at(0),
    updatedAt: at(1)
  };
}

function at(second: number): string {
  return `2026-08-28T00:00:${String(second).padStart(2, '0')}.000Z`;
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
