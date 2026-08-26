import {
  agentAdmissionAuthoritySourceSchema,
  modelProviderBootstrapSchema,
  type AgentAdmissionAuthoritySource,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';

import type {
  AgentModelSelectionPreference,
  DispatchExactAgentModelInferenceRequest,
  ExactAgentModelContextCapacity,
  ExactAgentModelInferenceRuntime,
  ExactAgentModelInferenceMessage,
  ExactAgentModelInferenceResult
} from '../../control/ports/AgentModelInference.js';

const MAX_REQUEST_MESSAGES = 1_024;
const MAX_REQUEST_BYTES = 4 * 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

type ModelProviderBootstrap = NonNullable<RuntimeBootstrap['modelProviders']>[number];
type Fetch = typeof globalThis.fetch;

export interface ProductionExactAgentModelInferenceGatewayOptions {
  readonly modelProviders: RuntimeBootstrap['modelProviders'];
  readonly agentAdmissionAuthoritySource: AgentAdmissionAuthoritySource;
  /** Process-start snapshot. Only declared Provider credential variables are read. */
  readonly credentialEnvironment: Readonly<Record<string, string | undefined>>;
  readonly fetch?: Fetch;
  readonly requestTimeoutMs?: number;
}

interface ExactTransportBinding {
  readonly providerId: string;
  readonly modelId: string;
  readonly settingsRevision: number;
  readonly protocol: ModelProviderBootstrap['protocol'];
  readonly endpoint: string;
  readonly credential: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Pure Ariadne v3 model transport.
 *
 * Bindings are compiled once from the validated bootstrap Provider records and
 * first-party admission authority. Inference can only look up the exact
 * providerId/modelId/settingsRevision tuple; it never routes or falls back.
 */
export class ProductionExactAgentModelInferenceGateway
implements ExactAgentModelInferenceRuntime {
  private readonly bindings: ReadonlyMap<string, ExactTransportBinding>;
  private readonly fetch: Fetch;
  private readonly requestTimeoutMs: number;

  public constructor(options: ProductionExactAgentModelInferenceGatewayOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    if (
      options.requestTimeoutMs !== undefined
      && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    ) {
      throw new Error('agent_model_request_timeout_invalid');
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.bindings = compileExactBindings(options);
  }

  public hasExactBinding(
    binding: DispatchExactAgentModelInferenceRequest['binding']
  ): boolean {
    return this.bindings.has(bindingKey(
      binding.providerId,
      binding.modelId,
      binding.settingsRevision
    ));
  }

  public resolveBinding(
    settingsRevision: number,
    preference: AgentModelSelectionPreference = {}
  ): DispatchExactAgentModelInferenceRequest['binding'] | null {
    const bindings = [...this.bindings.values()].filter(
      (binding) => binding.settingsRevision === settingsRevision
    );
    const selected = preference.modelId === undefined
      ? bindings[0]
      : bindings.find((binding) => binding.modelId === preference.modelId);
    return selected === undefined ? null : publicBinding(selected);
  }

  public describeContextCapacity(
    binding: DispatchExactAgentModelInferenceRequest['binding']
  ): ExactAgentModelContextCapacity | null {
    const exact = this.bindings.get(bindingKey(
      binding.providerId,
      binding.modelId,
      binding.settingsRevision
    ));
    return exact === undefined ? null : {
      contextWindowTokens: exact.contextWindowTokens,
      maxOutputTokens: exact.maxOutputTokens
    };
  }

  public async inferExact(
    request: DispatchExactAgentModelInferenceRequest
  ): Promise<ExactAgentModelInferenceResult> {
    request.signal.throwIfAborted();
    const binding = this.bindings.get(bindingKey(
      request.binding.providerId,
      request.binding.modelId,
      request.binding.settingsRevision
    ));
    if (binding === undefined) return { status: 'binding_unavailable' };

    const messages = validateMessages(request.messages);
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const transportSignal = AbortSignal.any([request.signal, timeoutSignal]);
    const transportRequest = binding.protocol === 'openai-compatible'
      ? openAiRequest(binding, messages, request.binding.inference, transportSignal)
      : anthropicRequest(binding, messages, request.binding.inference, transportSignal);
    let response: Response;
    try {
      response = await this.fetch(binding.endpoint, transportRequest);
    } catch (cause) {
      if (timeoutSignal.aborted && !request.signal.aborted) {
        throw new ExactAgentModelInferenceTransportError(
          'agent_model_provider_timeout'
        );
      }
      throw cause;
    }
    request.signal.throwIfAborted();
    if (!response.ok) {
      if (await isContextOverflowResponse(response, request.signal)) {
        return { status: 'context_overflow' };
      }
      throw new ExactAgentModelInferenceTransportError(
        'agent_model_provider_http_error',
        response.status
      );
    }
    const payload = await readBoundedJson(response, request.signal);
    request.signal.throwIfAborted();
    return binding.protocol === 'openai-compatible'
      ? parseOpenAiResponse(payload, binding.modelId)
      : parseAnthropicResponse(payload, binding.modelId);
  }
}

export class ExactAgentModelInferenceTransportError extends Error {
  public constructor(
    public readonly code:
      | 'agent_model_provider_http_error'
      | 'agent_model_provider_timeout'
      | 'agent_model_provider_response_invalid'
      | 'agent_model_request_invalid',
    public readonly status?: number
  ) {
    super(status === undefined ? code : `${code}:${String(status)}`);
    this.name = 'ExactAgentModelInferenceTransportError';
  }
}

function compileExactBindings(
  options: ProductionExactAgentModelInferenceGatewayOptions
): ReadonlyMap<string, ExactTransportBinding> {
  const providers = modelProviderBootstrapSchema.array().max(16).parse(
    options.modelProviders ?? []
  );
  const authority = agentAdmissionAuthoritySourceSchema.parse(
    options.agentAdmissionAuthoritySource
  );
  if (authority.status !== 'enabled') return new Map();

  const providerCounts = new Map<string, number>();
  for (const provider of providers) {
    providerCounts.set(
      provider.providerId,
      (providerCounts.get(provider.providerId) ?? 0) + 1
    );
  }
  const providersById = new Map(
    providers
      .filter((provider) => providerCounts.get(provider.providerId) === 1)
      .map((provider) => [provider.providerId, provider] as const)
  );
  const bindings = new Map<string, ExactTransportBinding>();
  for (const manifest of authority.manifests) {
    for (const authorized of manifest.modelCandidates ?? [manifest.model]) {
      const provider = providersById.get(authorized.providerId);
      if (
        provider === undefined
        || !provider.enabled
        || provider.model !== authorized.modelId
      ) continue;
      const credential = options.credentialEnvironment[
        provider.credentialEnvironmentVariable
      ];
      if (typeof credential !== 'string' || credential.length === 0) continue;
      let endpoint: string;
      try {
        endpoint = exactEndpoint(provider.baseUrl, provider.protocol);
      } catch {
        continue;
      }
      const exact = Object.freeze({
        providerId: authorized.providerId,
        modelId: authorized.modelId,
        settingsRevision: authorized.settingsRevision,
        protocol: provider.protocol,
        endpoint,
        credential,
        contextWindowTokens: provider.contextWindowTokens,
        maxOutputTokens: provider.maxOutputTokens
      });
      const key = bindingKey(exact.providerId, exact.modelId, exact.settingsRevision);
      const existing = bindings.get(key);
      if (existing !== undefined && !sameTransport(existing, exact)) {
        bindings.delete(key);
        continue;
      }
      bindings.set(key, exact);
    }
  }
  return bindings;
}

function publicBinding(
  binding: ExactTransportBinding
): DispatchExactAgentModelInferenceRequest['binding'] {
  return {
    providerId: binding.providerId,
    modelId: binding.modelId,
    settingsRevision: binding.settingsRevision
  };
}

function exactEndpoint(
  baseUrl: string,
  protocol: ModelProviderBootstrap['protocol']
): string {
  const base = new URL(baseUrl);
  if (
    base.protocol !== 'https:'
    || base.username !== ''
    || base.password !== ''
    || base.search !== ''
    || base.hash !== ''
    || /%(?:2f|5c)/iu.test(base.pathname)
  ) {
    throw new Error('invalid_exact_model_base_url');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const relative = protocol === 'openai-compatible'
    ? 'chat/completions'
    : 'v1/messages';
  return new URL(relative, base).toString();
}

function openAiRequest(
  binding: ExactTransportBinding,
  messages: readonly ExactAgentModelInferenceMessage[],
  inference: DispatchExactAgentModelInferenceRequest['binding']['inference'],
  signal: AbortSignal
): RequestInit {
  return jsonRequest({
    model: binding.modelId,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content
    })),
    ...(binding.providerId === 'openai'
      ? { max_completion_tokens: binding.maxOutputTokens }
      : { max_tokens: binding.maxOutputTokens }),
    ...openAiInference(binding.providerId, binding.modelId, inference),
    stream: false
  }, {
    authorization: `Bearer ${binding.credential}`
  }, signal);
}

function anthropicRequest(
  binding: ExactTransportBinding,
  messages: readonly ExactAgentModelInferenceMessage[],
  inference: DispatchExactAgentModelInferenceRequest['binding']['inference'],
  signal: AbortSignal
): RequestInit {
  if (inference !== undefined && Object.keys(inference).length > 0) {
    throw invalidRequest();
  }
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const conversation = coalesceAnthropicMessages(messages);
  if (conversation.length === 0) throw invalidRequest();
  return jsonRequest({
    model: binding.modelId,
    max_tokens: binding.maxOutputTokens,
    ...(system.length > 0 ? { system } : {}),
    messages: conversation,
    stream: false
  }, {
    'x-api-key': binding.credential,
    'anthropic-version': ANTHROPIC_API_VERSION
  }, signal);
}

function openAiInference(
  providerId: string,
  modelId: string,
  inference: DispatchExactAgentModelInferenceRequest['binding']['inference']
): Record<string, unknown> {
  if (inference === undefined) return {};
  const effort = inference.reasoningEffort;
  if (providerId === 'deepseek') {
    return {
      ...(inference.reasoningMode === 'off' ? { thinking: { type: 'disabled' } } : {}),
      ...(inference.reasoningMode === 'on' ? { thinking: { type: 'enabled' } } : {}),
      ...(effort === undefined ? {} : { reasoning_effort: effort })
    };
  }
  if (providerId === 'kimi') {
    if (modelId.startsWith('kimi-k3')) {
      return effort === undefined ? {} : { reasoning_effort: effort };
    }
    if (modelId.startsWith('kimi-k2.6') || modelId.startsWith('kimi-k2.5')) {
      return inference.reasoningMode === 'off'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'enabled' } };
    }
    return {};
  }
  if (inference.reasoningMode === 'pro') throw invalidRequest();
  return effort === undefined ? {} : { reasoning_effort: effort };
}

function coalesceAnthropicMessages(
  messages: readonly ExactAgentModelInferenceMessage[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role !== 'user' && message.role !== 'assistant') throw invalidRequest();
    const previous = result.at(-1);
    if (previous?.role === message.role) {
      previous.content += `\n\n${message.content}`;
    } else {
      result.push({ role: message.role, content: message.content });
    }
  }
  return result;
}

function jsonRequest(
  payload: unknown,
  authorization: Readonly<Record<string, string>>,
  signal: AbortSignal
): RequestInit {
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw invalidRequest();
  }
  return {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...authorization
    },
    body,
    signal
  };
}

async function isContextOverflowResponse(
  response: Response,
  signal: AbortSignal
): Promise<boolean> {
  if (![400, 413, 422].includes(response.status) || response.body === null) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1_024) {
        await reader.cancel();
        return false;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const evidence = new TextDecoder().decode(bytes).toLowerCase();
  return [
    'context_length_exceeded',
    'context window exceeded',
    'maximum context length',
    'prompt is too long',
    'input is too long',
    'too many input tokens',
    'request too large for model'
  ].some((marker) => evidence.includes(marker));
}

function validateMessages(
  messages: readonly ExactAgentModelInferenceMessage[]
): readonly ExactAgentModelInferenceMessage[] {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_REQUEST_MESSAGES) {
    throw invalidRequest();
  }
  for (const message of messages) {
    if (!isPlainObject(message)) throw invalidRequest();
    const keys = Object.keys(message);
    if (
      keys.length !== 2
      || !keys.includes('role')
      || !keys.includes('content')
      || typeof message.role !== 'string'
      || !['system', 'user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string'
    ) {
      throw invalidRequest();
    }
  }
  return messages;
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal
): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') throw invalidResponse();
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESPONSE_BYTES) {
      throw invalidResponse();
    }
  }
  if (response.body === null) throw invalidResponse();
  const reader = response.body.getReader();
  const cancelForAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelForAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidResponse();
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener('abort', cancelForAbort);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidResponse();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse();
  }
}

function parseOpenAiResponse(
  value: unknown,
  exactModelId: string
): ExactAgentModelInferenceResult {
  const payload = plainResponseObject(value);
  if (payload.model !== exactModelId || !Array.isArray(payload.choices) || payload.choices.length !== 1) {
    throw invalidResponse();
  }
  const choice = plainResponseObject(payload.choices[0]);
  const message = plainResponseObject(choice.message);
  const toolCalls = message.tool_calls === undefined ? [] : message.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.some((call) => !isPlainObject(call))) {
    throw invalidResponse();
  }
  const content = message.content;
  if (typeof content !== 'string' && !(content === null && toolCalls.length > 0)) {
    throw invalidResponse();
  }
  return {
    status: 'completed',
    content: content ?? '',
    nativeToolCallCount: toolCalls.length
  };
}

function parseAnthropicResponse(
  value: unknown,
  exactModelId: string
): ExactAgentModelInferenceResult {
  const payload = plainResponseObject(value);
  if (payload.model !== exactModelId || !Array.isArray(payload.content) || payload.content.length === 0) {
    throw invalidResponse();
  }
  let content = '';
  let nativeToolCallCount = 0;
  for (const entry of payload.content) {
    const block = plainResponseObject(entry);
    if (block.type === 'text' && typeof block.text === 'string') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      nativeToolCallCount += 1;
    } else {
      throw invalidResponse();
    }
  }
  return { status: 'completed', content, nativeToolCallCount };
}

function plainResponseObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalidResponse();
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function bindingKey(providerId: string, modelId: string, settingsRevision: number): string {
  return JSON.stringify([providerId, modelId, settingsRevision]);
}

function sameTransport(left: ExactTransportBinding, right: ExactTransportBinding): boolean {
  return left.protocol === right.protocol
    && left.endpoint === right.endpoint
    && left.credential === right.credential
    && left.contextWindowTokens === right.contextWindowTokens
    && left.maxOutputTokens === right.maxOutputTokens;
}

function invalidRequest(): ExactAgentModelInferenceTransportError {
  return new ExactAgentModelInferenceTransportError('agent_model_request_invalid');
}

function invalidResponse(): ExactAgentModelInferenceTransportError {
  return new ExactAgentModelInferenceTransportError('agent_model_provider_response_invalid');
}
