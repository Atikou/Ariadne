import { randomUUID } from 'node:crypto';
import type {
  ModelSummary,
  ModelInferenceOptions,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeResult,
  RuntimeStatus
} from '@ariadne/protocol/public';

import type { AppContext } from '../app/createAppContext.js';
import type { UnifiedAgentProposalResponse } from '../app/UnifiedAssistantHandoffContracts.js';
import type { AgentCapability, AgentProposal as SourceAgentProposal } from '../assistant/AgentHandoffContracts.js';
import type { CompanionStreamEvent } from '../companion/CompanionStreamContracts.js';
import { CompanionAgentResultDeliverySchema } from '../companion/CompanionAgentResultContracts.js';
import type { ModelClientConfig, ModelInferenceProfile } from '../config/types.js';
import type { ApiResult } from '../core/apiResult.js';
import { PermissionRequestDecisionService } from '../orchestrator/PermissionRequestDecisionService.js';
import { PlanHandoffDecisionService } from '../orchestrator/PlanHandoffDecisionService.js';
import { TaskCheckpointService } from '../orchestrator/TaskCheckpointService.js';
import type { PermissionRequestPayload } from '../policy/permissionRequestTypes.js';
import { scanTraceEvents } from '../trace/traceQuery.js';
import { toPublicError } from '../util/publicError.js';
import { ConversationWorkspaceRegistry } from './ConversationWorkspaceRegistry.js';
import { DomainEventJournal } from '../events/DomainEventJournal.js';
import { RuntimeEventDispatcher } from '../events/RuntimeEventDispatcher.js';
import {
  projectAgentProposal,
  projectMemory,
  projectMessage,
  projectPermissionRequest,
  projectPlanHandoff,
  projectRun,
  projectSession,
  projectTraceEvent
} from './publicProjection.js';

export type RuntimeEventSink = (event: RuntimeEventEnvelope) => void;
type RawRuntimeEventSink = (event: RuntimeEvent) => void;

export interface RuntimeFacadeOptions {
  conversationWorkspaceStateFile?: string;
  companionStartTimeoutMs?: number;
  workspaces?: readonly {
    workspaceId: string;
    label?: string;
    access: 'read' | 'write';
  }[];
  proposalApproval?: 'manual' | 'automatic';
  allowedPermissions?: readonly ('read' | 'write' | 'shell' | 'network' | 'dangerous')[];
}

export class RuntimeFacadeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'RuntimeFacadeError';
  }
}

export class RuntimeFacade {
  private readonly streamProjector: CompanionStreamProjector;
  private readonly eventJournal: DomainEventJournal;
  private readonly eventDispatcher: RuntimeEventDispatcher;
  private readonly workspaceAccess: ReadonlyMap<string, 'read' | 'write'>;
  private readonly workspaceLabels: ReadonlyMap<string, string>;
  private readonly conversationWorkspaces: ConversationWorkspaceRegistry;
  private readonly proposalApproval: 'manual' | 'automatic';
  private readonly allowedPermissions: ReadonlySet<'read' | 'write' | 'shell' | 'network' | 'dangerous'>;
  private readonly companionStartTimeoutMs: number;
  private readonly activeResumes = new Set<string>();
  private readonly taskCheckpoints: TaskCheckpointService;
  private removeTraceListener?: () => void;

  constructor(
    private readonly app: AppContext,
    emit: RuntimeEventSink,
    private readonly runtimeVersion: string,
    options: RuntimeFacadeOptions = {}
  ) {
    const workspaces = options.workspaces ?? [{
      workspaceId: app.defaultWorkspaceKey,
      label: app.defaultWorkspaceKey,
      access: 'write' as const
    }];
    this.workspaceAccess = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.access]));
    this.workspaceLabels = new Map(workspaces.map((workspace) => [
      workspace.workspaceId,
      workspace.label?.trim() || workspace.workspaceId
    ]));
    this.eventJournal = new DomainEventJournal(app.contextManager.db);
    this.eventDispatcher = new RuntimeEventDispatcher(this.eventJournal, emit);
    this.conversationWorkspaces = new ConversationWorkspaceRegistry(
      options.conversationWorkspaceStateFile,
      this.workspaceAccess.keys(),
      app.defaultWorkspaceKey
    );
    this.proposalApproval = options.proposalApproval ?? 'manual';
    this.allowedPermissions = new Set(options.allowedPermissions ?? ['read', 'write', 'shell', 'network', 'dangerous']);
    this.companionStartTimeoutMs = options.companionStartTimeoutMs ?? 15_000;
    this.taskCheckpoints = new TaskCheckpointService(app.registry, app.workspaceRoot);
    this.streamProjector = new CompanionStreamProjector(
      (event) => this.emit(event),
      (proposal) => this.handleAgentProposal(proposal)
    );
  }

  async start(): Promise<void> {
    this.eventDispatcher.start();
    this.removeTraceListener = this.app.trace.subscribe((event) => {
      this.emit({
        kind: 'trace.appended',
        entry: projectTraceEvent(event, event.eventId)
      });
    });
    this.emit({ kind: 'runtime.status.changed', status: this.status() });
    await this.eventDispatcher.flush();
  }

  async stop(): Promise<void> {
    this.removeTraceListener?.();
    this.removeTraceListener = undefined;
    this.streamProjector.stop();
    await this.eventDispatcher.stop();
  }

  private emit(event: RuntimeEvent): void {
    const metadata = eventMetadata(event);
    if (metadata.aggregateType === 'run' && event.kind === 'run.changed' && event.run.origin === 'agent') {
      void this.eventDispatcher.flush();
      return;
    }
    this.eventJournal.append({
      aggregateType: metadata.aggregateType === 'run' ? 'companion' : metadata.aggregateType,
      aggregateId: metadata.aggregateId,
      correlationId: metadata.correlationId,
      event
    });
    void this.eventDispatcher.flush();
  }

  async handle(command: RuntimeCommand): Promise<RuntimeResult> {
    switch (command.kind) {
      case 'runtime.status.get':
        return { kind: 'runtime.status', status: this.status() };
      case 'runtime.snapshot.get':
        return { kind: 'runtime.snapshot', snapshot: this.snapshot() };
      case 'events.replay': {
        const events = this.eventDispatcher.replay(command.afterCursor, command.limit);
        return {
          kind: 'events.replay',
          events,
          nextCursor: events.at(-1)?.cursor ?? command.afterCursor
        };
      }
      case 'models.list':
        return { kind: 'models.catalog', models: this.models() };
      case 'models.check':
        await this.checkModels(command.modelId);
        return { kind: 'models.catalog', models: this.models() };
      case 'companion.sessions.list':
        return {
          kind: 'companion.sessions',
          sessions: this.app.companionService.listSessions().sessions.map((session) =>
            projectSession(session, this.conversationWorkspaces.workspaceFor(session.id)))
        };
      case 'companion.sessions.create': {
        const hookEventId = `session-create:${randomUUID()}`;
        await this.dispatchSessionPre(hookEventId, 'create');
        const workspaceId = this.resolveWorkspaceId(command.workspaceId);
        const created = this.app.companionService.createSession(
          command.title ? { title: command.title } : undefined
        );
        try {
          this.conversationWorkspaces.assign(created.session.id, workspaceId);
        } catch (error) {
          try {
            const deleted = await this.app.companionService.deleteSession({ sessionId: created.session.id });
            if (!deleted) throw new Error('created_session_cleanup_missing');
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              '会话已创建，但工作区归属写入和补偿删除均失败'
            );
          }
          throw error;
        }
        await this.dispatchSessionPost(hookEventId, 'create', created.session.id);
        return { kind: 'companion.session', session: projectSession(created.session, workspaceId) };
      }
      case 'companion.sessions.rename': {
        const hookEventId = `session-rename:${command.sessionId}:${randomUUID()}`;
        await this.dispatchSessionPre(hookEventId, 'rename', command.sessionId);
        const updated = this.app.companionService.updateSession(command.sessionId, {
          title: command.title
        });
        if (!updated) throw new RuntimeFacadeError('session_not_found', '会话不存在');
        await this.dispatchSessionPost(hookEventId, 'rename', command.sessionId);
        return {
          kind: 'companion.session',
          session: projectSession(
            updated.session,
            this.conversationWorkspaces.workspaceFor(updated.session.id)
          )
        };
      }
      case 'companion.sessions.delete': {
        const hookEventId = `session-delete:${command.sessionId}:${randomUUID()}`;
        await this.dispatchSessionPre(hookEventId, 'delete', command.sessionId);
        const deleted = await this.app.unifiedAssistantHandoffService.deleteCompanionSession({
          sessionId: command.sessionId
        });
        if (!deleted) throw new RuntimeFacadeError('session_not_found', '会话不存在');
        try {
          this.conversationWorkspaces.removeAfterAuthoritativeDelete(command.sessionId);
        } catch (error) {
          const cleanupError = toPublicError(error, 'Conversation was deleted; workspace metadata cleanup was deferred.');
          this.app.trace.write({
            type: 'conversation_workspace_cleanup_deferred',
            sessionId: command.sessionId,
            errorCode: cleanupError.code
          });
        }
        await this.dispatchSessionPost(hookEventId, 'delete', command.sessionId);
        return { kind: 'acknowledged' };
      }
      case 'companion.messages.list': {
        const result = this.app.companionService.listMessages({
          sessionId: command.sessionId,
          limit: command.limit
        });
        if (!result) throw new RuntimeFacadeError('session_not_found', '会话不存在');
        return {
          kind: 'companion.messages',
          messages: result.messages
            .filter((message) => message.status !== 'deleted')
            .map(projectMessage)
        };
      }
      case 'companion.chat.start':
        return this.startCompanionChat(command);
      case 'companion.chat.cancel': {
        const result = this.app.companionService.cancelRun(command.runId);
        if (!result.cancelled) {
          throw new RuntimeFacadeError('run_not_found', '对话运行不存在');
        }
        return { kind: 'acknowledged' };
      }
      case 'agent.proposals.list':
        return {
          kind: 'agent.proposals',
          proposals: this.app.agentHandoffCoordinator.listPending().map(projectAgentProposal)
        };
      case 'agent.proposals.respond': {
        const existing = this.app.agentHandoffCoordinator.get(command.proposalId);
        if (!existing || existing.status !== 'pending') {
          throw new RuntimeFacadeError('proposal_not_found', 'Agent 提案不存在或已处理');
        }
        const allowedCapabilities = command.decision === 'approve_once'
          ? command.allowedCapabilities ?? existing.requestedCapabilities
          : undefined;
        this.assertProposalWithinWorkspaceAccess(existing, allowedCapabilities, command.workspaceAccess);
        const input = {
          decision: command.decision,
          ...(allowedCapabilities ? { allowedCapabilities } : {}),
          ...(command.workspaceId ? { workspaceKey: command.workspaceId } : {})
        };
        const responsePromise = this.app.unifiedAssistantHandoffService.respond(command.proposalId, input);
        if (command.decision === 'reject') {
          const response = await responsePromise;
          if (!response) throw new RuntimeFacadeError('proposal_not_found', 'Agent 提案不存在或已处理');
          await this.publishProposalResponse(response);
          return { kind: 'agent.proposal', proposal: projectAgentProposal(response.proposal) };
        }
        const executing = this.app.agentHandoffCoordinator.get(command.proposalId);
        if (!executing) throw new RuntimeFacadeError('proposal_not_found', 'Agent 提案不存在或已处理');
        if (executing.status !== 'executing') {
          const response = await responsePromise;
          if (!response) throw new RuntimeFacadeError('proposal_not_found', 'Agent 提案不存在或已处理');
          if (response.proposal.status === 'pending') {
            throw new RuntimeFacadeError('proposal_start_failed', 'Agent 提案未能进入执行状态');
          }
          await this.publishProposalResponse(response);
          return { kind: 'agent.proposal', proposal: projectAgentProposal(response.proposal) };
        }
        void responsePromise.then(async (response) => {
          if (response) await this.publishProposalResponse(response);
        }).catch(() => {
          // Execution already started; durable Agent state and trace remain authoritative if presentation fails.
        });
        const proposal = projectAgentProposal(executing);
        this.emit({ kind: 'agent.proposal.changed', proposal });
        return { kind: 'agent.proposal', proposal };
      }
      case 'runs.list':
        return {
          kind: 'runs',
          runs: this.app.runs
            .list({ limit: 200 })
            .filter((run) => !command.sessionId || run.sessionId === command.sessionId)
            .map(projectRun)
            .filter((run) => !command.status || run.status === command.status)
        };
      case 'runs.get': {
        const run = this.app.runs.get(command.runId);
        if (!run) throw new RuntimeFacadeError('run_not_found', '运行记录不存在');
        return { kind: 'run', run: projectRun(run) };
      }
      case 'runs.cancel': {
        const result = this.app.orchestrator.cancelRun(command.runId);
        if (result.status === 404) {
          const pausedRun = this.app.runs.get(command.runId);
          if (pausedRun?.status === 'waiting_confirmation') {
            const request = this.app.permissionRequestStore.listPending()
              .find((candidate) => candidate.runId === command.runId);
            if (!request) {
              throw new RuntimeFacadeError('run_state_inconsistent', '等待权限的运行缺少待处理权限申请');
            }
            await this.respondPermission({
              kind: 'permissions.respond',
              requestId: request.id,
              approvalVersion: request.approvalVersion,
              decision: 'deny',
              approvedItemIds: []
            });
            return { kind: 'acknowledged' };
          }
          if (pausedRun?.status === 'waiting_plan_handoff') {
            const handoff = this.app.planHandoffStore.listPending()
              .find((candidate) => candidate.runId === command.runId);
            if (!handoff) {
              throw new RuntimeFacadeError('run_state_inconsistent', '等待计划的运行缺少待处理计划');
            }
            await this.respondPlanHandoff({
              kind: 'planHandoffs.respond',
              handoffId: handoff.id,
              decision: 'reject'
            });
            return { kind: 'acknowledged' };
          }
          throw new RuntimeFacadeError('run_not_found', '运行记录不存在或已结束');
        }
        const run = this.app.runs.get(command.runId);
        if (run) this.emit({ kind: 'run.changed', run: projectRun(run) });
        return { kind: 'acknowledged' };
      }
      case 'runs.recover': {
        const run = this.app.runs.get(command.runId);
        if (!run) throw new RuntimeFacadeError('run_not_found', 'Run does not exist.');
        if (run.aggregateVersion !== command.expectedAggregateVersion) {
          throw new RuntimeFacadeError(
            'run_version_conflict',
            `Run version is ${run.aggregateVersion}; expected ${command.expectedAggregateVersion}.`,
            true
          );
        }
        if (run.status !== 'recovery_required') {
          throw new RuntimeFacadeError('run_not_recoverable', 'Run is not waiting for recovery.');
        }
        if (command.decision === 'cancel') {
          this.app.runs.execute({
            type: 'run.cancel',
            runId: run.id,
            expectedAggregateVersion: run.aggregateVersion,
            reason: 'User cancelled recovery.'
          });
        } else if (command.decision === 'mark_failed') {
          this.app.runs.execute({
            type: 'run.fail',
            runId: run.id,
            expectedAggregateVersion: run.aggregateVersion,
            error: 'User confirmed that the interrupted effect cannot be recovered.'
          });
        } else {
          const result = await this.app.orchestrator.resumeAgent(
            { runId: run.id },
            this.makeChatForRun(run.id)
          );
          if (result.status < 200 || result.status >= 300) {
            const body = recordValue(result.body);
            throw new RuntimeFacadeError(
              'run_recovery_failed',
              typeof body.error === 'string' ? body.error : 'Run recovery failed.',
              true
            );
          }
        }
        await this.eventDispatcher.flush();
        return { kind: 'run', run: projectRun(this.app.runs.get(run.id) ?? run) };
      }
      case 'permissions.list':
        return {
          kind: 'permissions',
          requests: this.listVisiblePermissionRequests().map((request) => this.projectPermission(request))
        };
      case 'permissions.respond':
        return this.respondPermission(command);
      case 'permissions.resume':
        return this.retryPermission(command.requestId);
      case 'planHandoffs.list':
        return {
          kind: 'planHandoffs',
          handoffs: this.listVisiblePlanHandoffs().map(projectPlanHandoff)
        };
      case 'planHandoffs.respond':
        return this.respondPlanHandoff(command);
      case 'planHandoffs.resume':
        return this.retryPlanHandoff(command.handoffId);
      case 'resources.list':
        return {
          kind: 'resources',
          resources: this.app.resources.list({
            ownerType: command.ownerType,
            ownerId: command.ownerId,
            limit: command.limit
          })
        };
      case 'resources.get': {
        const resource = this.app.resources.get(command.resourceId);
        if (!resource) throw new RuntimeFacadeError('resource_not_found', 'Resource does not exist.');
        return { kind: 'resource', resource };
      }
      case 'resources.update': {
        const resource = this.app.resources.update(command.resourceId, {
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(command.lifecycle !== undefined ? { lifecycle: command.lifecycle } : {}),
          ...(command.sensitivity !== undefined ? { sensitivity: command.sensitivity } : {}),
          ...(command.provenanceSummary !== undefined
            ? { provenanceSummary: command.provenanceSummary }
            : {}),
          ...(command.expiresAt !== undefined ? { expiresAt: command.expiresAt } : {})
        });
        if (!resource) throw new RuntimeFacadeError('resource_not_found', 'Resource does not exist.');
        return { kind: 'resource', resource };
      }
      case 'resources.delete': {
        const deleted = await this.app.resources.delete(command.resourceId);
        if (!deleted) throw new RuntimeFacadeError('resource_not_found', 'Resource does not exist.');
        return { kind: 'acknowledged' };
      }
      case 'memories.list':
        return {
          kind: 'memories',
          memories: this.app.contextManager.memoryManager.list({
            scope: command.scope,
            scopeId: command.scopeId,
            lifecycleState: command.lifecycleState,
            limit: command.limit
          }).map(projectMemory)
        };
      case 'memories.get': {
        const memory = this.app.contextManager.memoryManager.get(command.memoryId);
        if (!memory) throw new RuntimeFacadeError('memory_not_found', 'Memory does not exist.');
        return { kind: 'memory', memory: projectMemory(memory) };
      }
      case 'memories.update': {
        const memory = this.app.contextManager.memoryManager.update(command.memoryId, {
          ...(command.value !== undefined ? { value: command.value } : {}),
          ...(command.summary !== undefined ? { summary: command.summary } : {}),
          ...(command.importance !== undefined ? { importance: command.importance } : {}),
          ...(command.confidence !== undefined ? { confidence: command.confidence } : {}),
          ...(command.lifecycleState !== undefined
            ? { lifecycleState: command.lifecycleState }
            : {}),
          ...(command.sensitivity !== undefined ? { sensitivity: command.sensitivity } : {}),
          ...(command.retentionUntil !== undefined
            ? { retentionUntil: command.retentionUntil }
            : {})
        });
        return { kind: 'memory', memory: projectMemory(memory) };
      }
      case 'memories.delete': {
        const deleted = this.app.contextManager.memoryManager.delete(command.memoryId);
        if (!deleted) throw new RuntimeFacadeError('memory_not_found', 'Memory does not exist.');
        return { kind: 'acknowledged' };
      }
      case 'taskCheckpoints.list': {
        this.requireRun(command.runId);
        return {
          kind: 'taskCheckpoints',
          checkpoints: await this.taskCheckpoints.list(command.runId)
        };
      }
      case 'taskCheckpoints.get':
      case 'taskCheckpoints.compare': {
        this.requireRun(command.runId);
        const checkpoint = await this.taskCheckpoints.get(command.runId, command.checkpointId);
        if (!checkpoint) {
          throw new RuntimeFacadeError('task_checkpoint_not_found', 'Task checkpoint does not exist.');
        }
        return { kind: 'taskCheckpoint', checkpoint };
      }
      case 'taskCheckpoints.restore': {
        const run = this.requireRun(command.runId);
        try {
          const restored = await this.taskCheckpoints.restore({
            runId: command.runId,
            checkpointId: command.checkpointId,
            sessionId: run.sessionId,
            taskId: run.taskId
          });
          return { kind: 'taskCheckpointRestore', ...restored };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'task_checkpoint_restore_failed';
          if (message.startsWith('task_checkpoint_restore_conflict:')) {
            throw new RuntimeFacadeError('task_checkpoint_restore_conflict', message);
          }
          if (message === 'task_checkpoint_not_found') {
            throw new RuntimeFacadeError('task_checkpoint_not_found', 'Task checkpoint does not exist.');
          }
          throw error;
        }
      }
      case 'trace.list': {
        const events = await scanTraceEvents(this.app.paths.traceFile, {
          limit: command.limit,
          redact: true,
          catalog: this.app.traceCatalog,
          filter: {
            ...(command.runId ? { runId: command.runId } : {}),
            replayOnly: false
          }
        });
        return {
          kind: 'trace',
          entries: events.map((event, index) => projectTraceEvent(event, `trace:${index}`))
        };
      }
    }
  }

  private async dispatchSessionPre(
    eventId: string,
    operation: 'create' | 'rename' | 'delete',
    sessionId?: string
  ): Promise<void> {
    const result = await this.app.hooks.dispatch({
      event: 'session.pre',
      eventId,
      payload: { operation, sessionId },
      authority: { permissions: ['write'], timeoutMs: 30_000 }
    });
    if (!result.allowed || !result.authority.permissions.includes('write')) {
      throw new RuntimeFacadeError(
        'hook_rejected',
        result.reason ?? `Session ${operation} was rejected by policy.`
      );
    }
  }

  private async dispatchSessionPost(
    eventId: string,
    operation: 'create' | 'rename' | 'delete',
    sessionId: string
  ): Promise<void> {
    const result = await this.app.hooks.dispatch({
      event: 'session.post',
      eventId,
      payload: { operation, sessionId },
      authority: { permissions: [], timeoutMs: 5_000 }
    });
    if (!result.allowed) {
      throw new RuntimeFacadeError(
        'hook_post_rejected',
        result.reason ?? `Session ${operation} post hook rejected.`
      );
    }
  }

  private requireRun(runId: string) {
    const run = this.app.runs.get(runId);
    if (!run) throw new RuntimeFacadeError('run_not_found', 'Run does not exist.');
    return run;
  }

  status(): RuntimeStatus {
    const workspaceWriteEnabled = [...this.workspaceAccess.values()].every((access) => access === 'write');
    return {
      availability: 'ready',
      runtimeVersion: this.runtimeVersion,
      protocolVersion: '2.0',
      capabilities: [
        'companion.chat',
        'companion.sessions',
        'agent.proposals',
        'agent.runs',
        'agent.permissions',
        'agent.plans',
        'agent.tools',
        'agent.subagents',
        'models.local',
        'models.remote',
        'workspace.read',
        ...(workspaceWriteEnabled ? ['workspace.write' as const] : []),
        'trace.read',
        'background.tasks',
        'scheduler',
        'resources',
        'memory.manage',
        ...(this.app.registry.listProviders().some((provider) => provider.id === 'browser-main')
          ? ['browser.web' as const]
          : [])
      ],
      observedAt: new Date().toISOString()
    };
  }

  private snapshot() {
    const connection = this.app.contextManager.db.connection;
    const ownsTransaction = !connection.isTransaction;
    if (ownsTransaction) connection.exec('BEGIN');
    try {
      const snapshot = {
        revision: this.eventJournal.currentCursor(),
        capturedAt: new Date().toISOString(),
        runs: this.app.runs.list({ limit: 200 }).map(projectRun),
        permissions: this.listVisiblePermissionRequests().map((request) => this.projectPermission(request)),
        planHandoffs: this.listVisiblePlanHandoffs().map(projectPlanHandoff),
        proposals: this.app.agentHandoffCoordinator.listPending().map(projectAgentProposal)
      };
      if (ownsTransaction) connection.exec('COMMIT');
      return snapshot;
    } catch (error) {
      if (ownsTransaction && connection.isTransaction) connection.exec('ROLLBACK');
      throw error;
    }
  }

  private models(): ModelSummary[] {
    const availability = new Map(
      this.app.modelAvailability.snapshot().map((record) => [record.modelId, record])
    );
    const configs = new Map(this.app.allModelConfigs().map((config) => [config.name, config]));
    const localDescriptors = this.app.localModelService.snapshot().models;
    const result: ModelSummary[] = [];
    for (const config of configs.values()) {
      result.push(this.projectModelConfig(config, availability.get(config.name)));
    }
    for (const descriptor of localDescriptors) {
      if (configs.has(descriptor.id)) continue;
      result.push({
        id: descriptor.id,
        label: descriptor.displayName,
        location: 'local',
        availability: descriptor.status === 'ready' ? 'ready' : 'unavailable',
        supportsAgent: descriptor.routerProfile?.capabilities?.toolCalling === true
          && descriptor.routerProfile?.capabilities?.jsonMode === true,
        supportsVision: descriptor.routerProfile?.supportsVision === true
          || descriptor.routerProfile?.capabilities?.image === true,
        ...(descriptor.error ? { detail: descriptor.error.slice(0, 1_024) } : {})
      });
    }
    return result;
  }

  private projectModelConfig(
    config: ModelClientConfig,
    availability: ReturnType<AppContext['modelAvailability']['get']>
  ): ModelSummary {
    const agentResolution = this.app.resolveForceClient(config.name, 'agent');
    return {
      id: config.name,
      label: config.model,
      location: config.location,
      availability: availability ? (availability.available ? 'ready' : 'unavailable') : 'checking',
      supportsAgent: !agentResolution.error,
      supportsVision: config.routerProfile?.supportsVision === true
        || config.routerProfile?.capabilities?.image === true,
      ...(config.kind === 'api' ? { providerQualification: config.qualification } : {}),
      ...(config.inference ? { inference: config.inference } : {}),
      ...(availability?.reason ? { detail: availability.reason.slice(0, 1_024) } : {})
    };
  }

  private async checkModels(modelId?: string): Promise<void> {
    await this.app.localModelService.refresh();
    if (modelId) {
      const client = this.app.clientMap.get(modelId);
      if (!client) throw new RuntimeFacadeError('model_not_found', '模型不存在');
      await this.app.modelAvailability.refreshModel(modelId, client);
      return;
    }
    await this.app.modelAvailability.refreshAll(this.app.clientMap);
  }

  private async startCompanionChat(
    command: Extract<RuntimeCommand, { kind: 'companion.chat.start' }>
  ): Promise<RuntimeResult> {
    if (command.resources.length > 0) {
      throw new RuntimeFacadeError('attachments_not_available', '附件资源协议尚未启用');
    }
    const selectedConfig = command.modelId
      ? this.app.allModelConfigs().find((config) => config.name === command.modelId)
      : undefined;
    if (command.modelId && !selectedConfig) {
      throw new RuntimeFacadeError('model_not_found', '模型不存在。');
    }
    const workspaceId = command.sessionId
      ? this.conversationWorkspaces.workspaceFor(command.sessionId)
      : this.resolveWorkspaceId(command.workspaceId);
    if (command.sessionId && command.workspaceId && command.workspaceId !== workspaceId) {
      throw new RuntimeFacadeError('session_workspace_conflict', '会话不能在创建后切换工作区。');
    }
    const inference = resolveInferenceOptions(selectedConfig?.inference, command.inference);
    const startController = new AbortController();
    const started = deferred<{ runId: string; sessionId: string }>();
    const run = this.app.companionService.chatStream(
      {
        message: command.message,
        userMessageId: command.clientMessageId,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        ...(command.modelId ? { clientName: command.modelId } : {}),
        ...(inference ? { inference } : {}),
        ...(command.routingStrategy ? { routingStrategy: command.routingStrategy } : {}),
        workspaceKey: workspaceId,
        outputMode: 'bounded'
      },
      (event) => {
        const identity = this.streamProjector.handle(event);
        if (identity) started.resolve(identity);
      },
      { signal: startController.signal }
    );
    void run.catch((error) => {
      started.reject(error);
    });
    let identity: { runId: string; sessionId: string };
    try {
      identity = await withTimeout(
        started.promise,
        this.companionStartTimeoutMs,
        'companion_start_timeout'
      );
    } catch (error) {
      startController.abort(error);
      throw error;
    }
    try {
      this.conversationWorkspaces.assign(identity.sessionId, workspaceId);
    } catch (error) {
      startController.abort(error);
      if (!command.sessionId) {
        try {
          await withTimeout(
            run.catch(() => undefined),
            this.companionStartTimeoutMs,
            'companion_cleanup_timeout'
          );
          const deleted = await this.app.unifiedAssistantHandoffService.deleteCompanionSession({
            sessionId: identity.sessionId
          });
          if (!deleted) throw new Error('created_companion_session_cleanup_missing');
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Companion session started, but workspace ownership and compensating deletion both failed.'
          );
        }
      }
      throw error;
    }
    return { kind: 'companion.chat.accepted', ...identity };
  }

  private resolveWorkspaceId(requestedWorkspaceId?: string): string {
    const workspaceId = requestedWorkspaceId ?? this.app.defaultWorkspaceKey;
    if (!this.workspaceAccess.has(workspaceId)) {
      throw new RuntimeFacadeError('workspace_not_authorized', '工作区不存在或未授权。');
    }
    return workspaceId;
  }

  private async respondPermission(
    command: Extract<RuntimeCommand, { kind: 'permissions.respond' }>
  ): Promise<RuntimeResult> {
    const current = this.app.permissionRequestStore.get(command.requestId);
    if (!current || current.status !== 'pending') {
      throw new RuntimeFacadeError('permission_not_found', '权限申请不存在或已处理');
    }
    this.assertPermissionWithinWorkspaceAccess(current, command.decision, command.approvedItemIds);
    const decisionInput = command.decision === 'deny'
      ? {
          approvalVersion: command.approvalVersion,
          decision: 'deny' as const
        }
      : {
          approvalVersion: command.approvalVersion,
          decision: command.decision,
          approvedItemIds: command.approvedItemIds
        };
    const decision = new PermissionRequestDecisionService(
      this.app.contextManager.db.connection,
      this.app.permissionRequestStore,
      this.app.sessionPermissionGrants,
      this.app.workspaceGrantStore,
      this.app.runs,
      this.app.pausedRunStore
    ).respond(command.requestId, decisionInput);
    if (!decision) throw new RuntimeFacadeError('permission_not_found', '权限申请不存在或已处理');
    const projected = this.projectPermission(decision.permissionRequest);
    this.emit({ kind: 'permission.changed', request: projected });
    if (command.decision === 'deny') {
      await this.settleRejectedRun(decision.permissionRequest.runId, 'permission_denied', '用户拒绝了权限申请。');
    } else {
      this.startResume(
        `permission:${decision.permissionRequest.runId}`,
        () => this.resumeAfterPermission(
          decision.permissionRequest.runId,
          decision.permissionRequest.id
        )
      );
    }
    const run = this.app.runs.get(decision.permissionRequest.runId);
    if (run) this.emit({ kind: 'run.changed', run: projectRun(run) });
    await this.eventDispatcher.flush();
    return { kind: 'permission', request: projected };
  }

  private async respondPlanHandoff(
    command: Extract<RuntimeCommand, { kind: 'planHandoffs.respond' }>
  ): Promise<RuntimeResult> {
    const decision = new PlanHandoffDecisionService(
      this.app.contextManager.db.connection,
      this.app.planHandoffStore,
      this.app.runs,
      this.app.pausedRunStore
    ).respond(command.handoffId, { decision: command.decision });
    if (!decision) throw new RuntimeFacadeError('plan_handoff_not_found', '计划交接不存在或已处理');
    const projected = projectPlanHandoff(decision);
    this.emit({ kind: 'planHandoff.changed', handoff: projected });
    if (command.decision === 'approve') {
      this.startResume(
        `plan:${decision.runId}`,
        () => this.resumeAfterPlanHandoff(decision.runId, decision.id)
      );
    } else {
      await this.settleRejectedRun(decision.runId, 'run_cancelled', '用户拒绝了执行计划。');
    }
    const run = this.app.runs.get(decision.runId);
    if (run) this.emit({ kind: 'run.changed', run: projectRun(run) });
    await this.eventDispatcher.flush();
    return { kind: 'planHandoff', handoff: projected };
  }

  private async publishProposalResponse(response: UnifiedAgentProposalResponse): Promise<void> {
    const proposal = projectAgentProposal(response.proposal);
    this.emit({ kind: 'agent.proposal.changed', proposal });
    this.emitCompanionPresentation(response.companionPresentation);
    if (response.proposal.runId) {
      const run = this.app.runs.get(response.proposal.runId);
      if (run) this.emit({ kind: 'run.changed', run: projectRun(run) });
    }
    await this.eventDispatcher.flush();
  }

  private handleAgentProposal(proposal: SourceAgentProposal): boolean {
    if (this.proposalApproval !== 'automatic') return false;
    const existing = this.app.agentHandoffCoordinator.get(proposal.id);
    if (!existing || existing.status !== 'pending') return false;
    const allowedCapabilities = existing.requestedCapabilities.filter((capability) => {
      if (capability === 'file-read') return this.allowedPermissions.has('read');
      if (capability === 'file-write') return this.allowedPermissions.has('write');
      if (capability === 'browser') return this.allowedPermissions.has('network');
      return this.allowedPermissions.has('shell');
    });
    if (allowedCapabilities.length === 0) return false;

    let responsePromise: Promise<UnifiedAgentProposalResponse | null>;
    try {
      this.assertProposalWithinWorkspaceAccess(existing, allowedCapabilities, this.workspaceAccess.get(existing.workspaceKey));
      responsePromise = this.app.unifiedAssistantHandoffService.respond(existing.id, {
        decision: 'approve_once',
        allowedCapabilities,
        workspaceKey: existing.workspaceKey
      });
    } catch {
      return false;
    }

    const started = this.app.agentHandoffCoordinator.get(existing.id);
    if (started && started.status !== 'pending') {
      this.emit({
        kind: 'agent.proposal.changed',
        proposal: projectAgentProposal(started)
      });
    }
    void responsePromise
      .then(async (response) => {
        if (response) {
          await this.publishProposalResponse(response);
          return;
        }
        this.publishCurrentProposal(existing.id);
      })
      .catch(() => this.publishCurrentProposal(existing.id));
    return true;
  }

  private publishCurrentProposal(proposalId: string): void {
    const proposal = this.app.agentHandoffCoordinator.get(proposalId);
    if (!proposal) return;
    this.emit({
      kind: 'agent.proposal.changed',
      proposal: projectAgentProposal(proposal)
    });
  }

  private makeChatForRun(runId: string) {
    const proposal = this.app.agentHandoffCoordinator.getByRunId(runId);
    return this.app.makeChatFn(proposal?.modelBinding?.clientName);
  }

  private async resumeAfterPermission(runId: string, permissionRequestId: string): Promise<void> {
    let result: ApiResult;
    try {
      result = await this.app.orchestrator.resumeAfterPermission(
        { runId, permissionRequestId },
        this.makeChatForRun(runId)
      );
    } catch (error) {
      result = failedApiResult(runId, error, 'Agent 权限恢复失败', true);
    }
    const recorded = await this.app.unifiedAssistantHandoffService.recordResumedExecution(runId, result);
    await this.publishRecordedExecution(runId, recorded);
  }

  private async resumeAfterPlanHandoff(runId: string, planHandoffId: string): Promise<void> {
    let result: ApiResult;
    try {
      result = await this.app.orchestrator.resumeAfterPlanHandoff(
        { runId, planHandoffId },
        this.makeChatForRun(runId)
      );
    } catch (error) {
      result = failedApiResult(runId, error, 'Agent 计划恢复失败', true);
    }
    const recorded = await this.app.unifiedAssistantHandoffService.recordResumedExecution(runId, result);
    await this.publishRecordedExecution(runId, recorded);
  }

  private async settleRejectedRun(
    runId: string,
    source: 'permission_denied' | 'run_cancelled',
    message: string
  ): Promise<void> {
    await this.app.orchestrator.publishRunTerminal(runId, source);
    const recorded = await this.app.unifiedAssistantHandoffService.recordResumedExecution(runId, {
      status: 403,
      body: { runId, error: message }
    });
    await this.publishRecordedExecution(runId, recorded);
  }

  private async publishRecordedExecution(runId: string, result: ApiResult): Promise<void> {
    const body = recordValue(result.body);
    this.emitCompanionPresentation(body.companionPresentation);
    await this.eventDispatcher.flush();
    const run = this.app.runs.get(runId);
    if (run) this.emit({ kind: 'run.changed', run: projectRun(run) });
  }

  private listVisiblePermissionRequests(): PermissionRequestPayload[] {
    const visible = this.app.permissionRequestStore.listPending();
    const ids = new Set(visible.map((request) => request.id));
    for (const run of this.app.runs.list({ limit: 200 })) {
      if (run.status !== 'waiting_confirmation' || !this.app.pausedRunStore.get(run.id)) continue;
      const approved = this.app.permissionRequestStore.getApprovedByRunId(run.id);
      if (approved && !ids.has(approved.id)) {
        ids.add(approved.id);
        visible.push(approved);
      }
    }
    return visible;
  }

  private listVisiblePlanHandoffs() {
    const visible = this.app.planHandoffStore.listPending();
    const ids = new Set(visible.map((handoff) => handoff.id));
    for (const run of this.app.runs.list({ limit: 200 })) {
      if (run.status !== 'waiting_plan_handoff' || !this.app.pausedRunStore.get(run.id)) continue;
      const approved = this.app.planHandoffStore.getApprovedByRunId(run.id);
      if (approved && !ids.has(approved.id)) {
        ids.add(approved.id);
        visible.push(approved);
      }
    }
    return visible;
  }

  private retryPermission(requestId: string): RuntimeResult {
    const request = this.app.permissionRequestStore.get(requestId);
    if (!request || request.status !== 'approved') {
      throw new RuntimeFacadeError(
        'permission_resume_not_found',
        '未找到可恢复的已批准权限申请。'
      );
    }
    const run = this.requireRetryableRun(request.runId, 'waiting_confirmation');
    this.startResume(
      `permission:${run.id}`,
      () => this.resumeAfterPermission(run.id, request.id)
    );
    return { kind: 'run', run: projectRun(this.app.runs.get(run.id) ?? run) };
  }

  private retryPlanHandoff(handoffId: string): RuntimeResult {
    const handoff = this.app.planHandoffStore.get(handoffId);
    if (!handoff || handoff.status !== 'approved') {
      throw new RuntimeFacadeError('plan_resume_not_found', '未找到可恢复的已批准计划。');
    }
    const run = this.requireRetryableRun(handoff.runId, 'waiting_plan_handoff');
    this.startResume(
      `plan:${run.id}`,
      () => this.resumeAfterPlanHandoff(run.id, handoff.id)
    );
    return { kind: 'run', run: projectRun(this.app.runs.get(run.id) ?? run) };
  }

  private requireRetryableRun(
    runId: string,
    expectedStatus: 'waiting_confirmation' | 'waiting_plan_handoff'
  ) {
    const run = this.app.runs.get(runId);
    if (!run || run.status !== expectedStatus || !this.app.pausedRunStore.get(runId)) {
      throw new RuntimeFacadeError('run_not_retryable', '运行已不在可恢复状态。');
    }
    return run;
  }

  private startResume(key: string, resume: () => Promise<void>): void {
    if (this.activeResumes.has(key)) {
      throw new RuntimeFacadeError(
        'resume_in_progress',
        '运行正在恢复，请等待当前恢复完成。',
        true
      );
    }
    this.activeResumes.add(key);
    void resume()
      .catch(() => {
        // Durable Run, approval and paused snapshot remain authoritative.
      })
      .finally(() => this.activeResumes.delete(key));
  }

  private emitCompanionPresentation(value: unknown): void {
    const delivery = CompanionAgentResultDeliverySchema.safeParse(value);
    if (delivery.success && delivery.data.status === 'presented') {
      this.emit({ kind: 'companion.message.changed', message: projectMessage(delivery.data.message) });
    }
  }

  private assertProposalWithinWorkspaceAccess(
    proposal: SourceAgentProposal,
    allowedCapabilities: readonly AgentCapability[] | undefined,
    requestedAccess?: 'read' | 'write'
  ): void {
    if (!allowedCapabilities) return;
    const access = this.workspaceAccess.get(proposal.workspaceKey);
    if (!access) {
      throw new RuntimeFacadeError('workspace_not_authorized', 'Agent 提案引用了未授权工作区。');
    }
    if (access !== 'read' && requestedAccess !== 'read') return;
    if (allowedCapabilities.some((capability) => capability === 'file-write' || capability === 'shell')) {
      throw new RuntimeFacadeError('workspace_read_only', '该工作区是只读工作区，不能批准写文件或 Shell 能力。');
    }
  }

  private assertPermissionWithinWorkspaceAccess(
    request: PermissionRequestPayload,
    decision: Extract<RuntimeCommand, { kind: 'permissions.respond' }>['decision'],
    approvedItemIds: readonly string[]
  ): void {
    if (decision === 'deny') return;
    const workspace = this.permissionWorkspace(request);
    if (!workspace) {
      throw new RuntimeFacadeError('workspace_not_authorized', '权限申请缺少可验证的会话工作区。');
    }
    const access = this.workspaceAccess.get(workspace.workspaceId);
    if (!access) {
      throw new RuntimeFacadeError('workspace_not_authorized', '权限申请引用了未授权工作区。');
    }
    if (access !== 'read') return;
    const approved = new Set(approvedItemIds);
    const violatesReadOnly = request.requiredPermissions.some((item) => approved.has(item.id)
      && item.type !== 'read_file'
      && item.type !== 'network');
    if (violatesReadOnly) {
      throw new RuntimeFacadeError('workspace_read_only', '该工作区是只读工作区，不能批准写入、删除、Shell 或危险操作。');
    }
  }

  private projectPermission(request: PermissionRequestPayload) {
    return projectPermissionRequest(request, this.permissionWorkspace(request));
  }

  private permissionWorkspace(request: PermissionRequestPayload) {
    const run = this.app.runs.get(request.runId);
    const sessionId = run?.sessionId ?? request.sessionId;
    if (!sessionId) return undefined;
    const workspaceId = this.app.contextManager.getSession(sessionId)?.workspaceKey;
    if (!workspaceId || !this.workspaceAccess.has(workspaceId)) return undefined;
    return {
      workspaceId,
      workspaceLabel: this.workspaceLabels.get(workspaceId) ?? workspaceId
    };
  }
}

function failedApiResult(runId: string, error: unknown, fallback: string, retryable = false): ApiResult {
  const publicError = toPublicError(error, fallback);
  return {
    status: 502,
    body: {
      runId,
      error: publicError.message,
      code: publicError.code,
      ...(retryable ? { retryable: true } : {})
    }
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resolveInferenceOptions(
  profile: ModelInferenceProfile | undefined,
  requested: ModelInferenceOptions | undefined
): ModelInferenceOptions | undefined {
  const reasoning = profile?.reasoning;
  if (!reasoning) {
    if (requested?.reasoningMode || requested?.reasoningEffort) {
      throw new RuntimeFacadeError('inference_option_unsupported', '当前模型未声明可调推理参数。');
    }
    return undefined;
  }
  const reasoningMode = requested?.reasoningMode ?? reasoning.defaultMode;
  if (!reasoning.modes.includes(reasoningMode)) {
    throw new RuntimeFacadeError('inference_option_unsupported', `当前模型不支持推理模式：${reasoningMode}`);
  }
  const reasoningEffort = requested?.reasoningEffort ?? reasoning.defaultEffort;
  if (reasoningEffort && !reasoning.efforts.includes(reasoningEffort)) {
    throw new RuntimeFacadeError('inference_option_unsupported', `当前模型不支持推理强度：${reasoningEffort}`);
  }
  if (!reasoningEffort && reasoning.efforts.length > 0) {
    throw new RuntimeFacadeError('inference_profile_invalid', '模型推理配置缺少默认强度。');
  }
  return {
    reasoningMode,
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

function eventMetadata(event: RuntimeEvent): {
  aggregateType: 'runtime' | 'run' | 'companion' | 'permission' | 'plan_handoff' | 'proposal' | 'trace';
  aggregateId: string;
  correlationId?: string;
} {
  switch (event.kind) {
    case 'runtime.status.changed':
      return { aggregateType: 'runtime', aggregateId: 'runtime' };
    case 'companion.token.delta':
      return { aggregateType: 'companion', aggregateId: event.messageId, correlationId: event.runId };
    case 'companion.message.changed':
      return {
        aggregateType: 'companion',
        aggregateId: event.message.messageId,
        correlationId: event.message.sessionId
      };
    case 'agent.proposal.changed':
      return {
        aggregateType: 'proposal',
        aggregateId: event.proposal.proposalId,
        correlationId: event.proposal.sessionId
      };
    case 'run.changed':
      return { aggregateType: 'run', aggregateId: event.run.runId, correlationId: event.run.sessionId };
    case 'run.activity':
      return {
        aggregateType: 'trace',
        aggregateId: event.activity.activityId,
        correlationId: event.activity.runId
      };
    case 'permission.changed':
      return {
        aggregateType: 'permission',
        aggregateId: event.request.requestId,
        correlationId: event.request.runId
      };
    case 'planHandoff.changed':
      return {
        aggregateType: 'plan_handoff',
        aggregateId: event.handoff.handoffId,
        correlationId: event.handoff.runId
      };
    case 'trace.appended':
      return {
        aggregateType: 'trace',
        aggregateId: event.entry.traceId,
        correlationId: event.entry.runId
      };
  }
}

class CompanionStreamProjector {
  private readonly streams = new Map<string, {
    sessionId: string;
    message: ReturnType<typeof projectMessage>;
    aggregateVersion: number;
    bufferedText: string;
    timer?: NodeJS.Timeout;
  }>();

  constructor(
    private readonly emit: RawRuntimeEventSink,
    private readonly onAgentProposal?: (proposal: SourceAgentProposal) => boolean
  ) {}

  stop(): void {
    for (const stream of this.streams.values()) {
      if (stream.timer) clearTimeout(stream.timer);
    }
    this.streams.clear();
  }

  handle(event: CompanionStreamEvent): { runId: string; sessionId: string } | undefined {
    switch (event.type) {
      case 'run_start':
        if (event.persistence !== 'stored') return undefined;
        this.streams.set(event.runId, {
          sessionId: event.session.id,
          message: projectMessage(event.assistantMessage),
          aggregateVersion: 1,
          bufferedText: ''
        });
        this.emit({ kind: 'companion.message.changed', message: projectMessage(event.userMessage) });
        this.emit({ kind: 'companion.message.changed', message: projectMessage(event.assistantMessage) });
        this.emit({
          kind: 'run.changed',
          run: {
            runId: event.runId,
            sessionId: event.session.id,
            origin: 'companion',
            title: event.userMessage.content.slice(0, 512),
            status: 'running',
            userFacingLabel: '正在回复',
            aggregateVersion: 1,
            checkpointStage: 'running',
            recoveryStatus: 'none',
            startedAt: event.userMessage.createdAt
          }
        });
        return { runId: event.runId, sessionId: event.session.id };
      case 'token':
        this.appendToken(event.runId, event.delta, event.final);
        return undefined;
      case 'replace': {
        this.flush(event.runId);
        const stream = this.streams.get(event.runId);
        if (stream) {
          stream.message = { ...stream.message, content: event.content };
          this.emit({ kind: 'companion.message.changed', message: stream.message });
        }
        return undefined;
      }
      case 'agent_proposal': {
        const handledAutomatically = this.onAgentProposal?.(event.proposal) === true;
        if (!handledAutomatically) {
          this.emit({ kind: 'agent.proposal.changed', proposal: projectAgentProposal(event.proposal) });
        }
        return undefined;
      }
      case 'done':
        this.flush(event.runId);
        if (event.result.persistence === 'stored') {
          const stream = this.streams.get(event.runId);
          const aggregateVersion = (stream?.aggregateVersion ?? 1) + 1;
          if (stream) stream.aggregateVersion = aggregateVersion;
          this.emit({
            kind: 'companion.message.changed',
            message: projectMessage(event.result.assistantMessage)
          });
          this.emit({
            kind: 'run.changed',
            run: {
              runId: event.runId,
              sessionId: event.result.session.id,
              origin: 'companion',
              title: event.result.userMessage.content.slice(0, 512),
              status: 'completed',
              userFacingLabel: '回复完成',
              aggregateVersion,
              checkpointStage: 'completed',
              recoveryStatus: 'none',
              startedAt: event.result.userMessage.createdAt,
              completedAt: event.result.assistantMessage.updatedAt
            }
          });
        }
        this.clear(event.runId);
        return undefined;
      case 'cancelled':
        this.flush(event.runId);
        this.finishMessage(event.runId, 'CANCELLED', '已停止生成。', false);
        this.finishRun(event.runId, 'cancelled', '已取消');
        this.clear(event.runId);
        return undefined;
      case 'error':
        this.flush(event.runId);
        {
          const presentation = companionStreamErrorPresentation(event);
          this.finishMessage(
            event.runId,
            event.code,
            presentation.message,
            presentation.retryable
          );
        }
        this.finishRun(event.runId, 'failed', event.message);
        this.clear(event.runId);
        return undefined;
      case 'stream_guard':
        return undefined;
    }
  }

  private appendToken(runId: string, text: string, final: boolean): void {
    const stream = this.streams.get(runId);
    if (!stream) return;
    stream.bufferedText += text;
    if (final || stream.bufferedText.length >= 4_096) {
      this.flush(runId);
      return;
    }
    stream.timer ??= setTimeout(() => {
      stream.timer = undefined;
      this.flush(runId);
    }, 50);
    stream.timer.unref?.();
  }

  private flush(runId: string): void {
    const stream = this.streams.get(runId);
    if (!stream?.bufferedText) return;
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = undefined;
    const text = stream.bufferedText;
    stream.bufferedText = '';
    stream.message = {
      ...stream.message,
      content: stream.message.content + text,
      status: 'streaming'
    };
    this.emit({
      kind: 'companion.token.delta',
      runId,
      sessionId: stream.sessionId,
      messageId: stream.message.messageId,
      text
    });
  }

  private finishMessage(runId: string, code: string, message: string, retryable: boolean): void {
    const stream = this.streams.get(runId);
    if (!stream) return;
    stream.message = {
      ...stream.message,
      status: 'interrupted',
      error: { code, message, retryable }
    };
    this.emit({ kind: 'companion.message.changed', message: stream.message });
  }

  private finishRun(runId: string, status: 'failed' | 'cancelled', label: string): void {
    const stream = this.streams.get(runId);
    if (!stream) return;
    stream.aggregateVersion += 1;
    this.emit({
      kind: 'run.changed',
      run: {
        runId,
        sessionId: stream.sessionId,
        origin: 'companion',
        title: stream.message.content.slice(0, 512) || 'Companion 对话',
        status,
        userFacingLabel: label,
        aggregateVersion: stream.aggregateVersion,
        checkpointStage: status,
        recoveryStatus: 'none',
        completedAt: new Date().toISOString()
      }
    });
  }

  private clear(runId: string): void {
    const stream = this.streams.get(runId);
    if (stream?.timer) clearTimeout(stream.timer);
    this.streams.delete(runId);
  }
}

function companionStreamErrorPresentation(
  event: Extract<CompanionStreamEvent, { type: 'error' }>
): { message: string; retryable: boolean } {
  switch (event.code) {
    case 'COMPANION_TURN_PROTOCOL_ERROR':
      return {
        message: 'Agent 提案未通过协议或业务校验，授权请求没有创建。详细阶段和字段路径已写入日志。',
        retryable: event.retryable
      };
    case 'COMPANION_EMPTY_RESPONSE':
      return {
        message: '模型只返回了内部推理，没有生成最终回复。Ariadne 已尝试续写但仍未得到内容，请重试。',
        retryable: true
      };
    default:
      return { message: event.message, retryable: event.retryable };
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RuntimeFacadeError(code, 'Runtime 操作启动超时', true)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
