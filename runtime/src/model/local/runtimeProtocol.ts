import type { ChatMessage } from "../types.js";

export interface RuntimeLoadPayload {
  modelId: string;
  modelPath: string;
  contextSize?: number;
  gpuLayers?: "auto" | number;
  device?: "auto" | "cpu" | "cuda" | "vulkan";
}

export interface RuntimeGeneratePayload {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export type RuntimeCommand = "ping" | "load" | "generate" | "unload" | "dispose" | "cancel";

export interface RuntimeRequestMessage {
  id: string;
  command: RuntimeCommand;
  payload?: unknown;
}

export type RuntimeEventMessage =
  | { id: string; type: "token"; delta: string }
  | { id: string; type: "result"; result?: unknown }
  | { id: string; type: "cancelled" }
  | { id: string; type: "error"; error: string };

export interface RuntimeGenerateResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
}
