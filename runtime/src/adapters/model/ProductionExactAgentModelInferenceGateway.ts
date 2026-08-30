import { createHash } from 'node:crypto';

import {
  agentAdmissionAuthoritySourceSchema,
  modelProviderBootstrapSchema,
  type AgentAdmissionAuthoritySource,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';

import type {
  AgentModelSelectionPreference,
  DispatchExactAgentModelInferenceRequest,
  ExactAgentModelContextCapacity,
  ExactAgentModelInferenceRequestContentBlock,
  ExactAgentModelInferenceRuntime,
  ExactAgentModelInferenceMessage,
  ExactAgentModelInferenceResult,
  ExactAgentModelInferenceToolContract
} from '../../control/ports/AgentModelInference.js';
import { countRemoteRequestTokens } from './PerModelLocalTokenCounter.js';
import { readExactAgentProviderStream } from './readExactAgentProviderStream.js';
import { estimateMessagesTokens } from './V3LongContextLifecycle.js';
import {
  ProviderResilienceCoordinator,
  type ProviderResilienceCoordinatorDependencies,
  type ProviderResilienceFailure,
  type ProviderResilienceTelemetrySink
} from './ProviderResilienceCoordinator.js';
import { classifyProviderError } from './ProviderError.js';

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
  readonly resiliencePolicy: RuntimePolicySnapshot['providerResilience'];
  readonly providerTelemetry?: ProviderResilienceTelemetrySink;
  readonly resilienceDependencies?: Pick<
    ProviderResilienceCoordinatorDependencies,
    'now' | 'sleep' | 'random'
  >;
  readonly fetch?: Fetch;
  readonly requestTimeoutMs?: number;
}

interface ExactTransportBinding {
  readonly providerId: string;
  readonly modelId: string;
  readonly settingsRevision: number;
  readonly supportsVision: boolean;
  readonly protocol: ModelProviderBootstrap['protocol'];
  readonly usageReporting: NonNullable<ModelProviderBootstrap['usageReporting']>;
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
  private readonly resilience: ReadonlyMap<string, ProviderResilienceCoordinator>;
  private readonly now: () => number;

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
    this.now = options.resilienceDependencies?.now ?? Date.now;
    this.resilience = new Map([...this.bindings.entries()].map(([key, binding]) => [
      key,
      new ProviderResilienceCoordinator(
        binding.providerId,
        binding.modelId,
        options.resiliencePolicy,
        {
          ...options.resilienceDependencies,
          ...(options.providerTelemetry === undefined
            ? {}
            : { telemetry: options.providerTelemetry }),
          createCircuitOpenError: () => new ExactAgentModelInferenceTransportError(
            'agent_model_provider_circuit_open',
            undefined,
            'temporary'
          ),
          createRateLimitError: () => new ExactAgentModelInferenceTransportError(
            'agent_model_provider_rate_limit',
            429,
            'rate_limit'
          )
        }
      )
    ]));
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
        && (!preference.requiresVision || binding.supportsVision)
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

    const tools = validateTools(request.tools);
    const messages = validateMessages(
      request.messages,
      new Set(tools.map((tool) => tool.providerToolName))
    );
    const resilience = this.resilience.get(bindingKey(
      binding.providerId,
      binding.modelId,
      binding.settingsRevision
    ));
    if (resilience === undefined) throw new Error('agent_model_resilience_binding_missing');
    return resilience.run({
      signal: request.signal,
      reservedTokens: estimateMessagesTokens([
        ...messages,
        ...(tools.length === 0
          ? []
          : [{
              role: 'system' as const,
              content: [{ type: 'text' as const, text: JSON.stringify(tools) }]
            }])
      ]) + binding.maxOutputTokens,
      execute: (markOutputStarted) => this.inferBindingAttempt(
        request,
        binding,
        messages,
        tools,
        markOutputStarted
      ),
      classify: classifyExactFailure
    });
  }

  public async countRequestTokens(
    request: Parameters<ExactAgentModelInferenceRuntime['countRequestTokens']>[0]
  ): ReturnType<ExactAgentModelInferenceRuntime['countRequestTokens']> {
    request.signal.throwIfAborted();
    const binding = this.bindings.get(bindingKey(
      request.binding.providerId,
      request.binding.modelId,
      request.binding.settingsRevision
    ));
    if (binding === undefined) throw new Error('agent_model_tokenizer_binding_unavailable');
    const result = countRemoteRequestTokens({
      providerId: binding.providerId,
      modelId: binding.modelId,
      protocol: binding.protocol,
      messages: validateMessages(request.messages, new Set(
        request.tools.map((tool) => tool.providerToolName)
      )),
      tools: validateTools(request.tools)
    });
    request.signal.throwIfAborted();
    return result;
  }

  private async inferBindingAttempt(
    request: DispatchExactAgentModelInferenceRequest,
    binding: ExactTransportBinding,
    messages: readonly ExactAgentModelInferenceMessage[],
    tools: readonly ExactAgentModelInferenceToolContract[],
    markOutputStarted: () => void
  ): Promise<ExactAgentModelInferenceResult> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const transportSignal = AbortSignal.any([request.signal, timeoutSignal]);
    const transportRequest = binding.protocol === 'openai-compatible'
      ? openAiRequest(binding, messages, tools, request.binding.inference, transportSignal)
      : anthropicRequest(binding, messages, tools, request.binding.inference, transportSignal);
    const requestEnvelopeDigest = digestRequestEnvelope(transportRequest);
    let response: Response;
    try {
      response = await this.fetch(binding.endpoint, transportRequest);
    } catch (cause) {
      if (timeoutSignal.aborted && !request.signal.aborted) {
        throw new ExactAgentModelInferenceTransportError(
          'agent_model_provider_timeout',
          undefined,
          'timeout'
        );
      }
      throw cause;
    }
    request.signal.throwIfAborted();
    if (!response.ok) {
      if (await isContextOverflowResponse(response, request.signal)) {
        return { status: 'context_overflow' };
      }
      throw providerHttpFailure(response.status, response.headers.get('retry-after'), this.now());
    }
    try {
      const streamed = await readExactAgentProviderStream(response, {
        protocol: binding.protocol,
        exactModelId: binding.modelId,
        signal: request.signal,
        maxContentBytes: MAX_RESPONSE_BYTES,
        maxReasoningBytes: MAX_RESPONSE_BYTES,
        onOutputStarted: markOutputStarted,
        ...(request.chunkObserver === undefined
          ? {}
          : { onChunk: (chunk) => request.chunkObserver!.observe(chunk) })
      });
      request.signal.throwIfAborted();
      return {
        status: 'completed',
        contentBlocks: streamed.contentBlocks,
        replay: Object.freeze({
          envelopeVersion: 1,
          adapter: binding.protocol,
          finishReason: streamed.finishReason,
          requestEnvelopeDigest,
          contentBlocksDigest: digestJson(streamed.contentBlocks),
          ...(streamed.providerResponseId === undefined
            ? {}
            : { providerResponseIdDigest: digestText(streamed.providerResponseId) })
        }),
        ...(streamed.usage === undefined
          ? {}
          : { usage: { ...streamed.usage } })
      };
    } catch (error) {
      request.signal.throwIfAborted();
      if (
        error instanceof Error
        && (
          error.message.startsWith('agent_model_provider_sse_')
          || error.message.startsWith('agent_model_provider_stream_')
          || error.message.startsWith('exact_agent_stream_')
        )
      ) throw invalidResponse();
      throw error;
    }
  }
}

export class ExactAgentModelInferenceTransportError extends Error {
  public constructor(
    public readonly code:
      | 'agent_model_provider_http_error'
      | 'agent_model_provider_timeout'
      | 'agent_model_provider_circuit_open'
      | 'agent_model_provider_rate_limit'
      | 'agent_model_provider_response_invalid'
      | 'agent_model_request_invalid',
    public readonly status?: number,
    public readonly category:
      | 'authentication'
      | 'invalid_request'
      | 'rate_limit'
      | 'temporary'
      | 'timeout'
      | 'cancelled'
      | 'fatal' = 'fatal',
    public readonly retryAfterMs?: number
  ) {
    super(status === undefined ? code : `${code}:${String(status)}`);
    this.name = 'ExactAgentModelInferenceTransportError';
  }
}

function classifyExactFailure(error: unknown): ProviderResilienceFailure {
  if (error instanceof ExactAgentModelInferenceTransportError) {
    return {
      category: error.category,
      retryable: error.category === 'rate_limit'
        || error.category === 'temporary'
        || error.category === 'timeout',
      error,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs })
    };
  }
  const classified = classifyProviderError(error);
  if (classified.category === 'fatal') {
    return { category: 'fatal', retryable: false, error };
  }
  const sanitized = new ExactAgentModelInferenceTransportError(
    classified.category === 'timeout'
      ? 'agent_model_provider_timeout'
      : classified.category === 'rate_limit'
        ? 'agent_model_provider_rate_limit'
        : 'agent_model_provider_http_error',
    classified.status,
    classified.category,
    classified.retryAfterMs
  );
  return {
    category: classified.category,
    retryable: classified.category === 'rate_limit'
      || classified.category === 'temporary'
      || classified.category === 'timeout',
    error: sanitized,
    ...(classified.status === undefined ? {} : { status: classified.status }),
    ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs })
  };
}

function providerHttpFailure(
  status: number,
  retryAfter: string | null,
  now: number
): ExactAgentModelInferenceTransportError {
  const category = status === 401 || status === 403
    ? 'authentication' as const
    : status === 408 || status === 504
      ? 'timeout' as const
      : status === 429
        ? 'rate_limit' as const
        : status >= 500
          ? 'temporary' as const
          : status >= 400
            ? 'invalid_request' as const
            : 'fatal' as const;
  return new ExactAgentModelInferenceTransportError(
    'agent_model_provider_http_error',
    status,
    category,
    parseRetryAfter(retryAfter, now)
  );
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.length === 0) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? date - now : undefined;
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
        || !usageReportingMatchesProtocol(
          provider.protocol,
          provider.usageReporting ?? 'none'
        )
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
        supportsVision: provider.supportsVision === true,
        protocol: provider.protocol,
        usageReporting: provider.usageReporting ?? 'none',
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
  tools: readonly ExactAgentModelInferenceToolContract[],
  inference: DispatchExactAgentModelInferenceRequest['binding']['inference'],
  signal: AbortSignal
): RequestInit {
  return jsonRequest({
    model: binding.modelId,
    messages: openAiMessages(messages),
    ...(binding.providerId === 'openai'
      ? { max_completion_tokens: binding.maxOutputTokens }
      : { max_tokens: binding.maxOutputTokens }),
    ...openAiInference(binding.providerId, binding.modelId, inference),
    ...(tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.providerToolName,
              description: tool.description,
              parameters: tool.inputSchema
            }
          })),
          tool_choice: 'auto'
        }),
    stream: true,
    ...(binding.usageReporting === 'openai-stream-options'
      ? { stream_options: { include_usage: true } }
      : {})
  }, {
    authorization: `Bearer ${binding.credential}`
  }, signal);
}

function anthropicRequest(
  binding: ExactTransportBinding,
  messages: readonly ExactAgentModelInferenceMessage[],
  tools: readonly ExactAgentModelInferenceToolContract[],
  inference: DispatchExactAgentModelInferenceRequest['binding']['inference'],
  signal: AbortSignal
): RequestInit {
  if (inference !== undefined && Object.keys(inference).length > 0) {
    throw invalidRequest();
  }
  const system = messages
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
  const conversation = coalesceAnthropicMessages(messages);
  if (conversation.length === 0) throw invalidRequest();
  return jsonRequest({
    model: binding.modelId,
    max_tokens: binding.maxOutputTokens,
    ...(system.length > 0 ? { system } : {}),
    messages: conversation,
    ...(tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            name: tool.providerToolName,
            description: tool.description,
            input_schema: tool.inputSchema
          }))
        }),
    stream: true
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
): Array<{
  role: 'user' | 'assistant';
  content: Array<Record<string, unknown>>;
}> {
  const result: Array<{
    role: 'user' | 'assistant';
    content: Array<Record<string, unknown>>;
  }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role !== 'user' && message.role !== 'assistant') throw invalidRequest();
    const content = message.content.map((block): Record<string, unknown> => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'image') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: block.mediaType,
            data: block.dataBase64
          }
        };
      }
      if (block.type === 'tool_call') {
        return {
          type: 'tool_use',
          id: block.toolCallId,
          name: block.providerToolName,
          input: block.input
        };
      }
      return {
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: JSON.stringify({ status: block.status, output: block.output }),
        is_error: block.status !== 'succeeded'
      };
    });
    const previous = result.at(-1);
    if (previous?.role === message.role) {
      previous.content.push(...content);
    } else {
      result.push({ role: message.role, content });
    }
  }
  return result;
}

function openAiMessages(
  messages: readonly ExactAgentModelInferenceMessage[]
): readonly Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const calls = message.content.filter((block): block is Extract<
      ExactAgentModelInferenceRequestContentBlock,
      { readonly type: 'tool_call' }
    > => block.type === 'tool_call');
    const toolResults = message.content.filter((block): block is Extract<
      ExactAgentModelInferenceRequestContentBlock,
      { readonly type: 'tool_result' }
    > => block.type === 'tool_result');
    const images = message.content.filter((block): block is Extract<
      ExactAgentModelInferenceRequestContentBlock,
      { readonly type: 'image' }
    > => block.type === 'image');
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content: JSON.stringify({ status: block.status, output: block.output })
        });
      }
      continue;
    }
    result.push({
      role: message.role,
      content: images.length > 0
        ? [
            ...(text.length === 0 ? [] : [{ type: 'text', text }]),
            ...images.map((block) => ({
              type: 'image_url',
              image_url: {
                url: `data:${block.mediaType};base64,${block.dataBase64}`,
                detail: 'auto'
              }
            }))
          ]
        : calls.length > 0 && text.length === 0 ? null : text,
      ...(calls.length === 0
        ? {}
        : {
            tool_calls: calls.map((block) => ({
              id: block.toolCallId,
              type: 'function',
              function: {
                name: block.providerToolName,
                arguments: JSON.stringify(block.input)
              }
            }))
          })
    });
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
      accept: 'text/event-stream',
      'content-type': 'application/json',
      ...authorization
    },
    body,
    signal
  };
}

function usageReportingMatchesProtocol(
  protocol: ModelProviderBootstrap['protocol'],
  usageReporting: NonNullable<ModelProviderBootstrap['usageReporting']>
): boolean {
  return usageReporting === 'none'
    || (protocol === 'openai-compatible' && usageReporting === 'openai-stream-options')
    || (protocol === 'anthropic-messages' && usageReporting === 'anthropic-events');
}

function digestRequestEnvelope(request: RequestInit): string {
  if (typeof request.body !== 'string') throw invalidRequest();
  return digestText(request.body);
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value));
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
  messages: readonly ExactAgentModelInferenceMessage[],
  toolNames: ReadonlySet<string>
): readonly ExactAgentModelInferenceMessage[] {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_REQUEST_MESSAGES) {
    throw invalidRequest();
  }
  const seenToolCallIds = new Set<string>();
  let outstandingToolCallIds = new Set<string>();
  for (const message of messages as readonly unknown[]) {
    if (!isPlainObject(message)) throw invalidRequest();
    const keys = Object.keys(message);
    if (
      keys.length !== 2
      || !keys.includes('role')
      || !keys.includes('content')
      || typeof message.role !== 'string'
      || !['system', 'user', 'assistant'].includes(message.role)
      || !Array.isArray(message.content)
      || message.content.length === 0
    ) {
      throw invalidRequest();
    }
    const blockTypes = new Set<string>();
    const messageToolCallIds = new Set<string>();
    for (const block of message.content as readonly unknown[]) {
      if (!isPlainObject(block) || typeof block.type !== 'string') throw invalidRequest();
      blockTypes.add(block.type);
      if (block.type === 'text') {
        if (
          Object.keys(block).length !== 2
          || typeof block.text !== 'string'
          || block.text.length === 0
        ) throw invalidRequest();
        continue;
      }
      if (block.type === 'image') {
        if (!validImageRequestBlock(block)) throw invalidRequest();
        continue;
      }
      if (block.type === 'tool_call') {
        if (
          Object.keys(block).length !== 4
          || typeof block.toolCallId !== 'string'
          || !isProviderToolCallId(block.toolCallId)
          || seenToolCallIds.has(block.toolCallId)
          || typeof block.providerToolName !== 'string'
          || !toolNames.has(block.providerToolName)
          || !isAgentJsonValue(block.input)
        ) throw invalidRequest();
        seenToolCallIds.add(block.toolCallId);
        messageToolCallIds.add(block.toolCallId);
        continue;
      }
      if (block.type === 'tool_result') {
        if (
          Object.keys(block).length !== 5
          || typeof block.effectId !== 'string'
          || block.effectId.length === 0
          || typeof block.toolCallId !== 'string'
          || !outstandingToolCallIds.has(block.toolCallId)
          || messageToolCallIds.has(block.toolCallId)
          || !['succeeded', 'failed', 'cancelled'].includes(String(block.status))
          || !isAgentJsonValue(block.output)
        ) throw invalidRequest();
        messageToolCallIds.add(block.toolCallId);
        continue;
      }
      throw invalidRequest();
    }
    if (message.role === 'system') {
      if (blockTypes.size !== 1 || !blockTypes.has('text')) throw invalidRequest();
    } else if (message.role === 'assistant') {
      if (
        blockTypes.has('tool_result')
        || blockTypes.has('image')
        || outstandingToolCallIds.size > 0
      ) {
        throw invalidRequest();
      }
      outstandingToolCallIds = messageToolCallIds;
    } else if (
      blockTypes.has('tool_call')
      || (blockTypes.has('tool_result')
        && (blockTypes.has('text') || blockTypes.has('image')))
    ) {
      throw invalidRequest();
    } else if (blockTypes.has('tool_result')) {
      if (
        messageToolCallIds.size !== outstandingToolCallIds.size
        || [...outstandingToolCallIds].some((id) => !messageToolCallIds.has(id))
      ) throw invalidRequest();
      outstandingToolCallIds = new Set();
    } else if (outstandingToolCallIds.size > 0) {
      throw invalidRequest();
    }
  }
  if (outstandingToolCallIds.size > 0) throw invalidRequest();
  return messages as readonly ExactAgentModelInferenceMessage[];
}

function validImageRequestBlock(value: Record<string, unknown>): boolean {
  if (
    Object.keys(value).length !== 7
    || typeof value.attachmentId !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(value.attachmentId)
    || !['image/png', 'image/jpeg', 'image/webp'].includes(String(value.mediaType))
    || typeof value.dataBase64 !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.dataBase64)
    || !Number.isSafeInteger(value.bytes)
    || Number(value.bytes) < 1
    || Number(value.bytes) > 2 * 1024 * 1024
    || !Number.isSafeInteger(value.width)
    || !Number.isSafeInteger(value.height)
    || Number(value.width) < 1
    || Number(value.height) < 1
    || Number(value.width) > 8_192
    || Number(value.height) > 8_192
    || Number(value.width) * Number(value.height) > 64_000_000
  ) return false;
  const bytes = Buffer.from(value.dataBase64, 'base64');
  return bytes.byteLength === value.bytes
    && bytes.toString('base64') === value.dataBase64
    && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === value.attachmentId;
}

function isProviderToolCallId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function isAgentJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isAgentJsonValue(entry, ancestors))
    : isPlainObject(value)
      && Object.values(value).every((entry) => isAgentJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function validateTools(
  tools: readonly ExactAgentModelInferenceToolContract[]
): readonly ExactAgentModelInferenceToolContract[] {
  if (!Array.isArray(tools) || tools.length > 256) throw invalidRequest();
  const names = new Set<string>();
  for (const value of tools as readonly unknown[]) {
    if (!isPlainObject(value)) throw invalidRequest();
    const providerToolName = value.providerToolName;
    const description = value.description;
    if (
      Object.keys(value).length !== 3
      || typeof providerToolName !== 'string'
      || !/^[A-Za-z0-9_-]{1,64}$/u.test(providerToolName)
      || names.has(providerToolName)
      || typeof description !== 'string'
      || description.length === 0
      || description.length > 1_024
      || !isPlainObject(value.inputSchema)
    ) throw invalidRequest();
    names.add(providerToolName);
  }
  return tools;
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
    && left.usageReporting === right.usageReporting
    && left.endpoint === right.endpoint
    && left.credential === right.credential
    && left.supportsVision === right.supportsVision
    && left.contextWindowTokens === right.contextWindowTokens
    && left.maxOutputTokens === right.maxOutputTokens;
}

function invalidRequest(): ExactAgentModelInferenceTransportError {
  return new ExactAgentModelInferenceTransportError('agent_model_request_invalid');
}

function invalidResponse(): ExactAgentModelInferenceTransportError {
  return new ExactAgentModelInferenceTransportError('agent_model_provider_response_invalid');
}
