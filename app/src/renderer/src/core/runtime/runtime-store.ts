import {
  PUBLIC_PROJECTION_CONTRACT_VERSION
} from '@ariadne/protocol/public';
import type {
  ConversationSession,
  ModelSummary,
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
import type { AgentInputDeliveryReceipt } from './agent-input-delivery';
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
import { ProductivityFeatureStore } from './features/productivity-feature-store';
import { ToolResultFeatureStore } from './features/tool-result-feature-store';
import { HumanSkillFeatureStore } from './features/human-skill-feature-store';
import { SessionFeatureStore } from './features/session-feature-store';
import { DecisionFeatureStore } from './features/decision-feature-store';
import { MessageFeatureStore } from './features/message-feature-store';
import { RunFeatureStore } from './features/run-feature-store';
import { FeatureSnapshotStore } from './features/feature-snapshot-store';
import { ModelFeatureStore } from './features/model-feature-store';
import { DiagnosticsFeatureStore } from './features/diagnostics-feature-store';

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
  readonly decisions: DecisionFeatureStore;
  readonly diagnostics: DiagnosticsFeatureStore;
  readonly humanSkills: HumanSkillFeatureStore;
  readonly messages: MessageFeatureStore;
  readonly models: ModelFeatureStore;
  readonly productivity: ProductivityFeatureStore;
  readonly runs: RunFeatureStore;
  readonly sessions: SessionFeatureStore;
  readonly toolResults: ToolResultFeatureStore;
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
  private projectionPollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: AriadneApi['runtime'],
    agentInputDeliveryPersistence?: AriadneApi['agentInputDeliveryOutbox']
  ) {
    const snapshotSource = { getSnapshot: this.getSnapshot, subscribe: this.subscribe };
    const featureView = <T>(select: (snapshot: RuntimeSnapshot) => T) =>
      new FeatureSnapshotStore(snapshotSource, select);
    const featureGateway = {
      execute: (command: RuntimeCommand, commandId?: string) => this.command(command, commandId)
    };
    this.decisions = new DecisionFeatureStore(featureGateway, {
      projectionDecisions: () => this.projection.decisions.getSnapshot(),
      awaitDecisionSettlement: (decisionId) => this.awaitDecisionProjectionSettlement(decisionId)
    }, featureView((snapshot) => ({
      permissions: snapshot.permissions,
      planHandoffs: snapshot.planHandoffs,
      userQuestions: snapshot.userQuestions
    })));
    this.diagnostics = new DiagnosticsFeatureStore(featureView((snapshot) => ({
      initialized: snapshot.initialized,
      status: snapshot.status,
      projectionStreamId: snapshot.projectionStreamId,
      projectionCursor: snapshot.projectionCursor,
      projectionIntegrityError: snapshot.projectionIntegrityError,
      trace: snapshot.trace,
      lastError: snapshot.lastError
    })), () => this.refresh());
    this.humanSkills = new HumanSkillFeatureStore(featureGateway);
    this.messages = new MessageFeatureStore(featureGateway, {
      selectedSessionId: () => this.ui.selectedSessionId,
      projectionSessions: () => this.projection.sessions.getSnapshot(),
      hasCapability: (capability) => this.status.capabilities.includes(capability),
      isPlanModeEnabled: (sessionId) => this.ui.isPlanModeEnabled(sessionId),
      beginPendingChat: (message, now) => this.ui.beginPendingChat(message, now),
      moveNewSessionPlanMode: (sessionId) => this.ui.moveNewSessionPlanMode(sessionId),
      selectSession: (sessionId) => this.ui.selectSession(sessionId),
      acceptPendingChat: (messageId, sessionId) => this.ui.acceptPendingChat(messageId, sessionId),
      failPendingChat: (messageId, message) => this.ui.failPendingChat(messageId, message),
      errorMessage: (error) => runtimeRequestErrorMessage(error),
      publish: () => this.publish(),
      synchronize: () => this.requestSynchronization(false)
    }, featureView((snapshot) => ({
      messages: snapshot.messages,
      pendingOverlayIds: snapshot.pendingOverlayIds
    })));
    this.models = new ModelFeatureStore(featureView((snapshot) => ({ models: snapshot.models })));
    this.productivity = new ProductivityFeatureStore(featureGateway);
    this.runs = new RunFeatureStore(featureGateway, {
      hasCapability: (capability) => this.status.capabilities.includes(capability),
      projectionRuns: () => this.projection.runs.getSnapshot(),
      isLifecycleGenerationCurrent: (generation) => generation === this.lifecycleGeneration,
      errorMessage: (error, fallback) => runtimeRequestErrorMessage(error, fallback),
      publish: () => this.publish(),
      synchronize: () => this.requestSynchronization(false)
    }, featureView((snapshot) => ({
      runs: snapshot.runs,
      activities: snapshot.activities,
      agentInputDeliveries: snapshot.agentInputDeliveries
    })), agentInputDeliveryPersistence);
    this.sessions = new SessionFeatureStore(featureGateway, {
      projectionSessions: () => this.projection.sessions.getSnapshot(),
      selectSession: (sessionId) => this.ui.selectSession(sessionId),
      clearSessionSelection: () => this.ui.clearSessionSelection(),
      isPlanModeEnabled: (sessionId) => this.ui.isPlanModeEnabled(sessionId),
      setPlanModeEnabled: (enabled, sessionId) => this.ui.setPlanModeEnabled(enabled, sessionId),
      publish: () => this.publish(),
      synchronize: () => this.requestSynchronization(false)
    }, featureView((snapshot) => ({
      sessions: snapshot.sessions,
      selectedSessionId: snapshot.selectedSessionId,
      planModeSessionIds: snapshot.planModeSessionIds
    })));
    this.toolResults = new ToolResultFeatureStore(featureGateway);
    this.projectionClient = new ProjectionRuntimeClient(api);
    this.snapshot = this.createSnapshot(this.projection.getSnapshot());
    this.removeProjectionListener = this.projection.subscribe(() => {
      const projection = this.projection.getSnapshot();
      if (projection.resetEpoch !== this.lastProjectionResetEpoch) {
        this.lastProjectionResetEpoch = projection.resetEpoch;
        this.ui.clearPendingOverlay();
      }
      this.runs.observeProjection();
      this.publish(projection);
      this.updateProjectionPolling(projection);
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

  private async initializeRuntime(generation: number): Promise<void> {
    if (this.runs.deliveryPersistenceConfigured) {
      await this.runs.restoreDeliveryPersistence(generation);
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
      agentInputDeliveries: this.runs.deliverySnapshot(),
      lastError: projection.integrityError
        ?? this.runs.deliveryPersistenceError
        ?? this.requestError
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
