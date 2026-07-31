import { performance } from "node:perf_hooks";

import { safeJsonParse, withTimeout } from "../util/timeout.js";
import {
  collectCompleteToolCallIds,
  hasCompleteToolCalls,
  renderInternalToolMessage,
} from "./messageBoundary.js";
import type {
  ChatMessage,
  ChatRequest,
  ModelClient,
  ModelResponse,
  ModelToolSpec,
  ToolCall,
} from "./types.js";
import {
  createConservativeTokenCounter,
  remoteTokenizerProfile,
} from "./TokenCounter.js";
import { ProviderRequestError, providerHttpError } from "./ProviderError.js";

export interface AnthropicOptions {
  name: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Anthropic API 版本头，默认 2023-06-01。 */
  apiVersion?: string;
  /** messages API 必填 max_tokens，未指定单次请求时的默认值。 */
  maxTokens?: number;
  timeoutMs?: number;
  contextWindowTokens?: number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessagesResponse {
  model?: string;
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic（Claude）远程客户端，使用其原生 Messages API。
 *
 * 与 OpenAI 协议的差异已在此处理：
 *  - system 是顶层参数，不放进 messages。
 *  - assistant/tool 调用链转换为原生 tool_use/tool_result 内容块；孤立历史结果降为 user 数据文本。
 *  - 鉴权用 x-api-key 头，并需 anthropic-version 头。
 *  - max_tokens 为必填。
 */
export class AnthropicClient implements ModelClient {
  public readonly name: string;
  public readonly model: string;
  public readonly location = "remote" as const;
  public readonly toolCallCapability = "native" as const;
  public readonly tokenCounter;
  public readonly contextWindowTokens: number | undefined;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: AnthropicOptions) {
    this.name = options.name;
    this.model = options.model;
    this.tokenCounter = createConservativeTokenCounter(
      remoteTokenizerProfile("anthropic", options.model),
    );
    this.contextWindowTokens = options.contextWindowTokens;
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "2023-06-01";
    this.defaultMaxTokens = options.maxTokens ?? 4096;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.apiVersion,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;

    const { signal, cancel } = withTimeout(Math.min(this.timeoutMs, 8_000));
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: "GET",
        headers: this.headers(),
        signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      cancel();
    }
  }

  async chat(request: ChatRequest): Promise<ModelResponse> {
    const { signal, cancel, didTimeout } = withTimeout(this.timeoutMs, request.signal);
    const start = performance.now();

    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    try {
      if (request.onToken || request.onReasoningToken) {
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            model: this.model,
            max_tokens: request.maxTokens ?? this.defaultMaxTokens,
            ...(system ? { system } : {}),
            messages: toAnthropicMessages(request.messages),
            tools: toAnthropicTools(request.tools),
            temperature: request.temperature,
            stream: true,
          }),
          signal,
        });

        if (!response.ok) {
          const detail = await safeReadText(response);
          throw providerHttpError(
            response.status,
            `Anthropic 请求失败：${response.status} ${detail}`,
            response.headers.get("retry-after"),
          );
        }
        if (!response.body) {
          throw new Error("Anthropic 流式响应无 body");
        }

        let content = "";
        let reasoningContent = "";
        let modelName = this.model;
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        const streamedToolCalls = new Map<number, {
          id?: string;
          name?: string;
          initialInput?: unknown;
          inputJson: string;
        }>();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const consumeSsePart = (part: string) => {
          let eventType = "";
          let dataLine = "";
          for (const line of part.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("event:")) eventType = trimmed.slice(6).trim();
            if (trimmed.startsWith("data:")) dataLine = trimmed.slice(5).trim();
          }
          if (!dataLine) return;
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataLine) as Record<string, unknown>;
          } catch {
            return;
          }
          const type = String(data.type ?? eventType);
          if (type === "message_start") {
            const message = data.message as { model?: string; usage?: { input_tokens?: number } } | undefined;
            if (message?.model) modelName = message.model;
            inputTokens = message?.usage?.input_tokens;
          }
          if (type === "content_block_start") {
            const index = typeof data.index === "number" ? data.index : -1;
            const block = data.content_block as AnthropicContentBlock | undefined;
            if (index >= 0 && block?.type === "tool_use") {
              streamedToolCalls.set(index, {
                id: block.id,
                name: block.name,
                initialInput: block.input,
                inputJson: "",
              });
            }
          }
          if (type === "content_block_delta") {
            const delta = data.delta as {
              type?: string;
              text?: string;
              thinking?: string;
              partial_json?: string;
            } | undefined;
            const text = delta?.type === "text_delta" ? delta.text ?? "" : "";
            if (text) {
              content += text;
              request.onToken?.(text);
            }
            const thinking = delta?.type === "thinking_delta"
              ? delta.thinking ?? ""
              : "";
            if (thinking) {
              reasoningContent += thinking;
              request.onReasoningToken?.(thinking);
            }
            if (delta?.type === "input_json_delta") {
              const index = typeof data.index === "number" ? data.index : -1;
              const call = streamedToolCalls.get(index);
              if (call) call.inputJson += delta.partial_json ?? "";
            }
          }
          if (type === "message_delta") {
            const usage = data.usage as { output_tokens?: number } | undefined;
            if (usage?.output_tokens != null) outputTokens = usage.output_tokens;
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) consumeSsePart(part);
        }
        if (buffer.trim()) consumeSsePart(buffer);

        return {
          content,
          ...(reasoningContent ? { reasoningContent } : {}),
          toolCalls: [...streamedToolCalls.entries()]
            .sort(([left], [right]) => left - right)
            .flatMap(([index, call]) => call.name
              ? [{
                  id: call.id || `stream-tool-${index}-${call.name}`,
                  name: call.name,
                  arguments: call.inputJson
                    ? safeJsonParse(call.inputJson)
                    : call.initialInput ?? {},
                }]
              : []),
          clientName: this.name,
          modelName,
          location: this.location,
          latencyMs: performance.now() - start,
          usage: {
            inputTokens,
            outputTokens,
          },
        };
      }

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens ?? this.defaultMaxTokens,
          ...(system ? { system } : {}),
          messages: toAnthropicMessages(request.messages),
          tools: toAnthropicTools(request.tools),
          temperature: request.temperature,
        }),
        signal,
      });

      if (!response.ok) {
        const detail = await safeReadText(response);
        throw providerHttpError(
          response.status,
          `Anthropic 请求失败：${response.status} ${detail}`,
          response.headers.get("retry-after"),
        );
      }

      const data = (await response.json()) as AnthropicMessagesResponse;
      const latencyMs = performance.now() - start;
      const blocks = data.content ?? [];

      return {
        content: blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(""),
        ...(() => {
          const reasoningContent = blocks
            .filter((block) => block.type === "thinking")
            .map((block) => block.thinking ?? block.text ?? "")
            .join("");
          return reasoningContent ? { reasoningContent } : {};
        })(),
        toolCalls: parseToolCalls(blocks),
        clientName: this.name,
        modelName: data.model ?? this.model,
        location: this.location,
        latencyMs,
        usage: {
          inputTokens: data.usage?.input_tokens,
          outputTokens: data.usage?.output_tokens,
        },
      };
    } catch (error) {
      if (didTimeout()) {
        throw new ProviderRequestError("timeout", `Provider request timed out after ${this.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      cancel();
    }
  }
}

export function toAnthropicMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const completeIds = collectCompleteToolCallIds(messages);
  const result: Array<{
    role: "user" | "assistant";
    content: Array<Record<string, unknown>>;
  }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      if (hasCompleteToolCalls(m, completeIds)) {
        blocks.push(...m.toolCalls!.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments ?? {},
        })));
      }
      appendAnthropicMessage(result, "assistant", blocks);
      continue;
    }
    if (m.role === "tool" && m.toolCallId && completeIds.has(m.toolCallId)) {
      appendAnthropicMessage(result, "user", [{
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      }]);
      continue;
    }
    appendAnthropicMessage(result, "user", [{
      type: "text",
      text: m.role === "tool" ? renderInternalToolMessage(m) : m.content,
    }]);
  }
  return result;
}

function appendAnthropicMessage(
  messages: Array<{
    role: "user" | "assistant";
    content: Array<Record<string, unknown>>;
  }>,
  role: "user" | "assistant",
  blocks: Array<Record<string, unknown>>,
): void {
  if (blocks.length === 0) return;
  const previous = messages.at(-1);
  if (previous?.role === role) {
    previous.content.push(...blocks);
    return;
  }
  messages.push({ role, content: blocks });
}

function toAnthropicTools(tools?: ModelToolSpec[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function parseToolCalls(blocks: AnthropicContentBlock[]): ToolCall[] {
  return blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id ?? "",
      name: b.name ?? "",
      arguments: b.input ?? {},
    }));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
