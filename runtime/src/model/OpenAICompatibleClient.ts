import { performance } from "node:perf_hooks";

import { safeJsonParse, withTimeout } from "../util/timeout.js";
import {
  collectCompleteToolCallIds,
  hasCompleteToolCalls,
  renderInternalToolMessage,
  serializeToolArguments,
} from "./messageBoundary.js";
import type {
  ChatMessage,
  ChatRequest,
  ModelClient,
  ModelLocation,
  ModelResponse,
  ModelToolSpec,
  ToolCall,
} from "./types.js";
import type { ModelInferenceOptions } from "@ariadne/protocol/public";

export interface OpenAICompatibleOptions {
  name: string;
  providerId: string;
  model: string;
  location: ModelLocation;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

type CompatibleMessage =
  | { role: "system" | "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: CompatibleToolCallRequest[];
    };

interface CompatibleToolCallRequest {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface CompatibleTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface StreamedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * Ariadne 自有的 OpenAI-compatible protocol transport。
 *
 * “OpenAI-compatible”只表示 HTTP 路径、JSON 字段和 SSE 事件格式兼容；
 * 实际 Provider 完全由 baseUrl 与凭据决定，本实现不依赖任何厂商 SDK。
 */
export class OpenAICompatibleClient implements ModelClient {
  public readonly name: string;
  public readonly location: ModelLocation;
  public readonly model: string;

  private readonly baseUrl: URL;
  private readonly providerId: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.providerId = options.providerId;
    this.model = options.model;
    this.location = options.location;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async isAvailable(): Promise<boolean> {
    if (this.location === "remote" && !this.apiKey) return false;
    const { signal, cancel } = withTimeout(Math.min(this.timeoutMs, 8_000));
    try {
      const response = await this.request("models", { method: "GET", signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      cancel();
    }
  }

  async chat(request: ChatRequest): Promise<ModelResponse> {
    const { signal, cancel } = withTimeout(this.timeoutMs, request.signal);
    const startedAt = performance.now();
    const providerInference = mapProviderInference(this.providerId, this.model, request.inference);
    const temperature = shouldSendTemperature(this.providerId, request.inference)
      ? request.temperature
      : undefined;
    const outputTokenLimit = mapOutputTokenLimit(this.providerId, request.maxTokens);
    try {
      const response = await this.request("chat/completions", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: toCompatibleMessages(request.messages, supportsReasoningHistory(this.providerId)),
          tools: toCompatibleTools(request.tools),
          temperature,
          ...outputTokenLimit,
          stream: Boolean(request.onToken),
          ...providerInference,
        }),
      });
      if (!response.ok) throw await responseError(response);
      return request.onToken
        ? this.readStream(response, request.onToken, startedAt)
        : this.readJson(response, startedAt);
    } finally {
      cancel();
    }
  }

  private request(pathname: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    return globalThis.fetch(new URL(pathname, this.baseUrl), { ...init, headers });
  }

  private async readJson(response: Response, startedAt: number): Promise<ModelResponse> {
    const payload = asRecord(await response.json());
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const firstChoice = asOptionalRecord(choices[0]);
    const message = asOptionalRecord(firstChoice?.message);
    const usage = asOptionalRecord(payload.usage);
    return {
      content: typeof message?.content === "string" ? message.content : "",
      ...(typeof message?.reasoning_content === "string"
        ? { reasoningContent: message.reasoning_content }
        : {}),
      toolCalls: parseToolCalls(message?.tool_calls),
      clientName: this.name,
      modelName: typeof payload.model === "string" ? payload.model : this.model,
      location: this.location,
      latencyMs: performance.now() - startedAt,
      usage: {
        inputTokens: optionalNumber(usage?.prompt_tokens),
        outputTokens: optionalNumber(usage?.completion_tokens),
      },
    };
  }

  private async readStream(
    response: Response,
    onToken: (delta: string) => void,
    startedAt: number,
  ): Promise<ModelResponse> {
    if (!response.body) throw new Error("OpenAI-compatible Provider 未返回流式响应体");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, StreamedToolCall>();
    let buffer = "";
    let content = "";
    let reasoningContent = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const consume = (event: string): boolean => {
      const data = event.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data) return false;
      if (data === "[DONE]") return true;
      const payload = asRecord(JSON.parse(data));
      const usage = asOptionalRecord(payload.usage);
      inputTokens = optionalNumber(usage?.prompt_tokens) ?? inputTokens;
      outputTokens = optionalNumber(usage?.completion_tokens) ?? outputTokens;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const firstChoice = asOptionalRecord(choices[0]);
      const delta = asOptionalRecord(firstChoice?.delta);
      if (typeof delta?.reasoning_content === "string") reasoningContent += delta.reasoning_content;
      if (typeof delta?.content === "string" && delta.content) {
        content += delta.content;
        onToken(delta.content);
      }
      collectStreamedToolCalls(delta?.tool_calls, toolCalls);
      return false;
    };

    let done = false;
    while (!done) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        if (consume(event)) {
          done = true;
          break;
        }
        separator = buffer.indexOf("\n\n");
      }
      if (next.done) {
        if (!done && buffer.trim()) consume(buffer);
        break;
      }
    }

    return {
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      toolCalls: [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([index, call]) => call.name ? [{
          id: call.id || `stream-tool-${index}-${call.name}`,
          name: call.name,
          arguments: safeJsonParse(call.argumentsJson || "{}"),
        }] : []),
      clientName: this.name,
      modelName: this.model,
      location: this.location,
      latencyMs: performance.now() - startedAt,
      usage: { inputTokens, outputTokens },
    };
  }
}

function mapOutputTokenLimit(providerId: string, maxTokens: number | undefined): Record<string, number | undefined> {
  return providerId === 'kimi'
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function mapProviderInference(
  providerId: string,
  model: string,
  inference: ModelInferenceOptions | undefined,
): Record<string, unknown> {
  if (!inference) return {};
  const effort = inference.reasoningEffort;
  if (providerId === "deepseek") {
    return {
      ...(inference.reasoningMode === "off" ? { thinking: { type: "disabled" } } : {}),
      ...(inference.reasoningMode === "on" ? { thinking: { type: "enabled" } } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    };
  }
  if (providerId === "kimi") {
    if (model.startsWith("kimi-k3")) return effort ? { reasoning_effort: effort } : {};
    if (model.startsWith("kimi-k2.6") || model.startsWith("kimi-k2.5")) {
      return inference.reasoningMode === "off"
        ? { thinking: { type: "disabled" } }
        : { thinking: { type: "enabled" } };
    }
    return {};
  }
  if (inference.reasoningMode === "pro") {
    throw new Error("当前 OpenAI-compatible Chat Completions transport 不支持 Pro 推理模式。");
  }
  return effort ? { reasoning_effort: effort } : {};
}

function shouldSendTemperature(providerId: string, inference: ModelInferenceOptions | undefined): boolean {
  if (providerId === "kimi") return false;
  if (providerId === "deepseek" && inference?.reasoningMode === "on") return false;
  return true;
}

function supportsReasoningHistory(providerId: string): boolean {
  return providerId === "deepseek" || providerId === "kimi";
}

export function toCompatibleMessages(
  messages: ChatMessage[],
  includeReasoningContent = false,
): CompatibleMessage[] {
  const completeIds = collectCompleteToolCallIds(messages);
  return messages.map((message): CompatibleMessage => {
    switch (message.role) {
      case "tool":
        return message.toolCallId && completeIds.has(message.toolCallId)
          ? { role: "tool", tool_call_id: message.toolCallId, content: message.content }
          : { role: "user", content: renderInternalToolMessage(message) };
      case "assistant":
        return hasCompleteToolCalls(message, completeIds)
          ? {
              role: "assistant",
              content: message.content || null,
              ...(includeReasoningContent && message.reasoningContent
                ? { reasoning_content: message.reasoningContent }
                : {}),
              tool_calls: message.toolCalls!.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: serializeToolArguments(call),
                },
              })),
            }
          : {
              role: "assistant",
              content: message.content,
              ...(includeReasoningContent && message.reasoningContent
                ? { reasoning_content: message.reasoningContent }
                : {}),
            };
      case "system":
        return { role: "system", content: message.content };
      case "user":
      default:
        return { role: "user", content: message.content };
    }
  });
}

function toCompatibleTools(tools?: ModelToolSpec[]): CompatibleTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const call = asOptionalRecord(item);
    const fn = asOptionalRecord(call?.function);
    if (call?.type !== "function" || typeof call.id !== "string" || typeof fn?.name !== "string") {
      return [];
    }
    return [{
      id: call.id,
      name: fn.name,
      arguments: safeJsonParse(typeof fn.arguments === "string" ? fn.arguments : "{}"),
    }];
  });
}

function collectStreamedToolCalls(value: unknown, target: Map<number, StreamedToolCall>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const call = asOptionalRecord(item);
    if (!call || typeof call.index !== "number") continue;
    const fn = asOptionalRecord(call.function);
    const current = target.get(call.index) ?? { id: "", name: "", argumentsJson: "" };
    if (typeof call.id === "string") current.id = call.id;
    if (typeof fn?.name === "string") current.name += fn.name;
    if (typeof fn?.arguments === "string") current.argumentsJson += fn.arguments;
    target.set(call.index, current);
  }
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenAI-compatible Provider 地址必须使用 HTTP 或 HTTPS");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function responseError(response: Response): Promise<Error> {
  const text = (await response.text()).slice(0, 2_048);
  let detail = text;
  try {
    const payload = asRecord(JSON.parse(text));
    const error = asOptionalRecord(payload.error);
    if (typeof error?.message === "string") detail = error.message;
  } catch {
    // 非 JSON 错误响应保留截断后的正文，便于诊断兼容服务。
  }
  return new Error(`OpenAI-compatible Provider 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenAI-compatible Provider 返回了无效 JSON");
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
