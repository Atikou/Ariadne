import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

import { redactString } from "../util/redact.js";

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
  readonly dimension = EMBEDDING_DIMENSION;
  readonly capability = "lexical_approximation" as const;
  readonly remote = false;

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

/** Deterministic test fixture. Production defaults must not use this provider. */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly dimension = EMBEDDING_DIMENSION;
  readonly capability = "test_mock" as const;
  readonly remote = false;

  status(): EmbeddingProviderStatus {
    return {
      provider: this.name,
      capability: this.capability,
      dimension: this.dimension,
      remote: false,
      degraded: true,
      reason: "test_fixture_not_for_semantic_recall",
    };
  }

  async embedText(text: string): Promise<number[]> {
    return deterministicTestVector(text, this.dimension);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deterministicTestVector(text, this.dimension));
  }
}

/** OpenAI-compatible embedding. Any failure is visible through status and falls back locally. */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "api";
  readonly dimension: number;
  readonly capability = "semantic" as const;
  readonly remote = true;
  private readonly localFallback = new LocalLexicalEmbeddingProvider();
  private lastFallbackReason?: string;

  constructor(
    private readonly opts: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      dimension?: number;
      /** Privacy mode forbids sending text to a remote provider. */
      sensitive?: boolean;
      /** Redact outbound text by default. */
      redactBeforeSend?: boolean;
    } = {},
  ) {
    this.dimension = opts.dimension ?? EMBEDDING_DIMENSION;
  }

  status(): EmbeddingProviderStatus {
    const apiKey = this.opts.apiKey ?? process.env.OPENAI_API_KEY;
    const reason = this.opts.sensitive
      ? "sensitive_content_forced_local"
      : !apiKey
        ? "missing_OPENAI_API_KEY_local_fallback"
        : this.lastFallbackReason;
    return {
      provider: reason ? this.localFallback.name : this.name,
      capability: reason ? this.localFallback.capability : this.capability,
      dimension: this.dimension,
      remote: !reason,
      degraded: Boolean(reason),
      reason,
    };
  }

  async embedText(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector ?? this.localFallback.embedText(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const apiKey = this.opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (this.opts.sensitive) return this.useLocal(texts, "sensitive_content_forced_local");
    if (!apiKey) return this.useLocal(texts, "missing_OPENAI_API_KEY_local_fallback");

    const baseUrl = (this.opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    const model = this.opts.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
    const payloadTexts = this.opts.redactBeforeSend === false ? texts : texts.map((text) => redactString(text));
    try {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, input: payloadTexts, dimensions: this.dimension }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return this.useLocal(texts, `embedding_api_http_${response.status}`);
      const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const vectors = (data.data ?? []).map((item) => item.embedding ?? []);
      const valid = vectors.length === texts.length && vectors.every((vector) => isValidVector(vector, this.dimension));
      if (!valid) return this.useLocal(texts, "embedding_api_dimension_or_count_mismatch");
      this.lastFallbackReason = undefined;
      return vectors;
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      return this.useLocal(texts, `embedding_api_unavailable_${name}`);
    }
  }

  private async useLocal(texts: string[], reason: string): Promise<number[][]> {
    this.lastFallbackReason = reason;
    return this.localFallback.embedBatch(texts);
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
    this.runtimePromise ??= this.loadRuntime().catch((error) => {
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
    if (this.opts.runtimeFactory) return this.opts.runtimeFactory();
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama({
      build: "never",
      skipDownload: true,
      progressLogs: false,
    });
    const model = await llama.loadModel({
      modelPath: this.opts.modelPath,
      gpuLayers: this.opts.gpuLayers ?? "auto",
      useMmap: "auto",
    });
    const context = await model.createEmbeddingContext();
    if (model.embeddingVectorSize !== this.dimension) {
      await context.dispose();
      await model.dispose();
      await llama.dispose();
      throw new Error(
        `embedding_model_dimension_mismatch:expected=${this.dimension}:actual=${model.embeddingVectorSize}`,
      );
    }
    return {
      dimension: model.embeddingVectorSize,
      async embed(text) {
        const embedding = await context.getEmbeddingFor(text);
        return [...embedding.vector];
      },
      async dispose() {
        await context.dispose();
        await model.dispose();
        await llama.dispose();
      },
    };
  }
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

function deterministicTestVector(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const value = text || "__empty__";
  for (let index = 0; index < value.length; index += 1) {
    const hash = fnv1a(`${index}:${value[index]}`);
    vector[hash % dimension] = vector[hash % dimension]! + 1;
  }
  return normalize(vector);
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
