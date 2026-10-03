import {
  AgentInferenceDeterministicFailureError,
  agentRunExecutionMode,
  cloneAgentAvailableTool,
  type AgentDirective,
  type AgentEngine,
  type AgentEffectExecutionInputReader,
  type AgentInferenceResponseEnvelopeV1,
  type AgentInferenceUsageAnchorV1,
  type PreparedAgentDecision,
  type AgentRunBinding,
  type AgentTurnInput
} from '@ariadne/agent-core';
import { redactPublicProjectionTextV3 } from '@ariadne/protocol/public';
import type {
  ExactAgentModelInferenceContentBlock,
  ExactAgentModelInferenceRuntime,
  ExactAgentModelInferenceToolContract
} from '../../control/ports/AgentModelInference.js';
import {
  admitV3TokenizedProjections,
  planV3LongContext,
  type V3LongContextPlan
} from './V3LongContextLifecycle.js';
import type { AgentInferenceToolContractReader } from '../../control/ports/AgentInferenceToolContracts.js';
import type { BoundInferenceStreamProjection } from '../../projection/InferenceStreamProjectionPorts.js';
import type { InferenceStreamPublicProjectionPublisher } from '../../projection/InferenceStreamPublicProjectionPublisher.js';
import type { ConversationAttachmentReader } from '../../control/ports/ConversationAttachmentStore.js';
import {
  assertPreparedModelRequest,
  digestTokenMeterHeader,
  findUsageBaseline,
  openInferenceIdentity,
  renderNativeAgentPrompt,
  splitPublicUtf8Text,
  validateBoundInput
} from './AgentModelRequest.js';
import {
  coalesceUserContentMessages,
  groupModelHistory,
  materializeBoundModelHistory,
  prepareBoundModelHistory,
  textMessage
} from './AgentModelHistory.js';
import {
  MAX_MODEL_RESPONSE_CHARACTERS,
  MODEL_AGENT_QUALIFICATION_ERROR,
  MODEL_BINDING_ERROR,
  MODEL_CONTEXT_ERROR,
  MODEL_DIRECTIVE_ERROR,
  MODEL_PLAN_QUALIFICATION_ERROR,
  MODEL_TEXT_QUALIFICATION_ERROR,
  MODEL_TEXT_RESPONSE_ERROR,
  type ModelDecisionChannel,
  type PreparedToolContract,
  deterministicFailure
} from './AgentModelProtocol.js';
import {
  cloneToolCatalogBinding,
  estimateProviderToolTokens,
  modelVisibleSubagentProviders,
  prepareControlToolContracts,
  prepareProviderToolContracts,
  prepareToolContracts
} from './AgentModelToolContracts.js';
import { parseNativeAgentResponse, parsePlainTextResponse } from './AgentModelResponse.js';

export type {
  AgentInferenceToolContractDescriptorV2,
  AgentInferenceToolContractReader,
  ReadAgentInferenceToolContractsRequest
} from '../../control/ports/AgentInferenceToolContracts.js';

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
    const executionMode = agentRunExecutionMode(input.run.binding);
    const qualification = this.models.describeExecutionQualification(input.run.binding.model);
    if (qualification === null || !qualification.supportsTextResponse) {
      throw deterministicFailure(
        MODEL_TEXT_QUALIFICATION_ERROR,
        'The exact model binding is not qualified for text responses.'
      );
    }
    if (executionMode === 'agent' && !qualification.supportsAgent) {
      throw deterministicFailure(
        MODEL_AGENT_QUALIFICATION_ERROR,
        'The exact model binding is not qualified for Agent execution.'
      );
    }
    if (executionMode === 'plan' && !qualification.supportsPlan) {
      throw deterministicFailure(
        MODEL_PLAN_QUALIFICATION_ERROR,
        'The exact model binding is not qualified for Plan execution.'
      );
    }
    const decisionChannel: ModelDecisionChannel = executionMode === 'chat'
      && !qualification.supportsAgent
      ? 'text_response'
      : 'native_agent';
    signal.throwIfAborted();

    const descriptors = decisionChannel === 'text_response'
      ? []
      : await this.toolContracts.readInferenceToolContracts({
          catalog: cloneToolCatalogBinding(input.run.binding.toolCatalog),
          availableTools: input.availableTools.map((available, index) => (
            cloneAgentAvailableTool(
              available,
              `engineInput.availableTools[${String(index)}]`
            )
          ))
        }, signal);
    signal.throwIfAborted();
    const tools = decisionChannel === 'text_response'
      ? []
      : prepareToolContracts(input, descriptors);
    const modelHistory = coalesceUserContentMessages(await materializeBoundModelHistory(
      input.run.runId,
      boundHistory,
      tools,
      this.effectInputs,
      this.attachments,
      signal
    ));
    const providerTools = decisionChannel === 'text_response'
      ? []
      : [
          ...prepareProviderToolContracts(tools),
          ...prepareControlToolContracts(executionMode)
        ];
    const protocolPrompt = decisionChannel === 'text_response'
      ? null
      : renderNativeAgentPrompt(
          executionMode,
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
        ...(protocolPrompt === null ? [] : [textMessage('system', protocolPrompt)]),
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
          executionMode,
          decisionChannel,
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
    executionMode: 'chat' | 'agent' | 'plan',
    decisionChannel: ModelDecisionChannel,
    signal: AbortSignal,
    stream?: BoundInferenceStreamProjection
  ): Promise<{
    readonly directive: AgentDirective;
    readonly usageAnchor?: AgentInferenceUsageAnchorV1;
    readonly responseEnvelope: AgentInferenceResponseEnvelopeV1;
  }> {
    let publicSequence = 0;
    let textStreamObserved = false;
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
          if (chunk.channel === 'reasoning') {
            emitPublicChunk('reasoning', chunk.text);
          } else {
            textStreamObserved = true;
            emitPublicChunk('token', chunk.text);
          }
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
      const directive = decisionChannel === 'text_response'
        ? parsePlainTextResponse(
            response.replay.finishReason,
            textContent,
            nativeToolCalls
          )
        : parseNativeAgentResponse(
            response.replay.finishReason,
            textContent,
            nativeToolCalls,
            tools,
            executionMode
          );
      if (directive.kind === 'respond' && !textStreamObserved) {
        emitPublicChunk('token', directive.content);
      }
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
        decisionChannel === 'text_response'
          ? MODEL_TEXT_RESPONSE_ERROR
          : MODEL_DIRECTIVE_ERROR,
        decisionChannel === 'text_response'
          ? 'The text model response was not one bounded non-empty text result.'
          : 'The native Agent response was not one valid text result or native call decision.'
      );
    }
  }
}
