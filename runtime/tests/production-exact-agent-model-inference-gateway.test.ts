import type { RuntimeBootstrap } from '@ariadne/protocol/host';
import { createHash } from 'node:crypto';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { describe, expect, it, vi } from 'vitest';

import {
  ExactAgentModelInferenceTransportError,
  ProductionExactAgentModelInferenceGateway
} from '../src/adapters/model/ProductionExactAgentModelInferenceGateway.js';

const SECRET = 'credential-must-never-appear';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('ProductionExactAgentModelInferenceGateway', () => {
  it('admits image turns only through a binding declared as vision-capable', () => {
    expect(gatewayFixture().resolveBinding(7, { requiresVision: true })).toBeNull();
    expect(gatewayFixture({
      providers: [provider({ supportsVision: true })]
    }).resolveBinding(7, { requiresVision: true })).toEqual({
      providerId: 'provider-exact',
      modelId: 'model-exact',
      settingsRevision: 7
    });
  });

  it('reports availability only for the exact provider, model, and settings revision', () => {
    const gateway = gatewayFixture();

    expect(gateway.hasExactBinding({
      providerId: 'provider-exact',
      modelId: 'model-exact',
      settingsRevision: 7
    })).toBe(true);
    expect(gateway.hasExactBinding({
      providerId: 'provider-other',
      modelId: 'model-exact',
      settingsRevision: 7
    })).toBe(false);
    expect(gateway.hasExactBinding({
      providerId: 'provider-exact',
      modelId: 'model-other',
      settingsRevision: 7
    })).toBe(false);
    expect(gateway.hasExactBinding({
      providerId: 'provider-exact',
      modelId: 'model-exact',
      settingsRevision: 8
    })).toBe(false);
    expect(gateway.describeContextCapacity({
      providerId: 'provider-exact',
      modelId: 'model-exact',
      settingsRevision: 7
    })).toEqual({ contextWindowTokens: 32_768, maxOutputTokens: 4_096 });
  });

  it('normalizes bounded Provider context-overflow evidence without leaking its body', async () => {
    const gateway = gatewayFixture({
      fetch: async () => new Response(JSON.stringify({
        error: {
          code: 'context_length_exceeded',
          message: `maximum context length ${SECRET}`
        }
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    });

    const result = await gateway.inferExact(request());
    expect(result).toEqual({ status: 'context_overflow' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('dispatches only the exact OpenAI-compatible binding and parses text plus native calls', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      id: 'response-1',
      model: 'model-exact',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'exact response',
          tool_calls: [{
            id: 'provider-private-call',
            type: 'function',
            function: {
              name: 'exact_tool',
              arguments: '{"input":{"path":"src/a.ts"},"scope":[]}'
            }
          }]
        }
      }]
    }));
    const gateway = gatewayFixture({ fetch });

    await expect(gateway.inferExact(request({ tools: [toolContract()] }))).resolves.toMatchObject({
      status: 'completed',
      contentBlocks: [{
        type: 'tool_call',
        toolCallId: expect.stringMatching(/^native-[a-f0-9]{64}$/u),
        providerToolName: 'exact_tool',
        input: { input: { path: 'src/a.ts' }, scope: [] }
      }, { type: 'text', text: 'exact response' }],
      replay: {
        envelopeVersion: 1,
        adapter: 'openai-compatible',
        finishReason: 'tool_calls'
      }
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://provider.example/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'model-exact',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 4096,
      tools: [{
        type: 'function',
        function: {
          name: 'exact_tool',
          description: 'Exact test Tool.',
          parameters: { type: 'object', additionalProperties: false }
        }
      }],
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true }
    });
  });

  it('resolves an opaque credential exactly once per inference and observes hot rotation', async () => {
    let credential = 'first-operation-key';
    const resolve = vi.fn(async () => credential);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      id: 'response-credential',
      model: 'model-exact',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }]
    }));
    const gateway = gatewayFixture({
      providers: [provider({ credentialRef: 'model:provider-exact' })],
      environment: {},
      credentialResolver: {
        resolve,
        describe: vi.fn(async () => ({
          configured: true,
          source: 'os_secure_storage' as const,
          writable: true
        }))
      },
      fetch
    });

    await gateway.inferExact(request());
    credential = 'second-operation-key';
    await gateway.inferExact(request());

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenNthCalledWith(
      1, 'model:provider-exact', 'model_inference', expect.any(AbortSignal)
    );
    expect(fetch.mock.calls.map((call) => (
      new Headers(call[1]?.headers).get('authorization')
    ))).toEqual(['Bearer first-operation-key', 'Bearer second-operation-key']);
  });

  it('counts an OpenAI route with its model-local BPE without claiming wire exactness', async () => {
    const gateway = gatewayFixture({
      providers: [provider({ providerId: 'openai', model: 'gpt-5-mini' })],
      modelId: 'gpt-5-mini',
      authorityProviderId: 'openai'
    });

    const counted = await gateway.countRequestTokens({
      ...request({ providerId: 'openai', modelId: 'gpt-5-mini' }),
      messages: [textMessage('user', 'A route-bound tokenizer must be local and deterministic.')],
      tools: []
    });

    expect(counted.tokens).toBeGreaterThan(1);
    expect(counted).toMatchObject({
      exact: false,
      tokenizer: 'openai:gpt-5-mini:o200k_base:local-wire-conservative'
    });
  });

  it('serializes verified images into native OpenAI-compatible message content', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      model: 'model-exact',
      choices: [{ message: { content: 'seen' } }]
    }));
    const gateway = gatewayFixture({ fetch });
    const image = imageBlock('verified-image');

    await expect(gateway.inferExact(request({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'describe' }, image]
      }]
    }))).resolves.toMatchObject({ status: 'completed' });

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${image.dataBase64}`,
            detail: 'auto'
          }
        }
      ]
    }]);
  });

  it('rejects image bytes whose digest does not match before Provider I/O', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const gateway = gatewayFixture({ fetch });
    const image = { ...imageBlock('verified-image'), attachmentId: DIGEST };

    await expect(gateway.inferExact(request({
      messages: [{ role: 'user', content: [image] }]
    }))).rejects.toThrow('agent_model_request_invalid');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('binds Provider usage to the exact serialized request envelope', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => sseResponse([
      {
        model: 'model-exact',
        choices: [{ delta: { content: 'measured' }, finish_reason: 'stop' }]
      },
      {
        model: 'model-exact',
        choices: [],
        usage: { prompt_tokens: 23, completion_tokens: 4 }
      },
      '[DONE]'
    ]));
    const gateway = gatewayFixture({ fetch });

    const result = await gateway.inferExact(request());
    const body = String(fetch.mock.calls[0]?.[1]?.body);

    expect(result).toMatchObject({
      status: 'completed',
      usage: {
        inputTokens: 23,
        outputTokens: 4
      }
    });
    if (result.status !== 'completed' || result.usage === undefined) return;
    expect(result.replay.requestEnvelopeDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const changed = await gateway.inferExact(request({ messages: [
      textMessage('user', 'different envelope')
    ] }));
    expect(changed.status).toBe('completed');
    if (changed.status !== 'completed' || changed.usage === undefined) return;
    expect(changed.replay.requestEnvelopeDigest).not.toBe(
      result.replay.requestEnvelopeDigest
    );
    expect(body).toContain('"hello"');
  });

  it('forwards the pinned inference options instead of dropping the Renderer selection', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      model: 'model-exact',
      choices: [{ message: { content: 'reasoned response' } }]
    }));
    const gateway = gatewayFixture({ fetch });

    await gateway.inferExact(request({
      inference: { reasoningMode: 'on', reasoningEffort: 'high' }
    }));

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ reasoning_effort: 'high' });
  });

  it('aborts a hung Provider request at the bounded transport deadline', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const gateway = gatewayFixture({ fetch, requestTimeoutMs: 10 });

    await expect(gateway.inferExact(request())).rejects.toMatchObject({
      code: 'agent_model_provider_timeout'
    });
  });

  it('returns binding_unavailable for revision drift and never falls back to another Provider', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const gateway = gatewayFixture({
      fetch,
      providers: [
        provider(),
        provider({
          providerId: 'fallback-provider',
          name: 'fallback-runtime-name',
          model: 'model-exact',
          credentialEnvironmentVariable: 'FALLBACK_KEY'
        })
      ],
      environment: {
        EXACT_KEY: SECRET,
        FALLBACK_KEY: 'fallback-secret'
      }
    });

    await expect(gateway.inferExact(request({ settingsRevision: 8 }))).resolves.toEqual({
      status: 'binding_unavailable'
    });
    await expect(gateway.inferExact(request({ providerId: 'fallback-provider' }))).resolves.toEqual({
      status: 'binding_unavailable'
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed without the declared credential', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const gateway = gatewayFixture({ fetch, environment: {} });

    await expect(gateway.inferExact(request())).resolves.toEqual({
      status: 'binding_unavailable'
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when the declared usage protocol does not match the transport protocol', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const gateway = gatewayFixture({
      fetch,
      providers: [provider({ usageReporting: 'anthropic-events' })]
    });

    expect(gateway.hasExactBinding(request())).toBe(false);
    await expect(gateway.inferExact(request())).resolves.toEqual({
      status: 'binding_unavailable'
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the Anthropic Messages shape and counts native tool_use blocks', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      id: 'message-1',
      model: 'claude-exact',
      content: [
        { type: 'text', text: 'anthropic response' },
        { type: 'tool_use', id: 'tool-1', name: 'not-executed', input: {} }
      ]
    }));
    const gateway = gatewayFixture({
      fetch,
      providers: [provider({
        protocol: 'anthropic-messages',
        baseUrl: 'https://anthropic.example',
        model: 'claude-exact'
      })],
      modelId: 'claude-exact'
    });

    await expect(gateway.inferExact(request({
      modelId: 'claude-exact',
      tools: [toolContract()],
      messages: [
        textMessage('system', 'system'),
        textMessage('user', 'hello'),
        textMessage('user', 'continued'),
        textMessage('assistant', 'prior answer')
      ]
    }))).resolves.toMatchObject({
      status: 'completed',
      contentBlocks: [
        { type: 'text', text: 'anthropic response' },
        {
          type: 'tool_call',
          providerToolName: 'not-executed',
          input: {}
        }
      ],
      replay: { finishReason: 'tool_calls', adapter: 'anthropic-messages' }
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://anthropic.example/v1/messages');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBe(SECRET);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'claude-exact',
      max_tokens: 4096,
      system: 'system',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'continued' }
          ]
        },
        { role: 'assistant', content: [{ type: 'text', text: 'prior answer' }] }
      ],
      tools: [{
        name: 'exact_tool',
        description: 'Exact test Tool.',
        input_schema: { type: 'object', additionalProperties: false }
      }],
      stream: true
    });
  });

  it('rejects extra choices, oversized bodies, and non-text content', async () => {
    const extraChoices = gatewayFixture({
      fetch: async () => jsonResponse({
        model: 'model-exact',
        choices: [
          { message: { content: 'one' } },
          { message: { content: 'two' } }
        ]
      })
    });
    await expect(extraChoices.inferExact(request())).rejects.toMatchObject({
      code: 'agent_model_provider_response_invalid'
    });

    const oversized = gatewayFixture({
      fetch: async () => new Response('{}', {
        status: 200,
        headers: { 'content-length': String(1_048_577) }
      })
    });
    await expect(oversized.inferExact(request())).rejects.toMatchObject({
      code: 'agent_model_provider_response_invalid'
    });

    const nonText = gatewayFixture({
      fetch: async () => jsonResponse({
        model: 'model-exact',
        choices: [{ message: { content: [{ type: 'text', text: 'not allowed' }] } }]
      })
    });
    await expect(nonText.inferExact(request())).rejects.toMatchObject({
      code: 'agent_model_provider_response_invalid'
    });
  });

  it('propagates cancellation and unknown Provider I/O errors unchanged', async () => {
    const before = new AbortController();
    before.abort(new Error('cancel-before-dispatch'));
    const fetch = vi.fn<typeof globalThis.fetch>();
    const gateway = gatewayFixture({ fetch });
    await expect(gateway.inferExact(request({ signal: before.signal }))).rejects.toThrow(
      'cancel-before-dispatch'
    );
    expect(fetch).not.toHaveBeenCalled();

    const providerFailure = new Error('provider socket failed');
    const failed = gatewayFixture({ fetch: async () => { throw providerFailure; } });
    await expect(failed.inferExact(request())).rejects.toBe(providerFailure);
  });

  it('does not copy credentials or Provider response bodies into errors', async () => {
    const gateway = gatewayFixture({
      fetch: async () => new Response(`upstream rejected ${SECRET}`, { status: 401 })
    });

    let caught: unknown;
    try {
      await gateway.inferExact(request());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExactAgentModelInferenceTransportError);
    expect(String(caught)).not.toContain(SECRET);
    expect(JSON.stringify(caught)).not.toContain(SECRET);
  });

  it('serializes causal Anthropic Tool history with exact tool_use identities', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      id: 'message-after-tool',
      model: 'claude-exact',
      content: [{ type: 'text', text: 'continued' }]
    }));
    const gateway = gatewayFixture({
      fetch,
      providers: [provider({
        protocol: 'anthropic-messages',
        baseUrl: 'https://anthropic.example',
        model: 'claude-exact'
      })],
      modelId: 'claude-exact'
    });

    await expect(gateway.inferExact(request({
      modelId: 'claude-exact',
      tools: [toolContract()],
      messages: [
        textMessage('user', 'read it'),
        {
          role: 'assistant',
          content: [{
            type: 'tool_call',
            toolCallId: 'history_abc',
            providerToolName: 'exact_tool',
            input: { input: { path: 'README.md' }, scope: [] }
          }]
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            effectId: 'effect-1',
            toolCallId: 'history_abc',
            status: 'succeeded',
            output: { content: 'ok' }
          }]
        }
      ]
    }))).resolves.toMatchObject({ status: 'completed' });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'history_abc',
          name: 'exact_tool',
          input: { input: { path: 'README.md' }, scope: [] }
        }]
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'history_abc',
          content: JSON.stringify({ status: 'succeeded', output: { content: 'ok' } }),
          is_error: false
        }]
      }
    ]);
  });

  it('serializes verified images into native Anthropic source blocks', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      id: 'message-image',
      model: 'claude-exact',
      content: [{ type: 'text', text: 'seen' }]
    }));
    const gateway = gatewayFixture({
      fetch,
      providers: [provider({
        protocol: 'anthropic-messages',
        baseUrl: 'https://anthropic.example',
        model: 'claude-exact'
      })],
      modelId: 'claude-exact'
    });
    const image = imageBlock('anthropic-image');

    await expect(gateway.inferExact(request({
      modelId: 'claude-exact',
      messages: [{ role: 'user', content: [image] }]
    }))).resolves.toMatchObject({ status: 'completed' });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([{
      role: 'user',
      content: [{
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: image.dataBase64
        }
      }]
    }]);
  });

  it('publishes the exact normalized chunk sequence through the bound observer', async () => {
    const observe = vi.fn();
    const gateway = gatewayFixture({
      fetch: async () => sseResponse([
        {
          model: 'model-exact',
          choices: [{ delta: { reasoning_content: 'why' }, finish_reason: null }]
        },
        {
          model: 'model-exact',
          choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }]
        },
        '[DONE]'
      ])
    });

    await expect(gateway.inferExact({
      ...request(),
      chunkObserver: { observe }
    })).resolves.toMatchObject({
      status: 'completed',
      contentBlocks: expect.arrayContaining([{ type: 'text', text: 'answer' }])
    });
    expect(observe.mock.calls.map(([chunk]) => chunk)).toEqual([
      { sequence: 1, channel: 'reasoning', text: 'why' },
      { sequence: 2, channel: 'token', text: 'answer' }
    ]);
  });

  it('retries bounded 429 responses before output and records sanitized telemetry', async () => {
    const sleeps: number[] = [];
    const telemetry = { recordProviderCall: vi.fn() };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', {
        status: 429,
        headers: { 'retry-after': '2' }
      }))
      .mockResolvedValueOnce(jsonResponse({
        model: 'model-exact',
        choices: [{ message: { content: 'recovered' } }]
      }));
    const gateway = gatewayFixture({
      fetch,
      resiliencePolicy: policy({ maxBackoffMs: 1_000 }),
      resilienceDependencies: {
        sleep: async (milliseconds) => { sleeps.push(milliseconds); },
        random: () => 0
      },
      providerTelemetry: telemetry
    });

    await expect(gateway.inferExact(request())).resolves.toMatchObject({
      status: 'completed',
      contentBlocks: [{ type: 'text', text: 'recovered' }]
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
    expect(telemetry.recordProviderCall).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'provider-exact',
      model: 'model-exact',
      outcome: 'success',
      retryCount: 1
    }));
  });

  it('never retries a transport failure after the first durable text chunk', async () => {
    const observe = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => failingSseResponse({
      model: 'model-exact',
      choices: [{ delta: { content: 'partial' }, finish_reason: null }]
    }));
    const gateway = gatewayFixture({
      fetch,
      resilienceDependencies: { sleep: async () => undefined }
    });

    await expect(gateway.inferExact({
      ...request(),
      chunkObserver: { observe }
    })).rejects.toMatchObject({ category: 'temporary' });
    expect(observe).toHaveBeenCalledWith({
      sequence: 1,
      channel: 'token',
      text: 'partial'
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats native Tool-call output as the no-retry boundary', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => failingSseResponse({
      model: 'model-exact',
      choices: [{
        delta: { tool_calls: [{ index: 0 }] },
        finish_reason: null
      }]
    }));
    const gateway = gatewayFixture({
      fetch,
      resilienceDependencies: { sleep: async () => undefined }
    });

    await expect(gateway.inferExact(request())).rejects.toMatchObject({
      category: 'temporary'
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('opens and later probes the circuit for the exact Provider/model/settings route', async () => {
    let now = 1_000;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => (
      fetch.mock.calls.length <= 2
        ? new Response('', { status: 503 })
        : jsonResponse({
          model: 'model-exact',
          choices: [{ message: { content: 'probe succeeded' } }]
        })
    ));
    const gateway = gatewayFixture({
      fetch,
      resiliencePolicy: policy({
        maxAttempts: 1,
        circuitFailureThreshold: 2,
        circuitOpenMs: 5_000
      }),
      resilienceDependencies: {
        now: () => now,
        sleep: async () => undefined
      }
    });

    await expect(gateway.inferExact(request())).rejects.toMatchObject({ status: 503 });
    await expect(gateway.inferExact(request())).rejects.toMatchObject({ status: 503 });
    await expect(gateway.inferExact(request())).rejects.toMatchObject({
      code: 'agent_model_provider_circuit_open'
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    now += 5_001;
    await expect(gateway.inferExact(request())).resolves.toMatchObject({
      status: 'completed',
      contentBlocks: [{ type: 'text', text: 'probe succeeded' }]
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

function gatewayFixture(overrides: {
  fetch?: typeof globalThis.fetch;
  providers?: NonNullable<RuntimeBootstrap['modelProviders']>;
  environment?: Readonly<Record<string, string | undefined>>;
  modelId?: string;
  authorityProviderId?: string;
  requestTimeoutMs?: number;
  resiliencePolicy?: RuntimeBootstrap['runtimePolicy']['providerResilience'];
  resilienceDependencies?: NonNullable<
    ConstructorParameters<typeof ProductionExactAgentModelInferenceGateway>[0]['resilienceDependencies']
  >;
  providerTelemetry?: NonNullable<
    ConstructorParameters<typeof ProductionExactAgentModelInferenceGateway>[0]['providerTelemetry']
  >;
  credentialResolver?: NonNullable<
    ConstructorParameters<typeof ProductionExactAgentModelInferenceGateway>[0]['credentialResolver']
  >;
} = {}): ProductionExactAgentModelInferenceGateway {
  return new ProductionExactAgentModelInferenceGateway({
    modelProviders: overrides.providers ?? [provider()],
    agentAdmissionAuthoritySource: authority(
      overrides.modelId ?? 'model-exact',
      overrides.authorityProviderId ?? 'provider-exact'
    ),
    credentialEnvironment: overrides.environment ?? { EXACT_KEY: SECRET },
    ...(overrides.credentialResolver === undefined
      ? {}
      : { credentialResolver: overrides.credentialResolver }),
    resiliencePolicy: overrides.resiliencePolicy
      ?? createDefaultRuntimePolicySnapshot().providerResilience,
    ...(overrides.resilienceDependencies === undefined
      ? {}
      : { resilienceDependencies: overrides.resilienceDependencies }),
    ...(overrides.providerTelemetry === undefined
      ? {}
      : { providerTelemetry: overrides.providerTelemetry }),
    fetch: overrides.fetch,
    requestTimeoutMs: overrides.requestTimeoutMs
  });
}

function provider(
  overrides: Partial<NonNullable<RuntimeBootstrap['modelProviders']>[number]> = {}
): NonNullable<RuntimeBootstrap['modelProviders']>[number] {
  return {
    providerId: 'provider-exact',
    name: 'runtime-provider-exact',
    protocol: 'openai-compatible',
    usageReporting: overrides.protocol === 'anthropic-messages'
      ? 'anthropic-events'
      : 'openai-stream-options',
    credentialEnvironmentVariable: 'EXACT_KEY',
    enabled: true,
    baseUrl: 'https://provider.example/v1',
    model: 'model-exact',
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    inference: {},
    ...overrides
  };
}

function authority(
  modelId: string,
  providerId = 'provider-exact'
): RuntimeBootstrap['agentAdmissionAuthoritySource'] {
  return {
    sourceVersion: 1,
    status: 'enabled',
    manifests: [{
      manifestVersion: 1,
      manifestId: 'manifest-1',
      revision: 1,
      workspace: {
        workspaceId: 'workspace-1',
        revision: 1,
        grantDigest: DIGEST,
        access: 'write',
        scopeIds: ['workspace-1']
      },
      model: {
        providerId,
        modelId,
        settingsRevision: 7
      },
      policy: {
        policyId: 'policy-1',
        revision: 1,
        permissionMode: 'ask'
      },
      capabilityGrant: {
        grantId: 'grant-1',
        revision: 1,
        capabilities: [{ capabilityId: 'workspace.read', scopeIds: ['workspace-1'] }]
      },
      toolCatalog: {
        catalogId: 'catalog-1',
        revision: 1,
        digest: DIGEST,
        allowedToolNames: ['workspace.read']
      },
      rootBudget: {
        authorityId: 'budget-1',
        revision: 1,
        vector: {
          modelTurns: 2,
          toolCalls: 1,
          readCalls: 1,
          writeCalls: 0,
          shellCalls: 0,
          costMicrousd: 1_000
        },
        deadlinePolicy: {
          kind: 'absolute',
          deadlineAt: '2030-01-01T00:00:00.000Z'
        }
      }
    }]
  };
}

function request(overrides: {
  providerId?: string;
  modelId?: string;
  settingsRevision?: number;
  messages?: Parameters<ProductionExactAgentModelInferenceGateway['inferExact']>[0]['messages'];
  tools?: Parameters<ProductionExactAgentModelInferenceGateway['inferExact']>[0]['tools'];
  signal?: AbortSignal;
  inference?: Parameters<ProductionExactAgentModelInferenceGateway['inferExact']>[0]['binding']['inference'];
} = {}): Parameters<ProductionExactAgentModelInferenceGateway['inferExact']>[0] {
  return {
    binding: {
      providerId: overrides.providerId ?? 'provider-exact',
      modelId: overrides.modelId ?? 'model-exact',
      settingsRevision: overrides.settingsRevision ?? 7,
      ...(overrides.inference === undefined ? {} : { inference: overrides.inference })
    },
    messages: overrides.messages ?? [textMessage('user', 'hello')],
    tools: overrides.tools ?? [],
    signal: overrides.signal ?? new AbortController().signal
  };
}

function textMessage(
  role: 'system' | 'user' | 'assistant',
  text: string
): Parameters<ProductionExactAgentModelInferenceGateway['inferExact']>[0]['messages'][number] {
  return { role, content: [{ type: 'text', text }] };
}

function imageBlock(value: string) {
  const bytes = Buffer.from(value, 'utf8');
  return {
    type: 'image' as const,
    attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    mediaType: 'image/png' as const,
    dataBase64: bytes.toString('base64'),
    bytes: bytes.byteLength,
    width: 32,
    height: 24
  };
}

function toolContract(): Parameters<
  ProductionExactAgentModelInferenceGateway['inferExact']
>[0]['tools'][number] {
  return {
    providerToolName: 'exact_tool',
    description: 'Exact test Tool.',
    inputSchema: { type: 'object', additionalProperties: false }
  };
}

function jsonResponse(payload: unknown): Response {
  if (isRecord(payload) && Array.isArray(payload.choices)) {
    const choices = payload.choices.map((entry, index) => {
      if (!isRecord(entry) || !isRecord(entry.message)) return entry;
      const message = entry.message;
      return {
        index,
        delta: {
          ...(message.content === undefined ? {} : { content: message.content }),
          ...(Array.isArray(message.tool_calls)
            ? {
              tool_calls: message.tool_calls.map((call, toolIndex) => ({
                index: toolIndex,
                ...(isRecord(call) ? call : {})
              }))
            }
            : {})
        },
        finish_reason: Array.isArray(message.tool_calls) ? 'tool_calls' : 'stop'
      };
    });
    return sseResponse([
      { ...payload, choices },
      '[DONE]'
    ]);
  }
  if (isRecord(payload) && Array.isArray(payload.content)) {
    const events: unknown[] = [{
      type: 'message_start',
      message: { id: payload.id, model: payload.model }
    }];
    payload.content.forEach((entry, index) => {
      if (!isRecord(entry)) {
        events.push({ type: 'invalid' });
        return;
      }
      if (entry.type === 'text') {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: entry.text }
        });
      } else if (entry.type === 'tool_use') {
        events.push({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: entry.id,
            name: entry.name,
            input: entry.input
          }
        });
      } else {
        events.push({ type: 'invalid' });
      }
    });
    events.push({
      type: 'message_delta',
      delta: {
        stop_reason: payload.content.some((entry) => isRecord(entry) && entry.type === 'tool_use')
          ? 'tool_use'
          : 'end_turn'
      }
    });
    events.push({ type: 'message_stop' });
    return sseResponse(events);
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function sseResponse(events: readonly unknown[]): Response {
  return new Response(events.map((event) => (
    `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`
  )).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function failingSseResponse(event: unknown): Response {
  const encoded = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  let delivered = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(encoded);
        return;
      }
      controller.error(new Error('fetch failed after Provider output'));
    }
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function policy(
  overrides: Partial<RuntimeBootstrap['runtimePolicy']['providerResilience']> = {}
): RuntimeBootstrap['runtimePolicy']['providerResilience'] {
  return {
    ...createDefaultRuntimePolicySnapshot().providerResilience,
    ...overrides
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
