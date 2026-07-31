import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelInferenceProfileSchema } from '../src/config/types.js';
import { OpenAICompatibleClient, toCompatibleMessages } from '../src/model/OpenAICompatibleClient.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('model inference option mapping', () => {
  it('rejects an invalid Runtime inference profile before a model client is created', () => {
    expect(ModelInferenceProfileSchema.safeParse({
      reasoning: {
        modes: ['on', 'on'],
        defaultMode: 'off',
        efforts: ['high']
      }
    }).success).toBe(false);
  });

  it('maps the universal profile to DeepSeek thinking mode and effort', async () => {
    const body = await captureRequestBody(new OpenAICompatibleClient({
      name: 'deepseek-test',
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      location: 'remote',
      baseUrl: 'https://api.deepseek.test',
      apiKey: 'test-key'
    }), {
      reasoningMode: 'on',
      reasoningEffort: 'max'
    });

    expect(body).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      max_tokens: 2_048
    });
    expect(body).not.toHaveProperty('temperature');
  });

  it('uses Kimi K3 effort without sending unsupported thinking or temperature fields', async () => {
    const body = await captureRequestBody(new OpenAICompatibleClient({
      name: 'kimi-test',
      providerId: 'kimi',
      model: 'kimi-k3',
      location: 'remote',
      baseUrl: 'https://api.moonshot.test/v1',
      apiKey: 'test-key'
    }), {
      reasoningMode: 'on',
      reasoningEffort: 'high'
    });

    expect(body.reasoning_effort).toBe('high');
    expect(body.max_completion_tokens).toBe(2_048);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
  });

  it('keeps completed-turn reasoning out of later context and only preserves tool continuation reasoning', () => {
    const completedTurn = [{
      role: 'assistant' as const,
      content: 'final answer',
      reasoningContent: 'private provider context'
    }];
    expect(toCompatibleMessages(completedTurn, true)[0]).not.toHaveProperty('reasoning_content');

    const toolContinuation = [{
      role: 'assistant' as const,
      content: '',
      reasoningContent: 'tool continuation context',
      toolCalls: [{ id: 'call-1', name: 'lookup', arguments: {} }]
    }, {
      role: 'tool' as const,
      content: 'result',
      toolCallId: 'call-1'
    }];
    expect(toCompatibleMessages(toolContinuation, true)[0]).toMatchObject({
      reasoning_content: 'tool continuation context'
    });
    expect(toCompatibleMessages(toolContinuation, false)[0]).not.toHaveProperty('reasoning_content');
  });

  it('streams reasoning_content before final answer content on separate callbacks', async () => {
    globalThis.fetch = async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '分析' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '过程' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '最终' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '答案' } }] })}`,
      'data: [DONE]',
      ''
    ].join('\n\n'), {
      headers: { 'content-type': 'text/event-stream' }
    });
    const onReasoningToken = vi.fn();
    const onToken = vi.fn();
    const client = new OpenAICompatibleClient({
      name: 'deepseek-stream',
      providerId: 'deepseek',
      model: 'deepseek-reasoner',
      location: 'remote',
      baseUrl: 'https://api.deepseek.test',
      apiKey: 'test-key'
    });

    await expect(client.chat({
      messages: [{ role: 'user', content: 'test' }],
      inference: { reasoningMode: 'on', reasoningEffort: 'high' },
      onReasoningToken,
      onToken
    })).resolves.toMatchObject({
      reasoningContent: '分析过程',
      content: '最终答案'
    });
    expect(onReasoningToken.mock.calls.flat()).toEqual(['分析', '过程']);
    expect(onToken.mock.calls.flat()).toEqual(['最终', '答案']);
  });
});

async function captureRequestBody(
  client: OpenAICompatibleClient,
  inference: { reasoningMode: 'on'; reasoningEffort: 'high' | 'max' }
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      model: client.model,
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    });
  };
  await client.chat({
    messages: [{ role: 'user', content: 'test' }],
    temperature: 0.7,
    maxTokens: 2_048,
    inference
  });
  if (!captured) throw new Error('request body was not captured');
  return captured;
}
