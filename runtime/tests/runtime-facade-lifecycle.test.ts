import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeEvent } from '@ariadne/protocol/public';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeFacade } from '../src/application/RuntimeFacade.js';
import type { AppContext } from '../src/app/createAppContext.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RuntimeFacade Agent lifecycle', () => {
  it('acknowledges approval before Agent execution finishes and later emits the Companion result', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-lifecycle-'));
    temporaryRoots.push(root);
    const events: RuntimeEvent[] = [];
    let proposal = sourceProposal('pending');
    let resolveResponse!: (value: Record<string, unknown>) => void;
    const response = new Promise<Record<string, unknown>>((resolve) => { resolveResponse = resolve; });
    const app = fakeApp(root, () => proposal, () => {
      proposal = sourceProposal('executing');
      return response;
    });
    const facade = new RuntimeFacade(app, (event) => events.push(event), 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });

    const result = await Promise.race([
      facade.handle({
        kind: 'agent.proposals.respond',
        proposalId: 'proposal-1',
        decision: 'approve_once',
        allowedCapabilities: ['file-read'],
        workspaceId: 'primary'
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('approval waited for execution')), 100))
    ]);
    expect(result).toMatchObject({
      kind: 'agent.proposal',
      proposal: { proposalId: 'proposal-1', status: 'executing' }
    });

    proposal = sourceProposal('completed');
    resolveResponse({
      proposal,
      companionPresentation: presentedCompanionResult()
    });
    await waitFor(() => events.some((event) => event.kind === 'companion.message.changed'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'companion.message.changed',
        message: expect.objectContaining({ content: 'Agent 已完成检查。', sessionId: 'session-1' })
      }),
      expect.objectContaining({
        kind: 'agent.proposal.changed',
        proposal: expect.objectContaining({ status: 'completed' })
      })
    ]));
  });

  it('blocks write and Shell capabilities for a read-only workspace before execution starts', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-readonly-'));
    temporaryRoots.push(root);
    let responded = false;
    const proposal = { ...sourceProposal('pending'), requestedCapabilities: ['file-read', 'file-write'] };
    const facade = new RuntimeFacade(fakeApp(root, () => proposal, () => {
      responded = true;
      return Promise.resolve({ proposal });
    }), () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'read' }]
    });

    await expect(facade.handle({
      kind: 'agent.proposals.respond',
      proposalId: 'proposal-1',
      decision: 'approve_once',
      allowedCapabilities: ['file-write'],
      workspaceId: 'primary'
    })).rejects.toMatchObject({ code: 'workspace_read_only' });
    expect(responded).toBe(false);
    expect(facade.status().capabilities).not.toContain('workspace.write');
  });

  it('publishes automatic approval as executing without exposing a clickable pending proposal', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-auto-approval-'));
    temporaryRoots.push(root);
    const events: RuntimeEvent[] = [];
    let proposal = {
      ...sourceProposal('pending'),
      requestedCapabilities: ['file-read', 'file-write', 'browser', 'shell']
    };
    let responseInput: Record<string, unknown> | undefined;
    let resolveResponse!: (value: Record<string, unknown>) => void;
    const response = new Promise<Record<string, unknown>>((resolve) => { resolveResponse = resolve; });
    const facade = new RuntimeFacade(fakeApp(root, () => proposal, (input?: Record<string, unknown>) => {
      responseInput = input;
      proposal = sourceProposal('executing');
      return response;
    }), (event) => events.push(event), 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }],
      proposalApproval: 'automatic',
      allowedPermissions: ['read', 'network']
    });

    (facade as unknown as {
      streamProjector: { handle(event: { type: 'agent_proposal'; proposal: typeof proposal }): unknown };
    }).streamProjector.handle({ type: 'agent_proposal', proposal });
    expect(responseInput).toEqual({
      decision: 'approve_once',
      allowedCapabilities: ['file-read', 'browser'],
      workspaceKey: 'primary'
    });
    expect(events.filter((event) => event.kind === 'agent.proposal.changed')).toEqual([
      expect.objectContaining({
        kind: 'agent.proposal.changed',
        proposal: expect.objectContaining({ status: 'executing' })
      })
    ]);

    proposal = sourceProposal('completed');
    resolveResponse({ proposal, companionPresentation: presentedCompanionResult() });
    await waitFor(() => events.some((event) => (
      event.kind === 'agent.proposal.changed' && event.proposal.status === 'completed'
    )));
  });

  it('applies a dynamic read-only ceiling without weakening the configured workspace boundary', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-dynamic-readonly-'));
    temporaryRoots.push(root);
    let responded = false;
    const proposal = { ...sourceProposal('pending'), requestedCapabilities: ['file-read', 'file-write'] };
    const facade = new RuntimeFacade(fakeApp(root, () => proposal, () => {
      responded = true;
      return Promise.resolve({ proposal });
    }), () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });

    await expect(facade.handle({
      kind: 'agent.proposals.respond',
      proposalId: 'proposal-1',
      decision: 'approve_once',
      allowedCapabilities: ['file-write'],
      workspaceId: 'primary',
      workspaceAccess: 'read'
    })).rejects.toMatchObject({ code: 'workspace_read_only' });
    expect(responded).toBe(false);
    expect(facade.status().capabilities).toContain('workspace.write');
  });

  it('resolves permission access from the Run session workspace instead of projectId', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-permission-workspace-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      permissionRequestStore: {
        get: () => ({
          id: 'permission-1',
          runId: 'run-1',
          sessionId: 'agent-session-1',
          projectId: 'project-record-1',
          approvalVersion: 'approval-1',
          status: 'pending',
          requiredPermissions: [{
            id: 'write-1',
            type: 'write_file',
            target: 'workspace-file.txt',
            reason: '需要写入',
            riskTier: 'medium'
          }]
        }),
        listPending: () => []
      },
      runs: { get: () => ({ id: 'run-1', sessionId: 'agent-session-1', status: 'waiting_confirmation' }) },
      contextManager: { getSession: () => ({ workspaceKey: 'primary' }) }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'read' }]
    });

    await expect(facade.handle({
      kind: 'permissions.respond',
      requestId: 'permission-1',
      approvalVersion: 'approval-1',
      decision: 'allow_once',
      approvedItemIds: ['write-1']
    })).rejects.toMatchObject({ code: 'workspace_read_only' });
  });

  it('fails closed when a permission request no longer has a resolvable session workspace', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-permission-missing-session-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      permissionRequestStore: {
        get: () => ({
          id: 'permission-1',
          runId: 'run-1',
          sessionId: 'missing-session',
          approvalVersion: 'approval-1',
          status: 'pending',
          requiredPermissions: [{
            id: 'write-1',
            type: 'write_file',
            target: 'workspace-file.txt',
            reason: '需要写入',
            riskTier: 'medium'
          }]
        }),
        listPending: () => []
      },
      runs: { get: () => ({ id: 'run-1', sessionId: 'missing-session', status: 'waiting_confirmation' }) },
      contextManager: { getSession: () => undefined }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });

    await expect(facade.handle({
      kind: 'permissions.respond',
      requestId: 'permission-1',
      approvalVersion: 'approval-1',
      decision: 'allow_once',
      approvedItemIds: ['write-1']
    })).rejects.toMatchObject({ code: 'workspace_not_authorized' });
  });

  it('surfaces an Agent start-time rejection instead of acknowledging a pending proposal', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-start-rejection-'));
    temporaryRoots.push(root);
    const proposal = sourceProposal('pending');
    const facade = new RuntimeFacade(fakeApp(root, () => proposal, () => Promise.reject(
      Object.assign(new Error('批准能力必须是提案能力的子集'), { code: 'AGENT_HANDOFF_INVALID' })
    )), () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });

    await expect(facade.handle({
      kind: 'agent.proposals.respond',
      proposalId: 'proposal-1',
      decision: 'approve_once',
      allowedCapabilities: ['browser'],
      workspaceId: 'primary'
    })).rejects.toMatchObject({
      message: '批准能力必须是提案能力的子集'
    });
    expect(proposal.status).toBe('pending');
  });

  it('turns cancellation of a permission-paused Run into a permission rejection', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-cancel-permission-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      orchestrator: { cancelRun: () => ({ status: 404, body: {} }) },
      runs: { get: () => ({ id: 'run-1', status: 'waiting_confirmation' }) },
      permissionRequestStore: {
        listPending: () => [{ id: 'permission-1', runId: 'run-1', approvalVersion: 'approval-1' }]
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test');
    const respondPermission = vi.spyOn(
      facade as unknown as { respondPermission(command: unknown): Promise<unknown> },
      'respondPermission'
    ).mockResolvedValue({ kind: 'permission' });

    await expect(facade.handle({ kind: 'runs.cancel', runId: 'run-1' }))
      .resolves.toEqual({ kind: 'acknowledged' });
    expect(respondPermission).toHaveBeenCalledWith({
      kind: 'permissions.respond',
      requestId: 'permission-1',
      approvalVersion: 'approval-1',
      decision: 'deny',
      approvedItemIds: []
    });
  });

  it('turns cancellation of a plan-paused Run into a plan rejection', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-cancel-plan-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      orchestrator: { cancelRun: () => ({ status: 404, body: {} }) },
      runs: { get: () => ({ id: 'run-1', status: 'waiting_plan_handoff' }) },
      planHandoffStore: { listPending: () => [{ id: 'plan-1', runId: 'run-1' }] }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test');
    const respondPlanHandoff = vi.spyOn(
      facade as unknown as { respondPlanHandoff(command: unknown): Promise<unknown> },
      'respondPlanHandoff'
    ).mockResolvedValue({ kind: 'planHandoff' });

    await expect(facade.handle({ kind: 'runs.cancel', runId: 'run-1' }))
      .resolves.toEqual({ kind: 'acknowledged' });
    expect(respondPlanHandoff).toHaveBeenCalledWith({
      kind: 'planHandoffs.respond',
      handoffId: 'plan-1',
      decision: 'reject'
    });
  });

  it('lists approved permission and plan decisions only while their paused Runs are retryable', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-retryable-list-'));
    temporaryRoots.push(root);
    const now = new Date().toISOString();
    const permission = approvedPermission(now);
    const handoff = approvedPlanHandoff(now);
    const runs = [
      sourceRun('run-permission', 'waiting_confirmation', now),
      sourceRun('run-plan', 'waiting_plan_handoff', now)
    ];
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      runs: {
        list: () => runs,
        get: (runId: string) => runs.find((run) => run.id === runId) ?? null
      },
      pausedRunStore: { get: (runId: string) => ({ runId }) },
      permissionRequestStore: {
        listPending: () => [],
        getApprovedByRunId: (runId: string) => runId === permission.runId ? permission : null
      },
      planHandoffStore: {
        listPending: () => [],
        getApprovedByRunId: (runId: string) => runId === handoff.runId ? handoff : null
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test');

    await expect(facade.handle({ kind: 'permissions.list' })).resolves.toMatchObject({
      kind: 'permissions',
      requests: [{ requestId: permission.id, status: 'approved' }]
    });
    await expect(facade.handle({ kind: 'planHandoffs.list' })).resolves.toMatchObject({
      kind: 'planHandoffs',
      handoffs: [{ handoffId: handoff.id, status: 'approved' }]
    });
  });

  it('retries approved paused Runs through explicit commands and rejects concurrent resumes', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-explicit-resume-'));
    temporaryRoots.push(root);
    const now = new Date().toISOString();
    const permission = approvedPermission(now);
    const handoff = approvedPlanHandoff(now);
    const runs = [
      sourceRun('run-permission', 'waiting_confirmation', now),
      sourceRun('run-plan', 'waiting_plan_handoff', now)
    ];
    const resumePermission = vi.fn(() => new Promise(() => {}));
    const resumePlanHandoff = vi.fn(() => new Promise(() => {}));
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      runs: {
        list: () => runs,
        get: (runId: string) => runs.find((run) => run.id === runId) ?? null
      },
      pausedRunStore: { get: (runId: string) => ({ runId }) },
      permissionRequestStore: { get: (id: string) => id === permission.id ? permission : null },
      planHandoffStore: { get: (id: string) => id === handoff.id ? handoff : null },
      orchestrator: {
        resumeAfterPermission: resumePermission,
        resumeAfterPlanHandoff: resumePlanHandoff
      },
      makeChatFn: () => vi.fn()
    });
    const facade = new RuntimeFacade(app, () => {}, 'test');

    await expect(facade.handle({ kind: 'permissions.resume', requestId: permission.id }))
      .resolves.toMatchObject({ kind: 'run', run: { runId: permission.runId } });
    await expect(facade.handle({ kind: 'permissions.resume', requestId: permission.id }))
      .rejects.toMatchObject({ code: 'resume_in_progress', retryable: true });
    expect(resumePermission).toHaveBeenCalledWith(
      { runId: permission.runId, permissionRequestId: permission.id },
      expect.any(Function)
    );

    await expect(facade.handle({ kind: 'planHandoffs.resume', handoffId: handoff.id }))
      .resolves.toMatchObject({ kind: 'run', run: { runId: handoff.runId } });
    await expect(facade.handle({ kind: 'planHandoffs.resume', handoffId: handoff.id }))
      .rejects.toMatchObject({ code: 'resume_in_progress', retryable: true });
    expect(resumePlanHandoff).toHaveBeenCalledWith(
      { runId: handoff.runId, planHandoffId: handoff.id },
      expect.any(Function)
    );
  });

  it('keeps host-level resume exceptions retryable instead of settling the proposal as failed', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-resume-exception-'));
    temporaryRoots.push(root);
    const recordResumedExecution = vi.fn(async (_runId: string, result: unknown) => result);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      orchestrator: {
        resumeAfterPermission: () => Promise.reject(new Error('temporary transport failure'))
      },
      makeChatFn: () => vi.fn(),
      unifiedAssistantHandoffService: { recordResumedExecution },
      runs: { get: () => null }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test');

    await (facade as unknown as {
      resumeAfterPermission(runId: string, requestId: string): Promise<void>;
    }).resumeAfterPermission('run-1', 'permission-1');

    expect(recordResumedExecution).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 502,
      body: expect.objectContaining({ retryable: true })
    }));
  });

  it('aborts the underlying Companion run when startup identity times out', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-chat-timeout-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    let capturedSignal: AbortSignal | undefined;
    Object.assign(app, {
      allModelConfigs: () => [],
      companionService: {
        chatStream: (
          _input: unknown,
          _emit: (event: unknown) => void,
          context: { signal?: AbortSignal }
        ) => new Promise<void>((_resolve, reject) => {
          capturedSignal = context.signal;
          context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true });
        })
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }],
      companionStartTimeoutMs: 10
    });

    await expect(facade.handle({
      kind: 'companion.chat.start',
      clientMessageId: 'message-timeout',
      message: '等待启动',
      workspaceId: 'primary',
      resources: []
    })).rejects.toMatchObject({ code: 'companion_start_timeout' });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts a started Companion run when workspace ownership cannot be persisted', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-chat-workspace-failure-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    let capturedSignal: AbortSignal | undefined;
    const deleteCompanionSession = vi.fn(async () => ({ deleted: true, sessionId: 'companion-session-1' }));
    Object.assign(app, {
      allModelConfigs: () => [],
      unifiedAssistantHandoffService: { deleteCompanionSession },
      companionService: {
        chatStream: (
          _input: unknown,
          emit: (event: unknown) => void,
          context: { signal?: AbortSignal }
        ) => {
          capturedSignal = context.signal;
          emit(storedRunStartEvent());
          return new Promise<void>((_resolve, reject) => {
            context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true });
          });
        }
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });
    const registry = (facade as unknown as {
      conversationWorkspaces: { assign(sessionId: string, workspaceId: string): void };
    }).conversationWorkspaces;
    vi.spyOn(registry, 'assign').mockImplementation(() => {
      throw new Error('workspace_state_write_failed');
    });

    await expect(facade.handle({
      kind: 'companion.chat.start',
      clientMessageId: 'message-workspace-failure',
      message: '启动后写入工作区映射',
      workspaceId: 'primary',
      resources: []
    })).rejects.toThrow('workspace_state_write_failed');
    expect(capturedSignal?.aborted).toBe(true);
    expect(deleteCompanionSession).toHaveBeenCalledWith({ sessionId: 'companion-session-1' });
  });

  it('does not delete an existing session when a missing workspace mapping cannot be persisted', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-existing-chat-workspace-failure-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    const deleteCompanionSession = vi.fn();
    Object.assign(app, {
      allModelConfigs: () => [],
      unifiedAssistantHandoffService: { deleteCompanionSession },
      companionService: {
        chatStream: (
          _input: unknown,
          emit: (event: unknown) => void,
          context: { signal?: AbortSignal }
        ) => {
          emit(storedRunStartEvent());
          return new Promise<void>((_resolve, reject) => {
            context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true });
          });
        }
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });
    const registry = (facade as unknown as {
      conversationWorkspaces: { assign(sessionId: string, workspaceId: string): void };
    }).conversationWorkspaces;
    vi.spyOn(registry, 'assign').mockImplementation(() => {
      throw new Error('workspace_state_write_failed');
    });

    await expect(facade.handle({
      kind: 'companion.chat.start',
      clientMessageId: 'message-existing-workspace-failure',
      message: 'Continue existing session',
      sessionId: 'companion-session-1',
      workspaceId: 'primary',
      resources: []
    })).rejects.toThrow('workspace_state_write_failed');
    expect(deleteCompanionSession).not.toHaveBeenCalled();
  });

  it('reports both workspace ownership and new Chat cleanup failures', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-chat-cleanup-failure-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      allModelConfigs: () => [],
      unifiedAssistantHandoffService: {
        deleteCompanionSession: () => Promise.reject(new Error('chat_cleanup_failed'))
      },
      companionService: {
        chatStream: (
          _input: unknown,
          emit: (event: unknown) => void,
          context: { signal?: AbortSignal }
        ) => {
          emit(storedRunStartEvent());
          return new Promise<void>((_resolve, reject) => {
            context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true });
          });
        }
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });
    const registry = (facade as unknown as {
      conversationWorkspaces: { assign(sessionId: string, workspaceId: string): void };
    }).conversationWorkspaces;
    vi.spyOn(registry, 'assign').mockImplementation(() => {
      throw new Error('workspace_state_write_failed');
    });

    const rejection = facade.handle({
      kind: 'companion.chat.start',
      clientMessageId: 'message-chat-cleanup-failure',
      message: 'Start then fail cleanup',
      workspaceId: 'primary',
      resources: []
    });
    await expect(rejection).rejects.toBeInstanceOf(AggregateError);
    await expect(rejection).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'workspace_state_write_failed' }),
        expect.objectContaining({ message: 'chat_cleanup_failed' })
      ]
    });
  });

  it('compensates a created session when workspace ownership cannot be persisted', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-session-workspace-failure-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    const deleteSession = vi.fn(async () => ({ deleted: true }));
    Object.assign(app, {
      companionService: {
        createSession: () => ({ session: { id: 'created-session-1' } }),
        deleteSession
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });
    const registry = (facade as unknown as {
      conversationWorkspaces: { assign(sessionId: string, workspaceId: string): void };
    }).conversationWorkspaces;
    vi.spyOn(registry, 'assign').mockImplementation(() => {
      throw new Error('workspace_state_write_failed');
    });

    await expect(facade.handle({
      kind: 'companion.sessions.create',
      workspaceId: 'primary'
    })).rejects.toThrow('workspace_state_write_failed');
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'created-session-1' });
  });

  it('keeps an authoritative session deletion successful when orphan workspace cleanup is deferred', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-session-delete-cleanup-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    const traceWrite = vi.fn();
    Object.assign(app, {
      trace: { write: traceWrite },
      unifiedAssistantHandoffService: {
        deleteCompanionSession: async () => ({ deleted: true, sessionId: 'session-delete' })
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });
    const registry = (facade as unknown as {
      conversationWorkspaces: { removeAfterAuthoritativeDelete(sessionId: string): void };
    }).conversationWorkspaces;
    vi.spyOn(registry, 'removeAfterAuthoritativeDelete').mockImplementation(() => {
      throw new Error('workspace_state_write_failed');
    });

    await expect(facade.handle({
      kind: 'companion.sessions.delete',
      sessionId: 'session-delete'
    })).resolves.toEqual({ kind: 'acknowledged' });
    expect(traceWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: 'conversation_workspace_cleanup_deferred',
      sessionId: 'session-delete'
    }));
  });

  it('reports both ownership and cleanup failures when session creation cannot be compensated', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-session-cleanup-failure-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      companionService: {
        createSession: () => ({ session: { id: 'created-session-2' } }),
        deleteSession: () => Promise.reject(new Error('session_cleanup_failed'))
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });
    const registry = (facade as unknown as {
      conversationWorkspaces: { assign(sessionId: string, workspaceId: string): void };
    }).conversationWorkspaces;
    vi.spyOn(registry, 'assign').mockImplementation(() => {
      throw new Error('workspace_state_write_failed');
    });

    const rejection = facade.handle({ kind: 'companion.sessions.create', workspaceId: 'primary' });
    await expect(rejection).rejects.toBeInstanceOf(AggregateError);
    await expect(rejection).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'workspace_state_write_failed' }),
        expect.objectContaining({ message: 'session_cleanup_failed' })
      ]
    });
  });
});

function storedRunStartEvent() {
  const now = new Date().toISOString();
  return {
    type: 'run_start',
    runId: 'companion-run-1',
    persistence: 'stored',
    session: { id: 'companion-session-1' },
    userMessage: {
      id: 'user-message-1',
      sessionId: 'companion-session-1',
      role: 'user',
      content: '启动后写入工作区映射',
      status: 'completed',
      createdAt: now
    },
    assistantMessage: {
      id: 'assistant-message-1',
      sessionId: 'companion-session-1',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: now
    }
  };
}

function sourceRun(
  id: string,
  status: 'waiting_confirmation' | 'waiting_plan_handoff',
  now: string
) {
  return {
    id,
    kind: 'agent' as const,
    status,
    goal: `Resume ${id}`,
    error: 'Previous resume failed',
    createdAt: now,
    updatedAt: now
  };
}

function approvedPermission(now: string) {
  return {
    schemaVersion: 1 as const,
    id: 'permission-approved',
    runId: 'run-permission',
    status: 'approved' as const,
    title: 'Run a command',
    summary: 'The next tool call needs approval',
    requiredPermissions: [{
      id: 'shell-1',
      type: 'shell' as const,
      target: 'npm test',
      reason: 'Verify the change'
    }],
    createdAt: now,
    respondedAt: now,
    decision: 'allow_once' as const,
    approvalVersion: 'approval-1',
    approvedItemIds: ['shell-1'],
    approvedPermissions: { shell: ['npm test'] }
  };
}

function approvedPlanHandoff(now: string) {
  return {
    schemaVersion: 1 as const,
    id: 'plan-approved',
    planId: 'plan-1',
    runId: 'run-plan',
    resumeMode: 'implement' as const,
    message: 'Execute the approved plan',
    planVariant: 'plan_wait_approval' as const,
    planMarkdown: '- Apply the change\n- Run tests',
    status: 'approved' as const,
    createdAt: now,
    respondedAt: now,
    decision: 'approve' as const
  };
}

function fakeApp(
  root: string,
  getProposal: () => Record<string, unknown>,
  respond: (input?: Record<string, unknown>) => Promise<Record<string, unknown>>
): AppContext {
  return {
    defaultWorkspaceKey: 'primary',
    paths: { traceFile: path.join(root, 'trace.jsonl') },
    traceCatalog: { tracesDir: root },
    permissionRequestStore: { listPending: () => [] },
    planHandoffStore: { listPending: () => [] },
    agentHandoffCoordinator: {
      get: (id: string) => id === 'proposal-1' ? getProposal() : null
    },
    unifiedAssistantHandoffService: {
      respond: (_proposalId: string, input: Record<string, unknown>) => respond(input)
    },
    runs: { get: () => null }
  } as unknown as AppContext;
}

function sourceProposal(status: 'pending' | 'executing' | 'completed'): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: 'proposal-1',
    sourceTurnId: 'turn-1',
    companionSessionId: 'session-1',
    ...(status === 'pending' ? {} : { agentSessionId: 'agent-session-1' }),
    reason: '需要读取项目',
    originalRequest: '检查项目',
    interpretedTask: '检查项目文件',
    requestedCapabilities: ['file-read'],
    requestedScope: ['E:\\Project\\Ariadne'],
    risk: 'read-only',
    workspaceKey: 'primary',
    status,
    createdAt: now,
    updatedAt: now,
    ...(status === 'pending' ? {} : { respondedAt: now, grantId: 'grant-1' }),
    ...(status === 'completed'
      ? { runId: 'run-1', outcome: { status: 'completed', answer: 'done' } }
      : {})
  };
}

function presentedCompanionResult(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    status: 'presented',
    projectionKey: 'proposal-1:completed',
    outcomeStatus: 'completed',
    source: 'fallback',
    reused: false,
    message: {
      id: 'message-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'Agent 已完成检查。',
      status: 'completed',
      trusted: true,
      memoryEligible: true,
      storageRoot: 'storage-root',
      createdAt: now,
      updatedAt: now
    },
    summaryStatus: { generated: false, reason: 'not_needed' },
    safety: {
      content: 'Agent 已完成检查。',
      rewritten: false,
      flags: [],
      attachmentRisk: 'low',
      realityAnchored: true,
      virtualIdentitySafe: true,
      warmEnough: true,
      outputMode: 'bounded'
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition timeout');
}
