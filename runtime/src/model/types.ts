/**
 * 模型层公共类型。
 *
 * 这一层只关心「如何和一个模型对话」，不关心路由、任务、工具执行。
 * 路由（自主选择）会在后续基于 ModelClient 列表实现。
 */

import type { ModelInferenceOptions } from "@ariadne/protocol/public";
import type { ContentEnvelope } from "../core/ContentEnvelope.js";
import type { TokenCounter } from "./TokenCounter.js";

export type ModelLocation = "local" | "remote";
export type ModelToolCallCapability = "native" | "unsupported";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** 工具消息或具名消息使用。 */
  name?: string;
  /** role 为 "tool" 时，对应触发该结果的 tool call id。 */
  toolCallId?: string;
  /** role 为 "assistant" 时，模型在该轮发起的结构化工具调用。 */
  toolCalls?: ToolCall[];
  /** Provider 返回的独立推理内容；不得拼接到普通对话正文。 */
  reasoningContent?: string;
  /** 数据来源与外发权限；远程 Provider 前由统一 egress gate 强制执行。 */
  contentEnvelope?: ContentEnvelope;
}

/**
 * 发送给模型的工具规格（JSON Schema 描述参数）。
 * 注意：这只是「告诉模型有哪些工具」，真正可执行的工具定义属于 tools 模块。
 */
export interface ModelToolSpec {
  name: string;
  description: string;
  /** JSON Schema 对象。 */
  parameters: Record<string, unknown>;
}

/** 模型返回的一次工具调用请求。 */
export interface ToolCall {
  id: string;
  name: string;
  /** 已尽量解析为对象；解析失败时为原始字符串。 */
  arguments: unknown;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ModelToolSpec[];
  temperature?: number;
  maxTokens?: number;
  inference?: ModelInferenceOptions;
  signal?: AbortSignal;
  /** 流式输出时每收到一段最终回答文本回调。 */
  onToken?: (delta: string) => void;
  /** 流式输出时每收到一段 Provider 明确返回的推理文本或推理摘要回调。 */
  onReasoningToken?: (delta: string) => void;
}

export interface ModelResponse {
  content: string;
  /** Provider 明确返回的独立推理内容；不得自动拼接到后续普通对话上下文。 */
  reasoningContent?: string;
  toolCalls: ToolCall[];
  /** The selected client's declared structured tool-call capability. */
  toolCallCapability?: ModelToolCallCapability;
  /** 实际响应的客户端名（用于路由追踪）。 */
  clientName: string;
  /** 实际使用的模型名。 */
  modelName: string;
  location: ModelLocation;
  latencyMs: number;
  usage?: TokenUsage;
  /** 本次调用估算费用，单位 USD；无计价配置时为空。 */
  costUsd?: number;
}

/**
 * 统一模型客户端接口。
 * 内嵌本地运行时与远程 API transport 都实现它，
 * 从而对上层屏蔽不同厂商的请求、响应、错误格式差异。
 */
export interface ModelClient {
  readonly name: string;
  readonly location: ModelLocation;
  readonly model: string;
  readonly toolCallCapability: ModelToolCallCapability;
  readonly tokenCounter: TokenCounter;
  readonly contextWindowTokens?: number;

  /** 探测该模型当前是否可用（用于启动检查与路由降级）。 */
  isAvailable(): Promise<boolean>;

  chat(request: ChatRequest): Promise<ModelResponse>;
}
