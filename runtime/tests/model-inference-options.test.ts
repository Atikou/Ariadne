import { afterEach, describe, expect, it } from 'vitest';

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

  it('only returns private reasoning history to Providers that require it', () => {
    const messages = [{
      role: 'assistant' as const,
      content: 'final answer',
      reasoningContent: 'private provider context'
    }];
    expect(toCompatibleMessages(messages, true)[0]).toMatchObject({
      reasoning_content: 'private provider context'
    });
    expect(toCompatibleMessages(messages, false)[0]).not.toHaveProperty('reasoning_content');
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
