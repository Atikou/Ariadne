import { createHash } from 'node:crypto';

import {
  AgentInferenceDeterministicFailureError,
  DEFAULT_AGENT_SUBAGENT_PROVIDER_BINDING,
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
  type AgentEffectExecutionInputReader,
  type AgentInferenceAttempt,
  type AgentInferenceResponseEnvelopeV1,
  type AgentInferenceUsageAnchorV1,
  type AgentJsonValue,
  type AgentPinnedToolIdentity,
  type AgentPlanStepImpact,
  type PreparedAgentDecision,
  type AgentRunBinding,
  type AgentSubagentProviderBinding,
  type AgentTurn,
  type AgentToolJsonValue,
  type AgentTurnInput
} from '@ariadne/agent-core';
import { redactPublicProjectionTextV3 } from '@ariadne/protocol/public';

import type {
  ExactAgentModelInferenceContentBlock,
  ExactAgentModelInferenceReplayEnvelopeV1,
  ExactAgentModelInferenceRuntime,
  ExactAgentModelInferenceMessage,
  ExactAgentModelInferenceRequestContentBlock,
  ExactAgentModelInferenceToolContract
} from '../../control/ports/AgentModelInference.js';
import {
  admitV3TokenizedProjections,
  estimateMessagesTokens,
  planV3LongContext,
  type V3LongContextPlan,
  type V3LongContextUsageBaseline,
  type V3ModelContextGroup
} from './V3LongContextLifecycle.js';
import type {
  AgentInferenceToolContractDescriptorV2,
  AgentInferenceToolContractReader
} from '../../control/ports/AgentInferenceToolContracts.js';
import type { BoundInferenceStreamProjection } from '../../projection/InferenceStreamProjectionPorts.js';
import type { InferenceStreamPublicProjectionPublisher } from '../../projection/InferenceStreamPublicProjectionPublisher.js';
import type {
  ConversationAttachmentReader,
  OwnedConversationImageAttachment
} from '../../control/ports/ConversationAttachmentStore.js';

export type {
  AgentInferenceToolContractDescriptorV2,
  AgentInferenceToolContractReader,
  ReadAgentInferenceToolContractsRequest
} from '../../control/ports/AgentInferenceToolContracts.js';

const DIRECTIVE_PROTOCOL = 'ariadne.agent-directive.v3';
const SUBAGENT_RESULTS_FORMAT = 'ariadne.subagent-results';
const MODEL_BINDING_ERROR = 'agent_model_binding_unavailable';
const TOOL_CONTRACT_ERROR = 'agent_tool_contract_unavailable';
const MODEL_DIRECTIVE_ERROR = 'agent_model_directive_invalid';
const MODEL_CONTEXT_ERROR = 'agent_model_context_exhausted';
const MAX_PROTOCOL_PROMPT_BYTES = 1_048_576;
const MAX_MODEL_REQUEST_MESSAGES = 1_024;
const MAX_MODEL_REQUEST_BYTES = 4 * 1_048_576;
const MAX_MODEL_RESPONSE_CHARACTERS = 1_048_576;

type AgentToolCatalogBinding = AgentRunBinding['toolCatalog'];

interface PreparedToolContract {
  readonly tool: AgentPinnedToolIdentity;
  readonly capabilityIds: readonly string[];
  readonly inputSchema: AgentToolJsonValue;
  readonly scopeSemantics: AgentInferenceToolContractDescriptorV2['scopeSemantics'];
  readonly lifecycleSemantics: AgentInferenceToolContractDescriptorV2['lifecycleSemantics'];
  readonly allowedScopes: readonly string[];
  readonly providerToolName: string;
  readonly providerInputSchema: AgentToolJsonValue;
  readonly providerDescription: string;
}

type BoundModelHistoryEntry =
  | {
      readonly kind: 'message';
      readonly message: ExactAgentModelInferenceMessage;
    }
  | {
      readonly kind: 'effect_exchange';
      readonly directive: Extract<AgentCommittedDirective, { readonly kind: 'invoke_tools' }>;
      readonly results: readonly {
        readonly effectId: string;
        readonly toolCallId: string;
        readonly status: 'succeeded' | 'failed' | 'cancelled';
        readonly result: AgentJsonValue;
      }[];
    }
  | {
      readonly kind: 'image';
      readonly image: OwnedConversationImageAttachment;
    };

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
    private readonly toolContracts: AgentInferenceToolContractReader,
    private readonly inferenceStreams?: InferenceStreamPublicProjectionPublisher,
    private readonly effectInputs?: AgentEffectExecutionInputReader,
    private readonly attachments?: ConversationAttachmentReader
  ) {}

  public async prepare(
    input: AgentTurnInput,
    signal: AbortSignal
  ): Promise<PreparedAgentDecision> {
    validateBoundInput(input);
    const boundHistory = prepareBoundModelHistory(input);
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
    const modelHistory = coalesceUserContentMessages(await materializeBoundModelHistory(
      input.run.runId,
      boundHistory,
      tools,
      this.effectInputs,
      this.attachments,
      signal
    ));
    const providerTools = prepareProviderToolContracts(tools);
    const protocolPrompt = renderProtocolPrompt(
      tools,
      agentRunExecutionMode(input.run.binding),
      modelVisibleSubagentProviders(input.run.binding)
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
      const pinnedMessages = [
        textMessage('system', protocolPrompt),
        ...grouped.pinned
      ];
      const fixedOverheadTokens = estimateProviderToolTokens(providerTools);
      const requestHeaderDigest = digestTokenMeterHeader(
        input.run.binding.model,
        pinnedMessages,
        providerTools
      );
      const usageBaseline = findUsageBaseline(input, requestHeaderDigest);
      const sourceTokenCount = await this.models.countRequestTokens({
        binding: { ...input.run.binding.model },
        messages: [...pinnedMessages, ...grouped.groups.flatMap((group) => group.messages)],
        tools: providerTools,
        signal
      });
      const planned = planV3LongContext({
        pinnedMessages,
        groups: grouped.groups,
        capacity,
        requestHeaderDigest,
        fixedOverheadTokens,
        sourceTokenCount,
        ...(usageBaseline === undefined ? {} : { usageBaseline })
      });
      const primaryTokenCount = await this.models.countRequestTokens({
        binding: { ...input.run.binding.model },
        messages: planned.primaryMessages,
        tools: providerTools,
        signal
      });
      const recoveryTokenCount = planned.overflowRecoveryMessages === null
        ? null
        : await this.models.countRequestTokens({
            binding: { ...input.run.binding.model },
            messages: planned.overflowRecoveryMessages,
            tools: providerTools,
            signal
          });
      context = admitV3TokenizedProjections({
        plan: planned,
        capacity,
        primary: primaryTokenCount,
        recovery: recoveryTokenCount
      });
      assertPreparedModelRequest(
        input.run.binding.model.modelId,
        context.primaryMessages,
        providerTools
      );
      if (context.overflowRecoveryMessages !== null) {
        assertPreparedModelRequest(
          input.run.binding.model.modelId,
          context.overflowRecoveryMessages,
          providerTools
        );
      }
    } catch {
      throw deterministicFailure(
        MODEL_CONTEXT_ERROR,
        'Protected v3 context cannot be projected within the exact model capacity.'
      );
    }
    signal.throwIfAborted();
    const stream = this.inferenceStreams === undefined
      ? undefined
      : await this.inferenceStreams.bind(openInferenceIdentity(input));
    let usageAnchor: AgentInferenceUsageAnchorV1 | null = null;
    let responseEnvelope: AgentInferenceResponseEnvelopeV1 | null = null;
    return {
      modelContext: context.modelContext,
      decide: async (decisionSignal) => {
        const decided = await this.decidePrepared(
          input.run.binding.model,
          context,
          tools,
          providerTools,
          decisionSignal,
          stream
        );
        usageAnchor = decided.usageAnchor ?? null;
        responseEnvelope = { ...decided.responseEnvelope };
        return decided.directive;
      },
      readUsageAnchor: () => usageAnchor === null ? null : { ...usageAnchor },
      readResponseEnvelope: () => responseEnvelope === null
        ? null
        : {
            ...responseEnvelope,
            contentBlockTypes: [...responseEnvelope.contentBlockTypes]
          },
      ...(stream === undefined
        ? {}
        : {
          streamLifecycle: {
            settle: (status: 'committed' | 'interrupted') => stream.terminate(status)
          }
        })
    };
  }

  private async decidePrepared(
    binding: AgentRunBinding['model'],
    context: V3LongContextPlan,
    tools: readonly PreparedToolContract[],
    providerTools: readonly ExactAgentModelInferenceToolContract[],
    signal: AbortSignal,
    stream?: BoundInferenceStreamProjection
  ): Promise<{
    readonly directive: AgentDirective;
    readonly usageAnchor?: AgentInferenceUsageAnchorV1;
    readonly responseEnvelope: AgentInferenceResponseEnvelopeV1;
  }> {
    let publicSequence = 0;
    const emitPublicChunk = (
      channel: 'token' | 'reasoning',
      text: string
    ): void => {
      if (stream === undefined) return;
      for (const part of splitPublicUtf8Text(redactPublicProjectionTextV3(text))) {
        publicSequence += 1;
        stream.chunkObserver.observe({ sequence: publicSequence, channel, text: part });
      }
    };
    const createChunkObserver = () => {
      if (stream === undefined) return undefined;
      return {
        observe: (chunk: {
          readonly sequence: number;
          readonly channel: 'token' | 'reasoning';
          readonly text: string;
        }) => {
          // Exact Agent token chunks contain the protected JSON Directive,
          // including possible Tool input. Only reasoning is public while the
          // response is running; respond.content is emitted after strict parse.
          if (chunk.channel === 'reasoning') emitPublicChunk('reasoning', chunk.text);
        }
      };
    };
    const primaryChunkObserver = createChunkObserver();
    let requestMessages = context.primaryMessages;
    let meteredInputTokens = context.primaryMeteredTokens;
    let response = await this.models.inferExact({
      binding: { ...binding },
      messages: requestMessages,
      tools: providerTools,
      signal,
      ...(primaryChunkObserver === undefined
        ? {}
        : { chunkObserver: primaryChunkObserver })
    });
    if (response.status === 'context_overflow') {
      if (context.overflowRecoveryMessages === null) {
        throw deterministicFailure(
          MODEL_CONTEXT_ERROR,
          'The exact Provider rejected context size and no smaller prepared projection exists.'
        );
      }
      signal.throwIfAborted();
      requestMessages = context.overflowRecoveryMessages;
      meteredInputTokens = context.overflowRecoveryMeteredTokens!;
      const recoveryChunkObserver = createChunkObserver();
      response = await this.models.inferExact({
        binding: { ...binding },
        messages: requestMessages,
        tools: providerTools,
        signal,
        ...(recoveryChunkObserver === undefined
          ? {}
          : { chunkObserver: recoveryChunkObserver })
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
    const textContent = response.contentBlocks
      .filter((block): block is Extract<
        ExactAgentModelInferenceContentBlock,
        { readonly type: 'text' }
      > => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const nativeToolCalls = response.contentBlocks.filter((block): block is Extract<
      ExactAgentModelInferenceContentBlock,
      { readonly type: 'tool_call' }
    > => block.type === 'tool_call');
    if (textContent.length > MAX_MODEL_RESPONSE_CHARACTERS) {
      throw deterministicFailure(
        MODEL_DIRECTIVE_ERROR,
        'The model response exceeded the bounded v3 content contract.'
      );
    }

    try {
      const directive = response.replay.finishReason === 'tool_calls'
        ? parseNativeToolCalls(textContent, nativeToolCalls, tools)
        : parseTextDirectiveResponse(
            response.replay.finishReason,
            textContent,
            nativeToolCalls,
            tools
          );
      if (directive.kind === 'respond') emitPublicChunk('token', directive.content);
      return {
        directive,
        responseEnvelope: {
          envelopeVersion: 1,
          providerId: binding.providerId,
          modelId: binding.modelId,
          settingsRevision: binding.settingsRevision,
          adapter: response.replay.adapter,
          finishReason: response.replay.finishReason,
          requestEnvelopeDigest: response.replay.requestEnvelopeDigest,
          contentBlocksDigest: response.replay.contentBlocksDigest,
          contentBlockTypes: response.contentBlocks.map((block) => block.type),
          ...(response.replay.providerResponseIdDigest === undefined
            ? {}
            : { providerResponseIdDigest: response.replay.providerResponseIdDigest })
        },
        ...(response.usage === undefined
          ? {}
          : {
              usageAnchor: {
                anchorVersion: 1,
                providerId: binding.providerId,
                modelId: binding.modelId,
                settingsRevision: binding.settingsRevision,
                requestHeaderDigest: context.requestHeaderDigest,
                requestEnvelopeDigest: response.replay.requestEnvelopeDigest,
                estimatedInputTokens: meteredInputTokens,
                inputTokens: response.usage.inputTokens,
                outputTokens: response.usage.outputTokens,
                ...(response.usage.cacheReadInputTokens === undefined
                  ? {}
                  : { cacheReadInputTokens: response.usage.cacheReadInputTokens }),
                ...(response.usage.cacheWriteInputTokens === undefined
                  ? {}
                  : { cacheWriteInputTokens: response.usage.cacheWriteInputTokens })
              }
            })
      };
    } catch (error) {
      if (error instanceof AgentInferenceDeterministicFailureError) throw error;
      throw deterministicFailure(
        MODEL_DIRECTIVE_ERROR,
        'The model response did not satisfy the strict v3 Directive contract.'
      );
    }
  }
}

function splitPublicUtf8Text(value: string): readonly string[] {
  if (value.length === 0) return [];
  const parts: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + 32 * 1_024);
    while (
      end > start
      && Buffer.byteLength(value.slice(start, end), 'utf8') > 32 * 1_024
    ) end -= 1;
    if (end === start) throw new Error('agent_public_stream_chunk_unrepresentable');
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts;
}

function openInferenceIdentity(input: AgentTurnInput): {
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
} {
  const intended = input.run.turns.flatMap((turn) => turn.attempts
    .filter((attempt) => attempt.state.status === 'intended')
    .map((attempt) => ({ turnId: turn.turnId, attemptId: attempt.attemptId })));
  if (intended.length !== 1) {
    throw deterministicFailure(
      MODEL_BINDING_ERROR,
      'AgentEngine requires one exact intended inference attempt identity.'
    );
  }
  return { runId: input.run.runId, ...intended[0]! };
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
      && current.content.length > 0
      && current.content.every((block) => block.type === 'tool_call')
      && next?.role === 'user'
      && next.content.length > 0
      && next.content.every((block) => block.type === 'tool_result')
      && exactToolExchangeIdsMatch(current, next)
    ) {
      groups.push({ kind: 'tool_exchange', messages: [current, next] });
      index += 1;
      continue;
    }
    if (
      current.role === 'user'
      && next?.role === 'assistant'
      && next.content.every((block) => block.type !== 'tool_call')
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

function exactToolExchangeIdsMatch(
  assistant: ExactAgentModelInferenceMessage,
  result: ExactAgentModelInferenceMessage
): boolean {
  const callIds = assistant.content.map((block) => (
    block.type === 'tool_call' ? block.toolCallId : null
  ));
  const resultIds = result.content.map((block) => (
    block.type === 'tool_result' ? block.toolCallId : null
  ));
  return callIds.length === resultIds.length
    && callIds.every((id, index) => id !== null && id === resultIds[index]);
}

function textMessage(
  role: ExactAgentModelInferenceMessage['role'],
  text: string
): ExactAgentModelInferenceMessage {
  return Object.freeze({
    role,
    content: Object.freeze([{ type: 'text' as const, text }])
  });
}

function prepareBoundModelHistory(
  input: AgentTurnInput
): readonly BoundModelHistoryEntry[] {
  const current = requireCurrentSchedulableAttempt(input);
  const turns = input.run.turns.slice(0, current.turnIndex + 1);
  const appendedCount = turns.slice(1).reduce((count, turn) => {
    const cause = turn.intention.cause;
    return count + (cause.kind === 'effect_results'
      ? cause.effectIds.length + (cause.inboxInputIds?.length ?? 0)
      : cause.kind === 'inbox_inputs'
        ? 1 + cause.inputIds.length
        : cause.kind === 'interrupted_inference'
          ? 1 + cause.inputIds.length
        : cause.kind === 'child_results'
          ? 2
        : Number.POSITIVE_INFINITY);
  }, 0);
  const baseCount = input.messages.length - appendedCount;
  if (!Number.isSafeInteger(baseCount) || baseCount < 1) throw invalidBoundModelHistory();
  const history: BoundModelHistoryEntry[] = [];
  for (let index = 0; index < baseCount; index += 1) {
    const message = input.messages[index];
    if (message?.kind === 'text') {
      history.push({ kind: 'message', message: textMessage(message.role, message.content) });
      continue;
    }
    if (message?.kind === 'image') {
      history.push({
        kind: 'image',
        image: {
          owner: { ...message.owner },
          ref: {
            ...message.attachment,
            ...(message.attachment.originalDimensions === undefined
              ? {}
              : { originalDimensions: { ...message.attachment.originalDimensions } })
          }
        }
      });
      continue;
    }
    throw invalidBoundModelHistory();
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
        history.push({
          kind: 'message',
          message: textMessage(message.role, message.content)
        });
      }
      messageIndex += batch.length;
      continue;
    }
    if (cause.kind === 'interrupted_inference') {
      const batch = input.messages.slice(
        messageIndex,
        messageIndex + 1 + cause.inputIds.length
      );
      const sourceTurn = input.run.turns.find(
        (candidate) => candidate.turnId === cause.sourceTurnId
      );
      const sourceAttempt = sourceTurn?.attempts.find(
        (candidate) => candidate.attemptId === cause.sourceAttemptId
      );
      if (
        batch.length !== 1 + cause.inputIds.length
        || batch[0]?.kind !== 'text'
        || batch[0].role !== 'system'
        || sourceAttempt?.state.status !== 'uncertain'
        || sourceAttempt.state.recovery.decisionId !== cause.recoveryDecisionId
        || batch.slice(1).some((message) => (
          message.kind !== 'text'
          || (message.role !== 'user' && message.role !== 'system')
        ))
      ) throw invalidBoundModelHistory();
      for (const message of batch) {
        if (message.kind !== 'text') throw invalidBoundModelHistory();
        history.push({ kind: 'message', message: textMessage(message.role, message.content) });
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
        { kind: 'message', message: textMessage('assistant', batch[0].content) },
        { kind: 'message', message: textMessage('user', batch[1].content) }
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
      kind: 'effect_exchange',
      directive: verified.directive,
      results: verified.results
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
      history.push({ kind: 'message', message: textMessage('user', message.content) });
    }
    messageIndex += inboxInputCount;
  }
  if (messageIndex !== input.messages.length) throw invalidBoundModelHistory();
  return history;
}

async function materializeBoundModelHistory(
  runId: string,
  entries: readonly BoundModelHistoryEntry[],
  tools: readonly PreparedToolContract[],
  effectInputs: AgentEffectExecutionInputReader | undefined,
  attachments: ConversationAttachmentReader | undefined,
  signal: AbortSignal
): Promise<readonly ExactAgentModelInferenceMessage[]> {
  const history: ExactAgentModelInferenceMessage[] = [];
  const requestToolCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'message') {
      history.push(entry.message);
      continue;
    }
    if (entry.kind === 'image') {
      if (attachments === undefined) {
        throw deterministicFailure(
          MODEL_BINDING_ERROR,
          'Durable Conversation attachments are unavailable for exact model history.'
        );
      }
      let stored;
      try {
        stored = await attachments.readOwnedImage(entry.image, signal);
      } catch {
        signal.throwIfAborted();
        throw deterministicFailure(
          MODEL_BINDING_ERROR,
          'A durable Conversation attachment could not be verified.'
        );
      }
      history.push(Object.freeze({
        role: 'user',
        content: Object.freeze([{
          type: 'image' as const,
          attachmentId: stored.ref.attachmentId,
          mediaType: stored.ref.mediaType,
          dataBase64: Buffer.from(stored.data).toString('base64'),
          bytes: stored.ref.bytes,
          width: stored.ref.width,
          height: stored.ref.height
        }])
      }));
      continue;
    }
    if (effectInputs === undefined) {
      throw deterministicFailure(
        MODEL_BINDING_ERROR,
        'Protected Tool inputs are unavailable for exact model history.'
      );
    }
    const calls: ExactAgentModelInferenceRequestContentBlock[] = [];
    const results: ExactAgentModelInferenceRequestContentBlock[] = [];
    for (let index = 0; index < entry.directive.invocations.length; index += 1) {
      signal.throwIfAborted();
      const invocation = entry.directive.invocations[index]!;
      const result = entry.results[index];
      const tool = tools.find((candidate) => (
        sameAgentPinnedToolIdentity(candidate.tool, invocation.tool)
      ));
      if (
        result === undefined
        || result.effectId !== invocation.effectId
        || result.toolCallId !== invocation.toolCallId
        || tool === undefined
        || !sameStringSequence(invocation.capabilityIds, tool.capabilityIds)
        || (
          tool.scopeSemantics === 'none'
            ? invocation.scope.length !== 0
            : invocation.scope.some((scopeId) => !tool.allowedScopes.includes(scopeId))
        )
      ) throw invalidBoundModelHistory();

      let protectedInput: Awaited<ReturnType<
        AgentEffectExecutionInputReader['loadEffectExecutionInput']
      >>;
      try {
        protectedInput = await effectInputs.loadEffectExecutionInput(
          runId,
          invocation.effectId
        );
      } catch {
        signal.throwIfAborted();
        throw deterministicFailure(
          MODEL_BINDING_ERROR,
          'Protected Tool input could not be resolved for exact model history.'
        );
      }
      signal.throwIfAborted();
      if (
        protectedInput.runId !== runId
        || protectedInput.effectId !== invocation.effectId
        || protectedInput.inputDigest !== invocation.inputDigest
      ) {
        throw deterministicFailure(
          MODEL_BINDING_ERROR,
          'Protected Tool input does not match the committed invocation.'
        );
      }
      const toolCallId = historicalProviderToolCallId(
        runId,
        invocation.effectId,
        invocation.toolCallId
      );
      if (requestToolCallIds.has(toolCallId)) throw invalidBoundModelHistory();
      requestToolCallIds.add(toolCallId);
      calls.push(Object.freeze({
        type: 'tool_call',
        toolCallId,
        providerToolName: tool.providerToolName,
        input: cloneCanonicalAgentToolInput({
          input: protectedInput.input,
          scope: [...invocation.scope]
        }, `modelHistory.toolCalls[${String(index)}].input`)
      }));
      results.push(Object.freeze({
        type: 'tool_result',
        effectId: result.effectId,
        toolCallId,
        status: result.status,
        output: cloneCanonicalAgentToolInput(
          result.result,
          `modelHistory.toolResults[${String(index)}].output`
        )
      }));
    }
    history.push(Object.freeze({ role: 'assistant', content: Object.freeze(calls) }));
    history.push(Object.freeze({ role: 'user', content: Object.freeze(results) }));
  }
  return Object.freeze(history);
}

function coalesceUserContentMessages(
  messages: readonly ExactAgentModelInferenceMessage[]
): readonly ExactAgentModelInferenceMessage[] {
  const result: ExactAgentModelInferenceMessage[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    const mergeable = message.role === 'user'
      && message.content.every((block) => block.type === 'text' || block.type === 'image')
      && previous?.role === 'user'
      && previous.content.every((block) => block.type === 'text' || block.type === 'image');
    if (mergeable && previous !== undefined) {
      result[result.length - 1] = Object.freeze({
        role: 'user',
        content: Object.freeze([...previous.content, ...message.content])
      });
    } else {
      result.push(message);
    }
  }
  return Object.freeze(result);
}

function historicalProviderToolCallId(
  runId: string,
  effectId: string,
  toolCallId: string
): string {
  return `history_${createHash('sha256')
    .update(canonicalJson({ runId, effectId, toolCallId }))
    .digest('hex')
    .slice(0, 40)}`;
}

function sameStringSequence(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
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
  const committed = sourceAttempt?.state.status === 'succeeded'
    ? sourceAttempt.state.directive.kind === 'delegate_subagent'
      ? [sourceAttempt.state.directive]
      : sourceAttempt.state.directive.kind === 'delegate_subagents'
        ? sourceAttempt.state.directive.delegations
        : []
    : [];
  if (
    sourceAttempt?.state.status !== 'succeeded'
    || sourceAttempt.state.directiveDigest !== cause.sourceDirectiveDigest
    || cause.delegationIds.length !== committed.length
    || cause.childRunIds.length !== committed.length
    || committed.some((item, index) => (
      item.delegationId !== cause.delegationIds[index]
      || item.childRunId !== cause.childRunIds[index]
    ))
  ) throw invalidBoundModelHistory();
  const assistant = parseExactObject(assistantContent);
  const result = parseExactObject(resultContent);
  const delegated = typeof assistant.directive === 'object'
    && assistant.directive !== null
    && !Array.isArray(assistant.directive)
    ? assistant.directive as Record<string, unknown>
    : null;
  const assistantDelegations = delegated?.kind === 'delegate_subagent'
    ? [delegated]
    : delegated?.kind === 'delegate_subagents' && Array.isArray(delegated.delegations)
      ? delegated.delegations
      : [];
  if (
    assistant.protocol !== DIRECTIVE_PROTOCOL
    || assistantDelegations.length !== committed.length
    || assistantDelegations.some((candidate, index) => {
      const expected = committed[index];
      return typeof candidate !== 'object'
        || candidate === null
        || Array.isArray(candidate)
        || expected === undefined
        || candidate.delegationId !== expected.delegationId
        || candidate.childRunId !== expected.childRunId
        || candidate.objectiveDigest !== expected.objectiveDigest
        || candidate.mode !== expected.mode;
    })
    || result.format !== SUBAGENT_RESULTS_FORMAT
    || result.schemaVersion !== 1
    || !Array.isArray(result.results)
    || result.results.length !== committed.length
  ) throw invalidBoundModelHistory();
  if (result.results.some((child, index) => (
    typeof child !== 'object'
    || child === null
    || Array.isArray(child)
    || child.delegationId !== cause.delegationIds[index]
    || child.childRunId !== cause.childRunIds[index]
    || !Number.isSafeInteger(child.childRunVersion)
    || !['completed', 'failed', 'cancelled'].includes(String(child.status))
    || typeof child.content !== 'string'
    || child.content.length === 0
  ))) throw invalidBoundModelHistory();
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

function assertPreparedModelRequest(
  modelId: string,
  messages: readonly ExactAgentModelInferenceMessage[],
  tools: readonly ExactAgentModelInferenceToolContract[]
): void {
  // This deliberately double-counts System content, so it is an upper bound
  // for both exact OpenAI-compatible and Anthropic text transports.
  const conservativeEnvelope = JSON.stringify({
    model: modelId,
    max_tokens: 4_096,
    system: messages
      .filter((message) => message.role === 'system')
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n'),
    messages,
    tools,
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

function digestTokenMeterHeader(
  binding: AgentRunBinding['model'],
  pinnedMessages: readonly ExactAgentModelInferenceMessage[],
  tools: readonly ExactAgentModelInferenceToolContract[]
): string {
  const encoded = canonicalJson({
    protocol: 'ariadne.token-meter-header.v1',
    providerId: binding.providerId,
    modelId: binding.modelId,
    settingsRevision: binding.settingsRevision,
    inference: binding.inference === undefined
      ? null
      : {
          reasoningMode: binding.inference.reasoningMode ?? null,
          reasoningEffort: binding.inference.reasoningEffort ?? null
        },
    pinnedMessages: pinnedMessages.map((message) => ({
      role: message.role,
      content: message.content
    })),
    tools: tools.map((tool) => ({
      providerToolName: tool.providerToolName,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  });
  return `sha256:${createHash('sha256').update(encoded).digest('hex')}`;
}

function findUsageBaseline(
  input: AgentTurnInput,
  requestHeaderDigest: string
): V3LongContextUsageBaseline | undefined {
  for (let turnIndex = input.run.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const attempts = input.run.turns[turnIndex]!.attempts;
    for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex -= 1) {
      const attempt = attempts[attemptIndex]!;
      if (attempt.state.status !== 'succeeded') continue;
      const anchor = attempt.state.usageAnchor;
      if (
        anchor === undefined
        || anchor.providerId !== input.run.binding.model.providerId
        || anchor.modelId !== input.run.binding.model.modelId
        || anchor.settingsRevision !== input.run.binding.model.settingsRevision
        || anchor.requestHeaderDigest !== requestHeaderDigest
      ) continue;
      return {
        attemptId: attempt.attemptId,
        anchor: { ...anchor }
      };
    }
  }
  return undefined;
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

function renderProtocolPrompt(
  tools: readonly PreparedToolContract[],
  executionMode: 'chat' | 'agent' | 'plan',
  subagentProviders: readonly AgentSubagentProviderBinding[]
): string {
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
      prompt: 'complete self-contained delegated objective',
      mode: 'one_shot | continuable',
      providerId: 'one advertised subagentProviders.providerId; omit to use the default'
    }
  };
  const delegateSubagents = {
    kind: 'delegate_subagents',
    subagents: [
      delegateSubagent.subagent,
      { ...delegateSubagent.subagent, description: 'second independent child objective' }
    ]
  };
  const askUser = {
    kind: 'ask_user',
    question: {
      prompt: 'one concrete question for the user',
      options: [
        {
          optionId: 'stable_option_a',
          label: 'first short option label',
          description: 'optional consequence or tradeoff'
        },
        {
          optionId: 'stable_option_b',
          label: 'second short option label'
        }
      ]
    }
  };
  const prompt = JSON.stringify({
    protocol: DIRECTIVE_PROTOCOL,
    instruction:
      'Return exactly one JSON object with keys protocol and directive. '
      + 'Use an advertised native function for Tool invocation; never synthesize invoke_tools JSON. '
      + 'Otherwise do not return markdown, commentary, or hidden reasoning.',
    executionMode,
    directiveShapes: executionMode === 'plan'
      ? {
          propose_plan: proposePlan,
          ask_user: askUser,
          checkpoint: { kind: 'checkpoint', reason: 'non-empty string' },
          fail: {
            kind: 'fail',
            errorCode: 'non-empty string',
            message: 'non-empty string'
          }
        }
      : executionMode === 'chat'
        ? {
            respond: { kind: 'respond', content: 'non-empty string' },
            ask_user: askUser,
            checkpoint: { kind: 'checkpoint', reason: 'non-empty string' },
            complete: { kind: 'complete', outputRef: 'optional non-empty string' },
            fail: {
              kind: 'fail',
              errorCode: 'non-empty string',
              message: 'non-empty string'
            }
          }
        : {
          respond: { kind: 'respond', content: 'non-empty string' },
          ask_user: askUser,
          delegate_subagent: delegateSubagent,
          delegate_subagents: delegateSubagents,
          propose_plan: proposePlan,
          checkpoint: { kind: 'checkpoint', reason: 'non-empty string' },
          complete: { kind: 'complete', outputRef: 'optional non-empty string' },
          fail: {
            kind: 'fail',
            errorCode: 'non-empty string',
            message: 'non-empty string'
          }
        },
    subagentProviders: executionMode === 'agent'
      ? subagentProviders.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          configurationDigest: provider.configurationDigest,
          transport: provider.transport,
          supportedModes: [...provider.supportedModes],
          supportsStructuredReport: provider.supportsStructuredReport,
          inheritsParentContext: provider.inheritsParentContext,
          usesParentTools: provider.usesParentTools
        }))
      : [],
    nativeToolCount: tools.length
  });
  if (new TextEncoder().encode(prompt).byteLength > MAX_PROTOCOL_PROMPT_BYTES) {
    throw deterministicFailure(
      TOOL_CONTRACT_ERROR,
      'The exact model-visible Tool contract prompt exceeds its bounded size.'
    );
  }
  return prompt;
}

function parseTextDirectiveResponse(
  finishReason: ExactAgentModelInferenceReplayEnvelopeV1['finishReason'],
  content: string,
  nativeToolCalls: readonly Extract<
    ExactAgentModelInferenceContentBlock,
    { readonly type: 'tool_call' }
  >[],
  tools: readonly PreparedToolContract[]
): AgentDirective {
  if (finishReason !== 'stop' || nativeToolCalls.length !== 0) {
    throw new StrictDirectiveProtocolError();
  }
  return parseDirectiveEnvelope(content, tools);
}

function parseNativeToolCalls(
  textContent: string,
  calls: readonly Extract<
    ExactAgentModelInferenceContentBlock,
    { readonly type: 'tool_call' }
  >[],
  tools: readonly PreparedToolContract[]
): AgentDirective {
  if (textContent.trim().length !== 0 || calls.length === 0) {
    throw new StrictDirectiveProtocolError();
  }
  const toolsByProviderName = new Map(
    tools.map((tool) => [tool.providerToolName, tool] as const)
  );
  const toolCallIds = new Set<string>();
  const invocations = calls.map((call) => {
    const tool = toolsByProviderName.get(call.providerToolName);
    if (tool === undefined || toolCallIds.has(call.toolCallId)) {
      throw new StrictDirectiveProtocolError();
    }
    toolCallIds.add(call.toolCallId);
    const envelope = exactObject(call.input, ['input', 'scope']);
    const scope = stringArray(envelope.scope);
    if (
      tool.scopeSemantics === 'none'
        ? scope.length !== 0
        : scope.some((scopeId) => !tool.allowedScopes.includes(scopeId))
    ) throw new StrictDirectiveProtocolError();
    return {
      toolCallId: call.toolCallId,
      tool: cloneAgentPinnedToolIdentity(tool.tool),
      input: cloneCanonicalAgentToolInput(envelope.input, 'nativeToolCall.input'),
      capabilityIds: [...tool.capabilityIds],
      scope
    };
  });
  const directive: AgentDirective = { kind: 'invoke_tools', invocations };
  try {
    assertValidAgentDirective(directive);
  } catch {
    throw new StrictDirectiveProtocolError();
  }
  return directive;
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
      const subagent = exactObjectWithOptional(
        exact.subagent,
        ['description', 'prompt', 'mode'],
        ['providerId']
      );
      return {
        kind: 'delegate_subagent',
        subagent: {
          description: stringValue(subagent.description),
          prompt: stringValue(subagent.prompt),
          mode: subagentModeValue(subagent.mode),
          ...(subagent.providerId === undefined
            ? {}
            : { providerId: stringValue(subagent.providerId) })
        }
      };
    }
    case 'delegate_subagents': {
      const exact = exactObject(candidate, ['kind', 'subagents']);
      if (!Array.isArray(exact.subagents)) throw new StrictDirectiveProtocolError();
      return {
        kind: 'delegate_subagents',
        subagents: exact.subagents.map((candidateSubagent) => {
          const subagent = exactObjectWithOptional(
            candidateSubagent,
            ['description', 'prompt', 'mode'],
            ['providerId']
          );
          return {
            description: stringValue(subagent.description),
            prompt: stringValue(subagent.prompt),
            mode: subagentModeValue(subagent.mode),
            ...(subagent.providerId === undefined
              ? {}
              : { providerId: stringValue(subagent.providerId) })
          };
        })
      };
    }
    case 'ask_user': {
      const exact = exactObject(candidate, ['kind', 'question']);
      const question = exactObjectWithOptional(exact.question, ['prompt'], ['options']);
      const options = question.options;
      if (options !== undefined && !Array.isArray(options)) {
        throw new StrictDirectiveProtocolError();
      }
      return {
        kind: 'ask_user',
        question: {
          prompt: stringValue(question.prompt),
          ...(options === undefined
            ? {}
            : {
                options: options.map((candidateOption) => {
                  const option = exactObjectWithOptional(
                    candidateOption,
                    ['optionId', 'label'],
                    ['description']
                  );
                  return {
                    optionId: stringValue(option.optionId),
                    label: stringValue(option.label),
                    ...(option.description === undefined
                      ? {}
                      : { description: stringValue(option.description) })
                  };
                })
              })
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

function prepareProviderToolContracts(
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

function estimateProviderToolTokens(
  tools: readonly ExactAgentModelInferenceToolContract[]
): number {
  if (tools.length === 0) return 0;
  return estimateMessagesTokens([
    textMessage('system', JSON.stringify({ tools }))
  ]);
}

function modelVisibleSubagentProviders(
  binding: AgentRunBinding
): readonly AgentSubagentProviderBinding[] {
  if (
    binding.bindingVersion === 4
    && binding.executionProfile.subagentProviders !== undefined
  ) return binding.executionProfile.subagentProviders;
  return [DEFAULT_AGENT_SUBAGENT_PROVIDER_BINDING];
}

function subagentModeValue(value: unknown): 'one_shot' | 'continuable' {
  if (value !== 'one_shot' && value !== 'continuable') {
    throw new StrictDirectiveProtocolError();
  }
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
