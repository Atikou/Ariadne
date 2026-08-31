import {
  AgentEffectDispatchService,
  AgentInferenceDispatchService,
  AgentSubagentDelegationService,
  DefaultAgentInferenceDirectivePlanner,
  type AgentRunBinding
} from '@ariadne/agent-core';
import {
  agentAdmissionAuthoritySourceSchema,
  type AgentAdmissionAuthoritySource,
  type AgentAdmissionAuthoritySourceManifest,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';

import {
  ProductionAgentEngineAdapter
} from '../adapters/model/ProductionAgentEngineAdapter.js';
import {
  ProductionExactAgentModelInferenceGateway,
  type ProductionExactAgentModelInferenceGatewayOptions
} from '../adapters/model/ProductionExactAgentModelInferenceGateway.js';
import type {
  ExactAgentModelInferenceRuntime
} from '../control/ports/AgentModelInference.js';
import type { AgentProcessSandbox } from '../control/ports/AgentProcessSandbox.js';
import type { AgentSubagentSessionStore } from '../control/ports/AgentSubagentSessionStore.js';
import {
  Sha256AgentEffectInputDigester
} from '../adapters/persistence/Sha256AgentEffectInputDigester.js';
import type {
  SqliteAgentRunUnitOfWork
} from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type {
  SqliteConversationRunHandoffUnitOfWork
} from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { InferenceStreamPublicProjectionPublisher } from '../projection/InferenceStreamPublicProjectionPublisher.js';
import type { ConversationAttachmentStore } from '../control/ports/ConversationAttachmentStore.js';
import type { AgentToolPresentationResolver } from '../projection/AgentRunProjectionPorts.js';
import {
  ImmutableAgentToolCatalogRegistry
} from '../adapters/tool/ImmutableAgentToolCatalogRegistry.js';
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
  V3AgentEffectDispatchCheckpointFactory
} from '../control/execution/AgentEffectDispatchCheckpointFactory.js';
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
  V3AgentInferenceDispatchCheckpointFactory
} from '../control/execution/AgentInferenceDispatchCheckpointFactory.js';
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
  AgentRunExecutionDispatchController
} from '../control/execution/AgentRunExecutionDispatchController.js';
import {
  AgentStartedWorkRecoveryCoordinator
} from '../control/execution/AgentStartedWorkRecoveryCoordinator.js';
import {
  ProductionAgentEffectExecutionInputReader
} from '../control/execution/ProductionAgentEffectExecutionInputReader.js';
import {
  ProductionAgentInferenceExecutionInputReader
} from '../control/execution/ProductionAgentInferenceExecutionInputReader.js';
import {
  AgentRunAdmissionController
} from '../control/run/AgentRunAdmissionController.js';
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
  type AgentAdmissionAuthorityClock,
  compileBootstrapAgentAdmissionAuthoritySource
} from './BootstrapAgentAdmissionAuthorityBundleProvider.js';
import {
  ConversationAgentHandoffCoordinator
} from './ConversationAgentHandoffCoordinator.js';
import {
  ConversationAgentHandoffProducer,
  type ConversationAgentHandoffProducerOptions
} from './ConversationAgentHandoffProducer.js';
import {
  ProductionAgentRunAdmissionSnapshotReader
} from './ProductionAgentRunAdmissionSnapshotReader.js';
import type { AgentInstructionAssemblyService } from '../control/ports/AgentInstructionAssembly.js';
import type { AgentLifecycleHookService } from '../control/ports/AgentLifecycleHooks.js';
import type { AgentLifecycleHookDeliverySink } from '../control/ports/AgentLifecycleObservability.js';
import type { AgentRuntimeTelemetry } from '../control/ports/AgentLifecycleObservability.js';
import type { CredentialResolver } from '../control/ports/CredentialResolver.js';
import {
  ProductionAgentRunWorkAuthorityVerifier
} from './ProductionAgentRunWorkAuthorityVerifier.js';
import { ProtectedAgentEffectResultReader } from '../control/resources/ProtectedAgentEffectResultReader.js';
import { ProductionConversationAttachmentReader } from '../control/conversation/ProductionConversationAttachmentReader.js';
import {
  LifecycleHookedAgentEngine,
  ProductionAgentLifecycleBridge
} from './ProductionAgentLifecycleBridge.js';
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

export {
  AgentControlConversationMessageAdmissionError,
  ProductionAgentControlExecutionPipelineError
} from './agent-entity/AgentExecutionPipelineErrors.js';

const PREFLIGHT_DIGEST = `sha256:${'0'.repeat(64)}`;

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
    const protectedEffectResultReader = new ProtectedAgentEffectResultReader(
      input.unitOfWork
    );
    const catalogs = new ImmutableAgentToolCatalogRegistry(
      this.options.toolCatalogSnapshots,
      lifecycleHooks,
      {
        protectedEffectResults: protectedEffectResultReader
      }
    );
    await assertCatalogAuthorities(source, catalogs);
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

    if (input.modelInferenceGateway === undefined && input.runtimePolicy === undefined) {
      throw new ProductionAgentControlExecutionPipelineError(
        'AGENT_EXECUTION_PIPELINE_OPTIONS_INVALID',
        'The exact model gateway requires a frozen Runtime resilience policy.'
      );
    }
    const models = input.modelInferenceGateway
      ?? new ProductionExactAgentModelInferenceGateway({
        modelProviders: input.modelProviders,
        agentAdmissionAuthoritySource: source,
        credentialEnvironment: this.options.credentialEnvironment,
        credentialResolver: this.options.credentialResolver,
        resiliencePolicy: input.runtimePolicy!.providerResilience,
        ...(input.providerTelemetry === undefined
          ? {}
          : { providerTelemetry: input.providerTelemetry }),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch })
      });
    const authorityClock: AgentAdmissionAuthorityClock = { now: this.now };
    const authorities = compileBootstrapAgentAdmissionAuthoritySource(
      source,
      authorityClock,
      models
    );
    const snapshots = new ProductionAgentRunAdmissionSnapshotReader(
      input.conversation,
      authorities,
      catalogs,
      this.options.instructionAssembly,
      lifecycleHooks,
      subagentProviderCatalog.list()
    );
    const admissions = new AgentRunAdmissionController(input.unitOfWork, snapshots);
    const effectInputReader = new ProductionAgentEffectExecutionInputReader(
      input.unitOfWork
    );
    const attachmentReader = input.attachmentStore === undefined
      ? undefined
      : new ProductionConversationAttachmentReader(
          input.conversation,
          input.attachmentStore
        );
    const engine = new LifecycleHookedAgentEngine(
      new ProductionAgentEngineAdapter(
        models,
        catalogs,
        input.inferenceStreamPublisher,
        effectInputReader,
        attachmentReader
      ),
      lifecycleHooks
    );
    const inputReader = new ProductionAgentInferenceExecutionInputReader(
      input.unitOfWork,
      input.unitOfWork
    );
    const directivePlanner = new DefaultAgentInferenceDirectivePlanner(
      new Sha256AgentEffectInputDigester(),
      catalogs,
      subagentProviderCatalog
    );
    const inference = new AgentInferenceDispatchService(
      input.unitOfWork,
      inputReader,
      engine,
      directivePlanner,
      new V3AgentInferenceDispatchCheckpointFactory(),
      undefined,
      new AgentSubagentDelegationService(input.unitOfWork),
      lifecycle
    );
    const configuredSubagentProviders = subagents.createConfiguredProviders({
      inputReader,
      directivePlanner,
      lifecycle
    });
    const dispatcher = new AgentRunExecutionDispatchController(
      input.unitOfWork,
      inference
    );
    const effects = new AgentEffectDispatchService(
      input.unitOfWork,
      effectInputReader,
      catalogs,
      new V3AgentEffectDispatchCheckpointFactory(),
      undefined,
      lifecycle
    );
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
          models,
          catalogs,
          subagentProviderCatalog
        )
      }
    );
    const executionScheduler = new AgentRunExecutionIntentScheduler(
      input.unitOfWork,
      dispatcher,
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
      admissions,
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
      protectedEffectResultReader,
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
        if (!catalogs.hasExactCatalog(catalogReference(manifest))) {
          throw new AgentControlConversationMessageAdmissionError(
            'tool_catalog_unavailable'
          );
        }
        const binding = models.resolveBinding(manifest.model.settingsRevision);
        if (binding === null || !models.hasExactBinding(binding)) {
          throw new AgentControlConversationMessageAdmissionError(
            'model_binding_unavailable'
          );
        }
      },
      observeRuntimeStop: (occurredAt: string): void => lifecycle.observeRuntimeStop(occurredAt)
    });
  }
}

async function assertCatalogAuthorities(
  source: Extract<AgentAdmissionAuthoritySource, { readonly status: 'enabled' }>,
  catalogs: ImmutableAgentToolCatalogRegistry
): Promise<void> {
  for (const manifest of source.manifests) {
    const reference = catalogReference(manifest);
    if (!catalogs.hasExactCatalog(reference)) {
      throw new ProductionAgentControlExecutionPipelineError(
        'AGENT_EXECUTION_TOOL_CATALOG_MISSING',
        'An enabled Agent authority references an unavailable Tool Catalog.'
      );
    }
    const catalog = await catalogs.readToolCatalog(
      reference,
      new AbortController().signal
    );
    if (catalog === null) {
      throw new ProductionAgentControlExecutionPipelineError(
        'AGENT_EXECUTION_TOOL_CATALOG_MISSING',
        'An enabled Agent authority references an unavailable Tool Catalog.'
      );
    }
    try {
      catalog.resolveAdmissionTools(preflightBinding(manifest));
    } catch (cause) {
      throw new ProductionAgentControlExecutionPipelineError(
        'AGENT_EXECUTION_TOOL_CATALOG_INVALID',
        'An enabled Agent authority contradicts its immutable Tool Catalog.',
        { cause }
      );
    }
  }
}

function catalogReference(manifest: AgentAdmissionAuthoritySourceManifest) {
  return {
    referenceVersion: 1 as const,
    catalogId: manifest.toolCatalog.catalogId,
    revision: manifest.toolCatalog.revision,
    digest: manifest.toolCatalog.digest
  };
}

function preflightBinding(
  manifest: AgentAdmissionAuthoritySourceManifest
): AgentRunBinding {
  const runId = 'agent-execution-pipeline-preflight-run';
  return {
    bindingVersion: 3,
    sessionId: 'agent-execution-pipeline-preflight-session',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: 'agent-execution-pipeline-preflight-message',
      messageVersion: 1,
      contentDigest: PREFLIGHT_DIGEST
    },
    workspace: {
      ...manifest.workspace,
      scopeIds: [...manifest.workspace.scopeIds]
    },
    model: { ...manifest.model },
    policy: { ...manifest.policy },
    capabilities: manifest.capabilityGrant.capabilities.map((capability) => ({
      capabilityId: capability.capabilityId,
      scopeIds: [...capability.scopeIds]
    })),
    toolCatalog: {
      ...manifest.toolCatalog,
      allowedToolNames: [...manifest.toolCatalog.allowedToolNames]
    },
    budget: {
      grantId: manifest.rootBudget.authorityId,
      runId,
      vector: { ...manifest.rootBudget.vector },
      deadlineAt: manifest.rootBudget.deadlinePolicy.deadlineAt,
      source: { kind: 'root' }
    }
  };
}
