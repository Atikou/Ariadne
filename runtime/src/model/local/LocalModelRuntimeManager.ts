import type { EmbeddedModelRuntime } from "../../config/types.js";
import { LlamaCppRuntime } from "./LlamaCppRuntime.js";
import { TransformersRuntime } from "./TransformersRuntime.js";
import type {
  LocalModelDescriptor,
  LocalModelRuntime,
  LocalModelRuntimeManagerOptions,
} from "./types.js";
import type { ChatRequest, ModelResponse } from "../types.js";
import type { TokenCount } from "../TokenCounter.js";
import { createModelAbortError, throwIfModelAborted } from "../modelCancellation.js";

interface QueueItem<T> {
  operation: () => Promise<T>;
  signal?: AbortSignal;
  resolve(value: T): void;
  reject(error: unknown): void;
  removeAbort?: () => void;
}

interface LoadedRuntime {
  runtime: LocalModelRuntime;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
}

/** Owns lazy loading and LRU eviction. Calls are serialized to avoid RAM/VRAM spikes. */
export class LocalModelRuntimeManager {
  private readonly loaded = new Map<string, LoadedRuntime>();
  private readonly availability = new Map<EmbeddedModelRuntime, { value: boolean; checkedAt: number }>();
  private readonly queue: Array<QueueItem<unknown>> = [];
  private queueRunning = false;
  private disposed = false;

  constructor(private readonly options: LocalModelRuntimeManagerOptions) {}

  async isAvailable(kind: EmbeddedModelRuntime): Promise<boolean> {
    const cached = this.availability.get(kind);
    if (cached && Date.now() - cached.checkedAt < 30_000) return cached.value;
    const runtime = this.createRuntime(kind);
    const value = await runtime.isAvailable();
    await runtime.dispose();
    this.availability.set(kind, { value, checkedAt: Date.now() });
    return value;
  }

  async generate(model: LocalModelDescriptor, request: ChatRequest): Promise<ModelResponse> {
    return this.runExclusive(async () => {
      throwIfModelAborted(request.signal);
      if (this.disposed) throw new Error("本地模型管理器已关闭");
      const entry = await this.ensureLoaded(model);
      throwIfModelAborted(request.signal);
      this.touch(model.id, entry);
      try {
        return await entry.runtime.generate(model, request);
      } finally {
        this.touch(model.id, entry);
      }
    }, request.signal);
  }

  async unload(modelId: string): Promise<void> {
    await this.runExclusive(() => this.unloadInternal(modelId));
  }

  async dispose(): Promise<void> {
    await this.runExclusive(async () => {
      this.disposed = true;
      const entries = [...this.loaded.values()];
      this.loaded.clear();
      await Promise.all(entries.map(async (entry) => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        await entry.runtime.dispose();
      }));
    });
  }

  status(): Array<{ modelId: string; runtime: EmbeddedModelRuntime; lastUsedAt: string }> {
    return [...this.loaded.entries()].map(([modelId, entry]) => ({
      modelId,
      runtime: entry.runtime.kind,
      lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
    }));
  }

  private async ensureLoaded(model: LocalModelDescriptor): Promise<LoadedRuntime> {
    const current = this.loaded.get(model.id);
    if (current) return current;
    while (this.loaded.size >= this.options.maxLoadedModels) {
      const oldest = [...this.loaded.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (!oldest) break;
      await this.unloadInternal(oldest[0]);
    }
    const runtime = this.createRuntime(model.runtime);
    try {
      await runtime.load(model);
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
    const entry: LoadedRuntime = { runtime, lastUsedAt: Date.now() };
    this.loaded.set(model.id, entry);
    return entry;
  }

  private touch(modelId: string, entry: LoadedRuntime): void {
    entry.lastUsedAt = Date.now();
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.unload(modelId).catch((error) => {
        console.warn(`[local-model] 空闲卸载失败 ${modelId}: ${String(error)}`);
      });
    }, this.options.idleUnloadMs);
    entry.idleTimer.unref?.();
  }

  private async unloadInternal(modelId: string): Promise<void> {
    const entry = this.loaded.get(modelId);
    if (!entry) return;
    this.loaded.delete(modelId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await entry.runtime.dispose();
  }

  private createRuntime(kind: EmbeddedModelRuntime): LocalModelRuntime {
    if (this.options.runtimeFactory) return this.options.runtimeFactory(kind);
    return kind === "llama.cpp"
      ? new LlamaCppRuntime({ cacheRoot: this.options.runtimeCacheDirectory })
      : new TransformersRuntime({
          runtimeRoot: this.options.transformersRuntimeDirectory,
          cacheRoot: this.options.runtimeCacheDirectory,
        });
  }

  async countTokens(
    model: LocalModelDescriptor,
    request: Pick<ChatRequest, "messages" | "tools">,
  ): Promise<TokenCount> {
    return this.runExclusive(async () => {
      if (this.disposed) throw new Error("本地模型管理器已关闭");
      const entry = await this.ensureLoaded(model);
      this.touch(model.id, entry);
      return entry.runtime.countTokens(model, request);
    });
  }

  private runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(createModelAbortError(signal.reason));
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = { operation, signal, resolve, reject };
      if (signal) {
        const abort = (): void => {
          const index = this.queue.indexOf(item as QueueItem<unknown>);
          if (index < 0) return;
          this.queue.splice(index, 1);
          item.removeAbort?.();
          reject(createModelAbortError(signal.reason));
        };
        signal.addEventListener("abort", abort, { once: true });
        item.removeAbort = () => signal.removeEventListener("abort", abort);
      }
      this.queue.push(item as QueueItem<unknown>);
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.queueRunning) return;
    const item = this.queue.shift();
    if (!item) return;
    item.removeAbort?.();
    if (item.signal?.aborted) {
      item.reject(createModelAbortError(item.signal.reason));
      this.drainQueue();
      return;
    }
    this.queueRunning = true;
    void item.operation().then(item.resolve, item.reject).finally(() => {
      this.queueRunning = false;
      this.drainQueue();
    });
  }
}
