import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

export type EmbeddingCapability = "semantic" | "lexical_approximation" | "test_mock";

export interface EmbeddingProviderStatus {
  provider: string;
  capability: EmbeddingCapability;
  dimension: number;
  remote: boolean;
  degraded: boolean;
  reason?: string;
}

/** Every provider must honor one vector dimension so persisted indexes cannot silently truncate data. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  readonly capability: EmbeddingCapability;
  readonly remote: boolean;
  status(): EmbeddingProviderStatus;
  embedText(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

interface GgufEmbeddingRuntime {
  readonly dimension: number;
  embed(text: string): Promise<number[]>;
  dispose(): Promise<void>;
}

/** Shared index dimension. Remote v3 embedding requests explicitly ask for this dimension. */
export const EMBEDDING_DIMENSION = 256;

/**
 * Local, dependency-free lexical feature hashing.
 *
 * This is deliberately named lexical approximation: it provides useful word/character overlap
 * recall in offline mode, but it is not presented as a neural semantic model.
 */
export class LocalLexicalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local_lexical";
  readonly capability = "lexical_approximation" as const;
  readonly remote = false;

  constructor(readonly dimension = EMBEDDING_DIMENSION) {
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 65_536) throw new Error('embedding_dimension_invalid');
  }

  status(): EmbeddingProviderStatus {
    return {
      provider: this.name,
      capability: this.capability,
      dimension: this.dimension,
      remote: false,
      degraded: true,
      reason: "offline_lexical_approximation_not_neural_semantic_embedding",
    };
  }

  async embedText(text: string): Promise<number[]> {
    return lexicalVector(text, this.dimension);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => lexicalVector(text, this.dimension));
  }
}

export class LocalGgufEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  readonly capability = "semantic" as const;
  readonly remote = false;
  private runtimePromise?: Promise<GgufEmbeddingRuntime>;
  private failureReason?: string;

  constructor(private readonly opts: {
    modelId: string;
    modelPath: string;
    sha256: string;
    dimension: number;
    gpuLayers?: "auto" | number;
    runtimeFactory?: () => Promise<GgufEmbeddingRuntime>;
  }) {
    if (!path.isAbsolute(opts.modelPath)) throw new Error("embedding_model_path_must_be_absolute");
    if (!/^[a-f0-9]{64}$/u.test(opts.sha256)) throw new Error("embedding_model_sha256_invalid");
    this.name = `local_gguf:${opts.modelId}`;
    this.dimension = opts.dimension;
  }

  status(): EmbeddingProviderStatus {
    return {
      provider: this.name,
      capability: this.capability,
      dimension: this.dimension,
      remote: false,
      degraded: Boolean(this.failureReason),
      ...(this.failureReason ? { reason: this.failureReason } : {}),
    };
  }

  async embedText(text: string): Promise<number[]> {
    const runtime = await this.runtime();
    const vector = await runtime.embed(text);
    if (!isValidVector(vector, this.dimension)) {
      throw new Error(
        `embedding_dimension_contract_violation:expected=${this.dimension}:actual=${vector.length}`,
      );
    }
    return normalize(vector);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) results.push(await this.embedText(text));
    return results;
  }

  async dispose(): Promise<void> {
    const runtime = await this.runtimePromise?.catch(() => undefined);
    await runtime?.dispose();
    this.runtimePromise = undefined;
  }

  private runtime(): Promise<GgufEmbeddingRuntime> {
    this.runtimePromise ??= this.loadRuntime().then(runtime => {
      this.failureReason = undefined; return runtime;
    }).catch((error) => {
      this.failureReason = publicEmbeddingError(error);
      this.runtimePromise = undefined;
      throw error;
    });
    return this.runtimePromise;
  }

  private async loadRuntime(): Promise<GgufEmbeddingRuntime> {
    const actualHash = await sha256File(this.opts.modelPath);
    if (actualHash !== this.opts.sha256) {
      throw new Error("embedding_model_integrity_mismatch");
    }
    if (this.opts.runtimeFactory) {
      const runtime = await this.opts.runtimeFactory();
      if (runtime.dimension !== this.dimension) { await runtime.dispose(); throw new Error('embedding_runtime_dimension_mismatch'); }
      return runtime;
    }
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama({
      build: "never",
      skipDownload: true,
      progressLogs: false,
    });
    const resources: (() => Promise<void>)[] = [() => llama.dispose()];
    try {
    const model = await llama.loadModel({
      modelPath: this.opts.modelPath,
      gpuLayers: this.opts.gpuLayers ?? "auto",
      useMmap: "auto",
    });
    resources.unshift(() => model.dispose());
    if (model.embeddingVectorSize !== this.dimension) {
      throw new Error(
        `embedding_model_dimension_mismatch:expected=${this.dimension}:actual=${model.embeddingVectorSize}`,
      );
    }
    const contextSize = Math.min(2_048, model.trainContextSize);
    if (!Number.isInteger(contextSize) || contextSize < 8) throw new Error('embedding_model_context_size_invalid');
    const context = await model.createEmbeddingContext({ contextSize });
    resources.unshift(() => context.dispose());
    return {
      dimension: model.embeddingVectorSize,
      async embed(text) {
        const tokens = model.tokenize(text, false);
        const sum = new Array<number>(model.embeddingVectorSize).fill(0);
        // Reserve beginning/end tokens; retain every token rather than truncating a long memory.
        for (let offset = 0; offset < tokens.length; offset += contextSize - 4) {
          const part = tokens.slice(offset, offset + contextSize - 4); const embedding = await context.getEmbeddingFor(part);
          if (!isValidVector([...embedding.vector], sum.length)) throw new Error('embedding_dimension_contract_violation');
          for (let index = 0; index < sum.length; index++) sum[index]! += embedding.vector[index]! * part.length;
        }
        return normalize(sum);
      },
      async dispose() {
        await disposeEmbeddingResources(resources);
      },
    };
    } catch (error) {
      try { await disposeEmbeddingResources(resources); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'embedding_initialization_cleanup_failed'); }
      throw error;
    }
  }
}

async function disposeEmbeddingResources(resources: readonly (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const dispose of resources) try { await dispose(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'embedding_dispose_failed');
}

export class EmbeddingService {
  constructor(private readonly provider: EmbeddingProvider = new LocalLexicalEmbeddingProvider()) {}

  get providerName(): string {
    return this.provider.status().provider;
  }

  get dimension(): number {
    return this.provider.dimension;
  }

  status(): EmbeddingProviderStatus {
    return this.provider.status();
  }

  embedText(text: string): Promise<number[]> {
    return this.provider.embedText(text);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return this.provider.embedBatch(texts);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function publicEmbeddingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z]:\\[^\s]+/gu, "<path>").slice(0, 160);
}

function lexicalVector(input: string, dimension: number): number[] {
  const normalized = input.normalize("NFKC").toLocaleLowerCase().trim();
  const features = extractLexicalFeatures(normalized);
  const vector = new Array<number>(dimension).fill(0);
  for (const feature of features) {
    const hash = fnv1a(feature);
    const index = hash % dimension;
    const sign = (fnv1a(`sign:${feature}`) & 1) === 0 ? 1 : -1;
    vector[index] = vector[index]! + sign;
  }
  return normalize(vector);
}

function extractLexicalFeatures(text: string): string[] {
  if (!text) return [];
  const features: string[] = [];
  const words = text.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  for (const word of words) {
    features.push(`w:${word}`);
    if (word.length <= 2) continue;
    const chars = [...word];
    for (let index = 0; index < chars.length - 1; index += 1) {
      features.push(`c2:${chars[index]}${chars[index + 1]}`);
    }
    for (let index = 0; index < chars.length - 2; index += 1) {
      features.push(`c3:${chars[index]}${chars[index + 1]}${chars[index + 2]}`);
    }
  }
  for (let index = 0; index < words.length - 1; index += 1) {
    features.push(`w2:${words[index]}:${words[index + 1]}`);
  }
  return features;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function isValidVector(vector: number[], dimension: number): boolean {
  return vector.length === dimension && vector.every((value) => Number.isFinite(value));
}
