import {
  AgentInferenceDispatchService,
  type DefaultAgentInferenceDirectivePlanner
} from '@ariadne/agent-core';
import {
  subagentProviderBootstrapSchema,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';

import {
  AcpSubagentAgentEngine,
  digestAcpSubagentConfiguration
} from '../../../../adapters/subagent/AcpSubagentAgentEngine.js';
import {
  ClaudeSubagentAgentEngine,
  CodexSubagentAgentEngine,
  digestProductSubagentConfiguration
} from '../../../../adapters/subagent/ProductSubagentAgentEngines.js';
import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { AgentProcessSandbox } from '../../../../control/ports/AgentProcessSandbox.js';
import type { AgentSubagentSessionStore } from '../../../../control/ports/AgentSubagentSessionStore.js';
import { V3AgentInferenceDispatchCheckpointFactory } from '../../../../control/execution/AgentInferenceDispatchCheckpointFactory.js';
import type { ProductionAgentInferenceExecutionInputReader } from '../../../../control/execution/ProductionAgentInferenceExecutionInputReader.js';
import { AgentDelegatedInferenceDispatchController } from '../../../../control/execution/AgentDelegatedInferenceDispatchController.js';
import type { ProductionAgentLifecycleBridge } from '../../../ProductionAgentLifecycleBridge.js';
import {
  ImmutableAgentSubagentExecutionProviderCatalog,
  ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR,
  type AgentSubagentExecutionProvider
} from '../../../AgentSubagentExecutionProviders.js';
import { ProductionAgentControlExecutionPipelineError } from '../../AgentExecutionPipelineErrors.js';

export interface AgentSubagentExecutionComponentInput {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly configurations?: RuntimeBootstrap['subagentProviders'];
  readonly injectedProviders?: readonly AgentSubagentExecutionProvider[];
  readonly workspaces?: RuntimeBootstrap['workspaces'];
  readonly processSandboxForWorkspace?: (workspaceRoot: string) => AgentProcessSandbox;
  readonly sessionStore?: AgentSubagentSessionStore;
}

export interface AgentSubagentExecutionRuntimeInput {
  readonly inputReader: ProductionAgentInferenceExecutionInputReader;
  readonly directivePlanner: DefaultAgentInferenceDirectivePlanner;
  readonly lifecycle: ProductionAgentLifecycleBridge;
}

export interface AgentSubagentExecutionComponentHandle {
  readonly providerCatalog: ImmutableAgentSubagentExecutionProviderCatalog;
  createConfiguredProviders(
    input: AgentSubagentExecutionRuntimeInput
  ): readonly AgentSubagentExecutionProvider[];
}

export function createAgentSubagentExecutionComponent(
  input: AgentSubagentExecutionComponentInput
): AgentSubagentExecutionComponentHandle {
  const configurations = subagentProviderBootstrapSchema.array().max(8).parse(
    input.configurations ?? []
  );
  if (
    configurations.length > 0
    && (input.processSandboxForWorkspace === undefined || input.workspaces === undefined)
  ) {
    throw new ProductionAgentControlExecutionPipelineError(
      'AGENT_EXECUTION_PIPELINE_OPTIONS_INVALID',
      'Configured external SubAgent providers require Workspace and process-sandbox services.'
    );
  }
  const injectedProviders = Object.freeze([...(input.injectedProviders ?? [])]);
  const descriptors = configurations.map((config) => ({
    providerId: config.providerId,
    displayName: config.displayName,
    configurationDigest: config.kind === 'acp_stdio'
      ? digestAcpSubagentConfiguration(config)
      : digestProductSubagentConfiguration(config),
    transport: 'external_process' as const,
    supportedModes: config.kind === 'acp_stdio' && config.sessionPersistence === 'resume'
      ? ['one_shot', 'continuable'] as const
      : ['one_shot'] as const,
    supportsStructuredReport: false,
    inheritsParentContext: false,
    usesParentTools: false
  }));
  if ([...injectedProviders.map((provider) => provider.descriptor), ...descriptors]
    .some((descriptor) => (
      descriptor.providerId === ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR.providerId
    ))) {
    throw new ProductionAgentControlExecutionPipelineError(
      'AGENT_EXECUTION_PIPELINE_OPTIONS_INVALID',
      'The ordinary SubAgent execution provider cannot be replaced.'
    );
  }
  const providerCatalog = new ImmutableAgentSubagentExecutionProviderCatalog([
    ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR,
    ...injectedProviders.map((provider) => provider.descriptor),
    ...descriptors
  ]);
  const workspaceRoots = new Map(
    (input.workspaces ?? []).map((workspace) => [workspace.workspaceId, workspace.rootPath])
  );

  const handle: AgentSubagentExecutionComponentHandle = {
    providerCatalog,
    createConfiguredProviders: (
      runtime: AgentSubagentExecutionRuntimeInput
    ) => Object.freeze(configurations.map((config) => {
      const externalEngine = config.kind === 'acp_stdio'
        ? new AcpSubagentAgentEngine({
            config,
            workspaceRoots,
            sandboxForWorkspace: input.processSandboxForWorkspace!,
            ...(input.sessionStore === undefined ? {} : { sessionStore: input.sessionStore })
          })
        : config.kind === 'codex_app_server'
          ? new CodexSubagentAgentEngine({
              config,
              workspaceRoots,
              sandboxForWorkspace: input.processSandboxForWorkspace!
            })
          : new ClaudeSubagentAgentEngine({
              config,
              workspaceRoots,
              sandboxForWorkspace: input.processSandboxForWorkspace!
            });
      const inference = new AgentInferenceDispatchService(
        input.unitOfWork,
        runtime.inputReader,
        externalEngine,
        runtime.directivePlanner,
        new V3AgentInferenceDispatchCheckpointFactory(),
        undefined,
        undefined,
        runtime.lifecycle
      );
      const delegated = new AgentDelegatedInferenceDispatchController(
        input.unitOfWork,
        inference
      );
      return {
        descriptor: descriptors.find(
          (descriptor) => descriptor.providerId === config.providerId
        )!,
        dispatchDelegatedInitial: (request, signal) => delegated.dispatchOwned(request, signal),
        dispatchFollowUp: config.kind === 'acp_stdio' && config.sessionPersistence === 'resume'
          ? (request, signal) => delegated.dispatchOwned(request, signal)
          : async () => {
              throw new Error('External SubAgent provider is pinned as one-shot.');
            }
      } satisfies AgentSubagentExecutionProvider;
    }))
  };
  return Object.freeze(handle);
}
