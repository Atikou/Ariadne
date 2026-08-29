import { createHash } from 'node:crypto';

import { cloneCanonicalAgentToolInput } from '@ariadne/agent-core';
import type {
  AgentModelSelectionPreference,
  DispatchExactAgentModelInferenceRequest,
  ExactAgentModelContextCapacity,
  ExactAgentModelInferenceRuntime,
  ExactAgentModelInferenceResult,
  ExactAgentModelInferenceContentBlock,
  ExactAgentModelInferenceMessage
} from '../control/ports/AgentModelInference.js';
import type { RuntimeBootstrap } from '@ariadne/protocol/host';
import type { LocalModelService } from '../model/local/LocalModelService.js';
import type { ChatMessage } from '../model/types.js';

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
    private readonly defaultRoutingStrategy: NonNullable<RuntimeBootstrap['routingStrategy']>
  ) {}

  public resolveBinding(
    settingsRevision: number,
    preference: AgentModelSelectionPreference = {}
  ): DispatchExactAgentModelInferenceRequest['binding'] | null {
    const local = this.localModels.clients().map((client) => ({
      providerId: LOCAL_AGENT_MODEL_PROVIDER_ID,
      modelId: client.name,
      settingsRevision
    }));
    const remote = (this.modelProviders ?? []).flatMap((provider) => (
      provider.enabled
      && Boolean(process.env[provider.credentialEnvironmentVariable]?.trim())
        ? [{
            providerId: provider.providerId,
            modelId: provider.model,
            settingsRevision
          }]
        : []
    ));
    if (preference.modelId !== undefined) {
      return [...local, ...remote].find(
        (candidate) => candidate.modelId === preference.modelId
      ) ?? null;
    }
    const strategy = preference.routingStrategy ?? this.defaultRoutingStrategy;
    const candidates = strategy === 'privacy-first'
      ? local
      : strategy === 'local-first'
        ? [...local, ...remote]
        : [...remote, ...local];
    return candidates[0] ?? null;
  }

  public hasExactBinding(
    binding: DispatchExactAgentModelInferenceRequest['binding']
  ): boolean {
    if (binding.providerId !== LOCAL_AGENT_MODEL_PROVIDER_ID) {
      return this.remote.hasExactBinding(binding);
    }
    return this.localModels.clients().some(
      (candidate) => candidate.name === binding.modelId
    );
  }

  public describeContextCapacity(
    binding: DispatchExactAgentModelInferenceRequest['binding']
  ): ExactAgentModelContextCapacity | null {
    if (binding.providerId !== LOCAL_AGENT_MODEL_PROVIDER_ID) {
      return this.remote.describeContextCapacity(binding);
    }
    const client = this.localModels.clients().find(
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

  public async inferExact(
    request: DispatchExactAgentModelInferenceRequest
  ): Promise<ExactAgentModelInferenceResult> {
    if (request.binding.providerId !== LOCAL_AGENT_MODEL_PROVIDER_ID) {
      return this.remote.inferExact(request);
    }
    const client = this.localModels.clients().find(
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
        : { inference: structuredClone(request.binding.inference) })
    };
    const response = await client.chat({ ...exactRequest, signal: request.signal });
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
