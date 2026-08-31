import {
  agentAdmissionAuthoritySourceSchema,
  type AgentAdmissionAuthoritySource,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';

import {
  type ProductionExactAgentModelInferenceGatewayOptions
} from '../adapters/model/ProductionExactAgentModelInferenceGateway.js';
import type {
  ExactAgentModelInferenceRuntime
} from '../control/ports/AgentModelInference.js';
import type { AgentProcessSandbox } from '../control/ports/AgentProcessSandbox.js';
import type { AgentSubagentSessionStore } from '../control/ports/AgentSubagentSessionStore.js';
import type {
  SqliteAgentRunUnitOfWork
} from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type {
  SqliteConversationRunHandoffUnitOfWork
} from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { InferenceStreamPublicProjectionPublisher } from '../projection/InferenceStreamPublicProjectionPublisher.js';
import type { ConversationAttachmentStore } from '../control/ports/ConversationAttachmentStore.js';
import type { AgentToolPresentationResolver } from '../projection/AgentRunProjectionPorts.js';
import type {
  TrustedAgentToolCatalogSnapshot
} from '../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import {
  ConversationRunHandoffSagaService
} from '../control/conversation/ConversationRunHandoffSagaService.js';
import {
  ConversationAgentStartFailureProjectionService
} from '../control/conversation/ConversationAgentStartFailureProjectionService.js';
import {
  AgentEffectContinuationController
} from '../control/execution/AgentEffectContinuationController.js';
import {
  AgentInboxContinuationController
} from '../control/execution/AgentInboxContinuationController.js';
import {
  AgentFollowUpInferenceDispatchController
} from '../control/execution/AgentFollowUpInferenceDispatchController.js';
import {
  AgentDelegatedInferenceDispatchController
} from '../control/execution/AgentDelegatedInferenceDispatchController.js';
import {
  AgentChildResultsContinuationController
} from '../control/execution/AgentChildResultsContinuationController.js';
import {
  ProtectedAgentTerminalAssistantContentResolver
} from './ProtectedAgentTerminalAssistantContentResolver.js';
import {
  AgentRunWorkClassifier
} from '../control/execution/AgentRunWorkClassifier.js';
import {
  AgentContinuationBoundaryTerminalizationCoordinator
} from '../control/execution/AgentContinuationBoundaryTerminalizationCoordinator.js';
import {
  AgentRetiredToolCatalogTerminalizationCoordinator
} from '../control/execution/AgentRetiredToolCatalogTerminalizationCoordinator.js';
import {
  AgentStartedWorkRecoveryCoordinator
} from '../control/execution/AgentStartedWorkRecoveryCoordinator.js';
import {
  AgentRunExecutionIntentScheduler,
  type AgentRunExecutionIntentRecoveryReporter,
  type AgentRunExecutionIntentSchedulerOptions
} from './AgentRunExecutionIntentScheduler.js';
import {
  AgentRunWorkScheduler,
  type AgentRunWorkSchedulerOptions
} from './AgentRunWorkScheduler.js';
import {
  ConversationAgentHandoffCoordinator
} from './ConversationAgentHandoffCoordinator.js';
import {
  ConversationAgentHandoffProducer,
  type ConversationAgentHandoffProducerOptions
} from './ConversationAgentHandoffProducer.js';
import type { AgentInstructionAssemblyService } from '../control/ports/AgentInstructionAssembly.js';
import type { AgentLifecycleHookService } from '../control/ports/AgentLifecycleHooks.js';
import type { AgentLifecycleHookDeliverySink } from '../control/ports/AgentLifecycleObservability.js';
import type { AgentRuntimeTelemetry } from '../control/ports/AgentLifecycleObservability.js';
import type { CredentialResolver } from '../control/ports/CredentialResolver.js';
import {
  ProductionAgentRunWorkAuthorityVerifier
} from './ProductionAgentRunWorkAuthorityVerifier.js';
import type { ProtectedAgentEffectResultReader } from '../control/resources/ProtectedAgentEffectResultReader.js';
import { ProductionAgentLifecycleBridge } from './ProductionAgentLifecycleBridge.js';
import {
  AgentSubagentExecutionProviderRouter,
  ordinaryRunSubagentExecutionProvider,
  type AgentSubagentExecutionProvider
} from './AgentSubagentExecutionProviders.js';
import {
  AgentControlConversationMessageAdmissionError,
  ProductionAgentControlExecutionPipelineError
} from './agent-entity/AgentExecutionPipelineErrors.js';
import {
  createAgentSubagentExecutionComponent
} from './agent-entity/components/subagent/AgentSubagentExecutionComponent.js';
import {
  createAgentToolExecutionComponent
} from './agent-entity/components/tool-execution/AgentToolExecutionComponent.js';
import {
  createAgentInferenceLoopComponent
} from './agent-entity/components/inference-loop/AgentInferenceLoopComponent.js';

export {
  AgentControlConversationMessageAdmissionError,
  ProductionAgentControlExecutionPipelineError
} from './agent-entity/AgentExecutionPipelineErrors.js';

export interface AgentControlExecutionPipeline {
  readonly handoffProducer: ConversationAgentHandoffProducer;
  readonly executionScheduler: AgentRunExecutionIntentScheduler;
  readonly runWorkScheduler: AgentRunWorkScheduler;
  readonly toolPresentationResolver: AgentToolPresentationResolver;
  readonly protectedEffectResultReader?: ProtectedAgentEffectResultReader;
  /** Synchronous, pre-write gate for one new Conversation objective. */
  assertConversationMessageAdmission(workspaceId: string): void;
  observeRuntimeStop(occurredAt: string): void;
}

export interface AgentControlExecutionPipelineFactoryInput {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly agentAdmissionAuthoritySource: AgentAdmissionAuthoritySource;
  readonly modelProviders: RuntimeBootstrap['modelProviders'];
  readonly subagentProviders?: RuntimeBootstrap['subagentProviders'];
  readonly modelInferenceGateway?: ExactAgentModelInferenceRuntime;
  readonly installRoot?: string;
  readonly workspaces?: RuntimeBootstrap['workspaces'];
  readonly runtimePolicy?: RuntimeBootstrap['runtimePolicy'];
  readonly hookDeliverySink?: AgentLifecycleHookDeliverySink;
  readonly inferenceStreamPublisher?: InferenceStreamPublicProjectionPublisher;
  readonly processSandboxForWorkspace?: (workspaceRoot: string) => AgentProcessSandbox;
  readonly providerTelemetry?: Pick<AgentRuntimeTelemetry, 'recordProviderCall'>;
  readonly attachmentStore?: ConversationAttachmentStore;
  readonly subagentSessionStore?: AgentSubagentSessionStore;
}

export interface AgentControlExecutionPipelineFactory {
  create(
    input: AgentControlExecutionPipelineFactoryInput
  ): Promise<AgentControlExecutionPipeline | null>;
}

export interface ProductionAgentControlExecutionPipelineFactoryOptions {
  readonly toolCatalogSnapshots: readonly TrustedAgentToolCatalogSnapshot[];
  readonly credentialEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly credentialResolver?: CredentialResolver;
  readonly instructionAssembly: AgentInstructionAssemblyService;
  readonly lifecycleHooks: AgentLifecycleHookService;
  readonly recoveryReporter: AgentRunExecutionIntentRecoveryReporter;
  readonly fetch?: ProductionExactAgentModelInferenceGatewayOptions['fetch'];
  readonly now?: () => number;
  readonly handoffProducer?: ConversationAgentHandoffProducerOptions;
  readonly executionScheduler?: Omit<
    AgentRunExecutionIntentSchedulerOptions,
    'onSettled' | 'startedInitialInferenceRecovery'
  >;
  readonly runWorkScheduler?: Omit<
    AgentRunWorkSchedulerOptions,
    | 'startedWorkRecovery'
    | 'authorityVerifier'
    | 'retiredToolCatalogTerminalizations'
  >;
  /** Frozen startup providers; ordinary in-process Child Runs are always present. */
  readonly subagentExecutionProviders?: readonly AgentSubagentExecutionProvider[];
  readonly liveWorkLifecycle?: {
    closeOwner(runId: string): void | Promise<void>;
  };
}

/**
 * Creates one complete, store-bound v3 execution pipeline per Runtime instance.
 * Disabled authority is represented by null; no legacy Engine, router, Tool
 * registry, Provider fallback, or process-global producer is consulted.
 */
export class ProductionAgentControlExecutionPipelineFactory
implements AgentControlExecutionPipelineFactory {
  private readonly now: () => number;

  public constructor(
    private readonly options: ProductionAgentControlExecutionPipelineFactoryOptions
  ) {
    if (
      options === null
      || typeof options !== 'object'
      || !Array.isArray(options.toolCatalogSnapshots)
      || options.credentialEnvironment === null
      || typeof options.credentialEnvironment !== 'object'
      || options.recoveryReporter === null
      || typeof options.recoveryReporter !== 'object'
      || typeof options.recoveryReporter.reportExecutionIntentRecovery !== 'function'
      || options.instructionAssembly === null
      || typeof options.instructionAssembly !== 'object'
      || typeof options.instructionAssembly.assemble !== 'function'
      || options.lifecycleHooks === null
      || typeof options.lifecycleHooks !== 'object'
      || typeof options.lifecycleHooks.bind !== 'function'
      || typeof options.lifecycleHooks.close !== 'function'
      || (options.fetch !== undefined && typeof options.fetch !== 'function')
      || (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw new ProductionAgentControlExecutionPipelineError(
        'AGENT_EXECUTION_PIPELINE_OPTIONS_INVALID',
        'Production Agent execution pipeline options are invalid.'
      );
    }
    this.now = options.now ?? (() => Date.now());
  }

  public async create(
    input: AgentControlExecutionPipelineFactoryInput
  ): Promise<AgentControlExecutionPipeline | null> {
    const source = agentAdmissionAuthoritySourceSchema.parse(
      input.agentAdmissionAuthoritySource
    );
    if (source.status === 'disabled') return null;

    const lifecycleHooks = this.options.lifecycleHooks.bind(input.hookDeliverySink);
    const lifecycle = new ProductionAgentLifecycleBridge(
      lifecycleHooks,
      this.options.liveWorkLifecycle
    );
    const tools = await createAgentToolExecutionComponent({
      unitOfWork: input.unitOfWork,
      authoritySource: source,
      catalogSnapshots: this.options.toolCatalogSnapshots,
      lifecycleHooks
    });
    const catalogs = tools.catalogs;
    const injectedSubagentProviders = this.options.subagentExecutionProviders ?? [];
    const subagents = createAgentSubagentExecutionComponent({
      unitOfWork: input.unitOfWork,
      configurations: input.subagentProviders,
      injectedProviders: injectedSubagentProviders,
      workspaces: input.workspaces,
      processSandboxForWorkspace: input.processSandboxForWorkspace,
      sessionStore: input.subagentSessionStore
    });
    const subagentProviderCatalog = subagents.providerCatalog;
    const loop = createAgentInferenceLoopComponent({
      unitOfWork: input.unitOfWork,
      conversation: input.conversation,
      authoritySource: source,
      modelProviders: input.modelProviders,
      modelInferenceGateway: input.modelInferenceGateway,
      runtimePolicy: input.runtimePolicy,
      providerTelemetry: input.providerTelemetry,
      attachmentStore: input.attachmentStore,
      inferenceStreamPublisher: input.inferenceStreamPublisher,
      tools,
      subagentProviders: subagentProviderCatalog,
      instructionAssembly: this.options.instructionAssembly,
      lifecycleHooks,
      lifecycle,
      credentialEnvironment: this.options.credentialEnvironment,
      credentialResolver: this.options.credentialResolver,
      fetch: this.options.fetch,
      now: this.now
    });
    const inference = loop.inference;
    const configuredSubagentProviders = subagents.createConfiguredProviders({
      inputReader: loop.inputReader,
      directivePlanner: loop.directivePlanner,
      lifecycle
    });
    const effects = tools.createEffectDispatch(lifecycle);
    const continuations = new AgentEffectContinuationController(
      input.unitOfWork,
      input.unitOfWork
    );
    const inboxContinuations = new AgentInboxContinuationController(
      input.unitOfWork,
      input.unitOfWork
    );
    const followUps = new AgentFollowUpInferenceDispatchController(
      input.unitOfWork,
      inference
    );
    const delegatedInference = new AgentDelegatedInferenceDispatchController(
      input.unitOfWork,
      inference
    );
    const subagentProviderRouter = new AgentSubagentExecutionProviderRouter(
      input.unitOfWork,
      [
        ordinaryRunSubagentExecutionProvider(delegatedInference, followUps),
        ...injectedSubagentProviders,
        ...configuredSubagentProviders
      ]
    );
    const childResultsContinuation = new AgentChildResultsContinuationController(
      input.unitOfWork,
      input.unitOfWork,
      new ProtectedAgentTerminalAssistantContentResolver(input.unitOfWork)
    );
    const startedWorkRecovery = new AgentStartedWorkRecoveryCoordinator(
      input.unitOfWork
    );
    const terminalizations = new AgentContinuationBoundaryTerminalizationCoordinator(
      input.unitOfWork
    );
    const retiredToolCatalogTerminalizations =
      new AgentRetiredToolCatalogTerminalizationCoordinator(input.unitOfWork);
    const runWorkScheduler = new AgentRunWorkScheduler(
      input.unitOfWork,
      new AgentRunWorkClassifier(),
      effects,
      continuations,
      inboxContinuations,
      followUps,
      terminalizations,
      {
        ...this.options.runWorkScheduler,
        startedWorkRecovery,
        delegatedInference: subagentProviderRouter.delegatedInitial,
        delegatedFollowUps: subagentProviderRouter.followUp,
        childResultsContinuation,
        retiredToolCatalogTerminalizations,
        authorityVerifier: new ProductionAgentRunWorkAuthorityVerifier(
          loop.modelAvailability,
          catalogs,
          subagentProviderCatalog
        )
      }
    );
    const executionScheduler = new AgentRunExecutionIntentScheduler(
      input.unitOfWork,
      loop.dispatcher,
      this.options.recoveryReporter,
      {
        ...this.options.executionScheduler,
        startedInitialInferenceRecovery: startedWorkRecovery,
        // Follow-up work becomes eligible only after the initial execution
        // intent has crossed its durable settlement boundary.
        onSettled: () => runWorkScheduler.wake()
      }
    );
    const handoffs = new ConversationRunHandoffSagaService(input.conversation);
    const coordinator = new ConversationAgentHandoffCoordinator(
      input.conversation,
      handoffs,
      loop.admissions,
      input.unitOfWork,
      {},
      new ConversationAgentStartFailureProjectionService(input.conversation)
    );
    const handoffProducer = new ConversationAgentHandoffProducer({
      drainToFixedPoint: async (request) => {
        const result = await coordinator.drainToFixedPoint(request);
        // Admission creates execution intents at the Handoff fixed point. Wake
        // only after that durable boundary so a fast scheduler cannot miss the
        // newly admitted work and defer it to its periodic timer.
        executionScheduler.wake();
        return result;
      }
    }, this.options.handoffProducer);
    const manifests = new Map(source.manifests.map((manifest) => [
      manifest.workspace.workspaceId,
      manifest
    ] as const));

    return Object.freeze({
      handoffProducer,
      executionScheduler,
      runWorkScheduler,
      toolPresentationResolver: catalogs,
      protectedEffectResultReader: tools.protectedEffectResultReader,
      assertConversationMessageAdmission: (workspaceId: string): void => {
        const manifest = manifests.get(workspaceId);
        if (manifest === undefined) {
          throw new AgentControlConversationMessageAdmissionError(
            'workspace_authority_missing'
          );
        }
        const now = this.now();
        if (
          !Number.isFinite(now)
          || Date.parse(manifest.rootBudget.deadlinePolicy.deadlineAt) <= now
        ) {
          throw new AgentControlConversationMessageAdmissionError('authority_expired');
        }
        if (!tools.hasExactAuthority(manifest)) {
          throw new AgentControlConversationMessageAdmissionError(
            'tool_catalog_unavailable'
          );
        }
        if (!loop.hasExactModelAuthority(manifest)) {
          throw new AgentControlConversationMessageAdmissionError(
            'model_binding_unavailable'
          );
        }
      },
      observeRuntimeStop: (occurredAt: string): void => lifecycle.observeRuntimeStop(occurredAt)
    });
  }
}
