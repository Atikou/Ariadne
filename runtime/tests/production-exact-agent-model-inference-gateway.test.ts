import type { RuntimeBootstrap } from '@ariadne/protocol/host';
import { describe, expect, it, vi } from 'vitest';

import {
  ExactAgentModelInferenceTransportError,
  ProductionExactAgentModelInferenceGateway
} from '../src/adapters/model/ProductionExactAgentModelInferenceGateway.js';

const SECRET = 'credential-must-never-appear';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('ProductionExactAgentModelInferenceGateway', () => {
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
          tool_calls: [{ type: 'function' }]
        }
      }]
    }));
    const gateway = gatewayFixture({ fetch });

    await expect(gateway.inferExact(request())).resolves.toEqual({
      status: 'completed',
      content: 'exact response',
      nativeToolCallCount: 1
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://provider.example/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'model-exact',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 4096,
      stream: false
    });
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
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'continued' },
        { role: 'assistant', content: 'prior answer' }
      ]
    }))).resolves.toEqual({
      status: 'completed',
      content: 'anthropic response',
      nativeToolCallCount: 1
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
        { role: 'user', content: 'hello\n\ncontinued' },
        { role: 'assistant', content: 'prior answer' }
      ],
      stream: false
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

  it('rejects Anthropic tool history because the v3 message port has no tool-call identity', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
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
      messages: [{ role: 'tool', content: 'result without tool-call ID' }]
    }))).rejects.toMatchObject({ code: 'agent_model_request_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function gatewayFixture(overrides: {
  fetch?: typeof globalThis.fetch;
  providers?: NonNullable<RuntimeBootstrap['modelProviders']>;
  environment?: Readonly<Record<string, string | undefined>>;
  modelId?: string;
  requestTimeoutMs?: number;
} = {}): ProductionExactAgentModelInferenceGateway {
  return new ProductionExactAgentModelInferenceGateway({
    modelProviders: overrides.providers ?? [provider()],
    agentAdmissionAuthoritySource: authority(overrides.modelId ?? 'model-exact'),
    credentialEnvironment: overrides.environment ?? { EXACT_KEY: SECRET },
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

function authority(modelId: string): RuntimeBootstrap['agentAdmissionAuthoritySource'] {
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
        providerId: 'provider-exact',
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
    messages: overrides.messages ?? [{ role: 'user', content: 'hello' }],
    signal: overrides.signal ?? new AbortController().signal
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
