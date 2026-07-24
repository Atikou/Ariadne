import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { PythonRuntimeProcess } from "./PythonRuntimeProcess.js";
import type {
  RuntimeCountTokensResult,
  RuntimeGenerateResult,
} from "./runtimeProtocol.js";
import type { LocalModelDescriptor, LocalModelRuntime } from "./types.js";
import type { ChatRequest, ModelResponse } from "../types.js";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workerPath = path.join(packageRoot, "scripts", "model-runtime", "transformers_worker.py");

export interface TransformersRuntimeOptions {
  runtimeRoot?: string;
  cacheRoot?: string;
}

export function createTransformersRuntimeEnvironment(
  cacheRoot: string,
): NodeJS.ProcessEnv {
  const resolvedCacheRoot = path.resolve(cacheRoot, "transformers");
  const tempRoot = path.join(resolvedCacheRoot, "temp");
  const huggingFaceRoot = path.join(resolvedCacheRoot, "huggingface");
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(huggingFaceRoot, { recursive: true });
  return {
    HF_HOME: huggingFaceRoot,
    HF_HUB_CACHE: path.join(huggingFaceRoot, "hub"),
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    TORCH_HOME: path.join(resolvedCacheRoot, "torch"),
    XDG_CACHE_HOME: resolvedCacheRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
}

export class TransformersRuntime implements LocalModelRuntime {
  readonly kind = "transformers" as const;
  private readonly pythonPath: string;
  private readonly process: PythonRuntimeProcess;
  private loadedModelId?: string;

  constructor(options: TransformersRuntimeOptions = {}) {
    const runtimeRoot =
      options.runtimeRoot ?? path.join(packageRoot, ".runtime", "transformers");
    const environment = createTransformersRuntimeEnvironment(
      options.cacheRoot ?? path.join(packageRoot, ".runtime", "model-cache"),
    );
    const windowsPython = path.join(runtimeRoot, "Scripts", "python.exe");
    const unixPython = path.join(runtimeRoot, "bin", "python");
    this.pythonPath = existsSync(windowsPython) ? windowsPython : unixPython;
    this.process = new PythonRuntimeProcess(
      this.pythonPath,
      workerPath,
      environment,
    );
  }

  async isAvailable(): Promise<boolean> {
    if (!PythonRuntimeProcess.canStart(this.pythonPath, workerPath)) return false;
    try {
      await this.process.call("ping", undefined, { timeoutMs: 60_000 });
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
        device: model.device,
      },
      { timeoutMs: Math.max(model.timeoutMs ?? 0, 15 * 60_000) },
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
