import { describe, expect, it, vi } from 'vitest';

import { readExactAgentProviderStream } from '../src/adapters/model/readExactAgentProviderStream.js';

function sseResponse(parts: readonly string[], headers?: HeadersInit): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    }
  }), {
    headers: {
      'content-type': 'text/event-stream',
      ...Object.fromEntries(new Headers(headers).entries())
    }
  });
}

describe('readExactAgentProviderStream', () => {
  it('assembles and observes OpenAI-compatible chunks in one sequence', async () => {
    const observed = vi.fn();
    const response = sseResponse([
      dataEvent({
        model: 'model-exact',
        choices: [{ delta: { reasoning_content: 'why ' }, finish_reason: null }]
      }),
      dataEvent({
        id: 'response-1',
        model: 'model-exact',
        choices: [{
          delta: { tool_calls: [{
            index: 0,
            id: 'private-call',
            type: 'function',
            function: { name: 'exact_tool', arguments: '{"input":{}' }
          }] },
          finish_reason: null
        }]
      }),
      dataEvent({
        id: 'response-1',
        model: 'model-exact',
        choices: [{
          delta: {
            content: 'hello world',
            tool_calls: [{ index: 0, function: { arguments: ',"scope":[]}' } }]
          },
          finish_reason: 'tool_calls'
        }]
      }),
      dataEvent({
        model: 'model-exact',
        choices: [],
        usage: {
          prompt_tokens: 23,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 5 }
        }
      }),
      'data: [DONE]\n\n'
    ]);

    await expect(readExactAgentProviderStream(response, {
      protocol: 'openai-compatible',
      exactModelId: 'model-exact',
      signal: new AbortController().signal,
      maxContentBytes: 64,
      maxReasoningBytes: 64,
      onChunk: observed
    })).resolves.toEqual({
      contentBlocks: [{ type: 'reasoning', text: 'why ' }, {
        type: 'tool_call',
        toolCallId: expect.stringMatching(/^native-[a-f0-9]{64}$/u),
        providerToolName: 'exact_tool',
        input: { input: {}, scope: [] }
      }, { type: 'text', text: 'hello world' }],
      finalTextSequence: 2,
      finishReason: 'tool_calls',
      providerResponseId: 'response-1',
      usage: { inputTokens: 18, outputTokens: 4, cacheReadInputTokens: 5 }
    });
    expect(observed.mock.calls.map(([chunk]) => chunk)).toEqual([
      { sequence: 1, channel: 'reasoning', text: 'why ' },
      { sequence: 2, channel: 'token', text: 'hello world' }
    ]);
  });

  it('assembles Anthropic text and excludes tool JSON from public chunks', async () => {
    const observed: unknown[] = [];
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'message-1',
          model: 'claude-exact',
          usage: {
            input_tokens: 31,
            cache_read_input_tokens: 6,
            cache_creation_input_tokens: 3
          }
        }
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'private-tool', name: 'exact_tool', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'why' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'answer' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' }
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`);

    await expect(readExactAgentProviderStream(sseResponse(events), {
      protocol: 'anthropic-messages',
      exactModelId: 'claude-exact',
      signal: new AbortController().signal,
      maxContentBytes: 64,
      maxReasoningBytes: 64,
      onChunk: (chunk) => { observed.push(chunk); }
    })).resolves.toMatchObject({
      contentBlocks: [{
        type: 'tool_call',
        providerToolName: 'exact_tool',
        input: { x: 1 }
      }, { type: 'reasoning', text: 'why' }, { type: 'text', text: 'answer' }],
      finishReason: 'tool_calls',
      providerResponseId: 'message-1',
      usage: {
        inputTokens: 31,
        outputTokens: 7,
        cacheReadInputTokens: 6,
        cacheWriteInputTokens: 3
      }
    });
    expect(observed).toEqual([
      { sequence: 1, channel: 'reasoning', text: 'why' },
      { sequence: 2, channel: 'token', text: 'answer' }
    ]);
  });

  it('rejects missing completion, post-completion deltas, and bounded overflow', async () => {
    await expect(readExactAgentProviderStream(sseResponse([
      'data: {"model":"model-exact","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
    ]), {
      protocol: 'openai-compatible',
      exactModelId: 'model-exact',
      signal: new AbortController().signal,
      maxContentBytes: 64,
      maxReasoningBytes: 64
    })).rejects.toThrow('agent_model_provider_stream_invalid');

    await expect(readExactAgentProviderStream(sseResponse([
      'data: {"model":"model-exact","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"model":"model-exact","choices":[{"delta":{"content":"late"},"finish_reason":null}]}\n\n'
    ]), {
      protocol: 'openai-compatible',
      exactModelId: 'model-exact',
      signal: new AbortController().signal,
      maxContentBytes: 64,
      maxReasoningBytes: 64
    })).rejects.toThrow('agent_model_provider_stream_invalid');

    await expect(readExactAgentProviderStream(sseResponse([
      'data: {"model":"model-exact","choices":[{"delta":{"content":"too long"},"finish_reason":"stop"}]}\n\n'
    ]), {
      protocol: 'openai-compatible',
      exactModelId: 'model-exact',
      signal: new AbortController().signal,
      maxContentBytes: 3,
      maxReasoningBytes: 64
    })).rejects.toThrow('exact_agent_stream_content_limit_exceeded');
  });

  it('propagates cancellation before reading Provider data', async () => {
    const abort = new AbortController();
    abort.abort(new Error('cancel-stream'));
    await expect(readExactAgentProviderStream(sseResponse([]), {
      protocol: 'openai-compatible',
      exactModelId: 'model-exact',
      signal: abort.signal,
      maxContentBytes: 64,
      maxReasoningBytes: 64
    })).rejects.toThrow('cancel-stream');
  });
});

function dataEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
