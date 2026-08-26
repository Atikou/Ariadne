import {
  AgentInferenceDeterministicFailureError,
  agentRunExecutionMode,
  assertValidAgentDirective,
  assertValidAgentPinnedToolIdentity,
  assertValidAgentRun,
  canonicalizeAgentTurnInput,
  cloneAgentAvailableTool,
  cloneAgentPinnedToolIdentity,
  cloneCanonicalAgentToolInput,
  sameAgentPinnedToolIdentity,
  type AgentAvailableTool,
  type AgentCommittedDirective,
  type AgentDirective,
  type AgentEngine,
  type AgentInferenceAttempt,
  type AgentJsonValue,
  type AgentPinnedToolIdentity,
  type AgentPlanStepImpact,
  type PreparedAgentDecision,
  type AgentRunBinding,
  type AgentTurn,
  type AgentToolJsonValue,
  type AgentTurnInput
} from '@ariadne/agent-core';

import type {
  ExactAgentModelInferenceRuntime,
  ExactAgentModelInferenceMessage
} from '../../control/ports/AgentModelInference.js';
import {
  planV3LongContext,
  type V3LongContextPlan,
  type V3ModelContextGroup
} from './V3LongContextLifecycle.js';
import type {
  AgentInferenceToolContractDescriptorV1,
  AgentInferenceToolContractReader
} from '../../control/ports/AgentInferenceToolContracts.js';

export type {
  AgentInferenceToolContractDescriptorV1,
  AgentInferenceToolContractReader,
  ReadAgentInferenceToolContractsRequest
} from '../../control/ports/AgentInferenceToolContracts.js';

const DIRECTIVE_PROTOCOL = 'ariadne.agent-directive.v3';
const EFFECT_RESULTS_PROTOCOL = 'ariadne.agent-effect-results.v3';
const SUBAGENT_RESULTS_FORMAT = 'ariadne.subagent-results';
const MODEL_BINDING_ERROR = 'agent_model_binding_unavailable';
const TOOL_CONTRACT_ERROR = 'agent_tool_contract_unavailable';
const MODEL_DIRECTIVE_ERROR = 'agent_model_directive_invalid';
const MODEL_CONTEXT_ERROR = 'agent_model_context_exhausted';
const MAX_PROTOCOL_PROMPT_BYTES = 1_048_576;
const MAX_EFFECT_RESULTS_PROTOCOL_BYTES = 1_048_576;
const MAX_MODEL_REQUEST_MESSAGES = 1_024;
const MAX_MODEL_REQUEST_BYTES = 4 * 1_048_576;
const MAX_MODEL_RESPONSE_CHARACTERS = 1_048_576;

type AgentToolCatalogBinding = AgentRunBinding['toolCatalog'];

interface PreparedToolContract {
  readonly tool: AgentPinnedToolIdentity;
  readonly capabilityIds: readonly string[];
  readonly inputSchema: AgentToolJsonValue;
  readonly scopeSemantics: AgentInferenceToolContractDescriptorV1['scopeSemantics'];
  readonly lifecycleSemantics: AgentInferenceToolContractDescriptorV1['lifecycleSemantics'];
  readonly allowedScopes: readonly string[];
}

/**
 * Production v3 AgentEngine adapter.
 *
 * It performs exactly one transport-only model call against the immutable Run
 * binding, requests a versioned data-only directive, and maps Tool names back
 * to the already-pinned catalog identities. It never routes, executes Tools,
 * writes state, emits events, or calls the legacy Agent loop.
 */
export class ProductionAgentEngineAdapter implements AgentEngine {
  public constructor(
    private readonly models: ExactAgentModelInferenceRuntime,
    private readonly toolContracts: AgentInferenceToolContractReader
  ) {}

  public async prepare(
    input: AgentTurnInput,
    signal: AbortSignal
  ): Promise<PreparedAgentDecision> {
    validateBoundInput(input);
    const modelHistory = prepareBoundModelHistory(input);
    signal.throwIfAborted();

    const descriptors = await this.toolContracts.readInferenceToolContracts({
      catalog: cloneToolCatalogBinding(input.run.binding.toolCatalog),
      availableTools: input.availableTools.map((available, index) => (
        cloneAgentAvailableTool(
          available,
          `engineInput.availableTools[${String(index)}]`
        )
      ))
    }, signal);
    signal.throwIfAborted();
    const tools = prepareToolContracts(input, descriptors);
    const protocolPrompt = renderProtocolPrompt(
      tools,
      agentRunExecutionMode(input.run.binding)
    );
    const capacity = this.models.describeContextCapacity(input.run.binding.model);
    if (capacity === null) {
      return {
        modelContext: {
          format: 'ariadne.model-context',
          schemaVersion: 1,
          lifecycle: 'binding_unavailable'
        },
        decide: async () => {
          throw deterministicFailure(
            MODEL_BINDING_ERROR,
            'No exact model-context capacity matches the Agent Run binding.'
          );
        }
      };
    }
    let context: V3LongContextPlan;
    try {
      const grouped = groupModelHistory(modelHistory);
      context = planV3LongContext({
        pinnedMessages: [
          { role: 'system', content: protocolPrompt },
          ...grouped.pinned
        ],
        groups: grouped.groups,
        capacity
      });
      assertPreparedModelRequest(input.run.binding.model.modelId, context.primaryMessages);
      if (context.overflowRecoveryMessages !== null) {
        assertPreparedModelRequest(
          input.run.binding.model.modelId,
          context.overflowRecoveryMessages
        );
      }
    } catch {
      throw deterministicFailure(
        MODEL_CONTEXT_ERROR,
        'Protected v3 context cannot be projected within the exact model capacity.'
      );
    }
    signal.throwIfAborted();
    return {
      modelContext: context.modelContext,
      decide: (decisionSignal) => this.decidePrepared(
        input.run.binding.model,
        context,
        tools,
        decisionSignal
      )
    };
  }

  private async decidePrepared(
    binding: AgentRunBinding['model'],
    context: V3LongContextPlan,
    tools: readonly PreparedToolContract[],
    signal: AbortSignal
  ): Promise<AgentDirective> {
    let response = await this.models.inferExact({
      binding: { ...binding },
      messages: context.primaryMessages,
      signal
    });
    if (response.status === 'context_overflow') {
      if (context.overflowRecoveryMessages === null) {
        throw deterministicFailure(
          MODEL_CONTEXT_ERROR,
          'The exact Provider rejected context size and no smaller prepared projection exists.'
        );
      }
      signal.throwIfAborted();
      response = await this.models.inferExact({
        binding: { ...binding },
        messages: context.overflowRecoveryMessages,
        signal
      });
    }
    if (response.status === 'context_overflow') {
      throw deterministicFailure(
        MODEL_CONTEXT_ERROR,
        'The exact Provider rejected both bounded v3 context projections.'
      );
    }

    if (response.status === 'binding_unavailable') {
      throw deterministicFailure(
        MODEL_BINDING_ERROR,
        'No transport-only model client matches the exact Agent Run binding.'
      );
    }
    if (
      typeof response.content !== 'string'
      || response.content.length > MAX_MODEL_RESPONSE_CHARACTERS
      || response.nativeToolCallCount !== 0
    ) {
      throw deterministicFailure(
        MODEL_DIRECTIVE_ERROR,
        'The model response did not contain one bounded text-only v3 Directive.'
      );
    }

    try {
      return parseDirectiveEnvelope(response.content, tools);
    } catch (error) {
      if (error instanceof AgentInferenceDeterministicFailureError) throw error;
      throw deterministicFailure(
        MODEL_DIRECTIVE_ERROR,
        'The model response did not satisfy the strict v3 Directive contract.'
      );
    }
  }
}

function groupModelHistory(messages: readonly ExactAgentModelInferenceMessage[]): {
  readonly pinned: readonly ExactAgentModelInferenceMessage[];
  readonly groups: readonly V3ModelContextGroup[];
} {
  const pinned = messages.filter((message) => message.role === 'system');
  const causal = messages.filter((message) => message.role !== 'system');
  const groups: V3ModelContextGroup[] = [];
  for (let index = 0; index < causal.length; index += 1) {
    const current = causal[index]!;
    const next = causal[index + 1];
    if (
      current.role === 'assistant'
      && current.content.includes(`\"protocol\":\"${DIRECTIVE_PROTOCOL}\"`)
      && next?.role === 'user'
      && (
        next.content.includes(`\"protocol\":\"${EFFECT_RESULTS_PROTOCOL}\"`)
        || next.content.includes(`\"format\":\"${SUBAGENT_RESULTS_FORMAT}\"`)
      )
    ) {
      groups.push({ kind: 'tool_exchange', messages: [current, next] });
      index += 1;
      continue;
    }
    if (
      current.role === 'user'
      && next?.role === 'assistant'
      && !next.content.includes(`\"protocol\":\"${DIRECTIVE_PROTOCOL}\"`)
    ) {
      groups.push({ kind: 'conversation', messages: [current, next] });
      index += 1;
      continue;
    }
    groups.push({ kind: 'conversation', messages: [current] });
  }
  if (groups.length === 0) throw invalidBoundModelHistory();
  return { pinned, groups };
}

function prepareBoundModelHistory(
  input: AgentTurnInput
): readonly ExactAgentModelInferenceMessage[] {
  const current = requireCurrentSchedulableAttempt(input);
  const turns = input.run.turns.slice(0, current.turnIndex + 1);
  const appendedCount = turns.slice(1).reduce((count, turn) => {
    const cause = turn.intention.cause;
    return count + (cause.kind === 'effect_results'
      ? cause.effectIds.length + (cause.inboxInputIds?.length ?? 0)
      : cause.kind === 'inbox_inputs'
        ? 1 + cause.inputIds.length
        : cause.kind === 'child_results'
          ? 2
        : Number.POSITIVE_INFINITY);
  }, 0);
  const baseCount = input.messages.length - appendedCount;
  if (!Number.isSafeInteger(baseCount) || baseCount < 1) throw invalidBoundModelHistory();
  const history: ExactAgentModelInferenceMessage[] = [];
  for (let index = 0; index < baseCount; index += 1) {
    const message = input.messages[index];
    if (message?.kind !== 'text') throw invalidBoundModelHistory();
    history.push({ role: message.role, content: message.content });
  }

  let messageIndex = baseCount;
  for (const turn of turns.slice(1)) {
    const cause = turn.intention.cause;
    if (cause.kind === 'inbox_inputs') {
      const batch = input.messages.slice(
        messageIndex,
        messageIndex + 1 + cause.inputIds.length
      );
      if (
        batch.length !== 1 + cause.inputIds.length
        || batch.some((message) => message.kind !== 'text')
        || batch[0]?.kind !== 'text'
        || batch[0].role !== 'assistant'
        || batch.slice(1).some((message) => message.kind !== 'text' || message.role !== 'user')
      ) throw invalidBoundModelHistory();
      for (const message of batch) {
        if (message.kind !== 'text') throw invalidBoundModelHistory();
        history.push({ role: message.role, content: message.content });
      }
      messageIndex += batch.length;
      continue;
    }
    if (cause.kind === 'child_results') {
      const batch = input.messages.slice(messageIndex, messageIndex + 2);
      if (
        batch.length !== 2
        || batch[0]?.kind !== 'text'
        || batch[0].role !== 'assistant'
        || batch[1]?.kind !== 'text'
        || batch[1].role !== 'user'
      ) throw invalidBoundModelHistory();
      verifyChildResultTextBatch(input, turn, batch[0].content, batch[1].content);
      history.push(
        { role: 'assistant', content: batch[0].content },
        { role: 'user', content: batch[1].content }
      );
      messageIndex += 2;
      continue;
    }
    if (cause.kind !== 'effect_results') throw invalidBoundModelHistory();
    const batchSize = cause.effectIds.length;
    const batch = input.messages.slice(messageIndex, messageIndex + batchSize);
    if (
      batch.length !== batchSize
      || batch.some((message) => message.kind !== 'effect_result')
    ) {
      throw invalidBoundModelHistory();
    }
    const verified = verifyEffectResultBatch(
      input,
      turn,
      batch as readonly Extract<
        AgentTurnInput['messages'][number],
        { readonly kind: 'effect_result' }
      >[]
    );
    history.push({
      role: 'assistant',
      content: renderCommittedToolDirective(verified.directive)
    });
    history.push({
      role: 'user',
      content: renderEffectResultBatch(
        cause.sourceDirectiveDigest,
        verified.results
      )
    });
    messageIndex += batchSize;
    const inboxInputCount = cause.inboxInputIds?.length ?? 0;
    const inboxMessages = input.messages.slice(
      messageIndex,
      messageIndex + inboxInputCount
    );
    if (
      inboxMessages.length !== inboxInputCount
      || inboxMessages.some((message) => message.kind !== 'text' || message.role !== 'user')
    ) {
      throw invalidBoundModelHistory();
    }
    for (const message of inboxMessages) {
      if (message.kind !== 'text') throw invalidBoundModelHistory();
      history.push({ role: 'user', content: message.content });
    }
    messageIndex += inboxInputCount;
  }
  if (messageIndex !== input.messages.length) throw invalidBoundModelHistory();
  return history;
}

function verifyChildResultTextBatch(
  input: AgentTurnInput,
  turn: AgentTurn,
  assistantContent: string,
  resultContent: string
): void {
  const cause = turn.intention.cause;
  if (cause.kind !== 'child_results') throw invalidBoundModelHistory();
  const sourceTurn = input.run.turns.find(
    (candidate) => candidate.turnId === cause.sourceTurnId
  );
  const sourceAttempt = sourceTurn?.attempts.find(
    (candidate) => candidate.attemptId === cause.sourceAttemptId
  );
  if (
    sourceAttempt?.state.status !== 'succeeded'
    || sourceAttempt.state.directive.kind !== 'delegate_subagent'
    || sourceAttempt.state.directiveDigest !== cause.sourceDirectiveDigest
    || cause.delegationIds.length !== 1
    || cause.childRunIds.length !== 1
    || sourceAttempt.state.directive.delegationId !== cause.delegationIds[0]
    || sourceAttempt.state.directive.childRunId !== cause.childRunIds[0]
  ) throw invalidBoundModelHistory();
  const assistant = parseExactObject(assistantContent);
  const result = parseExactObject(resultContent);
  const delegated = typeof assistant.directive === 'object'
    && assistant.directive !== null
    && !Array.isArray(assistant.directive)
    ? assistant.directive as Record<string, unknown>
    : null;
  if (
    assistant.protocol !== DIRECTIVE_PROTOCOL
    || delegated?.kind !== 'delegate_subagent'
    || delegated.delegationId !== cause.delegationIds[0]
    || delegated.childRunId !== cause.childRunIds[0]
    || delegated.objectiveDigest !== sourceAttempt.state.directive.objectiveDigest
    || result.format !== SUBAGENT_RESULTS_FORMAT
    || result.schemaVersion !== 1
    || !Array.isArray(result.results)
    || result.results.length !== 1
  ) throw invalidBoundModelHistory();
  const child = result.results[0];
  if (
    typeof child !== 'object'
    || child === null
    || Array.isArray(child)
    || child.delegationId !== cause.delegationIds[0]
    || child.childRunId !== cause.childRunIds[0]
    || !Number.isSafeInteger(child.childRunVersion)
    || !['completed', 'failed', 'cancelled'].includes(String(child.status))
    || typeof child.content !== 'string'
    || child.content.length === 0
  ) throw invalidBoundModelHistory();
}

function parseExactObject(content: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw invalidBoundModelHistory();
    }
    return value as Record<string, unknown>;
  } catch {
    throw invalidBoundModelHistory();
  }
}

function requireCurrentSchedulableAttempt(input: AgentTurnInput): {
  readonly turn: AgentTurn;
  readonly attempt: AgentInferenceAttempt;
  readonly turnIndex: number;
} {
  const candidates: Array<{
    readonly turn: AgentTurn;
    readonly attempt: AgentInferenceAttempt;
    readonly turnIndex: number;
    readonly attemptIndex: number;
  }> = [];
  input.run.turns.forEach((turn, turnIndex) => {
    turn.attempts.forEach((attempt, attemptIndex) => {
      if (attempt.state.status === 'intended' || attempt.state.status === 'started') {
        candidates.push({ turn, attempt, turnIndex, attemptIndex });
      }
    });
  });
  const current = candidates[0];
  if (
    candidates.length !== 1
    || current === undefined
    || current.turnIndex !== input.run.turns.length - 1
    || current.attemptIndex !== current.turn.attempts.length - 1
  ) {
    throw invalidBoundModelHistory();
  }
  return current;
}

function verifyEffectResultBatch(
  input: AgentTurnInput,
  turn: AgentTurn,
  messages: readonly Extract<
    AgentTurnInput['messages'][number],
    { readonly kind: 'effect_result' }
  >[]
): {
  readonly directive: Extract<AgentCommittedDirective, { readonly kind: 'invoke_tools' }>;
  readonly results: readonly {
    readonly effectId: string;
    readonly toolCallId: string;
    readonly status: 'succeeded' | 'failed' | 'cancelled';
    readonly result: AgentJsonValue;
  }[];
} {
  const cause = turn.intention.cause;
  if (cause.kind !== 'effect_results') throw invalidBoundModelHistory();
  const sourceTurnIndex = input.run.turns.findIndex(
    (candidate) => candidate.turnId === cause.sourceTurnId
  );
  const continuationTurnIndex = input.run.turns.findIndex(
    (candidate) => candidate.turnId === turn.turnId
  );
  const sourceTurn = input.run.turns[sourceTurnIndex];
  const sourceAttempt = sourceTurn?.attempts.find(
    (candidate) => candidate.attemptId === cause.sourceAttemptId
  );
  if (
    sourceTurn === undefined
    || sourceTurnIndex < 0
    || sourceTurnIndex >= continuationTurnIndex
    || sourceAttempt?.state.status !== 'succeeded'
    || sourceAttempt.state.directive.kind !== 'invoke_tools'
    || sourceAttempt.state.directiveDigest !== cause.sourceDirectiveDigest
    || sourceAttempt.state.directive.invocations.length !== cause.effectIds.length
    || messages.length !== cause.effectIds.length
  ) {
    throw invalidBoundModelHistory();
  }

  const results = messages.map((message, index) => {
    const invocation = sourceAttempt.state.status === 'succeeded'
      && sourceAttempt.state.directive.kind === 'invoke_tools'
      ? sourceAttempt.state.directive.invocations[index]
      : undefined;
    const effect = input.run.effects.find(
      (candidate) => candidate.effectId === cause.effectIds[index]
    );
    if (
      invocation === undefined
      || effect === undefined
      || invocation.effectId !== cause.effectIds[index]
      || invocation.toolCallId !== cause.toolCallIds[index]
      || message.effectId !== invocation.effectId
      || message.toolCallId !== invocation.toolCallId
      || effect.toolCallId !== invocation.toolCallId
      || effect.origin?.turnId !== cause.sourceTurnId
      || effect.origin.attemptId !== cause.sourceAttemptId
      || effect.origin.directiveDigest !== cause.sourceDirectiveDigest
      || (
        effect.state.status !== 'succeeded'
        && effect.state.status !== 'failed'
        && effect.state.status !== 'cancelled'
      )
      || message.status !== effect.state.status
    ) {
      throw invalidBoundModelHistory();
    }
    return {
      effectId: message.effectId,
      toolCallId: message.toolCallId,
      status: message.status,
      result: cloneCanonicalAgentToolInput(
        message.result,
        `engineInput.effectResults[${String(index)}].result`
      )
    };
  });
  return {
    directive: sourceAttempt.state.directive,
    results
  };
}

function renderCommittedToolDirective(
  directive: Extract<AgentCommittedDirective, { readonly kind: 'invoke_tools' }>
): string {
  const content = canonicalJson({
    protocol: DIRECTIVE_PROTOCOL,
    directive: {
      kind: 'invoke_tools',
      invocations: directive.invocations.map(renderCommittedToolInvocation)
    }
  });
  assertBoundedEffectResultsProtocol(content);
  return content;
}

function renderCommittedToolInvocation(
  invocation: Extract<
    AgentCommittedDirective,
    { readonly kind: 'invoke_tools' }
  >['invocations'][number]
): Readonly<Record<string, AgentJsonValue>> {
  const tool = cloneAgentPinnedToolIdentity(invocation.tool);
  return {
    effectId: invocation.effectId,
    toolCallId: invocation.toolCallId,
    tool: {
      catalogId: tool.catalogId,
      revision: tool.revision,
      digest: tool.digest,
      toolName: tool.toolName,
      toolVersion: tool.toolVersion,
      providerId: tool.providerId,
      contractDigest: tool.contractDigest
    },
    idempotencyKey: invocation.idempotencyKey,
    capabilityIds: [...invocation.capabilityIds],
    scope: [...invocation.scope],
    inputDigest: invocation.inputDigest,
    ...(invocation.permissionDecisionId === undefined
      ? {}
      : { permissionDecisionId: invocation.permissionDecisionId })
  };
}

function renderEffectResultBatch(
  sourceDirectiveDigest: string,
  results: readonly {
    readonly effectId: string;
    readonly toolCallId: string;
    readonly status: 'succeeded' | 'failed' | 'cancelled';
    readonly result: AgentJsonValue;
  }[]
): string {
  const content = canonicalJson({
    protocol: EFFECT_RESULTS_PROTOCOL,
    sourceDirectiveDigest,
    results: results.map((result) => ({
      effectId: result.effectId,
      toolCallId: result.toolCallId,
      status: result.status,
      result: result.result
    }))
  });
  assertBoundedEffectResultsProtocol(content);
  return content;
}

function assertBoundedEffectResultsProtocol(content: string): void {
  if (new TextEncoder().encode(content).byteLength > MAX_EFFECT_RESULTS_PROTOCOL_BYTES) {
    throw invalidBoundModelHistory();
  }
}

function assertPreparedModelRequest(
  modelId: string,
  messages: readonly ExactAgentModelInferenceMessage[]
): void {
  // This deliberately double-counts System content, so it is an upper bound
  // for both exact OpenAI-compatible and Anthropic text transports.
  const conservativeEnvelope = JSON.stringify({
    model: modelId,
    max_tokens: 4_096,
    system: messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n'),
    messages,
    stream: false
  });
  if (new TextEncoder().encode(conservativeEnvelope).byteLength > MAX_MODEL_REQUEST_BYTES) {
    throw invalidBoundModelHistory();
  }
  if (messages.length > MAX_MODEL_REQUEST_MESSAGES) throw invalidBoundModelHistory();
}

function canonicalJson(value: AgentJsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, AgentJsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key] as AgentJsonValue)}`
  ).join(',')}}`;
}

function invalidBoundModelHistory(): AgentInferenceDeterministicFailureError {
  return deterministicFailure(
    MODEL_BINDING_ERROR,
    'Effect-result continuation requires exact cumulative causal v3 history.'
  );
}

function validateBoundInput(input: AgentTurnInput): void {
  try {
    assertValidAgentRun(input.run);
    canonicalizeAgentTurnInput({
      messages: input.messages,
      availableTools: input.availableTools
    });
  } catch {
    throw deterministicFailure(
      MODEL_BINDING_ERROR,
      'AgentEngine received an invalid or unbound Run input.'
    );
  }
}

function prepareToolContracts(
  input: AgentTurnInput,
  descriptors: readonly AgentInferenceToolContractDescriptorV1[]
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
    preparedByName.set(descriptor.tool.toolName, Object.freeze({
      tool: cloneAgentPinnedToolIdentity(descriptor.tool),
      capabilityIds: Object.freeze([...available.capabilityIds]),
      inputSchema,
      scopeSemantics: descriptor.scopeSemantics,
      lifecycleSemantics: descriptor.lifecycleSemantics,
      allowedScopes: Object.freeze(resolveAllowedScopes(
        input.run.binding,
        available,
        descriptor.scopeSemantics
      ))
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

function resolveAllowedScopes(
  binding: AgentRunBinding,
  available: AgentAvailableTool,
  semantics: AgentInferenceToolContractDescriptorV1['scopeSemantics']
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

function renderProtocolPrompt(
  tools: readonly PreparedToolContract[],
  executionMode: 'agent' | 'plan'
): string {
  const invokeTools = {
    kind: 'invoke_tools',
    invocations: [{
      toolCallId: 'unique non-empty string',
      toolName: 'one advertised toolName',
      input: 'JSON value satisfying inputSchema',
      scope: ['canonical sorted subset of allowedScopes']
    }]
  };
  const proposePlan = {
    kind: 'propose_plan',
    plan: {
      summary: 'non-empty implementation plan summary',
      impactSummary: 'non-empty summary of expected effects',
      steps: [{
        title: 'non-empty step title',
        summary: 'non-empty concrete step summary',
        impact: 'read_only | workspace_change | command_execution | network_access | external_side_effect | mixed'
      }]
    }
  };
  const delegateSubagent = {
    kind: 'delegate_subagent',
    subagent: {
      description: 'short display description',
      prompt: 'complete self-contained delegated objective'
    }
  };
  const prompt = JSON.stringify({
    protocol: DIRECTIVE_PROTOCOL,
    instruction:
      'Return exactly one JSON object with keys protocol and directive. '
      + 'Do not return markdown, commentary, hidden reasoning, or native tool calls.',
    executionMode,
    directiveShapes: executionMode === 'plan'
      ? {
          invoke_tools: invokeTools,
          propose_plan: proposePlan,
          checkpoint: { kind: 'checkpoint', reason: 'non-empty string' },
          fail: {
            kind: 'fail',
            errorCode: 'non-empty string',
            message: 'non-empty string'
          }
        }
      : {
          respond: { kind: 'respond', content: 'non-empty string' },
          invoke_tools: invokeTools,
          delegate_subagent: delegateSubagent,
          propose_plan: proposePlan,
          checkpoint: { kind: 'checkpoint', reason: 'non-empty string' },
          complete: { kind: 'complete', outputRef: 'optional non-empty string' },
          fail: {
            kind: 'fail',
            errorCode: 'non-empty string',
            message: 'non-empty string'
          }
        },
    tools: tools.map((tool) => ({
      toolName: tool.tool.toolName,
      toolVersion: tool.tool.toolVersion,
      capabilityIds: [...tool.capabilityIds],
      scopeSemantics: tool.scopeSemantics,
      lifecycleSemantics: tool.lifecycleSemantics,
      allowedScopes: [...tool.allowedScopes],
      inputSchema: tool.inputSchema
    }))
  });
  if (new TextEncoder().encode(prompt).byteLength > MAX_PROTOCOL_PROMPT_BYTES) {
    throw deterministicFailure(
      TOOL_CONTRACT_ERROR,
      'The exact model-visible Tool contract prompt exceeds its bounded size.'
    );
  }
  return prompt;
}

function parseDirectiveEnvelope(
  content: string,
  tools: readonly PreparedToolContract[]
): AgentDirective {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new StrictDirectiveProtocolError();
  }
  const envelope = exactObject(parsed, ['protocol', 'directive']);
  if (envelope.protocol !== DIRECTIVE_PROTOCOL) {
    throw new StrictDirectiveProtocolError();
  }
  const directive = parseDirective(envelope.directive, tools);
  try {
    assertValidAgentDirective(directive);
  } catch {
    throw new StrictDirectiveProtocolError();
  }
  return directive;
}

function parseDirective(
  value: unknown,
  tools: readonly PreparedToolContract[]
): AgentDirective {
  const candidate = plainObject(value);
  switch (candidate.kind) {
    case 'respond': {
      const exact = exactObject(candidate, ['kind', 'content']);
      return { kind: 'respond', content: stringValue(exact.content) };
    }
    case 'invoke_tools': {
      const exact = exactObject(candidate, ['kind', 'invocations']);
      if (!Array.isArray(exact.invocations)) throw new StrictDirectiveProtocolError();
      const toolsByName = new Map(tools.map((tool) => [tool.tool.toolName, tool] as const));
      const toolCallIds = new Set<string>();
      const invocations = exact.invocations.map((invocation) => {
        const source = exactObject(
          invocation,
          ['toolCallId', 'toolName', 'input', 'scope']
        );
        const toolCallId = stringValue(source.toolCallId);
        const toolName = stringValue(source.toolName);
        const tool = toolsByName.get(toolName);
        if (tool === undefined || toolCallIds.has(toolCallId)) {
          throw new StrictDirectiveProtocolError();
        }
        toolCallIds.add(toolCallId);
        const scope = stringArray(source.scope);
        if (
          tool.scopeSemantics === 'none'
            ? scope.length !== 0
            : scope.some((scopeId) => !tool.allowedScopes.includes(scopeId))
        ) {
          throw new StrictDirectiveProtocolError();
        }
        return {
          toolCallId,
          tool: cloneAgentPinnedToolIdentity(tool.tool),
          input: cloneCanonicalAgentToolInput(source.input, 'modelDirective.input'),
          capabilityIds: [...tool.capabilityIds],
          scope
        };
      });
      return { kind: 'invoke_tools', invocations };
    }
    case 'propose_plan': {
      const exact = exactObject(candidate, ['kind', 'plan']);
      const plan = exactObject(exact.plan, ['summary', 'impactSummary', 'steps']);
      if (!Array.isArray(plan.steps)) throw new StrictDirectiveProtocolError();
      return {
        kind: 'propose_plan',
        plan: {
          summary: stringValue(plan.summary),
          impactSummary: stringValue(plan.impactSummary),
          steps: plan.steps.map((candidateStep) => {
            const step = exactObject(
              candidateStep,
              ['title', 'summary', 'impact']
            );
            return {
              title: stringValue(step.title),
              summary: stringValue(step.summary),
              impact: planImpactValue(step.impact)
            };
          })
        }
      };
    }
    case 'delegate_subagent': {
      const exact = exactObject(candidate, ['kind', 'subagent']);
      const subagent = exactObject(exact.subagent, ['description', 'prompt']);
      return {
        kind: 'delegate_subagent',
        subagent: {
          description: stringValue(subagent.description),
          prompt: stringValue(subagent.prompt)
        }
      };
    }
    case 'checkpoint': {
      const exact = exactObject(candidate, ['kind', 'reason']);
      return { kind: 'checkpoint', reason: stringValue(exact.reason) };
    }
    case 'complete': {
      const exact = exactObjectWithOptional(candidate, ['kind'], ['outputRef']);
      return exact.outputRef === undefined
        ? { kind: 'complete' }
        : { kind: 'complete', outputRef: stringValue(exact.outputRef) };
    }
    case 'fail': {
      const exact = exactObject(candidate, ['kind', 'errorCode', 'message']);
      return {
        kind: 'fail',
        errorCode: stringValue(exact.errorCode),
        message: stringValue(exact.message)
      };
    }
    default:
      throw new StrictDirectiveProtocolError();
  }
}

function isExactDescriptor(
  value: unknown
): value is AgentInferenceToolContractDescriptorV1 {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 5
    && keys.every((key) => [
      'descriptorVersion',
      'tool',
      'inputSchema',
      'scopeSemantics',
      'lifecycleSemantics'
    ].includes(key))
    && value.descriptorVersion === 1
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

function cloneToolCatalogBinding(
  binding: AgentToolCatalogBinding
): AgentToolCatalogBinding {
  return {
    catalogId: binding.catalogId,
    revision: binding.revision,
    digest: binding.digest,
    allowedToolNames: [...binding.allowedToolNames]
  };
}

function exactObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  const object = plainObject(value);
  const actual = Object.keys(object);
  if (
    actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    throw new StrictDirectiveProtocolError();
  }
  return object;
}

function exactObjectWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[]
): Record<string, unknown> {
  const object = plainObject(value);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(object);
  if (
    actual.some((key) => !allowed.has(key))
    || required.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    throw new StrictDirectiveProtocolError();
  }
  return object;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new StrictDirectiveProtocolError();
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new StrictDirectiveProtocolError();
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new StrictDirectiveProtocolError();
  }
  return [...value] as string[];
}

function planImpactValue(value: unknown): AgentPlanStepImpact {
  if (
    value !== 'read_only'
    && value !== 'workspace_change'
    && value !== 'command_execution'
    && value !== 'network_access'
    && value !== 'external_side_effect'
    && value !== 'mixed'
  ) throw new StrictDirectiveProtocolError();
  return value;
}

function deterministicFailure(
  code: string,
  message: string
): AgentInferenceDeterministicFailureError {
  return new AgentInferenceDeterministicFailureError(code, message);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class StrictDirectiveProtocolError extends Error {}
