import type { ModelProviderBootstrap } from '@ariadne/protocol/host';

import {
  ExactAgentInferenceContentAssembler,
  type ExactAgentInferenceAssembly,
  type ExactAgentInferenceChunk
} from './ExactAgentInferenceContentAssembler.js';
import {
  decodeAnthropicStreamEvent,
  decodeOpenAiCompatibleStreamEvent,
  type ExactAgentProviderEventResult
} from './ExactAgentProviderStreamDecoder.js';
import { ServerSentEventDataDecoder } from './ServerSentEventDataDecoder.js';

const MAX_PROVIDER_STREAM_WIRE_BYTES = 4 * 1_048_576;
const MAX_NATIVE_TOOL_CALLS = 256;
const MAX_NATIVE_TOOL_ARGUMENT_BYTES = 1_048_576;
const MAX_CONTENT_BLOCKS = 4_096;

export interface ReadExactAgentProviderStreamOptions {
  readonly protocol: ModelProviderBootstrap['protocol'];
  readonly exactModelId: string;
  readonly signal: AbortSignal;
  readonly maxContentBytes: number;
  readonly maxReasoningBytes: number;
  /** Called before exposing the first semantic Provider output of any kind. */
  readonly onOutputStarted?: () => void;
  readonly onChunk?: (chunk: ExactAgentInferenceChunk) => void | Promise<void>;
}

export interface ExactAgentProviderStreamResult extends ExactAgentInferenceAssembly {
  readonly finishReason: import('../../control/ports/AgentModelInference.js')
    .ExactAgentModelInferenceFinishReason;
  readonly providerResponseId?: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
  };
}

/**
 * Reads one bounded Provider body, durably-observable chunk by chunk. The final
 * content is returned only from the same assembler that received each observed
 * chunk, so a buffered shadow response cannot diverge from replay evidence.
 */
export async function readExactAgentProviderStream(
  response: Response,
  options: ReadExactAgentProviderStreamOptions
): Promise<ExactAgentProviderStreamResult> {
  options.signal.throwIfAborted();
  if (response.body === null) throw invalidStream();
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
    .toLowerCase();
  if (contentType !== 'text/event-stream') throw invalidStream();
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_PROVIDER_STREAM_WIRE_BYTES)
  ) throw invalidStream();

  const assembler = new ExactAgentInferenceContentAssembler({
    maxContentBytes: options.maxContentBytes,
    maxReasoningBytes: options.maxReasoningBytes,
    maxToolArgumentBytes: MAX_NATIVE_TOOL_ARGUMENT_BYTES,
    maxToolCalls: MAX_NATIVE_TOOL_CALLS,
    maxContentBlocks: MAX_CONTENT_BLOCKS
  });
  const sse = new ServerSentEventDataDecoder();
  const reader = response.body.getReader();
  let sequence = 1;
  let wireBytes = 0;
  let completed = false;
  let exactModelObserved = false;
  let finishReason: ExactAgentProviderStreamResult['finishReason'] | undefined;
  let providerResponseId: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;
  let cacheWriteInputTokens: number | undefined;
  try {
    while (true) {
      options.signal.throwIfAborted();
      const read = await reader.read();
      options.signal.throwIfAborted();
      if (read.done) break;
      wireBytes += read.value.byteLength;
      if (wireBytes > MAX_PROVIDER_STREAM_WIRE_BYTES) throw invalidStream();
      for (const data of sse.push(read.value)) {
        const decoded = decodeEvent(data, options.protocol);
        exactModelObserved = validateExactModel(
          decoded,
          options.exactModelId,
          exactModelObserved
        );
        ({
          sequence,
          completed,
          finishReason,
          providerResponseId,
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheWriteInputTokens
        } = await applyDecodedEvent({
          decoded,
          sequence,
          completed,
          finishReason,
          providerResponseId,
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheWriteInputTokens,
          assembler,
          onOutputStarted: options.onOutputStarted,
          onChunk: options.onChunk
        }));
      }
    }
    for (const data of sse.finish()) {
      const decoded = decodeEvent(data, options.protocol);
      exactModelObserved = validateExactModel(
        decoded,
        options.exactModelId,
        exactModelObserved
      );
      ({
        sequence,
        completed,
        finishReason,
        providerResponseId,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheWriteInputTokens
      } = await applyDecodedEvent({
        decoded,
        sequence,
        completed,
        finishReason,
        providerResponseId,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheWriteInputTokens,
        assembler,
        onOutputStarted: options.onOutputStarted,
        onChunk: options.onChunk
      }));
    }
    if (!completed || !exactModelObserved || finishReason === undefined) throw invalidStream();
    const assembly = assembler.complete(finishReason);
    return Object.freeze({
      ...assembly,
      finishReason,
      ...(providerResponseId === undefined ? {} : { providerResponseId }),
      ...(inputTokens === undefined || outputTokens === undefined
        ? {}
        : {
            usage: Object.freeze({
              inputTokens,
              outputTokens,
              ...(cacheReadInputTokens === undefined
                ? {}
                : { cacheReadInputTokens }),
              ...(cacheWriteInputTokens === undefined
                ? {}
                : { cacheWriteInputTokens })
            })
          })
    });
  } finally {
    reader.releaseLock();
  }
}

function validateExactModel(
  decoded: ExactAgentProviderEventResult,
  exactModelId: string,
  observed: boolean
): boolean {
  if (decoded.modelId === undefined) return observed;
  if (decoded.modelId !== exactModelId) throw invalidStream();
  return true;
}

function decodeEvent(
  data: string,
  protocol: ModelProviderBootstrap['protocol']
): ExactAgentProviderEventResult {
  return protocol === 'openai-compatible'
    ? decodeOpenAiCompatibleStreamEvent(data)
    : decodeAnthropicStreamEvent(data);
}

async function applyDecodedEvent(input: {
  readonly decoded: ExactAgentProviderEventResult;
  readonly sequence: number;
  readonly completed: boolean;
  readonly finishReason?: ExactAgentProviderStreamResult['finishReason'];
  readonly providerResponseId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly assembler: ExactAgentInferenceContentAssembler;
  readonly onOutputStarted?: ReadExactAgentProviderStreamOptions['onOutputStarted'];
  readonly onChunk?: ReadExactAgentProviderStreamOptions['onChunk'];
}): Promise<{
  readonly sequence: number;
  readonly completed: boolean;
  readonly finishReason?: ExactAgentProviderStreamResult['finishReason'];
  readonly providerResponseId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}> {
  let sequence = input.sequence;
  if (
    input.decoded.toolCallDeltas.length > 0
    || input.decoded.deltas.length > 0
  ) input.onOutputStarted?.();
  if (
    input.completed
    && (input.decoded.toolCallDeltas.length > 0 || input.decoded.deltas.length > 0)
  ) throw invalidStream();
  for (const delta of input.decoded.toolCallDeltas) input.assembler.appendToolCall(delta);
  for (const delta of input.decoded.deltas) {
    const chunk = Object.freeze({ sequence, ...delta });
    input.assembler.appendText(chunk);
    await input.onChunk?.(chunk);
    sequence += 1;
  }
  const finishReason = mergeStableValue(
    input.finishReason,
    input.decoded.finishReason
  );
  const providerResponseId = mergeStableValue(
    input.providerResponseId,
    input.decoded.providerResponseId
  );
  const inputTokens = mergeUsage(input.inputTokens, input.decoded.usage?.inputTokens);
  const outputTokens = mergeUsage(input.outputTokens, input.decoded.usage?.outputTokens);
  const cacheReadInputTokens = mergeUsage(
    input.cacheReadInputTokens,
    input.decoded.usage?.cacheReadInputTokens
  );
  const cacheWriteInputTokens = mergeUsage(
    input.cacheWriteInputTokens,
    input.decoded.usage?.cacheWriteInputTokens
  );
  return {
    sequence,
    completed: input.completed || input.decoded.completed,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(providerResponseId === undefined ? {} : { providerResponseId }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens })
  };
}

function mergeUsage(current: number | undefined, observed: number | undefined): number | undefined {
  if (observed === undefined) return current;
  if (current !== undefined && current !== observed) throw invalidStream();
  return observed;
}

function mergeStableValue<T>(current: T | undefined, observed: T | undefined): T | undefined {
  if (observed === undefined) return current;
  if (current !== undefined && current !== observed) throw invalidStream();
  return observed;
}

function invalidStream(): Error {
  return new Error('agent_model_provider_stream_invalid');
}
