import {
  AgentInferenceDispatchService,
  AgentSubagentDelegationService,
  DefaultAgentInferenceDirectivePlanner
} from '@ariadne/agent-core';
import type {
  AgentAdmissionAuthoritySource,
  AgentAdmissionAuthoritySourceManifest,
  RuntimeBootstrap
} from '@ariadne/protocol/host';

import { ProductionAgentEngineAdapter } from '../../../../adapters/model/ProductionAgentEngineAdapter.js';
import {
  ProductionExactAgentModelInferenceGateway,
  type ProductionExactAgentModelInferenceGatewayOptions
} from '../../../../adapters/model/ProductionExactAgentModelInferenceGateway.js';
import { Sha256AgentEffectInputDigester } from '../../../../adapters/persistence/Sha256AgentEffectInputDigester.js';
import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../../../../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { ImmutableAgentToolCatalogRegistry } from '../../../../adapters/tool/ImmutableAgentToolCatalogRegistry.js';
import { ProductionConversationAttachmentReader } from '../../../../control/conversation/ProductionConversationAttachmentReader.js';
import { V3AgentInferenceDispatchCheckpointFactory } from '../../../../control/execution/AgentInferenceDispatchCheckpointFactory.js';
import { AgentRunExecutionDispatchController } from '../../../../control/execution/AgentRunExecutionDispatchController.js';
import { ProductionAgentInferenceExecutionInputReader } from '../../../../control/execution/ProductionAgentInferenceExecutionInputReader.js';
import type { AgentInstructionAssemblyService } from '../../../../control/ports/AgentInstructionAssembly.js';
import type { ExactAgentModelInferenceRuntime } from '../../../../control/ports/AgentModelInference.js';
import type { AgentLifecycleHooks } from '../../../../control/ports/AgentLifecycleHooks.js';
import type { AgentRuntimeTelemetry } from '../../../../control/ports/AgentLifecycleObservability.js';
import type { ConversationAttachmentStore } from '../../../../control/ports/ConversationAttachmentStore.js';
import type { CredentialResolver } from '../../../../control/ports/CredentialResolver.js';
import { AgentRunAdmissionController } from '../../../../control/run/AgentRunAdmissionController.js';
import type { InferenceStreamPublicProjectionPublisher } from '../../../../projection/InferenceStreamPublicProjectionPublisher.js';
import {
  type AgentAdmissionAuthorityClock,
  compileBootstrapAgentAdmissionAuthoritySource
} from '../../../BootstrapAgentAdmissionAuthorityBundleProvider.js';
import { LifecycleHookedAgentEngine, type ProductionAgentLifecycleBridge } from '../../../ProductionAgentLifecycleBridge.js';
import { ProductionAgentRunAdmissionSnapshotReader } from '../../../ProductionAgentRunAdmissionSnapshotReader.js';
import type { ImmutableAgentSubagentExecutionProviderCatalog } from '../../../AgentSubagentExecutionProviders.js';
import { ProductionAgentControlExecutionPipelineError } from '../../AgentExecutionPipelineErrors.js';
import type { AgentToolExecutionComponentHandle } from '../tool-execution/AgentToolExecutionComponent.js';

export interface AgentInferenceLoopComponentInput {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly authoritySource: Extract<AgentAdmissionAuthoritySource, { readonly status: 'enabled' }>;
  readonly modelProviders: RuntimeBootstrap['modelProviders'];
  readonly modelInferenceGateway?: ExactAgentModelInferenceRuntime;
  readonly runtimePolicy?: RuntimeBootstrap['runtimePolicy'];
  readonly providerTelemetry?: Pick<AgentRuntimeTelemetry, 'recordProviderCall'>;
  readonly attachmentStore?: ConversationAttachmentStore;
  readonly inferenceStreamPublisher?: InferenceStreamPublicProjectionPublisher;
  readonly tools: AgentToolExecutionComponentHandle;
  readonly subagentProviders: ImmutableAgentSubagentExecutionProviderCatalog;
  readonly instructionAssembly: AgentInstructionAssemblyService;
  readonly lifecycleHooks: AgentLifecycleHooks;
  readonly lifecycle: ProductionAgentLifecycleBridge;
  readonly credentialEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly credentialResolver?: CredentialResolver;
  readonly fetch?: ProductionExactAgentModelInferenceGatewayOptions['fetch'];
  readonly now: () => number;
}

export interface AgentInferenceLoopComponentHandle {
  readonly admissions: AgentRunAdmissionController;
  readonly dispatcher: AgentRunExecutionDispatchController;
  readonly inference: AgentInferenceDispatchService;
  readonly inputReader: ProductionAgentInferenceExecutionInputReader;
  readonly directivePlanner: DefaultAgentInferenceDirectivePlanner;
  readonly modelAvailability: Pick<ExactAgentModelInferenceRuntime, 'hasExactBinding'>;
  hasExactModelAuthority(manifest: AgentAdmissionAuthoritySourceManifest): boolean;
}

/** Owns exact model admission, inference preparation, and the required Agent loop. */
export function createAgentInferenceLoopComponent(
  input: AgentInferenceLoopComponentInput
): AgentInferenceLoopComponentHandle {
  if (input.modelInferenceGateway === undefined && input.runtimePolicy === undefined) {
    throw new ProductionAgentControlExecutionPipelineError(
      'AGENT_EXECUTION_PIPELINE_OPTIONS_INVALID',
      'The exact model gateway requires a frozen Runtime resilience policy.'
    );
  }
  const models = input.modelInferenceGateway
    ?? new ProductionExactAgentModelInferenceGateway({
      modelProviders: input.modelProviders,
      agentAdmissionAuthoritySource: input.authoritySource,
      credentialEnvironment: input.credentialEnvironment,
      credentialResolver: input.credentialResolver,
      resiliencePolicy: input.runtimePolicy!.providerResilience,
      ...(input.providerTelemetry === undefined
        ? {}
        : { providerTelemetry: input.providerTelemetry }),
      ...(input.fetch === undefined ? {} : { fetch: input.fetch })
    });
  const clock: AgentAdmissionAuthorityClock = { now: input.now };
  const authorities = compileBootstrapAgentAdmissionAuthoritySource(
    input.authoritySource,
    clock,
    models
  );
  const snapshots = new ProductionAgentRunAdmissionSnapshotReader(
    input.conversation,
    authorities,
    input.tools.catalogs,
    input.instructionAssembly,
    input.lifecycleHooks,
    input.subagentProviders.list()
  );
  const admissions = new AgentRunAdmissionController(input.unitOfWork, snapshots);
  const attachments = input.attachmentStore === undefined
    ? undefined
    : new ProductionConversationAttachmentReader(
        input.conversation,
        input.attachmentStore
      );
  const engine = new LifecycleHookedAgentEngine(
    new ProductionAgentEngineAdapter(
      models,
      input.tools.catalogs,
      input.inferenceStreamPublisher,
      input.tools.effectInputReader,
      attachments
    ),
    input.lifecycleHooks
  );
  const inputReader = new ProductionAgentInferenceExecutionInputReader(
    input.unitOfWork,
    input.unitOfWork
  );
  const directivePlanner = new DefaultAgentInferenceDirectivePlanner(
    new Sha256AgentEffectInputDigester(),
    input.tools.catalogs,
    input.subagentProviders
  );
  const inference = new AgentInferenceDispatchService(
    input.unitOfWork,
    inputReader,
    engine,
    directivePlanner,
    new V3AgentInferenceDispatchCheckpointFactory(),
    undefined,
    new AgentSubagentDelegationService(input.unitOfWork),
    input.lifecycle
  );

  return Object.freeze({
    admissions,
    dispatcher: new AgentRunExecutionDispatchController(input.unitOfWork, inference),
    inference,
    inputReader,
    directivePlanner,
    modelAvailability: models,
    hasExactModelAuthority: (manifest: AgentAdmissionAuthoritySourceManifest): boolean => {
      return (manifest.modelCandidates ?? [manifest.model]).some((binding) => (
        models.hasExactBinding(binding)
      ));
    }
  });
}
