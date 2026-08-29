import { createHash } from 'node:crypto';

import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type {
  ExactAgentModelInferenceContentBlock,
  ExactAgentModelInferenceFinishReason
} from '../../control/ports/AgentModelInference.js';

export type ExactAgentInferenceChunkChannel = 'token' | 'reasoning';

export interface ExactAgentInferenceChunk {
  readonly sequence: number;
  readonly channel: ExactAgentInferenceChunkChannel;
  readonly text: string;
}

export interface ExactAgentProviderToolCallDelta {
  readonly index: number;
  readonly providerCallId?: string;
  readonly providerToolName?: string;
  readonly argumentsDelta?: string;
  readonly initialInput?: unknown;
}

export interface ExactAgentInferenceAssembly {
  readonly contentBlocks: readonly ExactAgentModelInferenceContentBlock[];
  readonly finalTextSequence: number;
}

export interface ExactAgentInferenceContentAssemblerOptions {
  readonly maxContentBytes: number;
  readonly maxReasoningBytes: number;
  readonly maxToolArgumentBytes: number;
  readonly maxToolCalls: number;
  readonly maxContentBlocks: number;
}

interface OrderedTextBlock {
  readonly order: number;
  readonly block: Extract<ExactAgentModelInferenceContentBlock, { readonly type: 'text' | 'reasoning' }>;
}

interface PendingToolCall {
  readonly index: number;
  readonly order: number;
  providerCallId?: string;
  providerToolName?: string;
  argumentsText: string;
  argumentBytes: number;
  initialInput?: unknown;
}

/**
 * Sole fold from normalized Provider output to provider-neutral content blocks.
 * Text and reasoning retain their exact order, while native Tool arguments stay
 * protected and become visible only after one bounded, unambiguous JSON object
 * has been assembled for every call.
 */
export class ExactAgentInferenceContentAssembler {
  private readonly maxContentBytes: number;
  private readonly maxReasoningBytes: number;
  private readonly maxToolArgumentBytes: number;
  private readonly maxToolCalls: number;
  private readonly maxContentBlocks: number;
  private nextTextSequence = 1;
  private nextOrder = 1;
  private contentBytes = 0;
  private reasoningBytes = 0;
  private readonly textBlocks: OrderedTextBlock[] = [];
  private readonly toolCalls = new Map<number, PendingToolCall>();
  private completed = false;

  public constructor(options: ExactAgentInferenceContentAssemblerOptions) {
    this.maxContentBytes = boundedPositiveInteger(
      options.maxContentBytes,
      'exact_agent_stream_content_limit_invalid'
    );
    this.maxReasoningBytes = boundedPositiveInteger(
      options.maxReasoningBytes,
      'exact_agent_stream_reasoning_limit_invalid'
    );
    this.maxToolArgumentBytes = boundedPositiveInteger(
      options.maxToolArgumentBytes,
      'exact_agent_stream_tool_argument_limit_invalid'
    );
    this.maxToolCalls = boundedPositiveInteger(
      options.maxToolCalls,
      'exact_agent_stream_tool_call_limit_invalid'
    );
    this.maxContentBlocks = boundedPositiveInteger(
      options.maxContentBlocks,
      'exact_agent_stream_block_limit_invalid'
    );
  }

  public appendText(chunk: ExactAgentInferenceChunk): void {
    this.assertOpen();
    if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence !== this.nextTextSequence) {
      throw new Error('exact_agent_stream_sequence_invalid');
    }
    if (chunk.text.length === 0) throw new Error('exact_agent_stream_chunk_empty');
    this.assertBlockCapacity();
    const bytes = Buffer.byteLength(chunk.text, 'utf8');
    if (chunk.channel === 'token') {
      if (this.contentBytes + bytes > this.maxContentBytes) {
        throw new Error('exact_agent_stream_content_limit_exceeded');
      }
      this.contentBytes += bytes;
      this.textBlocks.push(Object.freeze({
        order: this.nextOrder,
        block: Object.freeze({ type: 'text', text: chunk.text })
      }));
    } else if (chunk.channel === 'reasoning') {
      if (this.reasoningBytes + bytes > this.maxReasoningBytes) {
        throw new Error('exact_agent_stream_reasoning_limit_exceeded');
      }
      this.reasoningBytes += bytes;
      this.textBlocks.push(Object.freeze({
        order: this.nextOrder,
        block: Object.freeze({ type: 'reasoning', text: chunk.text })
      }));
    } else {
      throw new Error('exact_agent_stream_channel_invalid');
    }
    this.nextTextSequence += 1;
    this.nextOrder += 1;
  }

  public appendToolCall(delta: ExactAgentProviderToolCallDelta): void {
    this.assertOpen();
    if (!Number.isSafeInteger(delta.index) || delta.index < 0) {
      throw new Error('exact_agent_stream_tool_call_index_invalid');
    }
    let call = this.toolCalls.get(delta.index);
    if (call === undefined) {
      if (this.toolCalls.size >= this.maxToolCalls) {
        throw new Error('exact_agent_stream_tool_call_limit_exceeded');
      }
      this.assertBlockCapacity();
      call = {
        index: delta.index,
        order: this.nextOrder,
        argumentsText: '',
        argumentBytes: 0
      };
      this.toolCalls.set(delta.index, call);
      this.nextOrder += 1;
    }
    call.providerCallId = mergeStableString(
      call.providerCallId,
      delta.providerCallId,
      'exact_agent_stream_tool_call_id_conflict'
    );
    call.providerToolName = mergeStableString(
      call.providerToolName,
      delta.providerToolName,
      'exact_agent_stream_tool_name_conflict'
    );
    if (delta.initialInput !== undefined) {
      if (call.initialInput !== undefined) {
        throw new Error('exact_agent_stream_tool_input_ambiguous');
      }
      call.initialInput = delta.initialInput;
    }
    if (delta.argumentsDelta !== undefined && delta.argumentsDelta.length > 0) {
      const bytes = Buffer.byteLength(delta.argumentsDelta, 'utf8');
      if (call.argumentBytes + bytes > this.maxToolArgumentBytes) {
        throw new Error('exact_agent_stream_tool_argument_limit_exceeded');
      }
      call.argumentsText += delta.argumentsDelta;
      call.argumentBytes += bytes;
    }
  }

  public complete(
    finishReason: ExactAgentModelInferenceFinishReason
  ): ExactAgentInferenceAssembly {
    this.assertOpen();
    this.completed = true;
    const ordered: Array<{ readonly order: number; readonly block: ExactAgentModelInferenceContentBlock }> = [
      ...this.textBlocks
    ];
    const normalizedIds = new Set<string>();
    for (const call of this.toolCalls.values()) {
      if (call.providerCallId === undefined || call.providerToolName === undefined) {
        throw new Error('exact_agent_stream_tool_call_incomplete');
      }
      const input = parseToolInput(call);
      const toolCallId = normalizedToolCallId(call.providerCallId, call.index);
      if (normalizedIds.has(toolCallId)) {
        throw new Error('exact_agent_stream_tool_call_id_duplicate');
      }
      normalizedIds.add(toolCallId);
      ordered.push({
        order: call.order,
        block: Object.freeze({
          type: 'tool_call',
          toolCallId,
          providerToolName: call.providerToolName,
          input
        })
      });
    }
    const hasToolCalls = this.toolCalls.size > 0;
    if ((finishReason === 'tool_calls') !== hasToolCalls) {
      throw new Error('exact_agent_stream_finish_reason_conflict');
    }
    ordered.sort((left, right) => left.order - right.order);
    return Object.freeze({
      contentBlocks: Object.freeze(ordered.map((entry) => entry.block)),
      finalTextSequence: this.nextTextSequence - 1
    });
  }

  private assertOpen(): void {
    if (this.completed) throw new Error('exact_agent_stream_already_completed');
  }

  private assertBlockCapacity(): void {
    if (this.textBlocks.length + this.toolCalls.size >= this.maxContentBlocks) {
      throw new Error('exact_agent_stream_block_limit_exceeded');
    }
  }
}

function parseToolInput(call: PendingToolCall): AgentToolJsonValue {
  if (call.argumentsText.length > 0) {
    if (call.initialInput !== undefined && !isEmptyPlainObject(call.initialInput)) {
      throw new Error('exact_agent_stream_tool_input_ambiguous');
    }
    try {
      const parsed: unknown = JSON.parse(call.argumentsText);
      if (!isPlainObject(parsed)) throw new Error();
      return parsed as AgentToolJsonValue;
    } catch {
      throw new Error('exact_agent_stream_tool_arguments_invalid');
    }
  }
  if (!isPlainObject(call.initialInput)) {
    throw new Error('exact_agent_stream_tool_arguments_invalid');
  }
  return call.initialInput as AgentToolJsonValue;
}

function normalizedToolCallId(providerCallId: string, index: number): string {
  if (providerCallId.length === 0 || providerCallId.length > 1_024) {
    throw new Error('exact_agent_stream_tool_call_id_invalid');
  }
  const digest = createHash('sha256')
    .update(`${String(index)}\u0000${providerCallId}`)
    .digest('hex');
  return `native-${digest}`;
}

function mergeStableString(
  current: string | undefined,
  observed: string | undefined,
  conflictCode: string
): string | undefined {
  if (observed === undefined) return current;
  if (observed.length === 0 || observed.length > 1_024) {
    throw new Error(conflictCode);
  }
  if (current !== undefined && current !== observed) throw new Error(conflictCode);
  return observed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmptyPlainObject(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function boundedPositiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}
