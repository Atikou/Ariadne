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
import type {
  AgentRunExecutionIntentScheduler,
  AgentRunExecutionIntentRecoveryReporter,
  AgentRunExecutionIntentSchedulerOptions
} from './AgentRunExecutionIntentScheduler.js';
import type {
  AgentRunWorkScheduler,
  AgentRunWorkSchedulerOptions
} from './AgentRunWorkScheduler.js';
import type {
  ConversationAgentHandoffProducer,
  ConversationAgentHandoffProducerOptions
} from './ConversationAgentHandoffProducer.js';
import type { AgentInstructionAssemblyService } from '../control/ports/AgentInstructionAssembly.js';
import type { AgentLifecycleHookService } from '../control/ports/AgentLifecycleHooks.js';
import type { AgentLifecycleHookDeliverySink } from '../control/ports/AgentLifecycleObservability.js';
import type { AgentRuntimeTelemetry } from '../control/ports/AgentLifecycleObservability.js';
import type { CredentialResolver } from '../control/ports/CredentialResolver.js';
import type { ProtectedAgentEffectResultReader } from '../control/resources/ProtectedAgentEffectResultReader.js';
import { ProductionAgentLifecycleBridge } from './ProductionAgentLifecycleBridge.js';
import type { AgentSubagentExecutionProvider } from './AgentSubagentExecutionProviders.js';
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
import {
  createAgentExecutionSchedulerComponent
} from './agent-entity/components/scheduler/AgentExecutionSchedulerComponent.js';

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
    const configuredSubagentProviders = subagents.createConfiguredProviders({
      inputReader: loop.inputReader,
      directivePlanner: loop.directivePlanner,
      lifecycle
    });
    const scheduler = createAgentExecutionSchedulerComponent({
      unitOfWork: input.unitOfWork,
      conversation: input.conversation,
      loop,
      tools,
      lifecycle,
      subagentProviders: subagentProviderCatalog,
      injectedSubagentProviders,
      configuredSubagentProviders,
      recoveryReporter: this.options.recoveryReporter,
      executionScheduler: this.options.executionScheduler,
      runWorkScheduler: this.options.runWorkScheduler,
      handoffProducer: this.options.handoffProducer
    });
    const manifests = new Map(source.manifests.map((manifest) => [
      manifest.workspace.workspaceId,
      manifest
    ] as const));

    return Object.freeze({
      handoffProducer: scheduler.handoffProducer,
      executionScheduler: scheduler.executionScheduler,
      runWorkScheduler: scheduler.runWorkScheduler,
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
