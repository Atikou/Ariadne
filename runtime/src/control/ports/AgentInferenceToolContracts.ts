import type {
  AgentAvailableTool,
  AgentPinnedToolIdentity,
  AgentRunBinding,
  AgentToolJsonValue
} from '@ariadne/agent-core';

/** Data-only model view of one exact immutable executable Tool contract. */
export interface AgentInferenceToolContractDescriptorV1 {
  readonly descriptorVersion: 1;
  readonly tool: AgentPinnedToolIdentity;
  readonly inputSchema: AgentToolJsonValue;
  readonly scopeSemantics:
    | 'none'
    | 'all_requested_workspace_scopes_must_be_granted';
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
  ): Promise<readonly AgentInferenceToolContractDescriptorV1[]>;
}
