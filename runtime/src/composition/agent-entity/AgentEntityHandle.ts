import {
  AGENT_CONTROL_DB_SCHEMA_VERSION
} from '../../adapters/persistence/agentControlDbSchema.js';
import {
  CONVERSATION_DB_SCHEMA_VERSION
} from '../../adapters/persistence/ConversationDbSchema.js';
import {
  PUBLIC_PROJECTION_DB_SCHEMA_VERSION
} from '../../adapters/persistence/PublicProjectionDbSchema.js';
import { PRODUCTIVITY_DB_SCHEMA_VERSION } from '../../adapters/persistence/SqliteProductivityStore.js';
import type { PublicAgentObservability } from '../../adapters/observability/PublicAgentObservability.js';
import type {
  AgentControlRuntimeLifecycle,
  AgentControlRuntimeServices
} from '../../ingress/AgentControlLifecycle.js';
import type { RuntimeApplicationCommandResult } from '../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../ingress/RuntimeIngress.js';
import type { ShutdownContext } from '../../ingress/ShutdownContext.js';
import type { RuntimeCommandReconciliation } from '../../control/ports/RuntimeCommandJournal.js';
import type { AgentControlLiveWorkService } from '../../control/ports/AgentLiveWork.js';
import type { RuntimePublicEventSink } from '../../ingress/RuntimePublicEventSink.js';
import type { ModelCatalogProjectionSource } from '../../projection/ModelCatalogProjectionPorts.js';
import { AgentControlPublicCommandRouter } from '../AgentControlPublicCommandRouter.js';
import type { AgentControlExecutionPipeline } from '../ProductionAgentControlExecutionPipelineFactory.js';
import { V3ScheduleWorker } from '../V3ScheduleWorker.js';
import { composeAgentEntityCommandManifest } from './AgentEntityCommandAssembly.js';
import {
  createAgentExecutionComponent,
  type AgentExecutionComponentHandle
} from './components/execution/AgentExecutionComponent.js';
import type {
  AgentPersistenceComponentHandle
} from './components/persistence/AgentPersistenceComponent.js';
import {
  createAgentProjectionComponent,
  projectionHealthError,
  type AgentProjectionComponentHandle,
  type AgentProjectionComponentOptions
} from './components/projection/AgentProjectionComponent.js';

export interface AgentEntityHandleOptions extends AgentProjectionComponentOptions {
  readonly agentDecisionCommandNow?: () => Date;
  readonly agentInboxCommandNow?: () => Date;
}

/** Started Agent Entity handle that owns component lifecycle and public ingress. */
export class AgentEntityHandle implements AgentControlRuntimeLifecycle {
  public readonly schemaVersion = AGENT_CONTROL_DB_SCHEMA_VERSION;
  public readonly storageSchemas = Object.freeze({
    agentControl: AGENT_CONTROL_DB_SCHEMA_VERSION,
    conversation: CONVERSATION_DB_SCHEMA_VERSION,
    publicProjection: PUBLIC_PROJECTION_DB_SCHEMA_VERSION,
    productivity: PRODUCTIVITY_DB_SCHEMA_VERSION
  });
  private readonly projection: AgentProjectionComponentHandle;
  private readonly execution: AgentExecutionComponentHandle;
  private readonly publicCommands: AgentControlPublicCommandRouter;
  private readonly scheduleWorker: V3ScheduleWorker | undefined;
  private readonly unitOfWork: AgentPersistenceComponentHandle['unitOfWork'];
  private lifecycle: 'new' | 'starting' | 'running' | 'failed' | 'stopping' | 'stopped' = 'new';
  private prepareOperation: Promise<void> | null = null;
  private shutdownOperation: Promise<void> | null = null;

  public constructor(
    private readonly persistence: AgentPersistenceComponentHandle,
    options: AgentEntityHandleOptions = {},
    executionPipeline?: AgentControlExecutionPipeline,
    modelCatalog?: ModelCatalogProjectionSource,
    projectionWakeEventSink?: RuntimePublicEventSink,
    authorizedWorkspaceIds: readonly string[] = [],
    private readonly observability?: PublicAgentObservability,
    liveWork?: AgentControlLiveWorkService,
    humanSkillCatalog?: NonNullable<AgentControlRuntimeServices['humanSkillCatalog']>
  ) {
    const { unitOfWork, conversation, productivity, attachmentStore } = persistence;
    this.unitOfWork = unitOfWork;
    this.projection = createAgentProjectionComponent({
      persistence,
      options,
      executionPipeline,
      modelCatalog,
      wakeEventSink: projectionWakeEventSink
    });
    this.execution = createAgentExecutionComponent({
      unitOfWork,
      conversation,
      pipeline: executionPipeline,
      liveWork,
      wakeProjectionDrain: () => this.projection.wake()
    });
    const commandManifest = composeAgentEntityCommandManifest({
      unitOfWork,
      conversation,
      executionPipeline,
      projectionCommandOwners: this.projection.commandOwners(),
      wakeProjectionDrain: () => this.projection.wake(),
      authorizedWorkspaceIds,
      conversationCommandNow: this.projection.conversationCommandNow,
      agentDecisionCommandNow: options.agentDecisionCommandNow,
      agentInboxCommandNow: options.agentInboxCommandNow,
      attachmentStore,
      humanSkillCatalog,
      productivityStore: productivity
    });
    this.publicCommands = new AgentControlPublicCommandRouter(commandManifest.ownerTable);
    this.scheduleWorker = productivity === undefined
      ? undefined
      : new V3ScheduleWorker(
          productivity,
          conversation,
          (envelope) => this.publicCommands.executeOwnedCommand(envelope)
        );
  }

  public async start(): Promise<void> {
    if (this.lifecycle !== 'new') throw new Error('agent_control_lifecycle_already_started');
    this.lifecycle = 'starting';
    try {
      await this.execution.start(() => this.projection.drainPending());
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
    this.execution.assertHealthy();
    this.projection.assertHealthy();
    if (this.lifecycle !== 'running') {
      throw new Error('agent_control_public_projection_not_running');
    }
  }

  public executeOwnedCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult | null> {
    return this.publicCommands.executeOwnedCommand(envelope);
  }

  public reconcileUncertainCommand(
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
    failures.push(...await this.execution.prepareShutdown(context));
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
      throw new AggregateError([error], 'agent_control_shutdown_barrier_failed');
    }
    try {
      await this.persistence.close(context);
    } catch (error) {
      throw new AggregateError([error], 'agent_control_shutdown_failed');
    }
    this.projection.completeShutdown();
    this.lifecycle = 'stopped';
  }
}
