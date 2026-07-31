import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeEventEnvelope } from '@ariadne/protocol/public';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeFacade } from '../src/application/RuntimeFacade.js';
import { ActivityRunStore } from '../src/agent/timeline/ActivityRunStore.js';
import { AgentTimelineService } from '../src/agent/timeline/AgentTimelineService.js';
import { sessionAgentStorageRoot } from '../src/agent/timeline/SessionAgentStorage.js';
import type { AppContext } from '../src/app/createAppContext.js';
import { createCompanionMessageEnvelope } from '../src/companion/CompanionMessagePersistence.js';
import type { CompanionStreamEvent } from '../src/companion/CompanionStreamContracts.js';
import { DatabaseManager } from '../src/context/DatabaseManager.js';
import { TraceLogger } from '../src/trace/TraceLogger.js';

const temporaryRoots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RuntimeFacade Agent lifecycle', () => {
  it('persists a new Companion run in session-owned storage instead of the selected workspace', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-workspace-activity-'));
    temporaryRoots.push(root);
    const secondaryRoot = path.join(root, 'secondary');
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      workspaceCatalog: {
        defaultKey: 'primary',
        defaultRoot: root,
        entries: [
          { id: 'primary', label: 'Primary', root, resolvedRoot: root },
          { id: 'secondary', label: 'Secondary', root: secondaryRoot, resolvedRoot: secondaryRoot }
        ],
        byId: new Map([
          ['primary', { id: 'primary', label: 'Primary', root, resolvedRoot: root }],
          ['secondary', {
            id: 'secondary',
            label: 'Secondary',
            root: secondaryRoot,
            resolvedRoot: secondaryRoot
          }]
        ])
      },
      allModelConfigs: () => [],
      companionService: {
        chatStream: async (
          _input: unknown,
          emit: (event: CompanionStreamEvent) => void
        ) => {
          emit(storedReasoningRunStartEvent(new Date().toISOString()));
        }
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      activityDataRoot: root,
      workspaces: [
        { workspaceId: 'primary', access: 'write' },
        { workspaceId: 'secondary', access: 'write' }
      ]
    });

    await expect(facade.handle({
      kind: 'companion.chat.start',
      clientMessageId: 'secondary-message',
      message: '在第二工作区运行',
      workspaceId: 'secondary',
      resources: []
    })).resolves.toMatchObject({
      kind: 'companion.chat.accepted',
      executionMode: 'companion',
      runId: 'companion-reasoning-run'
    });
    expect(new ActivityRunStore(
      sessionAgentStorageRoot(root, 'companion-reasoning-session')
    ).loadRun('companion-reasoning-run')).not.toBeNull();
    expect(new ActivityRunStore(secondaryRoot).loadRun('companion-reasoning-run')).toBeNull();
    expect(new ActivityRunStore(root).loadRun('companion-reasoning-run')).toBeNull();
  });

  it('projects reasoning deltas independently before final answer deltas', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-reasoning-'));
    temporaryRoots.push(root);
    const events: RuntimeEventEnvelope[] = [];
    const facade = new RuntimeFacade(
      fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused'))),
      (event) => events.push(event),
      'test'
    );
    const projector = (facade as unknown as {
      streamProjector: {
        handle(event: CompanionStreamEvent): unknown;
        bindAgentRun(proposalId: string, runId: string): void;
      };
    }).streamProjector;
    const startedAt = '2026-07-22T00:00:00.000Z';

    projector.handle(storedReasoningRunStartEvent(startedAt));
    projector.handle({
      type: 'reasoning',
      runId: 'companion-reasoning-run',
      delta: '检查约束',
      source: 'provider',
      startedAt
    });
    await waitFor(() => events.some((event) =>
      event.event.kind === 'companion.reasoning.delta'));
    projector.handle({
      type: 'reasoning_end',
      runId: 'companion-reasoning-run',
      reasoning: {
        content: '检查约束',
        status: 'completed',
        source: 'provider',
        startedAt,
        completedAt: '2026-07-22T00:00:02.000Z',
        durationMs: 2_000
      }
    });
    projector.handle({
      type: 'token',
      runId: 'companion-reasoning-run',
      delta: '最终回答',
      final: true,
      outputMode: 'unrestricted',
      streamMode: 'direct',
      provisional: false
    });
    await waitFor(() => events.some((event) =>
      event.event.kind === 'companion.token.delta'));

    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'companion.reasoning.delta',
        text: '检查约束'
      }),
      expect.objectContaining({
        kind: 'companion.message.changed',
        message: expect.objectContaining({
          reasoning: expect.objectContaining({
            status: 'completed',
            durationMs: 2_000
          })
        })
      }),
      expect.objectContaining({
        kind: 'companion.token.delta',
        text: '最终回答'
      })
    ]));
  });

  it('keeps the processing message visible while an automatic Agent handoff is running', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-handoff-processing-'));
    temporaryRoots.push(root);
    const events: RuntimeEventEnvelope[] = [];
    let proposal = sourceProposal('pending');
    const response = new Promise<Record<string, unknown>>(() => undefined);
    const facade = new RuntimeFacade(
      fakeApp(root, () => proposal, () => {
        proposal = sourceProposal('executing');
        return response;
      }),
      (event) => events.push(event),
      'test',
      {
        proposalApproval: 'automatic',
        workspaces: [{ workspaceId: 'primary', access: 'write' }]
      }
    );
    const projector = (facade as unknown as {
      streamProjector: {
        handle(event: CompanionStreamEvent): unknown;
        bindAgentRun(proposalId: string, runId: string): void;
      };
    }).streamProjector;
    const startedAt = '2026-07-22T00:00:00.000Z';

    projector.handle(storedReasoningRunStartEvent(startedAt));
    projector.handle({
      type: 'reasoning_end',
      runId: 'companion-reasoning-run',
      reasoning: {
        content: '检查实现边界',
        status: 'completed',
        source: 'provider',
        startedAt,
        completedAt: '2026-07-22T00:00:02.000Z',
        durationMs: 2_000
      }
    });
    projector.handle({
      type: 'agent_proposal',
      runId: 'companion-reasoning-run',
      proposal: sourceProposal('pending') as never
    });
    await waitFor(() => events.some((event) =>
      event.event.kind === 'companion.message.changed'
      && event.event.message.messageId === 'reasoning-assistant-message'
      && event.event.message.status === 'streaming'
      && event.event.message.reasoning?.status === 'completed'
    ));
    expect(events.some((event) =>
      event.event.kind === 'run.changed'
      && event.event.run.runId === 'companion-reasoning-run'
      && event.event.run.status === 'completed'
    )).toBe(false);

    projector.bindAgentRun('proposal-1', 'agent-run-live-1');
    await waitFor(() => events.some((event) =>
      event.event.kind === 'companion.message.changed'
      && event.event.message.messageId === 'reasoning-assistant-message'
      && event.event.message.runId === 'agent-run-live-1'
      && event.event.message.status === 'streaming'
    ));
    projector.handle({
      type: 'done',
      runId: 'companion-reasoning-run',
      result: { response: { type: 'agent_proposal' } }
    } as unknown as CompanionStreamEvent);

    expect(events.some((event) => event.event.kind === 'companion.message.removed')).toBe(false);
    expect(events.map((event) => event.event)).toContainEqual(expect.objectContaining({
      kind: 'companion.message.changed',
      message: expect.objectContaining({
        messageId: 'reasoning-assistant-message',
        runId: 'agent-run-live-1',
        status: 'streaming',
        reasoning: expect.objectContaining({ status: 'completed' })
      })
    }));
    expect(events.some((event) =>
      event.event.kind === 'run.changed'
      && event.event.run.runId === 'companion-reasoning-run'
      && event.event.run.status === 'completed'
    )).toBe(true);
  });

  it('publishes newly written Trace entries to the Runtime event stream', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-live-trace-'));
    temporaryRoots.push(root);
    const events: RuntimeEventEnvelope[] = [];
    const trace = new TraceLogger(path.join(root, 'trace.jsonl'));
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, { trace });
    const facade = new RuntimeFacade(app, (event) => events.push(event), 'test');

    try {
      await facade.start();
      trace.write({
        type: 'companion.proposal.protocol.error',
        level: 'error',
        category: 'companion.proposal.protocol',
        message: 'Agent 提案校验失败',
        metadata: { lifecycleStage: 'schema_validation', fieldPaths: ['risk'] }
      });

      await waitFor(() => events.some((event) =>
        event.event.kind === 'trace.appended'
        && event.event.entry.category === 'companion.proposal.protocol'));
      expect(events).toContainEqual(expect.objectContaining({
        event: {
          kind: 'trace.appended',
          entry: expect.objectContaining({
            level: 'error',
            category: 'companion.proposal.protocol',
            message: 'Agent 提案校验失败',
            metadata: expect.objectContaining({
              lifecycleStage: 'schema_validation',
              fieldPaths: ['risk']
            })
          })
        }
      }));
    } finally {
      await facade.stop();
      await trace.close();
    }
  });

  it('acknowledges approval before Agent execution finishes and later emits the Companion result', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-lifecycle-'));
    temporaryRoots.push(root);
    const events: RuntimeEventEnvelope[] = [];
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
    await waitFor(() => events.some((event) => event.event.kind === 'companion.message.changed'));
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
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

  it('publishes a newly created permission request when Agent execution pauses', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-live-permission-'));
    temporaryRoots.push(root);
    const events: RuntimeEventEnvelope[] = [];
    let proposal = sourceProposal('pending');
    let resolveResponse!: (value: Record<string, unknown>) => void;
    const response = new Promise<Record<string, unknown>>((resolve) => { resolveResponse = resolve; });
    const run = waitingRun('run-permission', 'waiting_confirmation');
    const permission = pendingPermission(run.id);
    const app = fakeApp(root, () => proposal, () => {
      proposal = sourceProposal('executing');
      return response;
    });
    Object.assign(app, {
      runs: { get: (runId: string) => runId === run.id ? run : null },
      permissionRequestStore: {
        listPending: (filter?: { runId?: string }) =>
          !filter?.runId || filter.runId === run.id ? [permission] : []
      }
    });
    const facade = new RuntimeFacade(app, (event) => events.push(event), 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });

    await facade.handle({
      kind: 'agent.proposals.respond',
      proposalId: 'proposal-1',
      decision: 'approve_once',
      allowedCapabilities: ['file-read'],
      workspaceId: 'primary'
    });
    proposal = {
      ...sourceProposal('executing'),
      status: 'waiting_permission',
      runId: run.id,
      outcome: {
        status: 'waiting_permission',
        permissionRequestId: permission.id
      }
    };
    resolveResponse({ proposal });

    await waitFor(() => events.some((event) => event.event.kind === 'permission.changed'));
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'permission.changed',
        request: expect.objectContaining({
          requestId: permission.id,
          runId: run.id,
          sessionId: 'session-1',
          status: 'pending'
        })
      })
    ]));
  });

  it('publishes a newly created plan handoff when Agent execution pauses', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-live-plan-'));
    temporaryRoots.push(root);
    const events: RuntimeEventEnvelope[] = [];
    let proposal = sourceProposal('pending');
    let resolveResponse!: (value: Record<string, unknown>) => void;
    const response = new Promise<Record<string, unknown>>((resolve) => { resolveResponse = resolve; });
    const run = waitingRun('run-plan', 'waiting_plan_handoff');
    const handoff = pendingPlanHandoff(run.id);
    const app = fakeApp(root, () => proposal, () => {
      proposal = sourceProposal('executing');
      return response;
    });
    Object.assign(app, {
      runs: { get: (runId: string) => runId === run.id ? run : null },
      planHandoffStore: {
        listPending: (filter?: { runId?: string }) =>
          !filter?.runId || filter.runId === run.id ? [handoff] : []
      }
    });
    const facade = new RuntimeFacade(app, (event) => events.push(event), 'test', {
      workspaces: [{ workspaceId: 'primary', access: 'write' }]
    });

    await facade.handle({
      kind: 'agent.proposals.respond',
      proposalId: 'proposal-1',
      decision: 'approve_once',
      allowedCapabilities: ['file-read'],
      workspaceId: 'primary'
    });
    proposal = {
      ...sourceProposal('executing'),
      status: 'waiting_plan_handoff',
      runId: run.id,
      outcome: {
        status: 'waiting_plan_handoff',
        planHandoffId: handoff.id
      }
    };
    resolveResponse({ proposal });

    await waitFor(() => events.some((event) => event.event.kind === 'planHandoff.changed'));
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'planHandoff.changed',
        handoff: expect.objectContaining({
          handoffId: handoff.id,
          runId: run.id,
          sessionId: 'session-1',
          status: 'pending'
        })
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
    const events: RuntimeEventEnvelope[] = [];
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
    expect(events.filter((event) => event.event.kind === 'agent.proposal.changed').map((event) => event.event)).toEqual([
      expect.objectContaining({
        kind: 'agent.proposal.changed',
        proposal: expect.objectContaining({ status: 'executing' })
      })
    ]);

    proposal = sourceProposal('completed');
    resolveResponse({ proposal, companionPresentation: presentedCompanionResult() });
    await vi.waitFor(async () => {
      const replay = await facade.handle({ kind: 'events.replay', afterCursor: 0, limit: 100 });
      expect(replay).toMatchObject({
        kind: 'events.replay',
        events: expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              kind: 'agent.proposal.changed',
              proposal: expect.objectContaining({ status: 'completed' })
            })
          })
        ])
      });
    });
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
      contextManager: { ...app.contextManager, getSession: () => ({ workspaceKey: 'primary' }) }
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
      contextManager: { ...app.contextManager, getSession: () => undefined }
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

  it('keeps approved recovery records out of the permission approval surface', async () => {
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
      requests: []
    });
    await expect(facade.handle({ kind: 'planHandoffs.list' })).resolves.toMatchObject({
      kind: 'planHandoffs',
      handoffs: []
    });
  });

  it('reconciles an approved interrupted permission resume into Agent recovery state at startup', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-startup-reconcile-'));
    temporaryRoots.push(root);
    const now = new Date().toISOString();
    const permission = approvedPermission(now);
    let run = {
      id: permission.runId,
      kind: 'agent' as const,
      status: 'waiting_confirmation' as const,
      aggregateVersion: 4,
      checkpointStage: 'waiting_confirmation' as const,
      recoveryStatus: 'none' as const,
      state: { round: 0, plan: null, childRunIds: [], inFlightEffects: [], verificationEvidence: [] },
      goal: 'Resume permission',
      createdAt: now,
      updatedAt: now
    };
    const execute = vi.fn((command: { type: string; expectedAggregateVersion: number }) => {
      expect(command).toMatchObject({
        type: 'run.require_recovery',
        expectedAggregateVersion: 4,
        recoverable: true
      });
      run = {
        ...run,
        status: 'recovery_required',
        aggregateVersion: 5,
        checkpointStage: 'recovery_required',
        recoveryStatus: 'recoverable'
      };
      return run;
    });
    const trace = new TraceLogger(path.join(root, 'trace.jsonl'));
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      trace,
      runs: { list: () => [run], get: () => run, execute },
      pausedRunStore: { get: () => ({ runId: run.id, pendingAction: { tool: 'write_file' } }) },
      permissionRequestStore: {
        listPending: () => [],
        getApprovedByRunId: () => permission
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test');

    try {
      await facade.start();
      expect(run).toMatchObject({
        status: 'recovery_required',
        recoveryStatus: 'recoverable'
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await facade.stop();
      await trace.close();
    }
  });

  it('routes Agent recovery through the approved permission continuation, not generic resume', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-recover-route-'));
    temporaryRoots.push(root);
    const now = new Date().toISOString();
    const permission = approvedPermission(now);
    const run = {
      id: permission.runId,
      kind: 'agent' as const,
      status: 'recovery_required' as const,
      aggregateVersion: 9,
      checkpointStage: 'recovery_required' as const,
      recoveryStatus: 'recoverable' as const,
      state: { round: 0, plan: null, childRunIds: [], inFlightEffects: [], verificationEvidence: [] },
      goal: 'Resume permission',
      createdAt: now,
      updatedAt: now
    };
    const resumeAfterPermission = vi.fn(() => new Promise(() => {}));
    const resumeAgent = vi.fn(() => new Promise(() => {}));
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      runs: { list: () => [run], get: () => run },
      pausedRunStore: { get: () => ({ runId: run.id, pendingAction: { tool: 'write_file' } }) },
      permissionRequestStore: {
        listPending: () => [],
        getApprovedByRunId: () => permission
      },
      orchestrator: {
        getActivityRun: () => ({ status: 404, body: { error: 'activity_run_not_found' } }),
        resumeAfterPermission,
        resumeAgent
      },
      makeChatFn: () => vi.fn()
    });
    const facade = new RuntimeFacade(app, () => {}, 'test');

    await expect(facade.handle({
      kind: 'runs.recover',
      runId: run.id,
      expectedAggregateVersion: run.aggregateVersion,
      decision: 'resume'
    })).resolves.toMatchObject({ kind: 'run', run: { runId: run.id } });
    await waitFor(() => resumeAfterPermission.mock.calls.length === 1);
    expect(resumeAfterPermission).toHaveBeenCalledWith(
      { runId: run.id, permissionRequestId: permission.id },
      expect.any(Function)
    );
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it('routes only a budget-paused Run through the budget resume command and rejects duplicates', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-budget-resume-'));
    temporaryRoots.push(root);
    const now = new Date().toISOString();
    const run = {
      id: 'run-budget',
      kind: 'agent' as const,
      status: 'paused' as const,
      aggregateVersion: 6,
      checkpointStage: 'waiting_budget' as const,
      recoveryStatus: 'none' as const,
      waitReason: {
        code: 'budget_exhausted',
        message: 'Yielded at the execution budget'
      },
      state: {
        round: 0,
        plan: null,
        childRunIds: [],
        inFlightEffects: [],
        verificationEvidence: []
      },
      goal: 'Continue from the saved budget checkpoint',
      createdAt: now,
      updatedAt: now
    };
    const resumeAgent = vi.fn(() => new Promise(() => {}));
    const makeChatFn = vi.fn(() => vi.fn());
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      runs: { list: () => [run], get: () => run },
      runStateStore: { get: () => ({ status: 'resumable' }) },
      orchestrator: {
        getActivityRun: () => ({ status: 404, body: { error: 'activity_run_not_found' } }),
        resumeAgent
      },
      makeChatFn
    });
    const facade = new RuntimeFacade(app, () => {}, 'test');
    const budget = {
      maxModelTurns: 12,
      maxToolCalls: 20,
      maxReadCalls: 12,
      maxWriteCalls: 4,
      maxShellCalls: 4,
      maxRuntimeMs: 180_000,
      maxPreflightTools: 3,
      maxRecoveryTurns: 3,
      maxRepeatedToolFailures: 1
    };

    await expect(facade.handle({
      kind: 'runs.resume',
      runId: run.id,
      expectedAggregateVersion: run.aggregateVersion,
      budget
    })).resolves.toMatchObject({ kind: 'run', run: { status: 'waiting_budget' } });
    await waitFor(() => resumeAgent.mock.calls.length === 1);
    expect(resumeAgent).toHaveBeenCalledWith(
      { runId: run.id, budget },
      expect.any(Function)
    );
    expect(makeChatFn).toHaveBeenCalledTimes(1);

    await expect(facade.handle({
      kind: 'runs.resume',
      runId: run.id,
      expectedAggregateVersion: run.aggregateVersion,
      budget
    })).rejects.toMatchObject({ code: 'resume_in_progress', retryable: true });

    await expect(facade.handle({
      kind: 'runs.recover',
      runId: run.id,
      expectedAggregateVersion: run.aggregateVersion,
      decision: 'resume'
    })).rejects.toMatchObject({ code: 'run_not_recoverable' });
  });

  it('normalizes a host-level resume failure to recovery instead of leaving a stale waiting state', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-resume-normalize-'));
    temporaryRoots.push(root);
    const now = new Date().toISOString();
    let run = {
      id: 'run-normalize',
      kind: 'agent' as const,
      status: 'running' as const,
      aggregateVersion: 7,
      checkpointStage: 'running' as const,
      recoveryStatus: 'none' as const,
      state: { round: 0, plan: null, childRunIds: [], inFlightEffects: [], verificationEvidence: [] },
      goal: 'Normalize failure',
      createdAt: now,
      updatedAt: now
    };
    const execute = vi.fn((command: { type: string }) => {
      expect(command).toMatchObject({
        type: 'run.require_recovery',
        recoverable: true
      });
      run = {
        ...run,
        status: 'recovery_required',
        aggregateVersion: 8,
        checkpointStage: 'recovery_required',
        recoveryStatus: 'recoverable'
      };
      return run;
    });
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      runs: { list: () => [run], get: () => run, execute },
      permissionRequestStore: {
        listPending: () => [],
        getPendingByRunId: () => null,
        getApprovedByRunId: () => null
      },
      planHandoffStore: {
        listPending: () => [],
        getPendingByRunId: () => null,
        getApprovedByRunId: () => null
      },
      orchestrator: {
        getActivityRun: () => ({ status: 404, body: { error: 'activity_run_not_found' } }),
        resumeAfterPermission: async () => ({
          status: 502,
          body: { code: 'provider_unavailable', error: 'provider unavailable' }
        })
      },
      makeChatFn: () => vi.fn(),
      unifiedAssistantHandoffService: {
        recordResumedExecution: async (_runId: string, result: unknown) => result
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test');

    await (facade as unknown as {
      resumeAfterPermission(runId: string, requestId: string): Promise<void>;
    }).resumeAfterPermission(run.id, 'permission-normalize');

    expect(run).toMatchObject({
      status: 'recovery_required',
      recoveryStatus: 'recoverable'
    });
    expect(execute).toHaveBeenCalledTimes(1);
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
    const makeChatFn = vi.fn(() => vi.fn());
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    Object.assign(app, {
      runs: {
        list: () => runs,
        get: (runId: string) => runs.find((run) => run.id === runId) ?? null
      },
      pausedRunStore: { get: (runId: string) => ({ runId }) },
      permissionRequestStore: { get: (id: string) => id === permission.id ? permission : null },
      planHandoffStore: {
        get: (id: string) => id === handoff.id ? handoff : null,
        getApprovedByRunId: (runId: string) => runId === handoff.runId ? handoff : null,
        updatePlan: (_id: string, plan: unknown) => ({ ...handoff, plan })
      },
      agentPlanStore: {
        markExecution: (
          _planId: string,
          _version: number,
          executionState: 'not_started' | 'in_progress' | 'blocked' | 'completed' | 'failed'
        ) => ({ ...handoff.plan, executionState })
      },
      orchestrator: {
        getActivityRun: () => ({ status: 404, body: { error: 'activity_run_not_found' } }),
        resumeAfterPermission: resumePermission,
        resumeAfterPlanHandoff: resumePlanHandoff
      },
      agentHandoffCoordinator: {
        getByRunId: () => ({
          modelBinding: {
            selectionMode: 'manual',
            clientName: 'cloud-deepseek',
            modelName: 'deepseek-v4-flash',
            protocolVersion: 'ariadne.agent-proposal.v1'
          }
        })
      },
      makeChatFn
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
    expect(makeChatFn).toHaveBeenCalledTimes(2);
    expect(makeChatFn).toHaveBeenNthCalledWith(1, 'cloud-deepseek');
    expect(makeChatFn).toHaveBeenNthCalledWith(2, 'cloud-deepseek');
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
    const sessionStorageRoot = sessionAgentStorageRoot(root, 'session-delete');
    const timeline = new AgentTimelineService({ projectRoot: root, storageRoot: sessionStorageRoot });
    timeline.createRun({
      id: 'deleted-session-run',
      goal: 'delete me',
      sessionId: 'session-delete'
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      activityDataRoot: root,
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
    expect(new ActivityRunStore(sessionStorageRoot).loadRun('deleted-session-run')).toBeNull();
    expect(traceWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: 'conversation_workspace_cleanup_deferred',
      sessionId: 'session-delete'
    }));
  });

  it('purges only sessions and orphan Agent contexts owned by the archived workspace', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-facade-workspace-purge-'));
    temporaryRoots.push(root);
    const app = fakeApp(root, () => sourceProposal('pending'), () => Promise.reject(new Error('unused')));
    const deletedCompanionSessions: string[] = [];
    const deletedAgentSessions: string[] = [];
    Object.assign(app, {
      companionService: {
        listSessions: () => ({
          sessions: [
            { id: 'primary-session' },
            { id: 'archived-session' }
          ]
        })
      },
      unifiedAssistantHandoffService: {
        deleteCompanionSession: async ({ sessionId }: { sessionId: string }) => {
          deletedCompanionSessions.push(sessionId);
          return { deleted: true, sessionId };
        }
      },
      contextManager: {
        ...app.contextManager,
        listSessions: () => [
          { id: 'orphan-agent-session', workspaceKey: 'secondary' }
        ],
        deleteSession: (sessionId: string) => {
          deletedAgentSessions.push(sessionId);
          return true;
        }
      }
    });
    const facade = new RuntimeFacade(app, () => {}, 'test', {
      activityDataRoot: root,
      workspaces: [
        { workspaceId: 'primary', access: 'write' },
        { workspaceId: 'secondary', access: 'write' }
      ]
    });
    const registry = (facade as unknown as {
      conversationWorkspaces: { assign(sessionId: string, workspaceId: string): void };
    }).conversationWorkspaces;
    registry.assign('primary-session', 'primary');
    registry.assign('archived-session', 'secondary');

    await expect(facade.handle({
      kind: 'companion.workspaces.purge',
      workspaceId: 'secondary'
    })).resolves.toEqual({
      kind: 'companion.workspace.purged',
      workspaceId: 'secondary',
      deletedSessions: 1,
      deletedAgentContexts: 1
    });
    expect(deletedCompanionSessions).toEqual(['archived-session']);
    expect(deletedAgentSessions).toEqual(['archived-session', 'orphan-agent-session']);
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

function storedReasoningRunStartEvent(
  now: string
): Extract<CompanionStreamEvent, { type: 'run_start'; persistence: 'stored' }> {
  const storageRoot = 'C:\\runtime\\companion';
  return {
    type: 'run_start',
    runId: 'companion-reasoning-run',
    persistence: 'stored',
    outputMode: 'unrestricted',
    session: {
      id: 'companion-reasoning-session',
      personaId: 'default',
      title: 'Reasoning',
      storageRoot,
      incognito: false,
      createdAt: now,
      updatedAt: now
    },
    userMessage: {
      id: 'reasoning-user-message',
      sessionId: 'companion-reasoning-session',
      role: 'user',
      content: '请分析',
      status: 'completed',
      contentEnvelope: createCompanionMessageEnvelope(
        'user',
        'completed',
        'reasoning-user-message'
      ),
      memoryEligible: true,
      storageRoot,
      createdAt: now,
      updatedAt: now
    },
    assistantMessage: {
      id: 'reasoning-assistant-message',
      sessionId: 'companion-reasoning-session',
      role: 'assistant',
      content: '',
      status: 'streaming',
      contentEnvelope: createCompanionMessageEnvelope(
        'assistant',
        'streaming',
        'reasoning-assistant-message'
      ),
      memoryEligible: false,
      storageRoot,
      createdAt: now,
      updatedAt: now
    },
    storage: {
      storageRoot,
      dbPath: `${storageRoot}\\companion.db`,
      schemaVersion: 9,
      writable: true
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

function waitingRun(
  id: string,
  status: 'waiting_confirmation' | 'waiting_plan_handoff'
) {
  const now = new Date().toISOString();
  return {
    id,
    kind: 'agent' as const,
    status,
    aggregateVersion: 2,
    sessionId: 'agent-session-1',
    goal: `Waiting ${id}`,
    checkpointStage: status,
    recoveryStatus: 'none' as const,
    createdAt: now,
    updatedAt: now
  };
}

function pendingPermission(runId: string) {
  return {
    schemaVersion: 1 as const,
    id: 'permission-pending',
    runId,
    sessionId: 'agent-session-1',
    status: 'pending' as const,
    title: '写入项目文件',
    summary: '需要写入文件才能继续。',
    requiredPermissions: [{
      id: 'write-1',
      type: 'write_file' as const,
      target: 'workspace-file.txt',
      reason: '实现用户要求',
      riskTier: 'medium' as const
    }],
    approvalVersion: 'approval-pending',
    createdAt: new Date().toISOString()
  };
}

function pendingPlanHandoff(runId: string) {
  const createdAt = new Date().toISOString();
  const plan = structuredPlan(runId, createdAt, 'ready_for_confirmation', 'plan-pending');
  return {
    schemaVersion: 1 as const,
    id: 'plan-pending',
    planId: 'plan-pending',
    runId,
    sessionId: 'agent-session-1',
    resumeMode: 'implement' as const,
    message: '确认后执行计划。',
    planVariant: 'plan_wait_approval' as const,
    planMarkdown: '- 修改文件\n- 运行测试',
    plan,
    planVersion: plan.version,
    status: 'pending' as const,
    createdAt
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
  const plan = structuredPlan('run-plan', now, 'approved', 'plan-1');
  return {
    schemaVersion: 1 as const,
    id: 'plan-approved',
    planId: 'plan-1',
    runId: 'run-plan',
    resumeMode: 'implement' as const,
    message: 'Execute the approved plan',
    planVariant: 'plan_wait_approval' as const,
    planMarkdown: '- Apply the change\n- Run tests',
    plan,
    planVersion: plan.version,
    status: 'approved' as const,
    createdAt: now,
    respondedAt: now,
    decision: 'approve' as const
  };
}

function structuredPlan(
  runId: string,
  createdAt: string,
  planState: 'ready_for_confirmation' | 'approved',
  planId: string
) {
  return {
    schemaVersion: 1 as const,
    planId,
    version: 1,
    sourceRunId: runId,
    title: '可验证执行计划',
    goal: '按批准范围完成修改并验证结果。',
    facts: [{
      id: 'fact-1',
      statement: '目标工作区已经定位。',
      evidence: '运行创建时绑定了工作区。',
    }],
    constraints: [],
    clarifications: [],
    steps: [{
      id: 'step-1',
      title: '完成范围内修改',
      dependsOn: [],
      action: '修改目标模块。',
      scope: ['target'],
      expectedOutcome: '目标行为可用。',
      verification: '运行确定性验证并记录结果。',
      status: 'pending' as const,
      actualScope: [],
      evidence: [],
      deviations: [],
    }],
    completionCriteria: [{
      id: 'done-1',
      behavior: '目标行为可以被用户观察。',
      verification: '重复执行验证场景。',
    }],
    planState,
    executionState: 'not_started' as const,
    completeness: 'complete' as const,
    blockingReasons: [],
    qualityIssues: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function fakeApp(
  root: string,
  getProposal: () => Record<string, unknown>,
  respond: (input?: Record<string, unknown>) => Promise<Record<string, unknown>>
): AppContext {
  const database = new DatabaseManager(root);
  databases.push(database);
  return {
    defaultWorkspaceKey: 'primary',
    workspaceRoot: root,
    workspaceCatalog: {
      defaultKey: 'primary',
      defaultRoot: root,
      entries: [{ id: 'primary', label: 'Primary', root, resolvedRoot: root }],
      byId: new Map([['primary', { id: 'primary', label: 'Primary', root, resolvedRoot: root }]])
    },
    paths: { traceFile: path.join(root, 'trace.jsonl') },
    traceCatalog: { tracesDir: root },
    permissionRequestStore: { listPending: () => [], getApprovedByRunId: () => null },
    planHandoffStore: { listPending: () => [], getApprovedByRunId: () => null },
    pausedRunStore: { get: () => null },
    agentHandoffCoordinator: {
      get: (id: string) => id === 'proposal-1' ? getProposal() : null,
      getLinkedAgentSession: () => null,
      getByRunId: (runId: string) => {
        const proposal = getProposal();
        return proposal.runId === runId ? proposal : null;
      }
    },
    unifiedAssistantHandoffService: {
      respond: (_proposalId: string, input: Record<string, unknown>) => respond(input)
    },
    contextManager: {
      db: database,
      getSession: () => ({ workspaceKey: 'primary' }),
      deleteSession: () => false,
      memoryManager: {}
    },
    runs: { get: () => null, list: () => [] },
    registry: { listProviders: () => [] },
    orchestrator: {
      getActivityRun: () => ({ status: 404, body: { error: 'activity_run_not_found' } })
    },
    hooks: {
      dispatch: async (input: {
        authority: { permissions: Array<'read' | 'write' | 'shell' | 'network' | 'dangerous'>; timeoutMs: number };
      }) => ({
        allowed: true,
        authority: input.authority,
        deliveryIds: []
      })
    }
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
      contentEnvelope: createCompanionMessageEnvelope('assistant', 'completed', 'message-1'),
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
