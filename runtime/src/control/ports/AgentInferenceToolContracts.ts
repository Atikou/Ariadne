import type {
  AgentAvailableTool,
  AgentPinnedToolIdentity,
  AgentRunBinding,
  AgentToolJsonValue
} from '@ariadne/agent-core';
import type { AgentToolModelSemanticsV1 } from './AgentToolExecution.js';

/** Data-only model view of one exact immutable executable Tool contract. */
export interface AgentInferenceToolContractDescriptorV2 {
  readonly descriptorVersion: 2;
  readonly tool: AgentPinnedToolIdentity;
  readonly model: AgentToolModelSemanticsV1;
  readonly inputSchema: AgentToolJsonValue;
  readonly scopeSemantics:
    | 'none'
    | 'all_requested_workspace_scopes_must_be_granted';
  readonly lifecycleSemantics:
    | 'bounded_invocation'
    | 'resource_create'
    | 'resource_observe'
    | 'resource_mutate'
    | 'resource_close';
}

export interface ReadAgentInferenceToolContractsRequest {
  readonly catalog: AgentRunBinding['toolCatalog'];
  readonly availableTools: readonly AgentAvailableTool[];
}

/**
 * Resolves only model-visible contract data from the exact pinned catalog.
 * Implementations never expose or invoke executable Tool callbacks.
 */
export interface AgentInferenceToolContractReader {
  readInferenceToolContracts(
    request: ReadAgentInferenceToolContractsRequest,
    signal: AbortSignal
  ): Promise<readonly AgentInferenceToolContractDescriptorV2[]>;
}
