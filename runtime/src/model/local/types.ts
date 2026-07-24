import type {
  EmbeddedModelClientConfig,
  EmbeddedModelRuntime,
  ModelRouterProfileConfig,
} from "../../config/types.js";
import type { ChatRequest, ModelResponse } from "../types.js";
import type { TokenCount } from "../TokenCounter.js";

export type LocalModelFormat = "gguf" | "safetensors";
export type LocalModelCatalogStatus = "ready" | "unsupported" | "incomplete" | "invalid";

export interface LocalModelDescriptor {
  id: string;
  displayName: string;
  format: LocalModelFormat;
  runtime: EmbeddedModelRuntime;
  /** GGUF 文件或 Transformers 模型目录。 */
  modelPath: string;
  sourcePath: string;
  sizeBytes: number;
  modifiedAt: string;
  status: LocalModelCatalogStatus;
  error?: string;
  contextSize?: number;
  gpuLayers?: "auto" | number;
  device?: "auto" | "cpu" | "cuda" | "vulkan";
  timeoutMs?: number;
  maxTokens?: number;
  firstTokenTimeoutMs?: number;
  tokenIdleTimeoutMs?: number;
  routerProfile?: ModelRouterProfileConfig;
}

export interface LocalModelCatalogSnapshot {
  directory: string;
  scannedAt: string;
  models: LocalModelDescriptor[];
  errors: string[];
}

export interface LocalModelRuntime {
  readonly kind: EmbeddedModelRuntime;
  isAvailable(): Promise<boolean>;
  load(model: LocalModelDescriptor): Promise<void>;
  countTokens(model: LocalModelDescriptor, request: Pick<ChatRequest, "messages" | "tools">): Promise<TokenCount>;
  generate(model: LocalModelDescriptor, request: ChatRequest): Promise<ModelResponse>;
  unload(modelId?: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface LocalModelRuntimeManagerOptions {
  maxLoadedModels: number;
  idleUnloadMs: number;
  transformersRuntimeDirectory?: string;
  runtimeCacheDirectory?: string;
  /** Test/embedding seam; production uses the built-in runtime adapters. */
  runtimeFactory?: (kind: EmbeddedModelRuntime) => LocalModelRuntime;
}

export function descriptorToClientConfig(
  descriptor: LocalModelDescriptor,
): EmbeddedModelClientConfig {
  return {
    kind: "embedded",
    name: descriptor.id,
    runtime: descriptor.runtime,
    location: "local",
    model: descriptor.displayName,
    modelPath: descriptor.modelPath,
    contextSize: descriptor.contextSize,
    gpuLayers: descriptor.gpuLayers,
    device: descriptor.device,
    timeoutMs: descriptor.timeoutMs,
    maxTokens: descriptor.maxTokens,
    firstTokenTimeoutMs: descriptor.firstTokenTimeoutMs,
    tokenIdleTimeoutMs: descriptor.tokenIdleTimeoutMs,
    routerProfile: descriptor.routerProfile,
  };
}

export function clientConfigToDescriptor(
  config: EmbeddedModelClientConfig,
): LocalModelDescriptor {
  return {
    id: config.name,
    displayName: config.model,
    format: config.runtime === "llama.cpp" ? "gguf" : "safetensors",
    runtime: config.runtime,
    modelPath: config.modelPath,
    sourcePath: config.modelPath,
    sizeBytes: 0,
    modifiedAt: new Date(0).toISOString(),
    status: "ready",
    contextSize: config.contextSize,
    gpuLayers: config.gpuLayers,
    device: config.device,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    firstTokenTimeoutMs: config.firstTokenTimeoutMs,
    tokenIdleTimeoutMs: config.tokenIdleTimeoutMs,
    routerProfile: config.routerProfile,
  };
}
