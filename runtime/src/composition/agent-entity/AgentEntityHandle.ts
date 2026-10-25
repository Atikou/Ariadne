import {
  AGENT_CONTROL_DB_SCHEMA_VERSION
} from '../../adapters/persistence/agentControlDbSchema.js';
import {
  CONVERSATION_DB_SCHEMA_VERSION
} from '../../adapters/persistence/ConversationDbSchema.js';
import {
  PUBLIC_PROJECTION_CURRENT_DB_SCHEMA_VERSION
} from '../../adapters/persistence/PublicProjectionDbSchema.js';
import { PRODUCTIVITY_DB_SCHEMA_VERSION } from '../../adapters/persistence/SqliteProductivityStore.js';
import type { PublicAgentObservability } from '../../adapters/observability/PublicAgentObservability.js';
import type { AgentControlRuntimeLifecycle } from '../../ingress/AgentControlLifecycle.js';
import type { RuntimeCommand } from '@ariadne/protocol/public';
import type { RuntimeDomainHealthSnapshot } from '../../ingress/RuntimeDomainHealth.js';
import { AgentEntityHealth } from './AgentEntityHealth.js';
import type { RuntimeApplicationCommandResult } from '../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../ingress/RuntimeIngress.js';
import type { ShutdownContext } from '../../ingress/ShutdownContext.js';
import type { RuntimeCommandReconciliationV2 as RuntimeCommandReconciliation } from '../../control/ports/RuntimeCommandJournalV2.js';
import { AgentControlPublicCommandRouter } from '../AgentControlPublicCommandRouter.js';
import { composeAgentEntityServices } from './AgentEntityServices.js';
import {
  createAgentExecutionComponent,
  type AgentExecutionComponentHandle
} from './components/execution/AgentExecutionComponent.js';
import type {
  AgentPersistenceComponentHandle
} from './components/persistence/AgentPersistenceComponent.js';
import type {
  AgentEntityHandleOptions,
  AgentEntityManifest
} from './AgentEntityManifest.js';
import {
  createAgentProjectionComponent,
  projectionHealthError,
  type AgentProjectionComponentHandle
} from './components/projection/AgentProjectionComponent.js';

export type { AgentEntityHandleOptions } from './AgentEntityManifest.js';

/** Started Agent Entity handle that owns component lifecycle and public ingress. */
export class AgentEntityHandle implements AgentControlRuntimeLifecycle {
  public readonly schemaVersion = AGENT_CONTROL_DB_SCHEMA_VERSION;
  public readonly storageSchemas: Readonly<Record<string, number>>;
  private readonly projection: AgentProjectionComponentHandle;
  private readonly execution: AgentExecutionComponentHandle;
  private readonly publicCommands: AgentControlPublicCommandRouter;
  private readonly services: ReturnType<typeof composeAgentEntityServices>;
  private readonly unitOfWork: AgentPersistenceComponentHandle['unitOfWork'];
  private readonly persistence: AgentPersistenceComponentHandle;
  private readonly observability?: PublicAgentObservability;
  private readonly startupTrace: AgentEntityHandleOptions['startupTrace'];
  private readonly health: AgentEntityHealth;
  private lifecycle: 'new' | 'starting' | 'running' | 'failed' | 'stopping' | 'stopped' = 'new';
  private prepareOperation: Promise<void> | null = null;
  private shutdownOperation: Promise<void> | null = null;

  public constructor(manifest: AgentEntityManifest) {
    this.storageSchemas = Object.freeze({ agentControl: AGENT_CONTROL_DB_SCHEMA_VERSION,
      conversation: CONVERSATION_DB_SCHEMA_VERSION, publicProjection: PUBLIC_PROJECTION_CURRENT_DB_SCHEMA_VERSION,
      ...(manifest.persistence.productivity === undefined ? {} : { productivity: PRODUCTIVITY_DB_SCHEMA_VERSION }),
      ...(manifest.memoryAuthority === undefined ? {} : { longMemory: manifest.memoryAuthority.schemaVersion }) });
    const {
      persistence,
      options,
      executionPipeline,
      modelCatalog,
      projectionWakeEventSink,
      observability,
      liveWork
    } = manifest;
    this.persistence = persistence;
    this.startupTrace = options.startupTrace;
    this.observability = observability;
    const { unitOfWork, conversation, productivity } = persistence;
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
    this.services = composeAgentEntityServices(manifest, this.projection, envelope => this.executeOwnedCommand(envelope));
    const { commandManifest, workers } = this.services;
    this.publicCommands = new AgentControlPublicCommandRouter(commandManifest.ownerTable);
    this.health = new AgentEntityHealth(this.execution, this.projection,
      workers,
      { execution: unitOfWork, conversation, productivity, memory: manifest.memoryHealth }, commandManifest.ownerTable.diagnosticSnapshot(), manifest.inferenceAdmission);
  }

  public async start(): Promise<void> {
    if (this.lifecycle !== 'new') throw new Error('agent_control_lifecycle_already_started');
    this.lifecycle = 'starting';
    try {
      this.startupTrace?.point('execution_start');
      await this.execution.start(() => this.projection.drainPending());
      this.startupTrace?.point('execution_started');
      await this.projection.drainPending();
      if (await this.unitOfWork.countUnpublishedOutbox() !== 0) {
        throw new Error('agent_control_startup_projection_not_at_fixed_point');
      }
      this.lifecycle = 'running';
      this.startupTrace?.point('startup_workers');
      await this.health.startBackgroundWorkers();
      this.projection.activate();
      this.services.taskCenter?.start();
    } catch (error) {
      this.projection.fail(error);
      throw projectionHealthError(error);
    }
  }

  public assertHealthy(): void {
    if (this.lifecycle !== 'running') {
      throw new Error('agent_control_public_projection_not_running');
    }
    this.health.assertCoreHealthy();
  }

  public assertCommandHealthy(command: RuntimeCommand): void {
    if (this.lifecycle !== 'running') throw new Error('agent_control_public_projection_not_running');
    this.health.assertCommandHealthy(command);
  }

  public readDomainHealth(): readonly RuntimeDomainHealthSnapshot[] { return this.health.read(); }

  public executeOwnedCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult | null> {
    return this.health.execute(envelope, () => this.publicCommands.executeOwnedCommand(envelope));
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
    try { await this.services.taskCenter?.stop(context); } catch (error) { failures.push(error); }
    failures.push(...await this.health.stopBackgroundWorkers());
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
