import type { ExactAgentModelInferenceFinishReason } from '../../control/ports/AgentModelInference.js';
import type {
  ExactAgentInferenceChunkChannel,
  ExactAgentProviderToolCallDelta
} from './ExactAgentInferenceContentAssembler.js';

const MAX_USAGE_TOKENS = 1_000_000_000;

export interface ExactAgentProviderTextDelta {
  readonly channel: ExactAgentInferenceChunkChannel;
  readonly text: string;
}

export interface ExactAgentProviderEventResult {
  readonly deltas: readonly ExactAgentProviderTextDelta[];
  readonly toolCallDeltas: readonly ExactAgentProviderToolCallDelta[];
  readonly completed: boolean;
  readonly finishReason?: ExactAgentModelInferenceFinishReason;
  readonly providerResponseId?: string;
  readonly modelId?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
  };
}

/** Decodes one OpenAI-compatible SSE data payload without assembling content. */
export function decodeOpenAiCompatibleStreamEvent(
  data: string
): ExactAgentProviderEventResult {
  if (data === '[DONE]') return emptyResult(true);
  const payload = parseObject(data);
  const choices = payload.choices;
  if (!Array.isArray(choices)) throw invalidEvent();
  const usage = openAiUsage(payload.usage);
  const providerResponseId = optionalStringValue(payload.id);
  if (choices.length === 0) {
    if (usage === undefined) throw invalidEvent();
    return freezeResult({
      deltas: [],
      toolCallDeltas: [],
      completed: false,
      modelId: optionalStringValue(payload.model),
      providerResponseId,
      usage
    });
  }
  if (choices.length !== 1) throw invalidEvent();
  const choice = objectValue(choices[0]);
  if (choice.index !== undefined && nonnegativeInteger(choice.index) !== 0) {
    throw invalidEvent();
  }
  const delta = objectValue(choice.delta);
  const deltas: ExactAgentProviderTextDelta[] = [];
  appendOptionalText(deltas, 'token', delta.content);
  appendOptionalText(deltas, 'reasoning', delta.reasoning_content);
  if (delta.reasoning_content === undefined) {
    appendOptionalText(deltas, 'reasoning', delta.reasoning);
  }
  const toolCallDeltas = openAiToolCallDeltas(delta.tool_calls);
  const providerFinishReason = optionalNullableStringValue(choice.finish_reason);
  return freezeResult({
    deltas,
    toolCallDeltas,
    completed: providerFinishReason !== undefined,
    ...(providerFinishReason === undefined
      ? {}
      : { finishReason: normalizeOpenAiFinishReason(providerFinishReason) }),
    modelId: stringValue(payload.model),
    providerResponseId,
    usage
  });
}

/** Decodes one Anthropic Messages SSE data payload without assembling content. */
export function decodeAnthropicStreamEvent(data: string): ExactAgentProviderEventResult {
  const payload = parseObject(data);
  const type = stringValue(payload.type);
  if (type === 'message_stop') return emptyResult(true);
  if (type === 'message_start') {
    const message = objectValue(payload.message);
    return freezeResult({
      deltas: [],
      toolCallDeltas: [],
      completed: false,
      modelId: stringValue(message.model),
      providerResponseId: optionalStringValue(message.id),
      usage: anthropicUsage(message.usage, 'input')
    });
  }
  if (type === 'message_delta') {
    const delta = objectValue(payload.delta);
    const providerFinishReason = optionalNullableStringValue(delta.stop_reason);
    return freezeResult({
      deltas: [],
      toolCallDeltas: [],
      completed: false,
      ...(providerFinishReason === undefined
        ? {}
        : { finishReason: normalizeAnthropicFinishReason(providerFinishReason) }),
      usage: anthropicUsage(payload.usage, 'output')
    });
  }
  if (type === 'ping') return emptyResult(false);
  if (type === 'content_block_start') {
    const index = nonnegativeInteger(payload.index);
    const block = objectValue(payload.content_block);
    const blockType = stringValue(block.type);
    if (blockType === 'tool_use') {
      return freezeResult({
        deltas: [],
        toolCallDeltas: [{
          index,
          providerCallId: stringValue(block.id),
          providerToolName: stringValue(block.name),
          initialInput: objectValue(block.input)
        }],
        completed: false
      });
    }
    if (!['text', 'thinking', 'redacted_thinking'].includes(blockType)) throw invalidEvent();
    return emptyResult(false);
  }
  if (type === 'content_block_stop') {
    nonnegativeInteger(payload.index);
    return emptyResult(false);
  }
  if (type !== 'content_block_delta') throw invalidEvent();

  const index = nonnegativeInteger(payload.index);
  const delta = objectValue(payload.delta);
  const deltaType = stringValue(delta.type);
  const deltas: ExactAgentProviderTextDelta[] = [];
  if (deltaType === 'text_delta') {
    appendRequiredText(deltas, 'token', delta.text);
  } else if (deltaType === 'thinking_delta') {
    appendRequiredText(deltas, 'reasoning', delta.thinking);
  } else if (deltaType === 'input_json_delta') {
    return freezeResult({
      deltas: [],
      toolCallDeltas: [{ index, argumentsDelta: stringValue(delta.partial_json) }],
      completed: false
    });
  } else if (deltaType !== 'signature_delta') {
    throw invalidEvent();
  }
  return freezeResult({ deltas, toolCallDeltas: [], completed: false });
}

function openAiToolCallDeltas(value: unknown): ExactAgentProviderToolCallDelta[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidEvent();
  const seen = new Set<number>();
  return value.map((entry) => {
    const call = objectValue(entry);
    const index = nonnegativeInteger(call.index);
    if (seen.has(index)) throw invalidEvent();
    seen.add(index);
    if (call.type !== undefined && call.type !== 'function') throw invalidEvent();
    const fn = call.function === undefined ? undefined : objectValue(call.function);
    return Object.freeze({
      index,
      ...(call.id === undefined ? {} : { providerCallId: stringValue(call.id) }),
      ...(fn?.name === undefined ? {} : { providerToolName: stringValue(fn.name) }),
      ...(fn?.arguments === undefined
        ? {}
        : { argumentsDelta: stringIncludingEmpty(fn.arguments) })
    });
  });
}

function emptyResult(completed: boolean): ExactAgentProviderEventResult {
  return freezeResult({ deltas: [], toolCallDeltas: [], completed });
}

function freezeResult(input: {
  readonly deltas: readonly ExactAgentProviderTextDelta[];
  readonly toolCallDeltas: readonly ExactAgentProviderToolCallDelta[];
  readonly completed: boolean;
  readonly finishReason?: ExactAgentModelInferenceFinishReason;
  readonly providerResponseId?: string;
  readonly modelId?: string;
  readonly usage?: ExactAgentProviderEventResult['usage'];
}): ExactAgentProviderEventResult {
  return Object.freeze({
    deltas: Object.freeze([...input.deltas]),
    toolCallDeltas: Object.freeze([...input.toolCallDeltas]),
    completed: input.completed,
    ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason }),
    ...(input.providerResponseId === undefined
      ? {}
      : { providerResponseId: input.providerResponseId }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.usage === undefined ? {} : { usage: Object.freeze({ ...input.usage }) })
  });
}

function normalizeOpenAiFinishReason(value: string): ExactAgentModelInferenceFinishReason {
  switch (value) {
    case 'stop': return 'stop';
    case 'tool_calls':
    case 'function_call': return 'tool_calls';
    case 'length': return 'length';
    case 'content_filter': return 'content_filter';
    default: return 'other';
  }
}

function normalizeAnthropicFinishReason(value: string): ExactAgentModelInferenceFinishReason {
  switch (value) {
    case 'end_turn':
    case 'stop_sequence': return 'stop';
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'length';
    case 'refusal': return 'content_filter';
    default: return 'other';
  }
}

function parseObject(data: string): Record<string, unknown> {
  if (typeof data !== 'string' || data.length === 0) throw invalidEvent();
  try {
    return objectValue(JSON.parse(data));
  } catch {
    throw invalidEvent();
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidEvent();
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) {
    throw invalidEvent();
  }
  return value;
}

function stringIncludingEmpty(value: unknown): string {
  if (typeof value !== 'string') throw invalidEvent();
  return value;
}

function optionalStringValue(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : stringValue(value);
}

function optionalNullableStringValue(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : stringValue(value);
}

function openAiUsage(value: unknown): ExactAgentProviderEventResult['usage'] | undefined {
  if (value === undefined || value === null) return undefined;
  const usage = objectValue(value);
  const details = usage.prompt_tokens_details === undefined
    ? undefined
    : objectValue(usage.prompt_tokens_details);
  const aggregateInputTokens = usageInteger(usage.prompt_tokens);
  const cacheReadInputTokens = details?.cached_tokens === undefined
    ? undefined
    : usageInteger(details.cached_tokens);
  if (cacheReadInputTokens !== undefined && cacheReadInputTokens > aggregateInputTokens) {
    throw invalidEvent();
  }
  return Object.freeze({
    inputTokens: aggregateInputTokens - (cacheReadInputTokens ?? 0),
    outputTokens: usageInteger(usage.completion_tokens),
    ...(cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens })
  });
}

function anthropicUsage(
  value: unknown,
  phase: 'input' | 'output'
): ExactAgentProviderEventResult['usage'] | undefined {
  if (value === undefined || value === null) return undefined;
  const usage = objectValue(value);
  if (phase === 'output') {
    return Object.freeze({ outputTokens: usageInteger(usage.output_tokens) });
  }
  return Object.freeze({
    inputTokens: usageInteger(usage.input_tokens),
    ...(usage.cache_read_input_tokens === undefined
      ? {}
      : { cacheReadInputTokens: usageInteger(usage.cache_read_input_tokens) }),
    ...(usage.cache_creation_input_tokens === undefined
      ? {}
      : { cacheWriteInputTokens: usageInteger(usage.cache_creation_input_tokens) })
  });
}

function usageInteger(value: unknown): number {
  const parsed = nonnegativeInteger(value);
  if (parsed > MAX_USAGE_TOKENS) throw invalidEvent();
  return parsed;
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidEvent();
  return value as number;
}

function appendOptionalText(
  target: ExactAgentProviderTextDelta[],
  channel: ExactAgentInferenceChunkChannel,
  value: unknown
): void {
  if (value === undefined || value === null || value === '') return;
  appendRequiredText(target, channel, value);
}

function appendRequiredText(
  target: ExactAgentProviderTextDelta[],
  channel: ExactAgentInferenceChunkChannel,
  value: unknown
): void {
  if (typeof value !== 'string' || value.length === 0) throw invalidEvent();
  target.push(Object.freeze({ channel, text: value }));
}

function invalidEvent(): Error {
  return new Error('agent_model_provider_stream_event_invalid');
}
