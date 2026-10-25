import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import type {
  ConversationSession,
  ModelSummary,
  RunActivity,
  PublicRunCatalogSummary,
  PublicDecisionCatalogSummary,
  PublicProjectionMessageWindow,
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResult,
  RuntimeStatus,
  TraceEntry,
} from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import {
  RendererProjectionRepository,
  SESSION_DIRECTORY, RUN_DIRECTORY, DECISION_DIRECTORY,
  type RendererProjectionSnapshot
} from './projection/renderer-projection-repository';
import type { ProjectionCatalogWindow } from './projection/projection-catalog-repository';
import {
  ProjectionProtocolIntegrityError,
  ProjectionCatalogResetSignal,
  ProjectionSnapshotResetSignal,
  ProjectionScopedReadResetSignal,
  ProjectionRuntimeClient
} from './projection/projection-runtime-client';
import { PublicResultError, unwrapPublicResult } from './public-result';
import type { AgentInputDeliveryReceipt } from './agent-input-delivery';
import {
  mergeInferenceStreamReasoning,
  type RuntimeMessage,
  type RuntimePermissionDecision,
  type RuntimePlanDecision,
  type RuntimeUserQuestionDecision,
  type RuntimeRun
} from './runtime-projection-presenter';
import { RuntimeUiState } from './runtime-ui-state';
import { ProjectionBodyReadQueue } from './projection/projection-body-read-queue';
import { RuntimeProjectionViews, isTerminalRunSummary } from './runtime-projection-views';
import { LiveSnapshotPublisher } from './live-snapshot-publisher';
import { LiveInferenceStreamStore } from './live-inference-stream-store';
import { presentInferenceMessages, reconcileLiveInferenceStreams } from './live-inference-message-projection';
import { ProductivityFeatureStore } from './features/productivity-feature-store';
import { TaskCenterFeatureStore } from './features/task-center-feature-store';
import { LongMemoryFeatureStore } from './features/long-memory-feature-store';
import { WorkspaceDocumentFeatureStore } from './features/workspace-document-feature-store';
import { ToolResultFeatureStore } from './features/tool-result-feature-store';
import { HumanSkillFeatureStore } from './features/human-skill-feature-store';
import { SessionFeatureStore } from './features/session-feature-store';
import { DecisionFeatureStore } from './features/decision-feature-store';
import { MessageFeatureStore } from './features/message-feature-store';
import { RunFeatureStore } from './features/run-feature-store';
import { FeatureSnapshotStore } from './features/feature-snapshot-store';
import { ModelFeatureStore } from './features/model-feature-store';
import { DiagnosticsFeatureStore } from './features/diagnostics-feature-store';
import { runtimeRequestErrorMessage, sanitizeRuntimeCommandError } from './runtime-request-errors';
export { runtimeRequestErrorMessage } from './runtime-request-errors';

export type { AgentInputDeliveryReceipt } from './agent-input-delivery';
export type {
  RuntimeMessage,
  RuntimePermissionDecision,
  RuntimePlanDecision,
  RuntimeUserQuestionDecision,
  RuntimeRun
} from './runtime-projection-presenter';
export { PublicResultError, unwrapPublicResult } from './public-result';

export type { RuntimeSnapshot } from './runtime-snapshot';
import { STOPPED_STATUS, type RuntimeSnapshot } from './runtime-snapshot';

const ACTIVE_PROJECTION_POLL_INTERVAL_MS = 500;

/**
 * Renderer composition store. The six authoritative domain collections are
 * derived from bounded independent read ranges; this class owns lifecycle, command
 * routing and local UI overlays.
 */
export class RuntimeStore {
  private readonly bodyReads = new ProjectionBodyReadQueue();
  readonly decisions: DecisionFeatureStore;
  readonly diagnostics: DiagnosticsFeatureStore;
  readonly humanSkills: HumanSkillFeatureStore;
  readonly messages: MessageFeatureStore;
  readonly models: ModelFeatureStore;
  readonly productivity: ProductivityFeatureStore;
  readonly tasks: TaskCenterFeatureStore;
  readonly memory: LongMemoryFeatureStore;
  readonly documents: WorkspaceDocumentFeatureStore;
  readonly runs: RunFeatureStore;
  readonly sessions: SessionFeatureStore;
  readonly toolResults: ToolResultFeatureStore;
  private readonly projectionClient: ProjectionRuntimeClient;
  private readonly projection: RendererProjectionRepository;
  private readonly ui = new RuntimeUiState();
  private readonly views = new RuntimeProjectionViews();
  private readonly livePublisher = new LiveSnapshotPublisher(() => this.publish());
  private readonly liveInferenceStreams = new LiveInferenceStreamStore();
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
    agentInputDeliveryPersistence?: AriadneApi['inputDeliveryOutbox']
  ) {
    this.projectionClient = new ProjectionRuntimeClient(api);
    this.projection = new RendererProjectionRepository(this.projectionClient);
    const snapshotSource = { getSnapshot: this.getSnapshot, subscribe: this.subscribe };
    const featureView = <T>(select: (snapshot: RuntimeSnapshot) => T) =>
      new FeatureSnapshotStore(snapshotSource, select);
    const featureGateway = {
      execute: (command: RuntimeCommand, commandId?: string) => this.command(command, commandId)
    };
    this.decisions = new DecisionFeatureStore(featureGateway, {
      projectionDecisions: () => this.projection.getSnapshot().decisions,
      awaitDecisionSettlement: (decisionId) => this.awaitDecisionProjectionSettlement(decisionId)
    }, featureView((snapshot) => ({
      permissions: snapshot.permissions,
      openedDecisionId: snapshot.openedDecisionId,
      planHandoffs: snapshot.planHandoffs,
      userQuestions: snapshot.userQuestions,
      decisionSummaries: snapshot.decisionSummaries,
      decisionDirectory: snapshot.projectionWindows.decisions,
      sessionDecisionDirectory: snapshot.projectionWindows.sessionDecisions
    })), { openDetail: id => this.openDecisionDetail(id), navigate: direction => this.navigateProjectionCatalog('decisions', direction),
      navigateSession: direction => this.projection.navigateSession('decisions', direction) });
    this.diagnostics = new DiagnosticsFeatureStore(featureView((snapshot) => ({
      initialized: snapshot.initialized,
      status: snapshot.status,
      projectionStreamId: snapshot.projectionStreamId,
      projectionCursor: snapshot.projectionCursor,
      projectionIntegrityError: snapshot.projectionIntegrityError,
      trace: snapshot.trace,
      lastError: snapshot.lastError
    })), () => this.refresh(), (command, options) => this.api.request(command, options));
    this.humanSkills = new HumanSkillFeatureStore(featureGateway);
    this.messages = new MessageFeatureStore(featureGateway, {
      selectedSessionId: () => this.ui.selectedSessionId,
      projectionSessions: () => this.projection.getSnapshot().sessions,
      resolveSendSession: sessionId => this.projection.readSessionProof(sessionId),
      hasCapability: (capability) => this.status.capabilities.includes(capability),
      isPlanModeEnabled: (sessionId) => this.ui.isPlanModeEnabled(sessionId),
      beginPendingChat: (message, now, messageId, sessionId, draftOwnerKey) => this.ui.beginPendingChat(message, now, messageId, sessionId, draftOwnerKey),
      selectDraftOwner: key => this.ui.selectDraftOwner(key),
      moveNewSessionPlanMode: (sessionId) => this.ui.moveNewSessionPlanMode(sessionId),
      selectSession: (sessionId) => this.selectSession(sessionId),
      acceptPendingChat: (messageId, sessionId) => {
        const previousSessionId = this.ui.selectedSessionId;
        this.ui.acceptPendingChat(messageId, sessionId);
        if (this.ui.selectedSessionId !== previousSessionId) this.liveInferenceStreams.clear();
        this.projection.selectSession(this.ui.selectedSessionId);
      },
      failPendingChat: (messageId, message) => this.ui.failPendingChat(messageId, message),
      errorMessage: (error) => runtimeRequestErrorMessage(error),
      publish: () => this.publish(),
      synchronize: () => this.requestSynchronization(false)
    }, featureView((snapshot) => ({
      messages: snapshot.messages,
      pendingOverlayIds: snapshot.pendingOverlayIds,
      messageWindow: snapshot.projectionWindows.messages
    })), window => this.showMessageWindow(window), (id, sessionId, digest) => this.bodyReads.read(JSON.stringify(['message', id, sessionId, digest]),
      () => this.projection.loadMessageBody(id, sessionId, digest)), agentInputDeliveryPersistence);
    this.models = new ModelFeatureStore(
      featureView((snapshot) => ({ models: snapshot.models, modelsReadReady: snapshot.projectionStreamId !== null })),
      featureGateway,
      () => this.requestSynchronization(false)
    );
    this.productivity = new ProductivityFeatureStore(featureGateway);
    this.tasks = new TaskCenterFeatureStore(featureGateway);
    this.memory = new LongMemoryFeatureStore(featureGateway);
    this.documents = new WorkspaceDocumentFeatureStore(featureGateway);
    this.runs = new RunFeatureStore(featureGateway, {
      hasCapability: (capability) => this.status.capabilities.includes(capability),
      projectionRuns: () => this.projection.getSnapshot().runs,
      isLifecycleGenerationCurrent: (generation) => generation === this.lifecycleGeneration,
      errorMessage: (error, fallback) => runtimeRequestErrorMessage(error, fallback),
      publish: () => this.publish(),
      synchronize: () => this.requestSynchronization(false)
    }, featureView((snapshot) => ({
      runs: snapshot.runs,
      activities: snapshot.activities,
      agentInputDeliveries: snapshot.agentInputDeliveries,
      runSummaries: snapshot.runSummaries,
      openedRunId: snapshot.openedRunId,
      runDirectory: snapshot.projectionWindows.runs,
      sessionRunDirectory: snapshot.projectionWindows.sessionRuns
    })), agentInputDeliveryPersistence, { openDetail: id => this.openRunDetail(id), navigate: direction => this.navigateProjectionCatalog('runs', direction),
      navigateSession: direction => this.projection.navigateSession('runs', direction),
      readCollection: (id, sessionId, token, collection, direction) => this.projection.readRunCollection(id, sessionId, token, collection, direction),
      readInboxBody: (id, sessionId, inputId, token) => this.bodyReads.read(JSON.stringify(['inbox', id, sessionId, inputId, token]),
        () => this.projection.loadInboxBody(id, sessionId, inputId, token)) });
    this.sessions = new SessionFeatureStore(featureGateway, {
      projectionSessions: () => this.projection.getSnapshot().sessions,
      resolveSession: sessionId => this.projection.readSessionProof(sessionId),
      selectSession: (sessionId) => this.selectSession(sessionId),
      clearSessionSelection: () => {
        this.ui.clearSessionSelection(); this.liveInferenceStreams.clear(); this.projection.selectSession(null);
        this.synchronizationGeneration += 1;
      },
      isPlanModeEnabled: (sessionId) => this.ui.isPlanModeEnabled(sessionId),
      setPlanModeEnabled: (enabled, sessionId) => this.ui.setPlanModeEnabled(enabled, sessionId),
      publish: () => this.publish(),
      synchronize: () => this.requestSynchronization(false)
    }, featureView((snapshot) => ({
      sessions: snapshot.sessions,
      selectedSessionId: snapshot.selectedSessionId,
      planModeSessionIds: snapshot.planModeSessionIds,
      sessionDirectory: snapshot.projectionWindows.sessions
    })), direction => this.navigateProjectionCatalog('sessions', direction));
    this.toolResults = new ToolResultFeatureStore(featureGateway);
    this.snapshot = this.createSnapshot(this.projection.getSnapshot());
    this.removeProjectionListener = this.projection.subscribe(() => {
      const projection = this.projection.getSnapshot();
      if (projection.resetEpoch !== this.lastProjectionResetEpoch) {
        this.lastProjectionResetEpoch = projection.resetEpoch;
        this.ui.clearPendingOverlay();
        this.liveInferenceStreams.clear();
      }
      reconcileLiveInferenceStreams(this.liveInferenceStreams, projection);
      this.publish(projection);
      this.updateProjectionPolling(projection);
    });
  }

  getSnapshot = (): RuntimeSnapshot => this.snapshot;

  private selectSession(sessionId: string): void {
    if (this.ui.selectedSessionId !== sessionId) this.liveInferenceStreams.clear();
    this.ui.selectSession(sessionId);
    this.projection.selectSession(sessionId);
    this.synchronizationGeneration += 1;
  }

  openRunDetail(runId: string): Promise<void> { return this.projection.openRun(runId); }
  openDecisionDetail(decisionId: string): Promise<void> { return this.projection.openDecision(decisionId); }
  showMessageWindow(window: PublicProjectionMessageWindow): Promise<void> { return this.projection.messageWindow(window); }
  navigateProjectionCatalog(kind: 'sessions' | 'runs' | 'decisions', direction: 'next' | 'previous'): Promise<void> {
    const selection = kind === 'sessions' ? SESSION_DIRECTORY : kind === 'runs' ? RUN_DIRECTORY : DECISION_DIRECTORY;
    return this.projection.navigate(selection, direction);
  }

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
    this.liveInferenceStreams.clear();

    // Projection events are wake hints; append-only inference events own ephemeral presentation.
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
    this.livePublisher.cancel();
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
    this.diagnostics.dispose();
    this.tasks.dispose();
    this.requestError = null;
    this.liveInferenceStreams.clear();
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
      this.liveInferenceStreams.clear();
      return;
    }
    if (!wasReady && this.lifecycleReady) void this.requestSynchronization(true);
  }

  private acceptStatus(status: RuntimeStatus): boolean {
    if (status.observedAt < this.status.observedAt) return false;
    this.status = status;
    this.diagnostics.acceptStatus(status);
    return true;
  }

  private receiveWakeHint(envelope: RuntimeEventEnvelope): void {
    if ((envelope.event.kind === 'inference.chunk.observed' || envelope.event.kind === 'inference.stream.terminated')
      && envelope.event.sessionId !== this.ui.selectedSessionId) {
      if (envelope.event.kind === 'inference.stream.terminated') void this.requestSynchronization(false);
      return;
    }
    try {
      if (this.liveInferenceStreams.accept(envelope)) {
        if (envelope.event.kind === 'inference.stream.terminated') this.publish();
        else this.livePublisher.schedule();
        this.updateProjectionPolling();
        if (this.liveInferenceStreams.needsSynchronization || envelope.event.kind === 'inference.stream.terminated') {
          void this.requestSynchronization(false);
        }
        return;
      }
    } catch (error) {
      this.setError(error);
      return;
    }
    this.synchronizationRequested = true;
    if (this.lifecycleReady && this.status.availability === 'ready') {
      void this.requestSynchronization(false);
    }
  }

  private requestSynchronization(forceSnapshot: boolean): Promise<void> {
    if (forceSnapshot) {
      this.projection.resetReadRanges();
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
    let resets = 0;
    while (
      this.synchronizationRequested
      && lifecycle === this.lifecycleGeneration
      && this.status.availability === 'ready'
    ) {
      this.synchronizationRequested = false;
      const synchronization = this.synchronizationGeneration;
      try {
        await this.projection.synchronize(this.ui.selectedSessionId, this.snapshotRequired);
        if (!this.isCurrentSynchronization(lifecycle, synchronization)) continue;
        this.snapshotRequired = false;
        const unsettled = this.runs.deliverySnapshot().filter(receipt => receipt.state === 'pending' || receipt.state === 'reconcile');
        await this.projection.observeInboxProofs(unsettled, identity => this.runs.observeVerifiedInboxIdentities([identity]));
        if (!this.isCurrentSynchronization(lifecycle, synchronization)) continue;
      } catch (error) {
        if (!this.isCurrentSynchronization(lifecycle, synchronization)) continue;
        if (!(error instanceof ProjectionCatalogResetSignal || error instanceof ProjectionSnapshotResetSignal || error instanceof ProjectionScopedReadResetSignal)) throw error;
        if (error.reason === 'contract_mismatch' || ++resets > 3) throw error;
        this.projection.resetReadRanges();
        this.snapshotRequired = true;
        this.synchronizationGeneration += 1;
        this.synchronizationRequested = true;
        continue;
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
    projection: RendererProjectionSnapshot = this.projection.getSnapshot()
  ): void {
    if (
      !this.lifecycleReady
      || this.status.availability !== 'ready'
      || (!projection.runSummaries.some((run) => !isTerminalRunSummary(run)) && !this.liveInferenceStreams.hasActiveStreams)
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
    const retryDelaysMs = [0, 25, 50, 100, 200, 400, 800, 1_600, 2_000];
    for (const [index, delayMs] of retryDelaysMs.entries()) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      if (this.status.availability !== 'ready' || !this.lifecycleReady) continue;
      // Catalog omission says nothing about settlement. Read this exact
      // Decision at a fresh durable boundary, including its terminal state.
      if (await this.projection.decisionSettled(decisionId)) {
        await this.requestSynchronization(index > 0);
        return;
      }
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
    this.livePublisher.cancel();
    this.snapshot = this.createSnapshot(projection);
    for (const listener of this.listeners) listener();
  }

  private createSnapshot(projection: RendererProjectionSnapshot): RuntimeSnapshot {
    const authoritative = this.views.messages(projection.messages);
    const messagesWithReasoning = mergeInferenceStreamReasoning(
      [...authoritative.bySession.values()].flat(),
      this.liveInferenceStreams.getSnapshot(),
    );
    const bySession = new Map<string, RuntimeMessage[]>();
    for (const message of messagesWithReasoning) {
      const session = bySession.get(message.sessionId) ?? [];
      session.push(message);
      bySession.set(message.sessionId, session);
    }
    const inferenceMessages = presentInferenceMessages(
      this.liveInferenceStreams, authoritative.terminalAssistantRunIds
    );
    const messages = this.ui.projectedMessages(
      this.views.selectedMessages(bySession, inferenceMessages, this.ui.selectedSessionId),
      projection.runs, true
    );
    const pendingOverlayId = this.ui.pendingChatOverlayId;
    return {
      initialized: this.initialized,
      status: this.status,
      projectionStreamId: projection.streamId,
      projectionCursor: projection.cursor,
      projectionIntegrityError: projection.integrityError,
      sessions: this.views.sessions(projection.sessions),
      selectedSessionId: this.ui.selectedSessionId,
      planModeSessionIds: this.ui.planModeSnapshot(),
      pendingOverlayIds: this.views.pendingOverlayIds(pendingOverlayId),
      messages,
      models: this.views.models(projection.models),
      runs: this.views.runs(projection.runs),
      runSummaries: projection.runSummaries,
      openedRunId: projection.openedRunId,
      openedDecisionId: projection.openedDecisionId,
      decisionSummaries: projection.decisionSummaries,
      projectionWindows: {
        sessions: projection.directory, runs: projection.taskDirectory, decisions: projection.decisionDirectory,
        sessionRuns: projection.sessionRuns, sessionDecisions: projection.sessionDecisions, messages: projection.messageWindow
      },
      activities: this.views.activities(projection.runs),
      ...this.views.decisions(projection.decisions),
      trace: this.views.trace(projection.diagnostics),
      agentInputDeliveries: this.runs.deliverySnapshot(),
      lastError: projection.integrityError
        ?? this.runs.deliveryPersistenceError
        ?? this.requestError
    };
  }
}
