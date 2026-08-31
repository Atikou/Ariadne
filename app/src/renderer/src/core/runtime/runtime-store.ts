import { useSyncExternalStore } from 'react';

import {
  PUBLIC_DECISION_ACTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PERSONAL_ASSISTANT_WORKSPACE_ID
} from '@ariadne/protocol/public';
import type {
  ChatRoutingStrategy,
  ConversationMessageReferenceV3,
  ConversationSession,
  EncodedImageAttachmentV3,
  ModelInferenceOptions,
  ModelSummary,
  PublicDecisionChoiceV3,
  PublicDecisionProjectionV3,
  PublicRunProjectionV3,
  RunActivity,
  PublicProjectionReadBatchV3,
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResult,
  RuntimeStatus,
  TraceEntry,
} from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import {
  ProjectionCache,
  type ProjectionCacheSnapshot
} from './projection/projection-cache';
import {
  ProjectionProtocolIntegrityError,
  ProjectionReadResetSignal,
  ProjectionRuntimeClient
} from './projection/projection-runtime-client';
import { PublicResultError, unwrapPublicResult } from './public-result';
import {
  AgentInputDeliveryTracker,
  type AgentInputDeliveryReceipt
} from './agent-input-delivery';
import {
  presentDiagnostic,
  presentInferenceStreamMessage,
  presentMessage,
  presentModel,
  presentPermissionDecision,
  presentPlanDecision,
  presentUserQuestionDecision,
  presentRun,
  presentRunActivities,
  presentSession,
  type RuntimeMessage,
  type RuntimePermissionDecision,
  type RuntimePlanDecision,
  type RuntimeUserQuestionDecision,
  type RuntimeRun
} from './runtime-projection-presenter';
import { RuntimeUiState } from './runtime-ui-state';

export type { AgentInputDeliveryReceipt } from './agent-input-delivery';
export type {
  RuntimeMessage,
  RuntimePermissionDecision,
  RuntimePlanDecision,
  RuntimeUserQuestionDecision,
  RuntimeRun
} from './runtime-projection-presenter';
export { PublicResultError, unwrapPublicResult } from './public-result';

export interface RuntimeSnapshot {
  initialized: boolean;
  status: RuntimeStatus;
  projectionStreamId: string | null;
  projectionCursor: number;
  projectionIntegrityError: string | null;
  sessions: ConversationSession[];
  selectedSessionId: string | null;
  planModeSessionIds: string[];
  pendingOverlayIds: string[];
  messages: RuntimeMessage[];
  models: ModelSummary[];
  runs: RuntimeRun[];
  activities: RunActivity[];
  permissions: RuntimePermissionDecision[];
  planHandoffs: RuntimePlanDecision[];
  userQuestions: RuntimeUserQuestionDecision[];
  trace: TraceEntry[];
  agentInputDeliveries: AgentInputDeliveryReceipt[];
  lastError: string | null;
}

export interface SendMessageOptions {
  modelId?: string;
  inference?: ModelInferenceOptions;
  routingStrategy?: ChatRoutingStrategy;
  workspaceId?: string;
  sessionId?: string;
  selectSession?: boolean;
  attachments?: readonly EncodedImageAttachmentV3[];
}

export type ConversationSessionQueryItem = Extract<
  RuntimeResult,
  { readonly kind: 'conversation.sessions.query_result.v3' }
>['items'][number];

export type ResolvedConversationMessage = Extract<
  RuntimeResult,
  { readonly kind: 'conversation.message.resolved.v3' }
>;

export type ProtectedToolResultDetail = Extract<
  RuntimeResult,
  { readonly kind: 'agent.tool_result.detail.v3' }
>;

export type HumanSkillCommand = Extract<
  RuntimeResult,
  { readonly kind: 'skill.commands.query_result.v3' }
>['commands'][number];

export type LoadedHumanSkill = Extract<
  RuntimeResult,
  { readonly kind: 'skill.command.loaded.v3' }
>;

export type HumanSkillResource = Extract<
  RuntimeResult,
  { readonly kind: 'skill.command.resource.v3' }
>;

export type ProductivitySnapshot = Extract<RuntimeResult, { kind: 'productivity.query_result.v3' }>;
export type ProductivityGoal = NonNullable<ProductivitySnapshot['goal']>;
export type ProductivityWorkflow = ProductivitySnapshot['workflows'][number];
export type ProductivitySchedule = Extract<RuntimeResult, { kind: 'schedules.query_result.v3' }>['schedules'][number];

const STOPPED_STATUS: RuntimeStatus = {
  availability: 'stopped',
  capabilities: [],
  observedAt: new Date(0).toISOString()
};

const ACTIVE_PROJECTION_POLL_INTERVAL_MS = 500;

/**
 * Renderer composition store. The six authoritative domain collections are
 * always rebuilt from ProjectionCache; this class owns only lifecycle, command
 * routing and local UI overlays.
 */
export class RuntimeStore {
  private readonly projectionClient: ProjectionRuntimeClient;
  private readonly projection = new ProjectionCache();
  private readonly ui = new RuntimeUiState();
  private readonly agentInputDeliveries = new AgentInputDeliveryTracker();
  private readonly listeners = new Set<() => void>();
  private readonly removeProjectionListener: () => void;
  private initialized = false;
  private status: RuntimeStatus = STOPPED_STATUS;
  private requestError: string | null = null;
  private activities: RunActivity[] = [];
  private snapshot: RuntimeSnapshot;
  private lastProjectionResetEpoch = 0;

  private initializePromise: Promise<void> | null = null;
  private removeStatusListener: (() => void) | null = null;
  private removeEventListener: (() => void) | null = null;
  private lifecycleGeneration = 0;
  private synchronizationGeneration = 0;
  private synchronizationPromise: Promise<void> | null = null;
  private synchronizationRequested = false;
  private snapshotRequired = true;
  private lifecycleReady = false;
  private projectionPollTimer: ReturnType<typeof setTimeout> | null = null;
  private agentInputDeliveryPersistenceReady: boolean;
  private agentInputDeliveryPersistenceError: string | null = null;

  constructor(
    private readonly api: AriadneApi['runtime'],
    private readonly agentInputDeliveryPersistence?: AriadneApi['agentInputDeliveryOutbox']
  ) {
    this.agentInputDeliveryPersistenceReady = agentInputDeliveryPersistence === undefined;
    this.projectionClient = new ProjectionRuntimeClient(api);
    this.snapshot = this.createSnapshot(this.projection.getSnapshot());
    this.removeProjectionListener = this.projection.subscribe(() => {
      const projection = this.projection.getSnapshot();
      if (projection.resetEpoch !== this.lastProjectionResetEpoch) {
        this.lastProjectionResetEpoch = projection.resetEpoch;
        this.ui.clearPendingOverlay();
      }
      const settledCommandIds = this.agentInputDeliveries.observeProjection(projection.runs);
      this.publish(projection);
      this.updateProjectionPolling(projection);
      for (const commandId of settledCommandIds) {
        void this.settlePersistedAgentInputDelivery(commandId);
      }
    });
  }

  getSnapshot = (): RuntimeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  initialize(): Promise<void> {
    if (this.initializePromise !== null) return this.initializePromise;
    const generation = ++this.lifecycleGeneration;
    this.lifecycleReady = false;
    this.stopProjectionPolling();
    this.snapshotRequired = true;
    this.synchronizationRequested = false;
    this.synchronizationGeneration += 1;
    this.projection.resetLifecycle();

    // Supervisor status is the only lifecycle authority. Runtime events are
    // projection wake hints and cannot mutate lifecycle or domain state.
    this.removeStatusListener = this.api.onStatus((status) => {
      if (generation === this.lifecycleGeneration) this.receiveStatus(status);
    });
    this.removeEventListener = this.api.onEvent((event) => {
      if (generation === this.lifecycleGeneration) this.receiveWakeHint(event);
    });
    this.initializePromise = this.initializeRuntime(generation);
    return this.initializePromise;
  }

  dispose(): void {
    this.lifecycleGeneration += 1;
    this.synchronizationGeneration += 1;
    this.lifecycleReady = false;
    this.stopProjectionPolling();
    this.synchronizationRequested = false;
    this.snapshotRequired = true;
    this.removeStatusListener?.();
    this.removeStatusListener = null;
    this.removeEventListener?.();
    this.removeEventListener = null;
    this.initializePromise = null;
    this.synchronizationPromise = null;
    this.initialized = false;
    this.status = STOPPED_STATUS;
    this.requestError = null;
    this.projection.resetLifecycle();
    this.publish();
  }

  async refresh(): Promise<void> {
    if (this.status.availability !== 'ready' || !this.lifecycleReady) return;
    await this.requestSynchronization(false);
  }

  async selectSession(sessionId: string): Promise<void> {
    this.ui.selectSession(sessionId);
    this.publish();
  }

  clearSessionSelection(): void {
    this.ui.clearSessionSelection();
    this.publish();
  }

  async renameSession(session: ConversationSession, title: string): Promise<void> {
    await this.mutateSession(session, {
      kind: 'conversation.session.rename.v3',
      title: title.trim()
    });
  }

  async archiveSession(session: ConversationSession): Promise<void> {
    await this.mutateSession(session, { kind: 'conversation.session.archive.v3' });
  }

  async restoreSession(session: ConversationSession): Promise<void> {
    await this.mutateSession(session, { kind: 'conversation.session.restore.v3' });
  }

  async querySessions(
    workspaceId: string,
    query: string,
    status: 'active' | 'archived' | 'all' = 'active',
    limit = 20
  ): Promise<readonly ConversationSessionQueryItem[]> {
    const result = await this.command({
      kind: 'conversation.sessions.query.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      query,
      status,
      limit
    });
    if (result.kind !== 'conversation.sessions.query_result.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.items;
  }

  async resolveMessageReference(
    reference: ConversationMessageReferenceV3
  ): Promise<ResolvedConversationMessage> {
    const result = await this.command({
      kind: 'conversation.message.resolve.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      reference
    });
    if (result.kind !== 'conversation.message.resolved.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result;
  }

  async forkSessionFromMessage(
    sourceSessionId: string,
    boundary: ConversationMessageReferenceV3
  ): Promise<string> {
    const source = this.projection.sessions.getSnapshot().find(
      (session) => session.sessionId === sourceSessionId
    );
    if (source === undefined || boundary.sessionId !== source.sessionId) {
      throw new Error('conversation_fork_projection_missing');
    }
    const sessionId = crypto.randomUUID();
    const result = await this.command({
      kind: 'conversation.session.fork.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId,
      sourceSessionId: source.sessionId,
      workspaceId: source.workspaceId,
      expectedSourceSessionVersion: source.version,
      boundary
    });
    if (
      result.kind !== 'conversation.session.forked.v3'
      || result.sessionId !== sessionId
      || result.sourceSessionId !== source.sessionId
    ) throw new Error(`runtime_result_invalid:${result.kind}`);
    this.ui.selectSession(sessionId);
    this.publish();
    await this.requestSynchronization(false);
    return sessionId;
  }

  async loadProtectedToolResultDetail(
    runId: string,
    workspaceId: string,
    effectId: string,
    cursor = 0,
    maxBytes = 32 * 1024
  ): Promise<ProtectedToolResultDetail> {
    const result = await this.command({
      kind: 'agent.tool_result.detail.get.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId,
      workspaceId,
      effectId,
      cursor,
      maxBytes
    });
    if (
      result.kind !== 'agent.tool_result.detail.v3'
      || result.runId !== runId
      || result.workspaceId !== workspaceId
      || result.effectId !== effectId
    ) throw new Error(`runtime_result_invalid:${result.kind}`);
    return result;
  }

  async queryHumanSkillCommands(workspaceId: string): Promise<readonly HumanSkillCommand[]> {
    const result = await this.command({
      kind: 'skill.commands.query.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId
    });
    if (result.kind !== 'skill.commands.query_result.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.commands;
  }

  async loadHumanSkillCommand(
    workspaceId: string,
    name: string,
    revision: string
  ): Promise<LoadedHumanSkill> {
    const result = await this.command({
      kind: 'skill.command.load.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      name,
      revision
    });
    if (result.kind !== 'skill.command.loaded.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result;
  }

  async readHumanSkillResource(
    workspaceId: string,
    name: string,
    revision: string,
    relativePath: string
  ): Promise<HumanSkillResource> {
    const result = await this.command({
      kind: 'skill.command.resource.read.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      name,
      revision,
      relativePath
    });
    if (result.kind !== 'skill.command.resource.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result;
  }

  async queryProductivity(workspaceId: string, sessionId: string): Promise<ProductivitySnapshot> {
    const result = await this.command({
      kind: 'productivity.query.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId, sessionId
    });
    if (result.kind !== 'productivity.query_result.v3') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result;
  }

  async putGoal(input: {
    workspaceId: string; sessionId: string; goalId: string; expectedVersion: number | null;
    title: string; phase: string; status: ProductivityGoal['status']; roundCap: number;
  }): Promise<ProductivityGoal> {
    const result = await this.command({
      kind: 'goal.put.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, ...input
    });
    if (result.kind !== 'goal.updated.v3') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.goal;
  }

  async replaceTodos(input: {
    workspaceId: string; sessionId: string; goalId: string; expectedGoalVersion: number;
    expectedRevision: number | null;
    items: readonly { todoId: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }[];
  }): Promise<number> {
    const result = await this.command({
      kind: 'todo.snapshot.replace.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input, items: [...input.items]
    });
    if (result.kind !== 'todo.snapshot.replaced.v3') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.revision;
  }

  async startWorkflow(input: {
    workspaceId: string; sessionId: string; workflowId: string; goalId: string;
    expectedGoalVersion: number; expectedTodoRevision: number; todoIds: readonly string[];
    maxConcurrency: number; maxTransitions: number; deadlineAt: string;
  }): Promise<ProductivityWorkflow> {
    const result = await this.command({ kind: 'workflow.start.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, ...input, todoIds: [...input.todoIds] });
    if (result.kind !== 'workflow.updated.v3') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.workflow;
  }

  async advanceWorkflow(input: {
    workspaceId: string; sessionId: string; workflowId: string; expectedVersion: number;
    completed: readonly { todoId: string; outcome: 'completed' | 'failed'; summary: string }[];
  }): Promise<ProductivityWorkflow> {
    const result = await this.command({ kind: 'workflow.advance.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, ...input, completed: [...input.completed] });
    if (result.kind !== 'workflow.updated.v3') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.workflow;
  }

  async cancelWorkflow(input: {
    workspaceId: string; sessionId: string; workflowId: string; expectedVersion: number;
  }): Promise<ProductivityWorkflow> {
    const result = await this.command({ kind: 'workflow.cancel.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, ...input });
    if (result.kind !== 'workflow.updated.v3') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.workflow;
  }

  async querySchedules(workspaceId: string, sessionId: string): Promise<readonly ProductivitySchedule[]> {
    const result = await this.command({ kind: 'schedules.query.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId, sessionId });
    if (result.kind !== 'schedules.query_result.v3') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.schedules;
  }

  async createSchedule(input: {
    workspaceId: string; sessionId: string; scheduleId: string; prompt: string;
    timing: ProductivitySchedule['timing'];
  }): Promise<ProductivitySchedule> {
    const result = await this.command({ kind: 'schedule.create.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, ...input });
    if (result.kind !== 'schedule.updated.v3') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.schedule;
  }

  async transitionSchedule(input: {
    workspaceId: string; sessionId: string; scheduleId: string; expectedVersion: number;
    action: 'pause' | 'resume' | 'cancel';
  }): Promise<ProductivitySchedule> {
    const result = await this.command({ kind: 'schedule.transition.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, ...input });
    if (result.kind !== 'schedule.updated.v3') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.schedule;
  }

  isPlanModeEnabled(sessionId: string | null = this.ui.selectedSessionId): boolean {
    return this.ui.isPlanModeEnabled(sessionId);
  }

  setPlanModeEnabled(
    enabled: boolean,
    sessionId: string | null = this.ui.selectedSessionId
  ): void {
    this.ui.setPlanModeEnabled(enabled, sessionId);
    this.publish();
  }

  async sendMessage(
    message: string,
    options: SendMessageOptions = {}
  ): Promise<{ messageId: string; sessionId: string }> {
    const selectedSessionId = options.sessionId ?? this.ui.selectedSessionId ?? undefined;
    const selectedSession = this.projection.sessions.getSnapshot().find(
      (session) => session.sessionId === selectedSessionId && session.status === 'active'
    );
    const workspaceId = selectedSession?.workspaceId
      ?? options.workspaceId
      ?? PERSONAL_ASSISTANT_WORKSPACE_ID;
    const planMode = workspaceId !== PERSONAL_ASSISTANT_WORKSPACE_ID
      && this.ui.isPlanModeEnabled(selectedSessionId ?? null);
    if (planMode && !this.status.capabilities.includes('companion.agent-plan')) {
      throw new Error('runtime_capability_missing:companion.agent-plan');
    }
    const executionMode = workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID
      ? 'chat' as const
      : planMode
        ? 'plan' as const
        : 'agent' as const;
    const pending = this.ui.beginPendingChat(message, new Date().toISOString());
    this.publish();

    try {
      let sessionId = selectedSessionId;
      let expectedSessionVersion = selectedSession?.version;
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        const created = await this.command({
          kind: 'conversation.session.create.v3',
          contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
          sessionId,
          workspaceId
        });
        if (
          created.kind !== 'conversation.session.created.v3'
          || created.sessionId !== sessionId
        ) throw new Error(`runtime_result_invalid:${created.kind}`);
        expectedSessionVersion = created.version;
        if (planMode) this.ui.moveNewSessionPlanMode(sessionId);
        if (options.selectSession !== false) this.ui.selectSession(sessionId);
        this.ui.acceptPendingChat(pending.clientMessageId, sessionId);
        this.publish();
      }
      if (expectedSessionVersion === undefined) {
        throw new Error('conversation_session_projection_missing');
      }
      const result = await this.command({
        kind: 'conversation.message.accept.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId,
        workspaceId,
        expectedSessionVersion,
        messageId: pending.clientMessageId,
        content: message,
        ...(options.attachments === undefined
          ? {}
          : { attachments: options.attachments.map((attachment) => ({ ...attachment })) }),
        execution: {
          mode: executionMode,
          ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
          ...(options.inference === undefined ? {} : { inference: options.inference }),
          ...(options.routingStrategy === undefined
            ? {}
            : { routingStrategy: options.routingStrategy })
        }
      });
      if (
        result.kind !== 'conversation.message.accepted.v3'
        || result.sessionId !== sessionId
        || result.messageId !== pending.clientMessageId
      ) {
        throw new Error(`runtime_result_invalid:${result.kind}`);
      }
      this.ui.acceptPendingChat(pending.clientMessageId, result.sessionId);
      this.publish();
      void this.requestSynchronization(false);
      return { messageId: result.messageId, sessionId: result.sessionId };
    } catch (error) {
      this.ui.failPendingChat(pending.clientMessageId, runtimeRequestErrorMessage(error));
      this.publish();
      throw error;
    }
  }

  async cancelRun(run: Pick<RuntimeRun, 'runId' | 'origin'>): Promise<void> {
    if (run.origin !== 'projection') {
      throw new Error('projection_run_action_unavailable:origin');
    }
    const authoritative = this.projection.runs.getSnapshot().find(
      (candidate) => candidate.runId === run.runId
    );
    if (authoritative === undefined) {
      throw new Error('projection_run_action_unavailable:missing');
    }
    const result = await this.command({
      kind: 'agent.run.cancel.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: run.runId,
      expectedVersion: authoritative.version,
      occurredAt: new Date().toISOString(),
      reason: 'user_requested'
    });
    if (
      result.kind !== 'agent.run.cancelled.v3'
      || result.runId !== run.runId
    ) throw new Error(`runtime_result_invalid:${result.kind}`);
    void this.requestSynchronization(false);
  }

  async enqueueAgentInput(
    run: RuntimeRun,
    content: string,
    delivery: 'next_turn' | 'next_step'
  ): Promise<AgentInputDeliveryReceipt> {
    if (!this.status.capabilities.includes('agent.inbox')) {
      throw new Error('runtime_capability_missing:agent.inbox');
    }
    if (run.origin !== 'projection' || run.sessionId === undefined) {
      throw new Error('projection_run_action_unavailable:inbox');
    }
    const inputId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const command = {
      kind: 'agent.inbox.enqueue.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: run.runId,
      sessionId: run.sessionId,
      inputId,
      delivery,
      content
    } satisfies Extract<RuntimeCommand, { kind: 'agent.inbox.enqueue.v3' }>;
    if (!this.agentInputDeliveryPersistenceReady) {
      const receipt = this.agentInputDeliveries.begin(
        commandId,
        command,
        new Date().toISOString()
      );
      const failed = this.agentInputDeliveries.fail(
        commandId,
        this.agentInputDeliveryPersistenceError
          ?? '无法安全保存待发送输入，输入未发送。',
        new Date().toISOString()
      );
      this.publish();
      return { ...receipt, ...failed };
    }
    try {
      const staged = await this.agentInputDeliveryPersistence?.stage({ commandId, command });
      this.agentInputDeliveries.begin(
        commandId,
        command,
        staged?.createdAt ?? new Date().toISOString()
      );
    } catch (error) {
      this.agentInputDeliveries.begin(commandId, command, new Date().toISOString());
      const failed = this.agentInputDeliveries.fail(
        commandId,
        runtimeRequestErrorMessage(error, '无法安全保存待发送输入，输入未发送。'),
        new Date().toISOString()
      );
      this.publish();
      return failed;
    }
    this.publish();
    return this.dispatchAgentInputDelivery(commandId, false);
  }

  async reconcileAgentInputDelivery(commandId: string): Promise<AgentInputDeliveryReceipt> {
    this.agentInputDeliveries.beginReconciliation(commandId, new Date().toISOString());
    this.publish();
    return this.dispatchAgentInputDelivery(commandId, true);
  }

  dismissAgentInputDelivery(commandId: string): void {
    this.agentInputDeliveries.dismiss(commandId);
    this.publish();
  }

  async sendSubagentInput(
    parent: RuntimeRun,
    child: RuntimeRun,
    content: string
  ): Promise<string> {
    if (!this.status.capabilities.includes('agent.subagents')) {
      throw new Error('runtime_capability_missing:agent.subagents');
    }
    if (
      parent.origin !== 'projection'
      || child.origin !== 'projection'
      || parent.sessionId === undefined
      || child.sessionId !== parent.sessionId
      || child.parentRunId !== parent.runId
      || child.subagentMode !== 'continuable'
    ) {
      throw new Error('projection_run_action_unavailable:subagent');
    }
    const inputId = crypto.randomUUID();
    const result = await this.command({
      kind: 'agent.subagent.send.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      parentRunId: parent.runId,
      childRunId: child.runId,
      sessionId: parent.sessionId,
      inputId,
      content
    });
    if (
      result.kind !== 'agent.subagent.input.sent.v3'
      || result.parentRunId !== parent.runId
      || result.childRunId !== child.runId
      || result.inputId !== inputId
    ) throw new Error(`runtime_result_invalid:${result.kind}`);
    void this.requestSynchronization(false);
    return inputId;
  }

  async interruptSubagent(parent: RuntimeRun, child: RuntimeRun): Promise<void> {
    if (!this.status.capabilities.includes('agent.subagents')) {
      throw new Error('runtime_capability_missing:agent.subagents');
    }
    if (
      parent.origin !== 'projection'
      || child.origin !== 'projection'
      || parent.sessionId === undefined
      || child.sessionId !== parent.sessionId
      || child.parentRunId !== parent.runId
      || child.subagentMode !== 'continuable'
    ) throw new Error('projection_run_action_unavailable:subagent');
    const result = await this.command({
      kind: 'agent.subagent.interrupt.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      parentRunId: parent.runId,
      childRunId: child.runId,
      sessionId: parent.sessionId,
      expectedChildVersion: child.aggregateVersion,
      occurredAt: new Date().toISOString(),
      reason: 'user_requested'
    });
    if (
      result.kind !== 'agent.subagent.interrupted.v3'
      || result.parentRunId !== parent.runId
      || result.childRunId !== child.runId
    ) throw new Error(`runtime_result_invalid:${result.kind}`);
    void this.requestSynchronization(false);
  }

  async replaceAgentInput(
    run: RuntimeRun,
    inputId: string,
    expectedInputVersion: number,
    content: string
  ): Promise<void> {
    if (!this.status.capabilities.includes('agent.inbox')) {
      throw new Error('runtime_capability_missing:agent.inbox');
    }
    if (run.origin !== 'projection') {
      throw new Error('projection_run_action_unavailable:inbox');
    }
    const result = await this.command({
      kind: 'agent.inbox.replace.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: run.runId,
      inputId,
      expectedInputVersion,
      content
    });
    if (result.kind !== 'agent.inbox.replaced.v3' || result.inputId !== inputId) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    void this.requestSynchronization(false);
  }

  async removeAgentInput(
    run: RuntimeRun,
    inputId: string,
    expectedInputVersion: number
  ): Promise<void> {
    if (!this.status.capabilities.includes('agent.inbox')) {
      throw new Error('runtime_capability_missing:agent.inbox');
    }
    if (run.origin !== 'projection') {
      throw new Error('projection_run_action_unavailable:inbox');
    }
    const result = await this.command({
      kind: 'agent.inbox.remove.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: run.runId,
      inputId,
      expectedInputVersion
    });
    if (result.kind !== 'agent.inbox.removed.v3' || result.inputId !== inputId) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    void this.requestSynchronization(false);
  }

  async respondToPermission(
    request: RuntimePermissionDecision,
    choice: 'allow_once' | 'deny'
  ): Promise<void> {
    if (!request.actionAvailable) {
      throw new Error('projection_decision_action_unavailable:permission');
    }
    await this.resolveProjectedDecision({
      decisionId: request.requestId,
      runId: request.runId,
      expectedVersion: request.projectionVersion,
      kind: 'permission',
      choice
    });
  }

  async respondToPlan(
    handoff: RuntimePlanDecision,
    choice: 'approve' | 'reject'
  ): Promise<void> {
    if (!handoff.actionAvailable) {
      throw new Error('projection_decision_action_unavailable:plan');
    }
    await this.resolveProjectedDecision({
      decisionId: handoff.handoffId,
      runId: handoff.runId,
      expectedVersion: handoff.projectionVersion,
      kind: 'plan',
      choice
    });
  }

  async recoverRun(
    run: RuntimeRun,
    decision: 'resume' | 'cancel' | 'mark_failed'
  ): Promise<void> {
    if (run.origin !== 'projection') {
      throw new Error('projection_run_action_unavailable:recovery');
    }
    const recovery = this.projection.decisions.getSnapshot().find(
      (candidate) => candidate.runId === run.runId
        && candidate.kind === 'recovery'
        && candidate.status === 'pending'
    );
    if (recovery === undefined) {
      throw new Error('projection_run_action_unavailable:recovery');
    }
    await this.resolveProjectedDecision({
      decisionId: recovery.decisionId,
      runId: recovery.runId,
      expectedVersion: recovery.version,
      kind: 'recovery',
      choice: decision === 'resume'
        ? 'retry'
        : decision === 'cancel'
          ? 'cancel_run'
          : 'mark_failed'
    });
  }

  async resumeBudget(
    run: RuntimeRun,
    budget: NonNullable<RuntimeRun['suggestedBudget']> | undefined = run.suggestedBudget
  ): Promise<void> {
    void budget;
    if (run.origin !== 'projection') {
      throw new Error('projection_run_action_unavailable:budget_resume');
    }
    const budgetDecision = this.projection.decisions.getSnapshot().find(
      (candidate) => candidate.runId === run.runId
        && candidate.kind === 'budget'
        && candidate.status === 'pending'
    );
    if (budgetDecision === undefined) {
      throw new Error('projection_run_action_unavailable:budget_resume');
    }
    await this.resolveProjectedDecision({
      decisionId: budgetDecision.decisionId,
      runId: budgetDecision.runId,
      expectedVersion: budgetDecision.version,
      kind: 'budget',
      choice: 'resume'
    });
  }

  private async initializeRuntime(generation: number): Promise<void> {
    if (this.agentInputDeliveryPersistence !== undefined) {
      await this.restorePersistedAgentInputDeliveries(generation);
      if (generation !== this.lifecycleGeneration) return;
    }
    try {
      const status = unwrapPublicResult(await this.api.getStatus());
      if (generation !== this.lifecycleGeneration) return;
      this.initialized = true;
      this.lifecycleReady = true;
      this.acceptStatus(status);
      this.requestError = null;
      this.publish();
      if (this.status.availability === 'ready') {
        await this.requestSynchronization(true);
      }
    } catch (error) {
      if (generation !== this.lifecycleGeneration) return;
      this.initialized = true;
      this.lifecycleReady = true;
      this.setError(error);
    }
  }

  private receiveStatus(status: RuntimeStatus): void {
    if (!this.acceptStatus(status)) return;
    const wasReady = this.snapshot.status.availability === 'ready';
    this.publish();
    if (status.availability !== 'ready') {
      this.synchronizationGeneration += 1;
      this.snapshotRequired = true;
      this.synchronizationRequested = false;
      this.projection.clearForRuntimeReset();
      return;
    }
    if (!wasReady && this.lifecycleReady) void this.requestSynchronization(true);
  }

  private acceptStatus(status: RuntimeStatus): boolean {
    if (status.observedAt < this.status.observedAt) return false;
    this.status = status;
    return true;
  }

  private receiveWakeHint(envelope: RuntimeEventEnvelope): void {
    this.synchronizationRequested = true;
    if (this.lifecycleReady && this.status.availability === 'ready') {
      void this.requestSynchronization(false);
    }
  }

  private requestSynchronization(forceSnapshot: boolean): Promise<void> {
    if (forceSnapshot) {
      this.snapshotRequired = true;
      this.synchronizationGeneration += 1;
    }
    this.synchronizationRequested = true;
    if (this.synchronizationPromise === null) {
      const lifecycle = this.lifecycleGeneration;
      const operation = this.drainSynchronization(lifecycle)
        .catch((error) => {
          if (lifecycle !== this.lifecycleGeneration) return;
          if (error instanceof ProjectionProtocolIntegrityError) {
            this.projection.lockIntegrity(error.integrityCode);
            return;
          }
          this.setError(error);
        })
        .finally(() => {
          if (this.synchronizationPromise === operation) {
            this.synchronizationPromise = null;
          }
          if (
            this.synchronizationRequested
            && lifecycle === this.lifecycleGeneration
            && this.lifecycleReady
            && this.status.availability === 'ready'
          ) {
            queueMicrotask(() => void this.requestSynchronization(false));
          }
        });
      this.synchronizationPromise = operation;
    }
    return this.synchronizationPromise;
  }

  private async drainSynchronization(lifecycle: number): Promise<void> {
    while (
      this.synchronizationRequested
      && lifecycle === this.lifecycleGeneration
      && this.status.availability === 'ready'
    ) {
      this.synchronizationRequested = false;
      const synchronization = this.synchronizationGeneration;
      if (this.snapshotRequired) {
        const snapshot = await this.projectionClient.getSnapshot();
        if (!this.isCurrentSynchronization(lifecycle, synchronization)) continue;
        this.projection.replaceSnapshot(snapshot);
        this.snapshotRequired = false;
      }

      let hasMore = true;
      let batches = 0;
      while (hasMore && this.isCurrentSynchronization(lifecycle, synchronization)) {
        if (++batches > 10_000) throw new Error('projection_replay_batch_limit');
        const request = this.projection.createReadRequest();
        let batch: PublicProjectionReadBatchV3;
        try {
          batch = await this.projectionClient.readCommits(request);
        } catch (error) {
          if (error instanceof ProjectionReadResetSignal) {
            this.snapshotRequired = true;
            this.synchronizationGeneration += 1;
            this.synchronizationRequested = true;
            break;
          }
          throw error;
        }
        if (!this.isCurrentSynchronization(lifecycle, synchronization)) break;
        const application = await this.projection.applyBatch(batch);
        if (!this.isCurrentSynchronization(lifecycle, synchronization)) break;
        if (application.status === 'reset_required') {
          this.snapshotRequired = true;
          this.synchronizationGeneration += 1;
          this.synchronizationRequested = true;
          break;
        }
        hasMore = batch.status === 'ok' && batch.hasMore;
      }
      if (this.projection.getSnapshot().integrityError === null) {
        this.requestError = null;
        this.publish();
      }
    }
  }

  private isCurrentSynchronization(lifecycle: number, synchronization: number): boolean {
    return lifecycle === this.lifecycleGeneration
      && synchronization === this.synchronizationGeneration;
  }

  private async command(
    command: RuntimeCommand,
    commandId?: string
  ): Promise<RuntimeResult> {
    try {
      const result = await this.requestRuntime(command, commandId);
      this.requestError = null;
      this.publish();
      return result;
    } catch (error) {
      const safeError = sanitizeRuntimeCommandError(command, error);
      this.setError(safeError);
      throw safeError;
    }
  }

  private updateProjectionPolling(
    projection: ProjectionCacheSnapshot = this.projection.getSnapshot()
  ): void {
    if (
      !this.lifecycleReady
      || this.status.availability !== 'ready'
      || !projection.runs.some((run) => !isTerminalPublicRun(run))
    ) {
      this.stopProjectionPolling();
      return;
    }
    if (this.projectionPollTimer !== null) return;

    const lifecycle = this.lifecycleGeneration;
    const timer = setTimeout(() => {
      if (this.projectionPollTimer === timer) this.projectionPollTimer = null;
      if (
        lifecycle !== this.lifecycleGeneration
        || !this.lifecycleReady
        || this.status.availability !== 'ready'
      ) return;
      void this.requestSynchronization(false).finally(() => {
        if (lifecycle === this.lifecycleGeneration) this.updateProjectionPolling();
      });
    }, ACTIVE_PROJECTION_POLL_INTERVAL_MS);
    this.projectionPollTimer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private stopProjectionPolling(): void {
    if (this.projectionPollTimer === null) return;
    clearTimeout(this.projectionPollTimer);
    this.projectionPollTimer = null;
  }

  async answerUserQuestion(
    question: RuntimeUserQuestionDecision,
    answer: string
  ): Promise<void> {
    if (!question.actionAvailable) {
      throw new Error('projection_decision_action_unavailable:user_question');
    }
    await this.resolveProjectedDecision({
      decisionId: question.decisionId,
      runId: question.runId,
      expectedVersion: question.projectionVersion,
      kind: 'user_question',
      choice: 'answer',
      answer
    });
  }

  private async mutateSession(
    session: ConversationSession,
    mutation:
      | { readonly kind: 'conversation.session.rename.v3'; readonly title: string }
      | { readonly kind: 'conversation.session.archive.v3' }
      | { readonly kind: 'conversation.session.restore.v3' }
  ): Promise<void> {
    const authoritative = this.projection.sessions.getSnapshot().find(
      (candidate) => candidate.sessionId === session.sessionId
    );
    if (authoritative === undefined || authoritative.workspaceId !== session.workspaceId) {
      throw new Error('conversation_session_projection_missing');
    }
    const result = await this.command({
      ...mutation,
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: authoritative.sessionId,
      workspaceId: authoritative.workspaceId,
      expectedSessionVersion: authoritative.version
    });
    if (
      result.kind !== 'conversation.session.updated.v3'
      || result.sessionId !== authoritative.sessionId
      || result.version !== authoritative.version + 1
    ) throw new Error(`runtime_result_invalid:${result.kind}`);
    void this.requestSynchronization(false);
  }

  private async resolveProjectedDecision(input: {
    readonly decisionId: string;
    readonly runId: string | undefined;
    readonly expectedVersion: number;
    readonly kind: 'permission' | 'plan' | 'recovery' | 'budget' | 'user_question';
    readonly choice: PublicDecisionChoiceV3;
    readonly answer?: string;
  }): Promise<void> {
    const decision = this.projection.decisions.getSnapshot().find(
      (candidate) => candidate.decisionId === input.decisionId
    );
    if (!isExactActionableDecision(decision, input)) {
      throw new Error(`projection_decision_action_unavailable:${input.kind}`);
    }
    const result = await this.command({
      kind: 'agent.decision.resolve.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: decision.runId,
      decisionId: decision.decisionId,
      action: {
        contractVersion: PUBLIC_DECISION_ACTION_CONTRACT_VERSION,
        actionToken: decision.action.actionToken,
        choice: input.choice,
        ...(input.answer === undefined ? {} : { answer: input.answer })
      }
    });
    if (
      result.kind !== 'agent.decision.resolved.v3'
      || result.runId !== decision.runId
      || result.decisionId !== decision.decisionId
    ) {
      throw new Error('runtime_result_invalid:agent.decision.resolved.v3');
    }
    await this.awaitDecisionProjectionSettlement(decision.decisionId);
  }

  private async awaitDecisionProjectionSettlement(decisionId: string): Promise<void> {
    const settled = (): boolean => {
      const current = this.projection.decisions.getSnapshot().find(
        (candidate) => candidate.decisionId === decisionId
      );
      return current === undefined || current.status !== 'pending';
    };
    if (settled()) return;

    const retryDelaysMs = [0, 25, 50, 100, 200, 400, 800, 1_600, 2_000];
    for (const [index, delayMs] of retryDelaysMs.entries()) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      if (this.status.availability !== 'ready' || !this.lifecycleReady) continue;
      // A command response can win the race with its asynchronous Projection
      // drain, and wake hints are deliberately non-authoritative. Re-read the
      // durable snapshot until the exact Decision is no longer actionable.
      await this.requestSynchronization(index > 0);
      if (settled()) return;
    }
    throw new Error('projection_decision_settlement_timeout');
  }

  private async requestRuntime(
    command: RuntimeCommand,
    commandId: string = crypto.randomUUID()
  ): Promise<RuntimeResult> {
    return unwrapPublicResult(await this.api.request(command, { commandId }));
  }

  private setError(error: unknown): void {
    const integrity = this.projection.getSnapshot().integrityError;
    if (integrity !== null) this.requestError = integrity;
    else this.requestError = runtimeRequestErrorMessage(error);
    this.publish();
  }

  private publish(projection = this.projection.getSnapshot()): void {
    this.snapshot = this.createSnapshot(projection);
    for (const listener of this.listeners) listener();
  }

  private createSnapshot(projection: ProjectionCacheSnapshot): RuntimeSnapshot {
    const authoritativeMessages = projection.messages.map(presentMessage);
    const terminalAssistantRunIds = new Set(authoritativeMessages
      .filter((message) => message.role === 'assistant' && message.status === 'completed')
      .flatMap((message) => message.runId === undefined ? [] : [message.runId]));
    const inferenceMessages = projection.inferenceStreams.flatMap((stream) => {
      if (terminalAssistantRunIds.has(stream.runId)) return [];
      const message = presentInferenceStreamMessage(
        stream,
        projection.runs.find((run) => run.runId === stream.runId)
      );
      return message === null ? [] : [message];
    });
    const messages = this.ui.projectedMessages(
      mergeInteractionMessages(
        [...authoritativeMessages, ...inferenceMessages],
        projection.runs
      ),
      projection.runs
    );
    const pendingOverlayId = this.ui.pendingChatOverlayId;
    return {
      initialized: this.initialized,
      status: this.status,
      projectionStreamId: projection.streamId,
      projectionCursor: projection.cursor,
      projectionIntegrityError: projection.integrityError,
      sessions: projection.sessions.map(presentSession),
      selectedSessionId: this.ui.selectedSessionId,
      planModeSessionIds: [...this.ui.planModeSessionIds].sort(compareCodeUnits),
      pendingOverlayIds: pendingOverlayId === null
        ? []
        : [pendingOverlayId],
      messages,
      models: projection.models.map(presentModel),
      runs: projection.runs.map(presentRun),
      activities: projection.runs.flatMap(presentRunActivities),
      permissions: projection.decisions.flatMap((decision) => {
        const request = presentPermissionDecision(decision);
        return request === null ? [] : [request];
      }),
      planHandoffs: projection.decisions.flatMap((decision) => {
        const handoff = presentPlanDecision(decision);
        return handoff === null ? [] : [handoff];
      }),
      userQuestions: projection.decisions.flatMap((decision) => {
        const question = presentUserQuestionDecision(decision);
        return question === null ? [] : [question];
      }),
      trace: projection.diagnostics.map(presentDiagnostic),
      agentInputDeliveries: this.agentInputDeliveries.snapshot(),
      lastError: projection.integrityError
        ?? this.agentInputDeliveryPersistenceError
        ?? this.requestError
    };
  }

  private async dispatchAgentInputDelivery(
    commandId: string,
    reconciliationAttempt: boolean
  ): Promise<AgentInputDeliveryReceipt> {
    const command = this.agentInputDeliveries.command(commandId);
    try {
      const result = await this.command(command, commandId);
      if (
        result.kind !== 'agent.inbox.enqueued.v3'
        || result.runId !== command.runId
        || result.inputId !== command.inputId
      ) throw new Error(`runtime_result_invalid:${result.kind}`);
      const receipt = this.agentInputDeliveries.accept(
        commandId,
        new Date().toISOString()
      );
      this.publish();
      void this.settlePersistedAgentInputDelivery(commandId);
      void this.requestSynchronization(false);
      return receipt;
    } catch (error) {
      const message = runtimeRequestErrorMessage(error, 'Agent 输入提交失败。');
      const shouldReconcile = shouldReconcileAgentInputDelivery(
        error,
        commandId,
        reconciliationAttempt
      );
      const persistenceSettled = shouldReconcile
        ? false
        : await this.settlePersistedAgentInputDelivery(commandId);
      const receipt = shouldReconcile || !persistenceSettled
        ? this.agentInputDeliveries.requireReconciliation(
            commandId,
            persistenceSettled
              ? message
              : `${message} 本地发送记录尚未安全结算，请重新确认。`,
            new Date().toISOString()
          )
        : this.agentInputDeliveries.fail(
            commandId,
            message,
            new Date().toISOString()
          );
      this.publish();
      return receipt;
    }
  }

  private async restorePersistedAgentInputDeliveries(generation: number): Promise<void> {
    if (this.agentInputDeliveryPersistence === undefined) return;
    try {
      const records = await this.agentInputDeliveryPersistence.list();
      if (generation !== this.lifecycleGeneration) return;
      const now = new Date().toISOString();
      for (const record of records) {
        this.agentInputDeliveries.restore(
          record.commandId,
          record.command,
          record.createdAt,
          now
        );
      }
      this.agentInputDeliveryPersistenceReady = true;
      this.agentInputDeliveryPersistenceError = null;
      this.publish();
    } catch (error) {
      if (generation !== this.lifecycleGeneration) return;
      this.agentInputDeliveryPersistenceReady = false;
      this.agentInputDeliveryPersistenceError = runtimeRequestErrorMessage(
        error,
        '未结算输入的安全恢复记录不可用。'
      );
      this.publish();
    }
  }

  private async settlePersistedAgentInputDelivery(commandId: string): Promise<boolean> {
    if (this.agentInputDeliveryPersistence === undefined) return true;
    try {
      await this.agentInputDeliveryPersistence.settle({ commandId });
      this.agentInputDeliveryPersistenceError = null;
      return true;
    } catch (error) {
      this.agentInputDeliveryPersistenceError = runtimeRequestErrorMessage(
        error,
        '未结算输入的安全恢复记录无法更新。'
      );
      this.publish();
      return false;
    }
  }
}

function mergeInteractionMessages(
  authoritative: readonly RuntimeMessage[],
  runs: readonly PublicRunProjectionV3[]
): RuntimeMessage[] {
  const messages = [...authoritative];
  const identities = new Set(messages.map((message) => message.messageId));
  for (const run of runs) {
    for (const interaction of run.interactionMessages) {
      if (identities.has(interaction.messageId)) continue;
      identities.add(interaction.messageId);
      messages.push(presentMessage(interaction));
    }
  }
  return messages.sort((left, right) => {
    const time = left.createdAt.localeCompare(right.createdAt);
    if (time !== 0) return time;
    const role = interactionRoleOrder(left.role) - interactionRoleOrder(right.role);
    return role !== 0 ? role : left.messageId.localeCompare(right.messageId);
  });
}

function interactionRoleOrder(role: RuntimeMessage['role']): number {
  return role === 'assistant' ? 0 : role === 'user' ? 1 : 2;
}

export function runtimeRequestErrorMessage(
  error: unknown,
  fallback = 'Runtime 请求失败。'
): string {
  const source = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const message = source
    .replace(/^Error invoking remote method '[^']+':\s*/iu, '')
    .replace(/^(?:(?:RuntimeRequestError|Error):\s*)+/iu, '')
    .replace(/decision-action\.v1:[0-9a-f]{64}/giu, '[redacted-decision-action]')
    .trim();
  return (message || fallback).slice(0, 16_384);
}

export function useRuntimeSnapshot(store: RuntimeStore): RuntimeSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isExactActionableDecision(
  decision: PublicDecisionProjectionV3 | undefined,
  expected: {
    readonly decisionId: string;
    readonly runId: string | undefined;
    readonly expectedVersion: number;
    readonly kind: 'permission' | 'plan' | 'recovery' | 'budget' | 'user_question';
    readonly choice: PublicDecisionChoiceV3;
  }
): decision is PublicDecisionProjectionV3 & {
  readonly action: NonNullable<PublicDecisionProjectionV3['action']>;
} {
  if (
    decision === undefined
    || expected.runId === undefined
    || decision.decisionId !== expected.decisionId
    || decision.runId !== expected.runId
    || decision.version !== expected.expectedVersion
    || decision.kind !== expected.kind
    || decision.presentation.kind !== expected.kind
    || decision.status !== 'pending'
    || decision.action === undefined
    || decision.action.contractVersion !== PUBLIC_DECISION_ACTION_CONTRACT_VERSION
  ) return false;
  const expectedChoices: readonly PublicDecisionChoiceV3[] = expected.kind === 'permission'
    ? ['allow_once', 'allow_run', 'deny']
    : expected.kind === 'plan'
      ? ['approve', 'reject']
      : expected.kind === 'recovery'
        ? ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
        : expected.kind === 'budget'
          ? ['resume', 'cancel_run']
          : ['answer'];
  return decision.action.choices.length === expectedChoices.length
    && decision.action.choices.every(
      (choice, index) => choice === expectedChoices[index]
    )
    && decision.action.choices.includes(expected.choice);
}

function sanitizeRuntimeCommandError(
  command: RuntimeCommand,
  error: unknown
): unknown {
  if (command.kind !== 'agent.decision.resolve.v3') return error;
  return new Error(runtimeRequestErrorMessage(error));
}

function isTerminalPublicRun(run: PublicRunProjectionV3): boolean {
  return run.status === 'completed'
    || run.status === 'failed'
    || run.status === 'cancelled';
}

const RECONCILABLE_AGENT_INPUT_ERROR_CODES = new Set([
  'command_outcome_uncertain',
  'runtime_request_timeout',
  'runtime_request_cancelled',
  'runtime_request_send_failed'
]);

const DEFERRED_RECONCILIATION_ERROR_CODES = new Set([
  'runtime_unavailable',
  'runtime_initializing',
  'runtime_shutting_down',
  'runtime_stopped',
  'runtime_exited'
]);

function shouldReconcileAgentInputDelivery(
  error: unknown,
  commandId: string,
  reconciliationAttempt: boolean
): boolean {
  if (!(error instanceof PublicResultError)) return false;
  const { code, correlationId } = error.publicError;
  if (
    correlationId === commandId
    && RECONCILABLE_AGENT_INPUT_ERROR_CODES.has(code)
  ) return true;
  return reconciliationAttempt && DEFERRED_RECONCILIATION_ERROR_CODES.has(code);
}
