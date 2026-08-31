import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import { describe, expect, it, vi } from 'vitest';

import type { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { AgentControlPublicCommandRouter } from '../src/composition/AgentControlPublicCommandRouter.js';
import type { AgentControlExecutionPipeline } from '../src/composition/ProductionAgentControlExecutionPipelineFactory.js';
import type { RuntimeCommandEnvelope } from '../src/ingress/RuntimeIngress.js';

describe('AgentControlPublicCommandRouter SubAgent interruption', () => {
  it('authorizes the direct continuable parent and returns exact active interruption evidence', async () => {
    const interruptActiveTurn = vi.fn(async () => ({
      status: 'interrupted' as const,
      runId: 'run-child',
      runVersion: 9,
      turnId: 'turn-child',
      attemptId: 'attempt-child',
      recoveryDecisionId: 'recovery-child'
    }));
    const router = routerFor({
      'run-parent': parentRun('run-parent'),
      'run-child': childRun('run-parent', 'continuable')
    }, interruptActiveTurn);

    await expect(router.executeOwnedCommand(envelope('run-parent'))).resolves.toEqual({
      outcome: {
        ok: true,
        result: {
          kind: 'agent.subagent.interrupted.v3',
          parentRunId: 'run-parent',
          childRunId: 'run-child',
          childRunVersion: 9,
          previousStatus: 'active'
        }
      },
      settlement: 'completed'
    });
    expect(interruptActiveTurn).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'command-interrupt-child',
      runId: 'run-child',
      expectedVersion: 7,
      finalize: expect.any(Function)
    }));
  });

  it('fails closed for a non-parent and treats one-shot children as inactive no-ops', async () => {
    const interruptActiveTurn = vi.fn();
    const wrongParent = routerFor({
      'run-parent': parentRun('run-parent'),
      'run-child': childRun('run-other-parent', 'continuable')
    }, interruptActiveTurn);
    const denied = await wrongParent.executeOwnedCommand(envelope('run-parent'));
    expect(denied).toMatchObject({
      outcome: { ok: false, error: { code: 'subagent_interrupt_not_authorized' } },
      settlement: 'completed'
    });
    expect(interruptActiveTurn).not.toHaveBeenCalled();

    const oneShot = routerFor({
      'run-parent': parentRun('run-parent'),
      'run-child': childRun('run-parent', 'one_shot')
    }, interruptActiveTurn);
    await expect(oneShot.executeOwnedCommand(envelope('run-parent'))).resolves.toMatchObject({
      outcome: {
        ok: true,
        result: {
          kind: 'agent.subagent.interrupted.v3',
          childRunVersion: 7,
          previousStatus: 'inactive'
        }
      }
    });
    expect(interruptActiveTurn).not.toHaveBeenCalled();
  });

  it('serves protected Tool detail only through the authorized workspace and pinned presentation', async () => {
    const read = vi.fn(async () => ({
      runId: 'run-detail',
      workspaceId: 'workspace-detail',
      effectId: 'effect-detail',
      toolCallId: 'call-detail',
      status: 'succeeded' as const,
      tool: {
        catalogId: 'catalog-detail',
        revision: 1,
        digest: `sha256:${'a'.repeat(64)}`,
        toolName: 'workspace.read_file',
        toolVersion: '2.0.0',
        providerId: 'ariadne.runtime',
        contractDigest: `sha256:${'b'.repeat(64)}`
      },
      digest: `sha256:${'c'.repeat(64)}`,
      totalBytes: 18,
      cursor: 0,
      nextCursor: 18,
      content: '{"content":"ok"}',
      complete: true
    }));
    const pipeline = {
      protectedEffectResultReader: { read },
      toolPresentationResolver: {
        resolveToolPresentation: vi.fn(() => ({ kind: 'file_read', label: '读取工作区文件' }))
      },
      runWorkScheduler: { wake: vi.fn(), interruptActiveTurn: vi.fn() }
    } as unknown as AgentControlExecutionPipeline;
    const router = new AgentControlPublicCommandRouter(
      {} as SqliteAgentRunUnitOfWork,
      {} as SqliteConversationRunHandoffUnitOfWork,
      {} as SqlitePublicProjectionStore,
      pipeline,
      { wakeProjectionDrain: vi.fn(), executeProjectionQuery: vi.fn() },
      { authorizedWorkspaceIds: ['workspace-detail'] }
    );
    const command = {
      commandId: 'command-tool-detail',
      correlationId: 'correlation-tool-detail',
      deadlineAt: '2026-08-28T00:01:00.000Z',
      signal: new AbortController().signal,
      command: {
        kind: 'agent.tool_result.detail.get.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        runId: 'run-detail',
        workspaceId: 'workspace-detail',
        effectId: 'effect-detail',
        cursor: 0,
        maxBytes: 32 * 1024
      }
    } as RuntimeCommandEnvelope;

    await expect(router.executeOwnedCommand(command)).resolves.toMatchObject({
      outcome: {
        ok: true,
        result: {
          kind: 'agent.tool_result.detail.v3',
          workspaceId: 'workspace-detail',
          effectId: 'effect-detail',
          presentation: { kind: 'file_read', label: '读取工作区文件' },
          content: '{"content":"ok"}',
          complete: true
        }
      },
      settlement: 'completed'
    });
    expect(read).toHaveBeenCalledWith(command.command);

    const denied = {
      ...command,
      commandId: 'command-tool-detail-denied',
      command: { ...command.command, workspaceId: 'workspace-other' }
    } as RuntimeCommandEnvelope;
    await expect(router.executeOwnedCommand(denied)).resolves.toMatchObject({
      outcome: { ok: false, error: { code: 'workspace_not_authorized' } }
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

function routerFor(
  runs: Readonly<Record<string, ReturnType<typeof parentRun> | ReturnType<typeof childRun>>>,
  interruptActiveTurn: ReturnType<typeof vi.fn>
): AgentControlPublicCommandRouter {
  const unitOfWork = {
    loadCommittedCommandReceipt: vi.fn(async () => null),
    transaction: vi.fn(async (operation: (transaction: {
      loadRun(runId: string): Promise<unknown>;
    }) => unknown) => operation({
      loadRun: async (runId: string) => runs[runId] ?? null
    }))
  } as unknown as SqliteAgentRunUnitOfWork;
  const pipeline = {
    runWorkScheduler: {
      wake: vi.fn(),
      interruptActiveTurn
    }
  } as unknown as AgentControlExecutionPipeline;
  return new AgentControlPublicCommandRouter(
    unitOfWork,
    {} as SqliteConversationRunHandoffUnitOfWork,
    {} as SqlitePublicProjectionStore,
    pipeline,
    {
      wakeProjectionDrain: vi.fn(),
      executeProjectionQuery: vi.fn()
    }
  );
}

function envelope(parentRunId: string): RuntimeCommandEnvelope {
  return {
    commandId: 'command-interrupt-child',
    correlationId: 'correlation-interrupt-child',
    deadlineAt: '2026-08-28T00:01:00.000Z',
    signal: new AbortController().signal,
    command: {
      kind: 'agent.subagent.interrupt.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      parentRunId,
      childRunId: 'run-child',
      sessionId: 'session-subagent',
      expectedChildVersion: 7,
      occurredAt: '2026-08-28T00:00:00.000Z',
      reason: 'user_requested'
    }
  };
}

function parentRun(runId: string) {
  return {
    runId,
    version: 5,
    binding: { sessionId: 'session-subagent' },
    state: { status: 'waiting_children' }
  } as const;
}

function childRun(parentRunId: string, mode: 'one_shot' | 'continuable') {
  return {
    runId: 'run-child',
    version: 7,
    binding: {
      sessionId: 'session-subagent',
      objectiveRef: {
        kind: 'parent_delegation',
        parentRunId,
        delegationId: 'delegation-child',
        objectiveDigest: `sha256:${'a'.repeat(64)}`,
        providerId: 'ariadne.in_process',
        mode
      }
    },
    state: { status: 'running' }
  } as const;
}
