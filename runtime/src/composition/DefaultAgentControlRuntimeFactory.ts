import { assertCanonicalAbsoluteDataRoot } from '@ariadne/protocol/host';
import {
  type AgentDirectivePayloadLookup,
  type AgentPlanReference
} from '@ariadne/agent-core';
import type { RuntimeResult } from '@ariadne/protocol/public';

import {
  AES_GCM_AGENT_PERSISTENCE_CODEC_ID,
  AesGcmAgentPersistencePayloadCodec
} from '../adapters/persistence/AesGcmAgentPersistencePayloadCodec.js';
import {
  SqliteAgentRunUnitOfWork
} from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  SqliteConversationRunHandoffUnitOfWork
} from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import {
  StrictJsonAgentPersistencePayloadCodec
} from '../adapters/persistence/StrictJsonAgentPersistencePayloadCodec.js';
import {
  AGENT_CONTROL_DB_SCHEMA_VERSION
} from '../adapters/persistence/agentControlDbSchema.js';
import {
  PUBLIC_PROJECTION_DB_SCHEMA_VERSION
} from '../adapters/persistence/PublicProjectionDbSchema.js';
import {
  CONVERSATION_DB_SCHEMA_VERSION
} from '../adapters/persistence/ConversationDbSchema.js';
import {
  SqlitePublicProjectionStore
} from '../adapters/persistence/SqlitePublicProjectionStore.js';
import type {
  AgentControlRuntimeFactory,
  AgentControlRuntimeFactoryInput,
  AgentControlRuntimeLifecycle
} from '../ingress/AgentControlLifecycle.js';
import {
  createShutdownContext,
  type ShutdownContext
} from '../ingress/ShutdownContext.js';
import type {
  RuntimeApplicationCommandResult
} from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import type {
  RuntimeCommandReconciliation
} from '../control/ports/RuntimeCommandJournal.js';
import {
  AgentLiveWorkCompletionLifecycle
} from '../control/execution/AgentLiveWorkCompletionLifecycle.js';
import type { AgentControlLiveWorkService } from '../control/ports/AgentLiveWork.js';
import {
  ConversationAgentResultProjectionService
} from '../control/conversation/ConversationAgentResultProjectionService.js';
import {
  AgentRunPublicProjectionPublisher,
  type AgentRunPublicProjectionPublisherOptions
} from '../projection/AgentRunPublicProjectionPublisher.js';
import {
  ConversationPublicProjectionPublisher,
  type ConversationPublicProjectionPublisherOptions
} from '../projection/ConversationPublicProjectionPublisher.js';
import {
  ModelCatalogPublicProjectionPublisher,
  type ModelCatalogPublicProjectionPublisherOptions
} from '../projection/ModelCatalogPublicProjectionPublisher.js';
import type { RuntimePublicEventSink } from '../ingress/RuntimePublicEventSink.js';
import {
  PublicProjectionWakeCommitSink,
  PublicProjectionWakePublisher
} from './PublicProjectionWakeCommitSink.js';
import type {
  ModelCatalogProjectionSource
} from '../projection/ModelCatalogProjectionPorts.js';
import type {
  AgentRunVersionReader
} from '../projection/AgentRunProjectionPorts.js';
import { loadAgentPersistenceKeyRing } from './loadAgentPersistenceKeyRing.js';
import {
  ConversationAgentResultCoordinator
} from './ConversationAgentResultCoordinator.js';
import { AgentTerminalResultCoordinator } from './AgentTerminalResultCoordinator.js';
import {
  type AgentControlExecutionPipeline,
  type AgentControlExecutionPipelineFactory
} from './ProductionAgentControlExecutionPipelineFactory.js';
import {
  ProductionAgentControlExecutionPipelineFactory
} from './ProductionAgentControlExecutionPipelineFactory.js';
import {
  ProtectedAgentTerminalAssistantContentResolver
} from './ProtectedAgentTerminalAssistantContentResolver.js';
import {
  ProtectedAgentRunInteractionMessageResolver
} from './ProtectedAgentRunInteractionMessageResolver.js';
import {
  AgentControlPublicCommandRouter
} from './AgentControlPublicCommandRouter.js';
import { PublicAgentObservability } from '../adapters/observability/PublicAgentObservability.js';
import {
  InferenceStreamPublicProjectionPublisher,
  type InferenceStreamIdentity
} from '../projection/InferenceStreamPublicProjectionPublisher.js';
import { LocalConversationAttachmentStore } from '../adapters/attachment/LocalConversationAttachmentStore.js';
import type { ConversationAttachmentStore } from '../control/ports/ConversationAttachmentStore.js';

const DEFAULT_PUBLIC_PROJECTION_INTERVAL_MS = 50;
const EMPTY_MODEL_CATALOG: ModelCatalogProjectionSource = Object.freeze({
  snapshot: () => Object.freeze([])
});

export interface AgentControlPublicProjectionLifecycleOptions {
  readonly publishIntervalMs?: number;
  readonly publisher?: Omit<
    AgentRunPublicProjectionPublisherOptions,
    'terminalResultSink' | 'interactionResolver' | 'toolPresentationResolver'
  >;
  readonly conversationPublisher?: ConversationPublicProjectionPublisherOptions;
  readonly modelPublisher?: ModelCatalogPublicProjectionPublisherOptions;
  readonly conversationCommandNow?: () => Date;
  readonly agentDecisionCommandNow?: () => Date;
  readonly agentInboxCommandNow?: () => Date;
}

/** Composition-owned Agent store and public projection producer lifecycle. */
export class ComposedAgentControlRuntime
implements AgentControlRuntimeLifecycle {
  public readonly schemaVersion = AGENT_CONTROL_DB_SCHEMA_VERSION;
  public readonly storageSchemas = Object.freeze({
    agentControl: AGENT_CONTROL_DB_SCHEMA_VERSION,
    conversation: CONVERSATION_DB_SCHEMA_VERSION,
    publicProjection: PUBLIC_PROJECTION_DB_SCHEMA_VERSION
  });
  private readonly agentPublisher: AgentRunPublicProjectionPublisher;
  private readonly conversationPublisher: ConversationPublicProjectionPublisher;
  private readonly modelPublisher: ModelCatalogPublicProjectionPublisher;
  private readonly publicCommands: AgentControlPublicCommandRouter;
  private readonly publishIntervalMs: number;
  private lifecycle: 'new' | 'starting' | 'running' | 'failed' | 'stopping' | 'stopped' = 'new';
  private timer?: NodeJS.Timeout;
  private activeDrain: Promise<void> | null = null;
  private projectionDrainRequested = false;
  private healthFailure: unknown;
  private shutdownDrainContext: ShutdownContext | null = null;
  private prepareOperation: Promise<void> | null = null;
  private shutdownOperation: Promise<void> | null = null;
  private readonly liveWorkCompletion?: AgentLiveWorkCompletionLifecycle;

  public constructor(
    private readonly unitOfWork: SqliteAgentRunUnitOfWork,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly publicProjection: SqlitePublicProjectionStore,
    private readonly encryptedCodec?: AesGcmAgentPersistencePayloadCodec,
    options: AgentControlPublicProjectionLifecycleOptions = {},
    private readonly executionPipeline?: AgentControlExecutionPipeline,
    modelCatalog: ModelCatalogProjectionSource = EMPTY_MODEL_CATALOG,
    projectionWakeEventSink?: RuntimePublicEventSink,
    authorizedWorkspaceIds: readonly string[] = [],
    private readonly observability?: PublicAgentObservability,
    liveWork?: AgentControlLiveWorkService,
    attachmentStore?: ConversationAttachmentStore
  ) {
    this.publishIntervalMs = options.publishIntervalMs
      ?? DEFAULT_PUBLIC_PROJECTION_INTERVAL_MS;
    const conversationCommandNow = options.conversationCommandNow ?? (() => new Date());
    assertPublishInterval(this.publishIntervalMs);
    const projectionSink = projectionWakeEventSink === undefined
      ? publicProjection
      : new PublicProjectionWakeCommitSink(
          publicProjection,
          projectionWakeEventSink
        );
    const projectionWakePublisher = projectionWakeEventSink === undefined
      ? undefined
      : new PublicProjectionWakePublisher(projectionWakeEventSink);
    const conversationTerminalResults = new ConversationAgentResultCoordinator(
      conversation,
      new ConversationAgentResultProjectionService(conversation),
      new ProtectedAgentTerminalAssistantContentResolver(unitOfWork),
      conversationCommandNow
    );
    const terminalResults = new AgentTerminalResultCoordinator(
      unitOfWork,
      conversationTerminalResults
    );
    this.agentPublisher = new AgentRunPublicProjectionPublisher(
      unitOfWork,
      createAgentRunVersionReader(unitOfWork),
      projectionSink,
      {
        ...options.publisher,
        terminalResultSink: terminalResults,
        interactionResolver: new ProtectedAgentRunInteractionMessageResolver(unitOfWork),
        toolPresentationResolver: executionPipeline?.toolPresentationResolver
      }
    );
    this.conversationPublisher = new ConversationPublicProjectionPublisher(
      conversation,
      projectionSink,
      options.conversationPublisher
    );
    this.modelPublisher = new ModelCatalogPublicProjectionPublisher(
      modelCatalog,
      publicProjection,
      options.modelPublisher,
      projectionWakePublisher === undefined
        ? undefined
        : (commit) => projectionWakePublisher.publish(commit)
    );
    this.publicCommands = new AgentControlPublicCommandRouter(
      unitOfWork,
      conversation,
      publicProjection,
      executionPipeline,
      {
        wakeProjectionDrain: () => this.wakeProjectionDrain(),
        executeProjectionQuery: (envelope, query) => (
          this.executeProjectionQuery(envelope, query)
        )
      },
      {
        authorizedWorkspaceIds,
        conversationCommandNow,
        agentDecisionCommandNow: options.agentDecisionCommandNow,
        agentInboxCommandNow: options.agentInboxCommandNow,
        attachmentStore
      }
    );
    if (liveWork !== undefined) {
      this.liveWorkCompletion = new AgentLiveWorkCompletionLifecycle(liveWork, unitOfWork, {
        wakeWorkScheduler: () => executionPipeline?.runWorkScheduler.wake(),
        wakeProjectionDrain: () => this.wakeProjectionDrain()
      });
    }
  }

  public async start(): Promise<void> {
    if (this.lifecycle !== 'new') {
      throw new Error('agent_control_lifecycle_already_started');
    }
    this.lifecycle = 'starting';
    try {
      if (this.executionPipeline === undefined) {
        if (await this.conversation.countPendingHandoffOutbox() !== 0) {
          throw new Error('conversation_agent_handoff_producer_required');
        }
        const executionRecovery = await this.unitOfWork.listExecutionIntentRecovery({
          limit: 1
        });
        if (executionRecovery.items.length !== 0) {
          throw new Error('agent_execution_scheduler_required');
        }
        const activeRuns = await this.unitOfWork.listActiveRuns({ limit: 1 });
        if (activeRuns.items.length !== 0) {
          throw new Error('agent_run_work_scheduler_required');
        }
      } else {
        // Recover durable interruption facts before any scheduler can consume
        // the affected Run or cross a fresh Provider/Tool boundary.
        await this.liveWorkCompletion?.reconcileStartup();
        // Crossed initial-inference dispatch fences must fail before any other
        // producer is allowed to perform Provider or Tool I/O.
        await this.executionPipeline.executionScheduler.preflightStartupRecovery();
        // Replay already committed terminal Child facts before authority
        // retirement scans Parent Runs. This closes a crash window where the
        // Child terminal event was durable but its Parent observation was not.
        await this.drainPending();
        await this.executionPipeline.runWorkScheduler.start();
        this.executionPipeline.runWorkScheduler.assertHealthy();
        await this.executionPipeline.executionScheduler.start();
        this.executionPipeline.executionScheduler.assertHealthy();
        await this.executionPipeline.handoffProducer.start();
        this.executionPipeline.handoffProducer.assertHealthy();
      }
      await this.drainPending();
      if (await this.unitOfWork.countUnpublishedOutbox() !== 0) {
        throw new Error('agent_control_startup_projection_not_at_fixed_point');
      }
      this.lifecycle = 'running';
      this.timer = setInterval(() => this.publishOnTimer(), this.publishIntervalMs);
      this.timer.unref?.();
    } catch (error) {
      this.recordHealthFailure(error);
      throw projectionHealthError(error);
    }
  }

  public assertHealthy(): void {
    this.liveWorkCompletion?.assertHealthy();
    this.executionPipeline?.runWorkScheduler.assertHealthy();
    this.executionPipeline?.executionScheduler.assertHealthy();
    this.executionPipeline?.handoffProducer.assertHealthy();
    if (this.healthFailure !== undefined) {
      throw projectionHealthError(this.healthFailure);
    }
    if (this.lifecycle !== 'running') {
      throw new Error('agent_control_public_projection_not_running');
    }
  }

  public async executeOwnedCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult | null> {
    return this.publicCommands.executeOwnedCommand(envelope);
  }

  public async reconcileUncertainCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeCommandReconciliation | null> {
    return this.publicCommands.reconcileUncertainCommand(envelope);
  }

  public prepareShutdown(context: ShutdownContext): Promise<void> {
    if (this.lifecycle === 'stopped') {
      context.throwIfExpired();
      return Promise.resolve();
    }
    if (this.prepareOperation !== null) return this.prepareOperation;

    const drainBeforeFreeze = this.lifecycle === 'running';
    this.lifecycle = 'stopping';
    this.shutdownDrainContext = context;
    this.stopTimer();
    this.prepareOperation = this.prepareProducerShutdown(context, drainBeforeFreeze);
    return this.prepareOperation;
  }

  public shutdown(context: ShutdownContext): Promise<void> {
    if (this.shutdownOperation !== null) return this.shutdownOperation;
    this.shutdownOperation = this.finishShutdown(context);
    return this.shutdownOperation;
  }

  private publishOnTimer(): void {
    if (
      this.lifecycle !== 'running'
      || this.healthFailure !== undefined
      || this.activeDrain !== null
    ) {
      return;
    }
    this.wakeProjectionDrain();
  }

  private wakeProjectionDrain(): void {
    if (
      this.lifecycle !== 'running'
      || this.healthFailure !== undefined
    ) return;
    this.projectionDrainRequested = true;
    void this.drainPending().catch((error) => {
      this.recordHealthFailure(error);
    });
  }

  private drainPending(): Promise<void> {
    this.projectionDrainRequested = true;
    if (this.activeDrain !== null) return this.activeDrain;
    const operation = this.drainProjectionRequests();
    this.activeDrain = operation;
    return operation;
  }

  private async drainProjectionRequests(): Promise<void> {
    try {
      do {
        this.projectionDrainRequested = false;
        await this.publishUntilEmpty();
      } while (this.projectionDrainRequested);
    } finally {
      // Clearing ownership happens synchronously with the final dirty check.
      // A wake before this point is consumed by this epoch; a wake after it
      // observes no active owner and starts the next one.
      this.activeDrain = null;
    }
  }

  private async publishUntilEmpty(): Promise<void> {
    while (true) {
      this.shutdownDrainContext?.throwIfExpired();
      const modelResult = await this.modelPublisher.publishPending();
      this.shutdownDrainContext?.throwIfExpired();
      const conversationResult = await this.conversationPublisher.publishPending();
      this.shutdownDrainContext?.throwIfExpired();
      const agentResult = await this.agentPublisher.publishPending();
      this.shutdownDrainContext?.throwIfExpired();
      if (
        modelResult.publishedChanges === 0
        && conversationResult.readRecords === 0
        && agentResult.claimedMessages === 0
      ) return;
      await Promise.resolve();
    }
  }

  private async prepareProducerShutdown(
    context: ShutdownContext,
    drainBeforeFreeze: boolean
  ): Promise<void> {
    const failures: unknown[] = [];
    if (this.executionPipeline !== undefined) {
      this.executionPipeline.observeRuntimeStop?.(new Date().toISOString());
      // Stop both I/O schedulers before awaiting either one. This prevents a
      // long join in one producer from leaving the other producer live.
      const schedulerStops: Promise<void>[] = [];
      try {
        context.throwIfExpired();
        schedulerStops.push(
          this.executionPipeline.runWorkScheduler.prepareShutdown(context)
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        context.throwIfExpired();
        schedulerStops.push(
          this.executionPipeline.executionScheduler.prepareShutdown(context)
        );
      } catch (error) {
        failures.push(error);
      }
      const schedulerResults = await Promise.allSettled(schedulerStops);
      for (const result of schedulerResults) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
      try {
        context.throwIfExpired();
        await this.executionPipeline.handoffProducer.prepareShutdown(context);
        context.throwIfExpired();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      context.throwIfExpired();
      await this.liveWorkCompletion?.prepareShutdown(context.remainingMs());
      context.throwIfExpired();
    } catch (error) {
      failures.push(error);
    }
    try {
      context.throwIfExpired();
      await this.observability?.drain();
      context.throwIfExpired();
      if (this.activeDrain !== null) await this.activeDrain;
      context.throwIfExpired();
      if (drainBeforeFreeze && this.healthFailure === undefined) {
        await this.drainPending();
      }
      context.throwIfExpired();
    } catch (error) {
      this.recordHealthFailure(error);
      failures.push(projectionHealthError(error));
    }

    try {
      // The UoW is frozen only after the publisher has stopped and its final
      // drain has settled, so no accepted outbox row can be stranded by order.
      this.unitOfWork.prepareShutdown(context);
    } catch (error) {
      failures.push(error);
    }
    try {
      this.conversation.prepareShutdown(context);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'agent_control_prepare_shutdown_failed');
    }
  }

  private async finishShutdown(context: ShutdownContext): Promise<void> {
    try {
      await this.prepareShutdown(context);
    } catch (error) {
      // Preparation is the hard producer/fixed-point barrier. Closing even one
      // store after it fails can release a partial ownership set while an
      // admitted operation is still uncertain. Retain every fence for Main's
      // deadline kill instead.
      throw new AggregateError(
        [error],
        'agent_control_shutdown_barrier_failed'
      );
    }

    // Close in dependency order and stop at the first uncertain close. A
    // previously closed read model is harmless, while every remaining
    // authority store keeps its owner fence until the process is terminated.
    try {
      await this.publicProjection.close(context);
      await this.conversation.close(context);
      await this.unitOfWork.close(context);
    } catch (error) {
      throw new AggregateError([error], 'agent_control_shutdown_failed');
    }
    this.encryptedCodec?.destroy();
    this.lifecycle = 'stopped';
  }

  private async executeProjectionQuery(
    envelope: RuntimeCommandEnvelope,
    query: () => Promise<RuntimeResult>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    try {
      const result = await query();
      envelope.signal.throwIfAborted();
      return {
        outcome: { ok: true, result },
        settlement: 'completed'
      };
    } catch (error) {
      if (envelope.signal.aborted) throw error;
      this.recordHealthFailure(error);
      return completedPublicError(
        envelope,
        'public_projection_unavailable',
        'The authoritative public projection is unavailable.',
        false
      );
    }
  }

  private recordHealthFailure(error: unknown): void {
    if (this.healthFailure === undefined) this.healthFailure = error;
    this.stopTimer();
    if (this.lifecycle !== 'stopping' && this.lifecycle !== 'stopped') {
      this.lifecycle = 'failed';
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export class DefaultAgentControlRuntimeFactory
implements AgentControlRuntimeFactory {
  public constructor(
    private readonly lifecycleOptions: AgentControlPublicProjectionLifecycleOptions = {},
    private readonly executionPipelineFactory?: AgentControlExecutionPipelineFactory
  ) {}

  public async create(
    input: AgentControlRuntimeFactoryInput
  ): Promise<ComposedAgentControlRuntime> {
    assertCanonicalAbsoluteDataRoot(input.dataRoot);
    const executionPipelineFactory = this.executionPipelineFactory
      ?? createProductionExecutionPipelineFactory(input);
    const attachmentStore = new LocalConversationAttachmentStore(input.dataRoot);
    if (!input.production) {
      let unitOfWork: SqliteAgentRunUnitOfWork | undefined;
      let conversation: SqliteConversationRunHandoffUnitOfWork | undefined;
      let publicProjection: SqlitePublicProjectionStore | undefined;
      let observability: PublicAgentObservability | undefined;
      try {
        unitOfWork = new SqliteAgentRunUnitOfWork(
          input.dataRoot,
          new StrictJsonAgentPersistencePayloadCodec()
        );
        conversation = new SqliteConversationRunHandoffUnitOfWork(input.dataRoot);
        publicProjection = new SqlitePublicProjectionStore(input.dataRoot);
        const inferenceStreams = new InferenceStreamPublicProjectionPublisher(publicProjection);
        await inferenceStreams.reconcileOpenStreams(
          (identity) => resolveInferenceStreamTerminalState(unitOfWork!, identity)
        );
        observability = await createPublicAgentObservability(input, publicProjection);
        const executionPipeline = await executionPipelineFactory?.create({
          unitOfWork,
          conversation,
          agentAdmissionAuthoritySource: input.agentAdmissionAuthoritySource,
          modelProviders: input.modelProviders,
          subagentProviders: input.subagentProviders,
          ...(input.installRoot === undefined ? {} : { installRoot: input.installRoot }),
          ...(input.workspaces === undefined ? {} : { workspaces: input.workspaces }),
          ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
          hookDeliverySink: observability,
          providerTelemetry: input.runtimeServices?.telemetry,
          processSandboxForWorkspace: input.runtimeServices?.processSandboxForWorkspace,
          inferenceStreamPublisher: inferenceStreams,
          attachmentStore,
          ...(input.modelInferenceGateway === undefined
            ? {}
            : { modelInferenceGateway: input.modelInferenceGateway })
        });
        return new ComposedAgentControlRuntime(
          unitOfWork,
          conversation,
          publicProjection,
          undefined,
          this.lifecycleOptions,
          executionPipeline ?? undefined,
          input.modelCatalog,
          input.publicEventSink,
          input.workspaces?.map((workspace) => workspace.workspaceId) ?? [],
          observability,
          input.runtimeServices?.liveWorkLifecycle,
          attachmentStore
        );
      } catch (error) {
        const cleanupContext = createShutdownContext(Date.now() + 5_000);
        const cleanupErrors: unknown[] = [];
        try {
          await publicProjection?.close(cleanupContext);
        } catch (failure) {
          cleanupErrors.push(failure);
        }
        try {
          await conversation?.close(cleanupContext);
        } catch (failure) {
          cleanupErrors.push(failure);
        }
        try {
          await unitOfWork?.close(cleanupContext);
        } catch (failure) {
          cleanupErrors.push(failure);
        } finally {
          cleanupContext.dispose();
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            'agent_control_factory_initialization_cleanup_failed'
          );
        }
        throw error;
      }
    }

    const keyRing = await loadAgentPersistenceKeyRing(
      input.hostCapabilities,
      input.runtimeInstanceId
    );
    const temporaryKeys = keyRing.keys.map((entry) => ({
      keyId: entry.keyId,
      key: Buffer.from(entry.keyMaterialBase64, 'base64')
    }));
    let codec: AesGcmAgentPersistencePayloadCodec | undefined;
    let unitOfWork: SqliteAgentRunUnitOfWork | undefined;
    let conversation: SqliteConversationRunHandoffUnitOfWork | undefined;
    let publicProjection: SqlitePublicProjectionStore | undefined;
    let observability: PublicAgentObservability | undefined;
    try {
      codec = new AesGcmAgentPersistencePayloadCodec(
        keyRing.activeKeyId,
        temporaryKeys
      );
      unitOfWork = new SqliteAgentRunUnitOfWork(input.dataRoot, codec);
      await unitOfWork.verifyOrInitializeKeyringAnchor({
        generation: keyRing.generation,
        activeKeyId: keyRing.activeKeyId,
        availableKeyIds: keyRing.keys.map((entry) => entry.keyId),
        requiredCodecId: AES_GCM_AGENT_PERSISTENCE_CODEC_ID
      });
      conversation = new SqliteConversationRunHandoffUnitOfWork(input.dataRoot);
      publicProjection = new SqlitePublicProjectionStore(input.dataRoot);
      const inferenceStreams = new InferenceStreamPublicProjectionPublisher(publicProjection);
      await inferenceStreams.reconcileOpenStreams(
        (identity) => resolveInferenceStreamTerminalState(unitOfWork!, identity)
      );
      observability = await createPublicAgentObservability(input, publicProjection);
      const executionPipeline = await executionPipelineFactory?.create({
        unitOfWork,
        conversation,
        agentAdmissionAuthoritySource: input.agentAdmissionAuthoritySource,
        modelProviders: input.modelProviders,
        ...(input.installRoot === undefined ? {} : { installRoot: input.installRoot }),
        ...(input.workspaces === undefined ? {} : { workspaces: input.workspaces }),
        ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
        hookDeliverySink: observability,
        providerTelemetry: input.runtimeServices?.telemetry,
        inferenceStreamPublisher: inferenceStreams,
        attachmentStore,
        ...(input.modelInferenceGateway === undefined
          ? {}
          : { modelInferenceGateway: input.modelInferenceGateway })
      });
      return new ComposedAgentControlRuntime(
        unitOfWork,
        conversation,
        publicProjection,
        codec,
        this.lifecycleOptions,
        executionPipeline ?? undefined,
        input.modelCatalog,
        input.publicEventSink,
        input.workspaces?.map((workspace) => workspace.workspaceId) ?? [],
        observability,
        input.runtimeServices?.liveWorkLifecycle,
        attachmentStore
      );
    } catch (error) {
      const cleanupContext = createShutdownContext(Date.now() + 5_000);
      try {
        await publicProjection?.close(cleanupContext).catch(() => undefined);
        await conversation?.close(cleanupContext).catch(() => undefined);
        await unitOfWork?.close(cleanupContext).catch(() => undefined);
      } finally {
        cleanupContext.dispose();
      }
      codec?.destroy();
      throw error;
    } finally {
      for (const entry of temporaryKeys) entry.key.fill(0);
    }
  }
}

async function resolveInferenceStreamTerminalState(
  unitOfWork: SqliteAgentRunUnitOfWork,
  identity: InferenceStreamIdentity
): Promise<'committed' | 'interrupted'> {
  return unitOfWork.transaction(async (transaction) => {
    const run = await transaction.loadRun(identity.runId);
    const turn = run?.turns.find((candidate) => candidate.turnId === identity.turnId);
    const attempt = turn?.attempts.find(
      (candidate) => candidate.attemptId === identity.attemptId
    );
    return attempt?.state.status === 'succeeded' ? 'committed' : 'interrupted';
  });
}

async function createPublicAgentObservability(
  input: AgentControlRuntimeFactoryInput,
  publicProjection: SqlitePublicProjectionStore
): Promise<PublicAgentObservability> {
  const observability = new PublicAgentObservability(
    publicProjection,
    new PublicProjectionWakeCommitSink(publicProjection, input.publicEventSink),
    input.runtimeServices?.telemetry
  );
  await observability.start();
  return observability;
}

function createProductionExecutionPipelineFactory(
  input: AgentControlRuntimeFactoryInput
): AgentControlExecutionPipelineFactory | undefined {
  if (input.workspaces === undefined || input.credentialEnvironment === undefined) {
    return undefined;
  }
  if (input.agentToolCatalogSnapshots === undefined) return undefined;
  if (input.runtimeServices?.instructionAssembly === undefined) return undefined;
  if (input.runtimeServices.lifecycleHooks === undefined) return undefined;
  return new ProductionAgentControlExecutionPipelineFactory({
    toolCatalogSnapshots: input.agentToolCatalogSnapshots,
    credentialEnvironment: input.credentialEnvironment,
    instructionAssembly: input.runtimeServices.instructionAssembly,
    lifecycleHooks: input.runtimeServices.lifecycleHooks,
    liveWorkLifecycle: input.runtimeServices?.liveWorkLifecycle,
    recoveryReporter: {
      reportExecutionIntentRecovery: async (notice) => {
        console.error('[agent-control] execution intent requires recovery', {
          state: notice.state,
          reason: notice.reason
        });
      }
    }
  });
}

function createAgentRunVersionReader(
  unitOfWork: SqliteAgentRunUnitOfWork
): AgentRunVersionReader {
  return Object.freeze({
    loadCommittedCommandReceipt: (commandId: string) => (
      unitOfWork.loadCommittedCommandReceipt(commandId)
    ),
    loadRunVersion: (runId: string, version: number) => (
      unitOfWork.loadRunVersion(runId, version)
    ),
    loadPlanVersion: (reference: AgentPlanReference) => unitOfWork.transaction(
      (transaction) => {
        if (transaction.loadPlanVersion === undefined) {
          throw new Error('agent_control_plan_version_reader_unavailable');
        }
        return transaction.loadPlanVersion(reference);
      }
    ),
    loadDirectivePayload: (reference: AgentDirectivePayloadLookup) => (
      unitOfWork.loadDirectivePayload(reference)
    )
  });
}

function completedPublicError(
  envelope: RuntimeCommandEnvelope,
  code: string,
  message: string,
  retryable: boolean
): RuntimeApplicationCommandResult {
  return {
    outcome: {
      ok: false,
      error: {
        code,
        message,
        retryable,
        correlationId: envelope.correlationId
      }
    },
    settlement: 'completed'
  };
}

function assertPublishInterval(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new Error('agent_control_public_projection_interval_invalid');
  }
}

function projectionHealthError(cause: unknown): Error {
  return new Error('agent_control_public_projection_unhealthy', { cause });
}
