import { createHash } from 'node:crypto';

import { cloneCanonicalAgentToolInput } from '@ariadne/agent-core';
import type {
  AgentModelSelectionPreference,
  DispatchExactAgentModelInferenceRequest,
  ExactAgentModelContextCapacity,
  ExactAgentModelExecutionQualification,
  ExactAgentModelInferenceRuntime,
  ExactAgentModelInferenceResult,
  ExactAgentModelInferenceContentBlock,
  ExactAgentModelInferenceMessage
} from '../control/ports/AgentModelInference.js';
import { ModelExecutionQualificationError } from '../control/ports/AgentModelInference.js';
import type { RuntimeBootstrap } from '@ariadne/protocol/host';
import type { LocalModelService } from '../model/local/LocalModelService.js';
import type { ChatMessage } from '../model/types.js';
import type { ModelCapabilityRegistry } from '../model/capability/ModelCapabilityRegistry.js';
import { deriveModelCapabilities } from '../model/capability/ModelCapabilityQualification.js';

export const LOCAL_AGENT_MODEL_PROVIDER_ID = 'ariadne.local' as const;

/**
 * One exact inference boundary for the production Runtime model domain.
 * Remote transport keeps its strict Provider binding while local bindings use
 * the already discovered embedded ModelClient owned by LocalModelService.
 */
export class RuntimeKernelModelInferenceGateway
implements ExactAgentModelInferenceRuntime {
  public constructor(
    private readonly remote: ExactAgentModelInferenceRuntime,
    private readonly localModels: LocalModelService,
    private readonly modelProviders: RuntimeBootstrap['modelProviders'],
    private readonly defaultRoutingStrategy: NonNullable<RuntimeBootstrap['routingStrategy']>,
    private readonly modelCapabilities: ModelCapabilityRegistry | undefined,
    private readonly isRemoteAvailable: (providerId: string, modelId: string) => boolean,
    private readonly disabledLocalModelIds: ReadonlySet<string> = new Set()
  ) {}

  public resolveBinding(
    settingsRevision: number,
    preference: AgentModelSelectionPreference = {}
  ): DispatchExactAgentModelInferenceRequest['binding'] | null {
    const executionMode = preference.executionMode ?? 'agent';
    const local = this.localModels.clients().filter((client) => !this.disabledLocalModelIds.has(client.name)).map((client) => ({
      providerId: LOCAL_AGENT_MODEL_PROVIDER_ID,
      modelId: client.name,
      settingsRevision
    }));
    const remote = (this.modelProviders ?? []).flatMap((provider) => (
      provider.enabled
      && this.isRemoteAvailable(provider.providerId, provider.model)
        ? [{
            providerId: provider.providerId,
            modelId: provider.model,
            settingsRevision
          }]
        : []
    ));
    if (preference.modelId !== undefined) {
      const selected = [...local, ...remote].find(
        (candidate) => candidate.modelId === preference.modelId
      ) ?? null;
      if (selected === null) return null;
      this.assertQualified(selected, executionMode, preference.requiresVision === true);
      return selected;
    }
    const strategy = preference.routingStrategy ?? this.defaultRoutingStrategy;
    const available = strategy === 'privacy-first'
      ? local
      : strategy === 'local-first'
        ? [...local, ...remote]
        : [...remote, ...local];
    const selected = available.find((candidate) => this.isQualified(
      candidate,
      executionMode,
      preference.requiresVision === true
    ));
    if (selected !== undefined) return selected;
    if (available.length > 0) {
      throw new ModelExecutionQualificationError(qualificationErrorCode(
        executionMode,
        preference.requiresVision === true
      ));
    }
    return null;
  }

  private assertQualified(
    binding: DispatchExactAgentModelInferenceRequest['binding'],
    executionMode: 'chat' | 'agent' | 'plan',
    requiresVision: boolean
  ): void {
    if (this.isQualified(binding, executionMode, requiresVision)) return;
    throw new ModelExecutionQualificationError(
      qualificationErrorCode(executionMode, requiresVision),
      binding.modelId
    );
  }

  private isQualified(
    binding: DispatchExactAgentModelInferenceRequest['binding'],
    executionMode: 'chat' | 'agent' | 'plan',
    requiresVision: boolean
  ): boolean {
    const qualification = this.describeExecutionQualification(binding);
    return supportsExecutionMode(qualification, executionMode)
      && (!requiresVision || qualification?.supportsVision === true);
  }

  public hasExactBinding(
    binding: DispatchExactAgentModelInferenceRequest['binding']
  ): boolean {
    if (binding.providerId !== LOCAL_AGENT_MODEL_PROVIDER_ID) {
      return this.remote.hasExactBinding(binding);
    }
    return !this.disabledLocalModelIds.has(binding.modelId) && this.localModels.clients().some(
      (candidate) => candidate.name === binding.modelId
    );
  }

  public describeContextCapacity(
    binding: DispatchExactAgentModelInferenceRequest['binding']
  ): ExactAgentModelContextCapacity | null {
    if (binding.providerId !== LOCAL_AGENT_MODEL_PROVIDER_ID) {
      return this.remote.describeContextCapacity(binding);
    }
    const client = this.disabledLocalModelIds.has(binding.modelId) ? undefined : this.localModels.clients().find(
      (candidate) => candidate.name === binding.modelId
    );
    const contextWindowTokens = client?.contextWindowTokens;
    if (
      contextWindowTokens === undefined
      || !Number.isSafeInteger(contextWindowTokens)
      || contextWindowTokens < 8_192
    ) return null;
    return {
      contextWindowTokens,
      maxOutputTokens: Math.min(4_096, Math.floor(contextWindowTokens / 4))
    };
  }

  public describeExecutionQualification(
    binding: DispatchExactAgentModelInferenceRequest['binding']
  ): ExactAgentModelExecutionQualification | null {
    if (this.modelCapabilities !== undefined) {
      const report = this.modelCapabilities.current(binding.providerId, binding.modelId);
      if (report === null) return null;
      const capability = deriveModelCapabilities(report);
      return {
        supportsTextResponse: capability.supportsTextChat,
        supportsAgent: capability.supportsAgent,
        supportsPlan: capability.supportsPlan,
        supportsVision: capability.supportsVision
      };
    }
    if (binding.providerId !== LOCAL_AGENT_MODEL_PROVIDER_ID) {
      return this.remote.describeExecutionQualification(binding);
    }
    const client = this.disabledLocalModelIds.has(binding.modelId) ? undefined : this.localModels.clients().find(
      (candidate) => candidate.name === binding.modelId
    );
    if (client === undefined) return null;
    const supportsAgent = client.toolCallCapability === 'native';
    return {
      supportsTextResponse: true,
      supportsAgent,
      supportsPlan: supportsAgent,
      supportsVision: false
    };
  }

  public async inferExact(
    request: DispatchExactAgentModelInferenceRequest
  ): Promise<ExactAgentModelInferenceResult> {
    if (request.binding.providerId !== LOCAL_AGENT_MODEL_PROVIDER_ID) {
      return this.remote.inferExact(request);
    }
    const client = this.disabledLocalModelIds.has(request.binding.modelId) ? undefined : this.localModels.clients().find(
      (candidate) => candidate.name === request.binding.modelId
    );
    if (client === undefined) return { status: 'binding_unavailable' };
    if (request.messages.some((message) => (
      message.content.some((block) => block.type === 'image')
    ))) return { status: 'binding_unavailable' };
    const exactRequest = {
      messages: toLocalModelMessages(request.messages),
      tools: request.tools.map((tool) => ({
        name: tool.providerToolName,
        description: tool.description,
        parameters: structuredClone(tool.inputSchema) as Record<string, unknown>
      })),
      ...(request.binding.inference === undefined
        ? {}
        : { inference: structuredClone(request.binding.inference) }),
      ...(request.sampling?.temperature === undefined
        ? {}
        : { temperature: request.sampling.temperature }),
      ...(request.sampling?.maxOutputTokens === undefined
        ? {}
        : { maxTokens: request.sampling.maxOutputTokens })
    };
    let observedSequence = 0;
    let observerQueue = Promise.resolve();
    const observe = (channel: 'token' | 'reasoning', text: string): void => {
      if (request.chunkObserver === undefined) return;
      const sequence = ++observedSequence;
      observerQueue = observerQueue.then(async () => {
        await request.chunkObserver!.observe({ sequence, channel, text });
      });
    };
    const response = await client.chat({
      ...exactRequest,
      signal: request.signal,
      onToken: (delta) => observe('token', delta),
      onReasoningToken: (delta) => observe('reasoning', delta)
    });
    await observerQueue;
    const toolNames = new Set(request.tools.map((tool) => tool.providerToolName));
    const toolCallIds = new Set<string>();
    const contentBlocks: ExactAgentModelInferenceContentBlock[] = [];
    if (response.reasoningContent !== undefined && response.reasoningContent.length > 0) {
      contentBlocks.push(Object.freeze({
        type: 'reasoning',
        text: response.reasoningContent
      }));
    }
    if (response.content.length > 0) {
      contentBlocks.push(Object.freeze({ type: 'text', text: response.content }));
    }
    for (const [index, call] of response.toolCalls.entries()) {
      if (!toolNames.has(call.name)) throw new Error('agent_local_model_tool_name_invalid');
      const toolCallId = digestText(`${String(index)}\u0000${call.id}`).slice(7);
      const normalizedId = `native-${toolCallId}`;
      if (toolCallIds.has(normalizedId)) throw new Error('agent_local_model_tool_id_duplicate');
      toolCallIds.add(normalizedId);
      contentBlocks.push(Object.freeze({
        type: 'tool_call',
        toolCallId: normalizedId,
        providerToolName: call.name,
        input: cloneCanonicalAgentToolInput(call.arguments, 'localModel.toolCall.input')
      }));
    }
    const requestEnvelopeDigest = digestText(JSON.stringify(exactRequest));
    return {
      status: 'completed',
      contentBlocks: Object.freeze(contentBlocks),
      replay: Object.freeze({
        envelopeVersion: 1,
        adapter: 'embedded-local',
        finishReason: response.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        requestEnvelopeDigest,
        contentBlocksDigest: digestText(JSON.stringify(contentBlocks))
      }),
      ...(response.usage?.inputTokens === undefined
        || response.usage.outputTokens === undefined
        ? {}
        : {
            usage: {
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens
            }
          })
    };
  }

  public async countRequestTokens(
    request: Parameters<ExactAgentModelInferenceRuntime['countRequestTokens']>[0]
  ): ReturnType<ExactAgentModelInferenceRuntime['countRequestTokens']> {
    if (request.binding.providerId !== LOCAL_AGENT_MODEL_PROVIDER_ID) {
      return this.remote.countRequestTokens(request);
    }
    request.signal.throwIfAborted();
    const client = this.disabledLocalModelIds.has(request.binding.modelId) ? undefined : this.localModels.clients().find(
      (candidate) => candidate.name === request.binding.modelId
    );
    if (client === undefined) throw new Error('agent_local_model_tokenizer_binding_unavailable');
    const counted = await client.tokenCounter.countRequest({
      messages: toLocalModelMessages(request.messages),
      tools: request.tools.map((tool) => ({
        name: tool.providerToolName,
        description: tool.description,
        parameters: structuredClone(tool.inputSchema) as Record<string, unknown>
      }))
    });
    request.signal.throwIfAborted();
    return {
      tokens: counted.tokens,
      exact: counted.exact,
      tokenizer: counted.tokenizer
    };
  }
}

function supportsExecutionMode(
  qualification: ExactAgentModelExecutionQualification | null,
  mode: 'chat' | 'agent' | 'plan'
): boolean {
  if (qualification === null || !qualification.supportsTextResponse) return false;
  if (mode === 'agent') return qualification.supportsAgent;
  if (mode === 'plan') return qualification.supportsPlan;
  return true;
}

function qualificationErrorCode(
  mode: 'chat' | 'agent' | 'plan',
  requiresVision: boolean
): ModelExecutionQualificationError['code'] {
  if (requiresVision) return 'model_vision_qualification_required';
  if (mode === 'agent') return 'model_agent_qualification_required';
  if (mode === 'plan') return 'model_plan_qualification_required';
  return 'model_text_qualification_required';
}

function toLocalModelMessages(
  messages: readonly ExactAgentModelInferenceMessage[]
): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = message.content.filter((block) => block.type === 'tool_call');
    const toolResults = message.content.filter((block) => block.type === 'tool_result');
    if (toolResults.length > 0) {
      if (message.role !== 'user' || text.length > 0 || toolCalls.length > 0) {
        throw new Error('agent_local_model_history_invalid');
      }
      for (const block of toolResults) {
        result.push({
          role: 'tool',
          toolCallId: block.toolCallId,
          content: JSON.stringify({ status: block.status, output: block.output })
        });
      }
      continue;
    }
    if (message.role === 'system' && toolCalls.length > 0) {
      throw new Error('agent_local_model_history_invalid');
    }
    result.push({
      role: message.role,
      content: text,
      ...(toolCalls.length === 0
        ? {}
        : {
            toolCalls: toolCalls.map((block) => ({
              id: block.toolCallId,
              name: block.providerToolName,
              arguments: structuredClone(block.input)
            }))
          })
    });
  }
  return result;
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
