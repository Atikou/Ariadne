import { describe, expect, it } from 'vitest';

import {
  decodeAnthropicStreamEvent,
  decodeOpenAiCompatibleStreamEvent
} from '../src/adapters/model/ExactAgentProviderStreamDecoder.js';
import { ServerSentEventDataDecoder } from '../src/adapters/model/ServerSentEventDataDecoder.js';

describe('exact Agent Provider stream decoders', () => {
  it('maps OpenAI-compatible content, reasoning, tool calls, and completion', () => {
    expect(decodeOpenAiCompatibleStreamEvent(JSON.stringify({
      model: 'model-exact',
      choices: [{
        delta: {
          content: 'answer',
          reasoning_content: 'thought',
          tool_calls: [{
            index: 0,
            id: 'call-0',
            type: 'function',
            function: { name: 'tool_0', arguments: '{"input":' }
          }, {
            index: 1,
            id: 'call-1',
            type: 'function',
            function: { name: 'tool_1', arguments: '{}' }
          }]
        },
        finish_reason: null
      }]
    }))).toEqual({
      deltas: [
        { channel: 'token', text: 'answer' },
        { channel: 'reasoning', text: 'thought' }
      ],
      toolCallDeltas: [{
        index: 0,
        providerCallId: 'call-0',
        providerToolName: 'tool_0',
        argumentsDelta: '{"input":'
      }, {
        index: 1,
        providerCallId: 'call-1',
        providerToolName: 'tool_1',
        argumentsDelta: '{}'
      }],
      completed: false,
      modelId: 'model-exact'
    });
    expect(decodeOpenAiCompatibleStreamEvent('[DONE]')).toEqual({
      deltas: [], toolCallDeltas: [], completed: true
    });
    expect(decodeOpenAiCompatibleStreamEvent(JSON.stringify({
      model: 'model-exact',
      choices: [],
      usage: {
        prompt_tokens: 23,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 5 }
      }
    }))).toEqual({
      deltas: [],
      toolCallDeltas: [],
      completed: false,
      modelId: 'model-exact',
      usage: { inputTokens: 18, outputTokens: 4, cacheReadInputTokens: 5 }
    });
  });

  it('maps Anthropic text and thinking while keeping tool input out of content', () => {
    expect(decodeAnthropicStreamEvent(JSON.stringify({
      type: 'message_start',
      message: {
        model: 'claude-exact',
        usage: {
          input_tokens: 31,
          cache_read_input_tokens: 6,
          cache_creation_input_tokens: 3
        }
      }
    }))).toMatchObject({
      modelId: 'claude-exact',
      usage: {
        inputTokens: 31,
        cacheReadInputTokens: 6,
        cacheWriteInputTokens: 3
      }
    });
    expect(decodeAnthropicStreamEvent(JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 7 }
    }))).toMatchObject({
      finishReason: 'stop',
      usage: { outputTokens: 7 }
    });
    expect(decodeAnthropicStreamEvent(JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'thought' }
    }))).toMatchObject({
      deltas: [{ channel: 'reasoning', text: 'thought' }]
    });
    expect(decodeAnthropicStreamEvent(JSON.stringify({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' }
    }))).toMatchObject({
      deltas: [{ channel: 'token', text: 'answer' }]
    });
    expect(decodeAnthropicStreamEvent(JSON.stringify({
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'private', name: 'exact_tool', input: {} }
    }))).toEqual({
      deltas: [],
      toolCallDeltas: [{
        index: 2,
        providerCallId: 'private',
        providerToolName: 'exact_tool',
        initialInput: {}
      }],
      completed: false
    });
    expect(decodeAnthropicStreamEvent(JSON.stringify({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"secret":' }
    }))).toEqual({
      deltas: [],
      toolCallDeltas: [{ index: 2, argumentsDelta: '{"secret":' }],
      completed: false
    });
    expect(() => decodeOpenAiCompatibleStreamEvent(JSON.stringify({
      model: 'model-exact',
      choices: [],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 3 }
      }
    }))).toThrow('agent_model_provider_stream_event_invalid');
  });

  it('fails closed on malformed or ambiguous Provider events', () => {
    expect(() => decodeOpenAiCompatibleStreamEvent('{')).toThrow(
      'agent_model_provider_stream_event_invalid'
    );
    expect(() => decodeOpenAiCompatibleStreamEvent(JSON.stringify({ choices: [] }))).toThrow(
      'agent_model_provider_stream_event_invalid'
    );
    expect(() => decodeAnthropicStreamEvent(JSON.stringify({ type: 'unknown' }))).toThrow(
      'agent_model_provider_stream_event_invalid'
    );
  });
});

describe('ServerSentEventDataDecoder', () => {
  it('frames split UTF-8, CRLF, comments, and multiline data deterministically', () => {
    const decoder = new ServerSentEventDataDecoder();
    const source = new TextEncoder().encode(': ping\r\ndata: {"text":"中\r\ndata: 文"}\r\n\r\n');
    const split = source.indexOf(0xe4) + 1;

    expect(decoder.push(source.slice(0, split))).toEqual([]);
    expect(decoder.push(source.slice(split))).toEqual(['{"text":"中\n文"}']);
    expect(decoder.finish()).toEqual([]);
  });

  it('flushes a final unterminated event and enforces event bytes', () => {
    const decoder = new ServerSentEventDataDecoder(8);
    expect(decoder.push(new TextEncoder().encode('data: ok'))).toEqual([]);
    expect(decoder.finish()).toEqual(['ok']);

    const oversized = new ServerSentEventDataDecoder(3);
    expect(() => oversized.push(new TextEncoder().encode('data: four\n'))).toThrow(
      'agent_model_provider_sse_event_too_large'
    );
  });

  it('rejects invalid UTF-8 and use after finish', () => {
    const invalid = new ServerSentEventDataDecoder();
    invalid.push(Uint8Array.from([0xc3]));
    expect(() => invalid.finish()).toThrow('agent_model_provider_sse_utf8_invalid');

    const completed = new ServerSentEventDataDecoder();
    completed.finish();
    expect(() => completed.push(new Uint8Array([1]))).toThrow(
      'agent_model_provider_sse_already_finished'
    );
  });
});
