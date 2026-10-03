import { createHash } from 'node:crypto';
import {
  DEFAULT_AGENT_SUBAGENT_PROVIDER_BINDING,
  assertValidAgentPinnedToolIdentity,
  cloneAgentPinnedToolIdentity,
  cloneCanonicalAgentToolInput,
  sameAgentPinnedToolIdentity,
  type AgentAvailableTool,
  type AgentPinnedToolIdentity,
  type AgentRunBinding,
  type AgentSubagentProviderBinding,
  type AgentToolJsonValue,
  type AgentTurnInput
} from '@ariadne/agent-core';
import type { ExactAgentModelInferenceToolContract } from '../../control/ports/AgentModelInference.js';
import { estimateMessagesTokens } from './V3LongContextLifecycle.js';
import type { AgentInferenceToolContractDescriptorV2 } from '../../control/ports/AgentInferenceToolContracts.js';
import {
  type AgentToolCatalogBinding,
  CONTROL_PROVIDER_NAMES,
  type NativeControlKind,
  type PreparedToolContract,
  TOOL_CONTRACT_ERROR,
  canonicalJson,
  compareCodeUnits,
  deterministicFailure,
  isPlainObject
} from './AgentModelProtocol.js';
import { textMessage } from './AgentModelHistory.js';

export function prepareToolContracts(
  input: AgentTurnInput,
  descriptors: readonly AgentInferenceToolContractDescriptorV2[]
): readonly PreparedToolContract[] {
  if (!Array.isArray(descriptors)) {
    throw deterministicFailure(
      TOOL_CONTRACT_ERROR,
      'The immutable Tool contract reader returned an invalid collection.'
    );
  }
  const availableByName = new Map(
    input.availableTools.map((available) => [available.tool.toolName, available] as const)
  );
  const preparedByName = new Map<string, PreparedToolContract>();
  for (const descriptor of descriptors) {
    if (!isExactDescriptor(descriptor)) {
      throw deterministicFailure(
        TOOL_CONTRACT_ERROR,
        'The immutable Tool contract reader returned a malformed descriptor.'
      );
    }
    try {
      assertValidAgentPinnedToolIdentity(descriptor.tool, 'toolContract.tool');
    } catch {
      throw deterministicFailure(
        TOOL_CONTRACT_ERROR,
        'A model-visible Tool contract has an invalid pinned identity.'
      );
    }
    const available = availableByName.get(descriptor.tool.toolName);
    if (
      available === undefined
      || preparedByName.has(descriptor.tool.toolName)
      || !sameAgentPinnedToolIdentity(descriptor.tool, available.tool)
    ) {
      throw deterministicFailure(
        TOOL_CONTRACT_ERROR,
        'Model-visible Tool contracts do not match the exact Turn catalog.'
      );
    }
    let inputSchema: AgentToolJsonValue;
    try {
      inputSchema = cloneCanonicalAgentToolInput(
        descriptor.inputSchema,
        `toolContract.${descriptor.tool.toolName}.inputSchema`
      );
    } catch {
      throw deterministicFailure(
        TOOL_CONTRACT_ERROR,
        'A model-visible Tool contract contains an invalid input schema.'
      );
    }
    const allowedScopes = resolveAllowedScopes(
      input.run.binding,
      available,
      descriptor.scopeSemantics
    );
    preparedByName.set(descriptor.tool.toolName, Object.freeze({
      tool: cloneAgentPinnedToolIdentity(descriptor.tool),
      capabilityIds: Object.freeze([...available.capabilityIds]),
      inputSchema,
      scopeSemantics: descriptor.scopeSemantics,
      lifecycleSemantics: descriptor.lifecycleSemantics,
      allowedScopes: Object.freeze(allowedScopes),
      providerToolName: providerToolName(descriptor.tool),
      providerInputSchema: providerInputSchema(inputSchema, allowedScopes),
      providerDescription: renderProviderToolDescription(descriptor)
    }));
  }
  if (preparedByName.size !== availableByName.size) {
    throw deterministicFailure(
      TOOL_CONTRACT_ERROR,
      'The immutable Tool contract reader did not resolve every exact Turn Tool.'
    );
  }
  return Object.freeze(input.availableTools.map((available) => {
    const prepared = preparedByName.get(available.tool.toolName);
    if (prepared === undefined) {
      throw deterministicFailure(
        TOOL_CONTRACT_ERROR,
        'The immutable Tool contract set changed while preparing inference.'
      );
    }
    return prepared;
  }));
}

function renderProviderToolDescription(
  descriptor: AgentInferenceToolContractDescriptorV2
): string {
  return descriptor.model.guidance.length === 0
    ? descriptor.model.description
    : [
        descriptor.model.description,
        'Usage guidance:',
        ...descriptor.model.guidance.map((item) => `- ${item}`)
      ].join('\n');
}

function resolveAllowedScopes(
  binding: AgentRunBinding,
  available: AgentAvailableTool,
  semantics: AgentInferenceToolContractDescriptorV2['scopeSemantics']
): string[] {
  if (semantics === 'none') return [];
  const grants = new Map(binding.capabilities.map((grant) => [
    grant.capabilityId,
    new Set(grant.scopeIds)
  ] as const));
  let allowed = new Set(binding.workspace.scopeIds);
  for (const capabilityId of available.capabilityIds) {
    const grantedScopes = grants.get(capabilityId);
    if (grantedScopes === undefined) {
      throw deterministicFailure(
        TOOL_CONTRACT_ERROR,
        'A model-visible Tool requires a Capability absent from the Run binding.'
      );
    }
    allowed = new Set([...allowed].filter((scopeId) => grantedScopes.has(scopeId)));
  }
  return [...allowed].sort(compareCodeUnits);
}

function isExactDescriptor(
  value: unknown
): value is AgentInferenceToolContractDescriptorV2 {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 6
    && keys.every((key) => [
      'descriptorVersion',
      'tool',
      'model',
      'inputSchema',
      'scopeSemantics',
      'lifecycleSemantics'
    ].includes(key))
    && value.descriptorVersion === 2
    && isExactToolModelSemantics(value.model)
    && (
      value.scopeSemantics === 'none'
      || value.scopeSemantics === 'all_requested_workspace_scopes_must_be_granted'
    )
    && typeof value.lifecycleSemantics === 'string'
    && [
      'bounded_invocation',
      'resource_create',
      'resource_observe',
      'resource_mutate',
      'resource_close'
    ].includes(value.lifecycleSemantics);
}

function isExactToolModelSemantics(value: unknown): value is {
  readonly description: string;
  readonly guidance: readonly string[];
} {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2
    && keys.every((key) => key === 'description' || key === 'guidance')
    && typeof value.description === 'string'
    && value.description.trim() === value.description
    && value.description.length > 0
    && value.description.length <= 2_048
    && !/[\u0000-\u001f\u007f]/u.test(value.description)
    && Array.isArray(value.guidance)
    && value.guidance.length <= 8
    && value.guidance.every((item) => (
      typeof item === 'string'
      && item.trim() === item
      && item.length > 0
      && item.length <= 512
      && !/[\u0000-\u001f\u007f]/u.test(item)
    ));
}

export function cloneToolCatalogBinding(
  binding: AgentToolCatalogBinding
): AgentToolCatalogBinding {
  return {
    catalogId: binding.catalogId,
    revision: binding.revision,
    digest: binding.digest,
    allowedToolNames: [...binding.allowedToolNames]
  };
}

export function prepareProviderToolContracts(
  tools: readonly PreparedToolContract[]
): readonly ExactAgentModelInferenceToolContract[] {
  return Object.freeze(tools.map((tool) => Object.freeze({
    providerToolName: tool.providerToolName,
    description: tool.providerDescription,
    inputSchema: cloneCanonicalAgentToolInput(
      tool.providerInputSchema,
      `providerTool.${tool.providerToolName}.inputSchema`
    )
  })));
}

export function prepareControlToolContracts(
  executionMode: 'chat' | 'agent' | 'plan'
): readonly ExactAgentModelInferenceToolContract[] {
  return Object.freeze(controlKindsForMode(executionMode).map((kind) => Object.freeze({
    providerToolName: CONTROL_PROVIDER_NAMES[kind],
    description: controlDescription(kind),
    inputSchema: cloneCanonicalAgentToolInput(
      controlInputSchema(kind),
      `providerControl.${CONTROL_PROVIDER_NAMES[kind]}.inputSchema`
    )
  })));
}

export function controlKindsForMode(
  executionMode: 'chat' | 'agent' | 'plan'
): readonly NativeControlKind[] {
  if (executionMode === 'plan') {
    return ['propose_plan', 'ask_user', 'checkpoint', 'fail'];
  }
  if (executionMode === 'chat') {
    return ['ask_user', 'checkpoint', 'complete', 'fail'];
  }
  return [
    'ask_user',
    'propose_plan',
    'checkpoint',
    'complete',
    'fail',
    'delegate_subagent',
    'delegate_subagents'
  ];
}

function controlDescription(kind: NativeControlKind): string {
  switch (kind) {
    case 'ask_user': return 'Ask the user one necessary question.';
    case 'propose_plan': return 'Submit the complete structured plan for user review.';
    case 'checkpoint': return 'Yield at a durable checkpoint with a concrete reason.';
    case 'complete': return 'Mark the task complete when no user-facing answer remains.';
    case 'fail': return 'Stop with one explicit safe failure.';
    case 'delegate_subagent': return 'Delegate one self-contained objective to a SubAgent.';
    case 'delegate_subagents': return 'Delegate independent objectives to multiple SubAgents.';
  }
}

function controlInputSchema(kind: NativeControlKind): AgentToolJsonValue {
  const text = { type: 'string', minLength: 1 };
  const subagent = {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'prompt', 'mode'],
    properties: {
      description: text,
      prompt: text,
      mode: { type: 'string', enum: ['one_shot', 'continuable'] },
      providerId: text
    }
  };
  switch (kind) {
    case 'ask_user':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['question'],
        properties: {
          question: {
            type: 'object',
            additionalProperties: false,
            required: ['prompt'],
            properties: {
              prompt: text,
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 3,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['optionId', 'label'],
                  properties: { optionId: text, label: text, description: text }
                }
              }
            }
          }
        }
      };
    case 'propose_plan':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['plan'],
        properties: {
          plan: {
            type: 'object',
            additionalProperties: false,
            required: ['summary', 'impactSummary', 'steps'],
            properties: {
              summary: text,
              impactSummary: text,
              steps: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['title', 'summary', 'impact'],
                  properties: {
                    title: text,
                    summary: text,
                    impact: {
                      type: 'string',
                      enum: [
                        'read_only', 'workspace_change', 'command_execution',
                        'network_access', 'external_side_effect', 'mixed'
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      };
    case 'checkpoint':
      return objectSchema(['reason'], { reason: text });
    case 'complete':
      return objectSchema([], { outputRef: text });
    case 'fail':
      return objectSchema(['errorCode', 'message'], { errorCode: text, message: text });
    case 'delegate_subagent':
      return objectSchema(['subagent'], { subagent });
    case 'delegate_subagents':
      return objectSchema(['subagents'], {
        subagents: { type: 'array', minItems: 1, items: subagent }
      });
  }
}

function objectSchema(
  required: readonly string[],
  properties: Readonly<Record<string, AgentToolJsonValue>>
): AgentToolJsonValue {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...required],
    properties: { ...properties }
  };
}

function providerToolName(tool: AgentPinnedToolIdentity): string {
  const digest = createHash('sha256').update(canonicalJson({
    catalogId: tool.catalogId,
    revision: tool.revision,
    digest: tool.digest,
    toolName: tool.toolName,
    toolVersion: tool.toolVersion,
    providerId: tool.providerId,
    contractDigest: tool.contractDigest
  })).digest('hex');
  return `ariadne_${digest.slice(0, 32)}`;
}

function providerInputSchema(
  inputSchema: AgentToolJsonValue,
  allowedScopes: readonly string[]
): AgentToolJsonValue {
  return cloneCanonicalAgentToolInput({
    type: 'object',
    additionalProperties: false,
    required: ['input', 'scope'],
    properties: {
      input: inputSchema,
      scope: {
        type: 'array',
        uniqueItems: true,
        maxItems: allowedScopes.length,
        items: allowedScopes.length === 0
          ? { type: 'string' }
          : { type: 'string', enum: [...allowedScopes] }
      }
    }
  }, 'providerTool.inputSchema');
}

export function estimateProviderToolTokens(
  tools: readonly ExactAgentModelInferenceToolContract[]
): number {
  if (tools.length === 0) return 0;
  return estimateMessagesTokens([
    textMessage('system', JSON.stringify({ tools }))
  ]);
}

export function modelVisibleSubagentProviders(
  binding: AgentRunBinding
): readonly AgentSubagentProviderBinding[] {
  if (
    binding.bindingVersion === 4
    && binding.executionProfile.subagentProviders !== undefined
  ) return binding.executionProfile.subagentProviders;
  return [DEFAULT_AGENT_SUBAGENT_PROVIDER_BINDING];
}
