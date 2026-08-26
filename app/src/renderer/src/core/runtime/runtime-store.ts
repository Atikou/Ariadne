import { useSyncExternalStore } from 'react';

import {
  PUBLIC_DECISION_ACTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_CONTRACT_VERSION
} from '@ariadne/protocol/public';
import type {
  ChatRoutingStrategy,
  ConversationSession,
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
  presentDiagnostic,
  presentMessage,
  presentModel,
  presentPermissionDecision,
  presentPlanDecision,
  presentRun,
  presentRunActivities,
  presentSession,
  type RuntimeMessage,
  type RuntimePermissionDecision,
  type RuntimePlanDecision,
  type RuntimeRun
} from './runtime-projection-presenter';
import { RuntimeUiState } from './runtime-ui-state';

export type {
  RuntimeMessage,
  RuntimePermissionDecision,
  RuntimePlanDecision,
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
  trace: TraceEntry[];
  lastError: string | null;
}

export interface SendMessageOptions {
  modelId?: string;
  inference?: ModelInferenceOptions;
  routingStrategy?: ChatRoutingStrategy;
  workspaceId?: string;
}

const STOPPED_STATUS: RuntimeStatus = {
  availability: 'stopped',
  capabilities: [],
  observedAt: new Date(0).toISOString()
};

/**
 * Renderer composition store. The six authoritative domain collections are
 * always rebuilt from ProjectionCache; this class owns only lifecycle, command
 * routing and local UI overlays.
 */
export class RuntimeStore {
  private readonly projectionClient: ProjectionRuntimeClient;
  private readonly projection = new ProjectionCache();
  private readonly ui = new RuntimeUiState();
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

  constructor(private readonly api: AriadneApi['runtime']) {
    this.projectionClient = new ProjectionRuntimeClient(api);
    this.snapshot = this.createSnapshot(this.projection.getSnapshot());
    this.removeProjectionListener = this.projection.subscribe(() => {
      const projection = this.projection.getSnapshot();
      if (projection.resetEpoch !== this.lastProjectionResetEpoch) {
        this.lastProjectionResetEpoch = projection.resetEpoch;
        this.ui.clearPendingOverlay();
      }
      this.publish(projection);
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
    const selectedSessionId = this.ui.selectedSessionId ?? undefined;
    const planMode = this.ui.isPlanModeEnabled(selectedSessionId ?? null);
    if (planMode && !this.status.capabilities.includes('companion.agent-plan')) {
      throw new Error('runtime_capability_missing:companion.agent-plan');
    }
    const selectedSession = this.projection.sessions.getSnapshot().find(
      (session) => session.sessionId === selectedSessionId && session.status === 'active'
    );
    const workspaceId = selectedSession?.workspaceId ?? options.workspaceId;
    if (!workspaceId) throw new Error('conversation_workspace_required');
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
        this.ui.selectSession(sessionId);
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
        execution: {
          mode: planMode ? 'plan' : 'agent',
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
  ): Promise<string> {
    if (!this.status.capabilities.includes('agent.inbox')) {
      throw new Error('runtime_capability_missing:agent.inbox');
    }
    if (run.origin !== 'projection' || run.sessionId === undefined) {
      throw new Error('projection_run_action_unavailable:inbox');
    }
    const inputId = crypto.randomUUID();
    const result = await this.command({
      kind: 'agent.inbox.enqueue.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: run.runId,
      sessionId: run.sessionId,
      inputId,
      delivery,
      content
    });
    if (
      result.kind !== 'agent.inbox.enqueued.v3'
      || result.runId !== run.runId
      || result.inputId !== inputId
    ) throw new Error(`runtime_result_invalid:${result.kind}`);
    void this.requestSynchronization(false);
    return inputId;
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

  private async command(command: RuntimeCommand): Promise<RuntimeResult> {
    try {
      const result = await this.requestRuntime(command);
      this.requestError = null;
      this.publish();
      return result;
    } catch (error) {
      const safeError = sanitizeRuntimeCommandError(command, error);
      this.setError(safeError);
      throw safeError;
    }
  }

  private async resolveProjectedDecision(input: {
    readonly decisionId: string;
    readonly runId: string | undefined;
    readonly expectedVersion: number;
    readonly kind: 'permission' | 'plan' | 'recovery' | 'budget';
    readonly choice: PublicDecisionChoiceV3;
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
        choice: input.choice
      }
    });
    if (
      result.kind !== 'agent.decision.resolved.v3'
      || result.runId !== decision.runId
      || result.decisionId !== decision.decisionId
    ) {
      throw new Error('runtime_result_invalid:agent.decision.resolved.v3');
    }
    void this.requestSynchronization(false);
  }

  private async requestRuntime(
    command: RuntimeCommand,
    commandId = crypto.randomUUID()
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
    const messages = this.ui.projectedMessages(
      mergeInteractionMessages(authoritativeMessages, projection.runs),
      projection.runs
    );
    const pendingOverlayId = this.ui.pendingChatOverlayId;
    return {
      initialized: this.initialized,
      status: this.status,
      projectionStreamId: projection.streamId,
      projectionCursor: projection.cursor,
      projectionIntegrityError: projection.integrityError,
      sessions: projection.sessions
        .filter((session) => session.status === 'active')
        .map(presentSession),
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
      trace: projection.diagnostics.map(presentDiagnostic),
      lastError: projection.integrityError ?? this.requestError
    };
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
    readonly kind: 'permission' | 'plan' | 'recovery' | 'budget';
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
        : ['resume', 'cancel_run'];
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
