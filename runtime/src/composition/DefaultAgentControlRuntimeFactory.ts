import { assertCanonicalAbsoluteDataRoot } from '@ariadne/protocol/host';

import type { SqliteAgentRunUnitOfWork } from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { SqlitePublicProjectionStore } from '../adapters/persistence/SqlitePublicProjectionStore.js';
import { PublicAgentObservability } from '../adapters/observability/PublicAgentObservability.js';
import type {
  AgentControlRuntimeFactory,
  AgentControlRuntimeFactoryInput
} from '../ingress/AgentControlLifecycle.js';
import { createShutdownContext } from '../ingress/ShutdownContext.js';
import {
  InferenceStreamPublicProjectionPublisher,
  type InferenceStreamIdentity
} from '../projection/InferenceStreamPublicProjectionPublisher.js';
import { PublicProjectionWakeCommitSink } from './PublicProjectionWakeCommitSink.js';
import type {
  AgentControlExecutionPipelineFactory
} from './ProductionAgentControlExecutionPipelineFactory.js';
import {
  createProductionExecutionPipelineFactory
} from './AgentControlRuntimeCompositionSupport.js';
import {
  AgentEntityHandle,
  type AgentEntityHandleOptions
} from './agent-entity/AgentEntityHandle.js';
import { compileAgentEntityManifest } from './agent-entity/AgentEntityManifest.js';
import type { RuntimeStartupTrace } from './RuntimeStartupTrace.js';
import {
  startAgentPersistenceComponent
} from './agent-entity/components/persistence/AgentPersistenceComponent.js';

export class DefaultAgentControlRuntimeFactory implements AgentControlRuntimeFactory {
  public constructor(
    private readonly lifecycleOptions: AgentEntityHandleOptions = {},
    private readonly executionPipelineFactory?: AgentControlExecutionPipelineFactory,
    private readonly startupTrace?: RuntimeStartupTrace
  ) {}

  public async create(input: AgentControlRuntimeFactoryInput): Promise<AgentEntityHandle> {
    assertCanonicalAbsoluteDataRoot(input.dataRoot);
    const executionPipelineFactory = this.executionPipelineFactory
      ?? createProductionExecutionPipelineFactory(input);
    const persistence = await startAgentPersistenceComponent(input, this.startupTrace);
    try {
      const inferenceStreams = new InferenceStreamPublicProjectionPublisher(
        persistence.publicProjection,
        input.liveInferenceEventSink
      );
      this.startupTrace?.point('inference_stream_reconcile');
      await inferenceStreams.reconcileOpenStreams(
        (identity) => resolveInferenceStreamTerminalState(persistence.unitOfWork, identity)
      );
      this.startupTrace?.point('agent_observability');
      const observability = await createPublicAgentObservability(
        input,
        persistence.publicProjection
      );
      this.startupTrace?.point('execution_pipeline_create');
      const executionPipeline = await executionPipelineFactory?.create({
        unitOfWork: persistence.unitOfWork,
        conversation: persistence.conversation,
        productivity: persistence.productivity,
        ...(input.runtimeServices?.memoryAuthority === undefined ? {} : { memoryAuthority: input.runtimeServices.memoryAuthority }),
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
      this.startupTrace?.point('agent_entity_create');
      return new AgentEntityHandle(compileAgentEntityManifest({
        persistence,
        options: { ...this.lifecycleOptions, startupTrace: this.startupTrace },
        ...(executionPipeline === null || executionPipeline === undefined
          ? {}
          : { executionPipeline }),
        modelCatalog: input.modelCatalog,
        ...(input.inferenceAdmission === undefined ? {} : { inferenceAdmission: input.inferenceAdmission }),
        ...(input.runtimeServices?.workspaceDocuments===undefined?{}:{workspaceDocuments:input.runtimeServices.workspaceDocuments}),
        projectionWakeEventSink: input.publicEventSink,
        authorizedWorkspaceIds:
          input.workspaces?.map((workspace) => workspace.workspaceId) ?? [],
        observability,
        ...(input.runtimeServices?.memoryHealth === undefined ? {} : { memoryHealth: input.runtimeServices.memoryHealth }),
        ...(input.runtimeServices?.memoryAuthority === undefined ? {} : { memoryAuthority: input.runtimeServices.memoryAuthority }),
        ...(input.runtimeServices?.liveWorkLifecycle === undefined
          ? {}
          : { liveWork: input.runtimeServices.liveWorkLifecycle }),
        ...(input.runtimeServices?.humanSkillCatalog === undefined
          ? {}
          : { humanSkillCatalog: input.runtimeServices.humanSkillCatalog })
      }));
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
