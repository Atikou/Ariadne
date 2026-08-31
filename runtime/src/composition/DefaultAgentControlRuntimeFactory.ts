import { assertCanonicalAbsoluteDataRoot } from '@ariadne/protocol/host';

import type {
  SqliteAgentRunUnitOfWork
} from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  AGENT_CONTROL_DB_SCHEMA_VERSION
} from '../adapters/persistence/agentControlDbSchema.js';
import {
  PUBLIC_PROJECTION_DB_SCHEMA_VERSION
} from '../adapters/persistence/PublicProjectionDbSchema.js';
import {
  CONVERSATION_DB_SCHEMA_VERSION
} from '../adapters/persistence/ConversationDbSchema.js';
import type {
  SqlitePublicProjectionStore
} from '../adapters/persistence/SqlitePublicProjectionStore.js';
import { PRODUCTIVITY_DB_SCHEMA_VERSION } from '../adapters/persistence/SqliteProductivityStore.js';
import type {
  AgentControlRuntimeFactory,
  AgentControlRuntimeFactoryInput,
  AgentControlRuntimeLifecycle,
  AgentControlRuntimeServices
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
import type { RuntimePublicEventSink } from '../ingress/RuntimePublicEventSink.js';
import { PublicProjectionWakeCommitSink } from './PublicProjectionWakeCommitSink.js';
import type {
  ModelCatalogProjectionSource
} from '../projection/ModelCatalogProjectionPorts.js';
import {
  type AgentControlExecutionPipeline,
  type AgentControlExecutionPipelineFactory
} from './ProductionAgentControlExecutionPipelineFactory.js';
import {
  createProductionExecutionPipelineFactory
} from './AgentControlRuntimeCompositionSupport.js';
import {
  AgentControlPublicCommandRouter
} from './AgentControlPublicCommandRouter.js';
import { PublicAgentObservability } from '../adapters/observability/PublicAgentObservability.js';
import {
  InferenceStreamPublicProjectionPublisher,
  type InferenceStreamIdentity
} from '../projection/InferenceStreamPublicProjectionPublisher.js';
import { V3ScheduleWorker } from './V3ScheduleWorker.js';
import {
  startAgentPersistenceComponent,
  type AgentPersistenceComponentHandle
} from './agent-entity/components/persistence/AgentPersistenceComponent.js';
import {
  createAgentProjectionComponent,
  projectionHealthError,
  type AgentProjectionComponentHandle,
  type AgentProjectionComponentOptions
} from './agent-entity/components/projection/AgentProjectionComponent.js';

export interface AgentControlPublicProjectionLifecycleOptions
extends AgentProjectionComponentOptions {
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
    publicProjection: PUBLIC_PROJECTION_DB_SCHEMA_VERSION,
    productivity: PRODUCTIVITY_DB_SCHEMA_VERSION
  });
  private readonly projection: AgentProjectionComponentHandle;
  private readonly publicCommands: AgentControlPublicCommandRouter;
  private lifecycle: 'new' | 'starting' | 'running' | 'failed' | 'stopping' | 'stopped' = 'new';
  private prepareOperation: Promise<void> | null = null;
  private shutdownOperation: Promise<void> | null = null;
  private readonly liveWorkCompletion?: AgentLiveWorkCompletionLifecycle;
  private readonly scheduleWorker: V3ScheduleWorker | undefined;
  private readonly unitOfWork: AgentPersistenceComponentHandle['unitOfWork'];
  private readonly conversation: AgentPersistenceComponentHandle['conversation'];
  private readonly publicProjection: AgentPersistenceComponentHandle['publicProjection'];
  private readonly productivity: AgentPersistenceComponentHandle['productivity'];

  public constructor(
    private readonly persistence: AgentPersistenceComponentHandle,
    options: AgentControlPublicProjectionLifecycleOptions = {},
    private readonly executionPipeline?: AgentControlExecutionPipeline,
    modelCatalog?: ModelCatalogProjectionSource,
    projectionWakeEventSink?: RuntimePublicEventSink,
    authorizedWorkspaceIds: readonly string[] = [],
    private readonly observability?: PublicAgentObservability,
    liveWork?: AgentControlLiveWorkService,
    humanSkillCatalog?: NonNullable<AgentControlRuntimeServices['humanSkillCatalog']>
  ) {
    const {
      unitOfWork,
      conversation,
      publicProjection,
      productivity,
      attachmentStore
    } = persistence;
    this.unitOfWork = unitOfWork;
    this.conversation = conversation;
    this.publicProjection = publicProjection;
    this.productivity = productivity;
    this.projection = createAgentProjectionComponent({
      persistence,
      options,
      executionPipeline,
      modelCatalog,
      wakeEventSink: projectionWakeEventSink
    });
    this.publicCommands = new AgentControlPublicCommandRouter(
      unitOfWork,
      conversation,
      publicProjection,
      executionPipeline,
      {
        wakeProjectionDrain: () => this.projection.wake(),
        executeProjectionQuery: (envelope, query) => (
          this.projection.executeQuery(envelope, query)
        )
      },
      {
        authorizedWorkspaceIds,
        conversationCommandNow: this.projection.conversationCommandNow,
        agentDecisionCommandNow: options.agentDecisionCommandNow,
        agentInboxCommandNow: options.agentInboxCommandNow,
        attachmentStore,
        humanSkillCatalog,
        productivityStore: productivity
      }
    );
    this.scheduleWorker = productivity === undefined
      ? undefined
      : new V3ScheduleWorker(
          productivity,
          conversation,
          (envelope) => this.publicCommands.executeOwnedCommand(envelope)
        );
    if (liveWork !== undefined) {
      this.liveWorkCompletion = new AgentLiveWorkCompletionLifecycle(liveWork, unitOfWork, {
        wakeWorkScheduler: () => executionPipeline?.runWorkScheduler.wake(),
        wakeProjectionDrain: () => this.projection.wake()
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
        await this.projection.drainPending();
        await this.executionPipeline.runWorkScheduler.start();
        this.executionPipeline.runWorkScheduler.assertHealthy();
        await this.executionPipeline.executionScheduler.start();
        this.executionPipeline.executionScheduler.assertHealthy();
        await this.executionPipeline.handoffProducer.start();
        this.executionPipeline.handoffProducer.assertHealthy();
      }
      await this.projection.drainPending();
      if (await this.unitOfWork.countUnpublishedOutbox() !== 0) {
        throw new Error('agent_control_startup_projection_not_at_fixed_point');
      }
      this.lifecycle = 'running';
      await this.scheduleWorker?.start();
      this.projection.activate();
    } catch (error) {
      this.projection.fail(error);
      throw projectionHealthError(error);
    }
  }

  public assertHealthy(): void {
    this.liveWorkCompletion?.assertHealthy();
    this.executionPipeline?.runWorkScheduler.assertHealthy();
    this.executionPipeline?.executionScheduler.assertHealthy();
    this.executionPipeline?.handoffProducer.assertHealthy();
    this.projection.assertHealthy();
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
    this.projection.beginShutdown(context);
    this.prepareOperation = this.prepareProducerShutdown(context, drainBeforeFreeze);
    return this.prepareOperation;
  }

  public shutdown(context: ShutdownContext): Promise<void> {
    if (this.shutdownOperation !== null) return this.shutdownOperation;
    this.shutdownOperation = this.finishShutdown(context);
    return this.shutdownOperation;
  }

  private async prepareProducerShutdown(
    context: ShutdownContext,
    drainBeforeFreeze: boolean
  ): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.scheduleWorker?.stop();
    } catch (error) {
      failures.push(error);
    }
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
    let projectionBarrierReady = true;
    try {
      context.throwIfExpired();
      await this.observability?.drain();
      context.throwIfExpired();
    } catch (error) {
      projectionBarrierReady = false;
      this.projection.fail(error);
      failures.push(projectionHealthError(error));
    }
    if (projectionBarrierReady) {
      try {
        await this.projection.settleAndDrain(context, drainBeforeFreeze);
      } catch (error) {
        failures.push(error);
      }
    }

    try {
      // The UoW is frozen only after the publisher has stopped and its final
      // drain has settled, so no accepted outbox row can be stranded by order.
      this.persistence.prepareShutdown(context);
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
      await this.persistence.close(context);
    } catch (error) {
      throw new AggregateError([error], 'agent_control_shutdown_failed');
    }
    this.projection.completeShutdown();
    this.lifecycle = 'stopped';
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
    const persistence = await startAgentPersistenceComponent(input);
    try {
      const inferenceStreams = new InferenceStreamPublicProjectionPublisher(
        persistence.publicProjection
      );
      await inferenceStreams.reconcileOpenStreams(
        (identity) => resolveInferenceStreamTerminalState(persistence.unitOfWork, identity)
      );
      const observability = await createPublicAgentObservability(
        input,
        persistence.publicProjection
      );
      const executionPipeline = await executionPipelineFactory?.create({
        unitOfWork: persistence.unitOfWork,
        conversation: persistence.conversation,
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
        attachmentStore: persistence.attachmentStore,
        subagentSessionStore: persistence.subagentSessionStore,
        ...(input.modelInferenceGateway === undefined
          ? {}
          : { modelInferenceGateway: input.modelInferenceGateway })
      });
      return new ComposedAgentControlRuntime(
        persistence,
        this.lifecycleOptions,
        executionPipeline ?? undefined,
        input.modelCatalog,
        input.publicEventSink,
        input.workspaces?.map((workspace) => workspace.workspaceId) ?? [],
        observability,
        input.runtimeServices?.liveWorkLifecycle,
        input.runtimeServices?.humanSkillCatalog
      );
    } catch (error) {
      const cleanupContext = createShutdownContext(Date.now() + 5_000);
      let cleanupErrors: readonly unknown[];
      try {
        cleanupErrors = await persistence.rollback(cleanupContext);
      } finally {
        cleanupContext.dispose();
      }
      throw cleanupErrors.length === 0
        ? error
        : new AggregateError(
            [error, ...cleanupErrors],
            'agent_control_factory_initialization_cleanup_failed'
          );
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
