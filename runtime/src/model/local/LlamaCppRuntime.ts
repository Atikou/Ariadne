import { mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { NodeRuntimeProcess } from "./NodeRuntimeProcess.js";
import type {
  RuntimeCountTokensResult,
  RuntimeGenerateResult,
} from "./runtimeProtocol.js";
import type { LocalModelDescriptor, LocalModelRuntime } from "./types.js";
import type { ChatRequest, ModelResponse } from "../types.js";

const workerUrl = new URL("./workers/llamaCppWorker.js", import.meta.url);
const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));

export interface LlamaCppRuntimeOptions {
  cacheRoot?: string;
}

export function resolveLlamaCppTempDirectory(cacheRoot: string): string {
  return path.resolve(cacheRoot, "llama.cpp", "temp");
}

export class LlamaCppRuntime implements LocalModelRuntime {
  readonly kind = "llama.cpp" as const;
  private readonly process: NodeRuntimeProcess;
  private loadedModelId?: string;

  constructor(options: LlamaCppRuntimeOptions = {}) {
    const tempRoot = resolveLlamaCppTempDirectory(
      options.cacheRoot ?? path.join(packageRoot, ".runtime", "model-cache"),
    );
    mkdirSync(tempRoot, { recursive: true });
    this.process = new NodeRuntimeProcess(workerUrl, {
      ARIADNE_MODEL_TEMP_ROOT: tempRoot,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.process.call("ping", undefined, { timeoutMs: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  async load(model: LocalModelDescriptor): Promise<void> {
    if (this.loadedModelId === model.id) return;
    await this.process.call(
      "load",
      {
        modelId: model.id,
        modelPath: model.modelPath,
        contextSize: model.contextSize,
        gpuLayers: model.gpuLayers,
        device: model.device,
      },
      { timeoutMs: Math.max(model.timeoutMs ?? 0, 10 * 60_000) },
    );
    this.loadedModelId = model.id;
  }

  async generate(model: LocalModelDescriptor, request: ChatRequest): Promise<ModelResponse> {
    await this.load(model);
    const start = performance.now();
    let result: RuntimeGenerateResult;
    try {
      result = await this.process.call<RuntimeGenerateResult>(
        "generate",
        {
          messages: request.messages,
          temperature: request.temperature,
          maxTokens: request.maxTokens ?? model.maxTokens ?? 1_024,
        },
        {
          timeoutMs: model.timeoutMs ?? 5 * 60_000,
          firstTokenTimeoutMs: model.firstTokenTimeoutMs ?? 45_000,
          tokenIdleTimeoutMs: model.tokenIdleTimeoutMs ?? 60_000,
          cancelGraceMs: 1_000,
          signal: request.signal,
          onToken: request.onToken,
        },
      );
    } catch (error) {
      if (!this.process.isRunning()) this.loadedModelId = undefined;
      throw error;
    }
    return {
      content: result.content,
      toolCalls: [],
      clientName: model.id,
      modelName: model.displayName,
      location: "local",
      latencyMs: performance.now() - start,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    };
  }

  async countTokens(
    model: LocalModelDescriptor,
    request: Pick<ChatRequest, "messages" | "tools">,
  ) {
    await this.load(model);
    const result = await this.process.call<RuntimeCountTokensResult>(
      "count_tokens",
      request,
      { timeoutMs: Math.max(model.timeoutMs ?? 0, 60_000) },
    );
    return {
      tokens: result.tokens,
      exact: true,
      method: "model_tokenizer" as const,
      tokenizer: result.tokenizer,
    };
  }

  async unload(modelId?: string): Promise<void> {
    if (modelId && this.loadedModelId !== modelId) return;
    await this.process.call("unload", undefined, { timeoutMs: 60_000 });
    this.loadedModelId = undefined;
  }

  async dispose(): Promise<void> {
    this.loadedModelId = undefined;
    await this.process.dispose();
  }
}
