import path from "node:path";

import {
  ApiEmbeddingProvider,
  EmbeddingService,
  LocalLexicalEmbeddingProvider,
} from "../context/EmbeddingService.js";
import {
  cosineSimilarity,
  LanceDbVectorStore,
  type VectorStore,
} from "../context/VectorStore.js";
import type { SemanticItem } from "../context/types.js";
import type { CompanionStorage } from "./CompanionStorage.js";
import type {
  CompanionMemory,
  CompanionOutputMode,
  CompanionSummary,
} from "./types.js";
import {
  CompanionVectorStatusSchema,
  type CompanionVectorStatus,
} from "./CompanionVectorContracts.js";
import { classifyMemorySensitivity } from "./CompanionMemoryPolicy.js";

export interface CompanionVectorSearchResult {
  memories: CompanionMemory[];
  summaries: CompanionSummary[];
  matches: CompanionVectorSearchMatch[];
  status: CompanionVectorStatus;
}

export interface CompanionVectorSearchMatch {
  item: SemanticItem;
  outputMode: CompanionOutputMode;
  score: number;
}

export class CompanionVectorIndex {
  private readonly embeddings: EmbeddingService;
  private readonly localEmbeddings = new EmbeddingService(new LocalLexicalEmbeddingProvider());
  private readonly vectors: VectorStore;
  private readonly configuredReason: string;

  constructor(private readonly storage: CompanionStorage) {
    const requestedProvider = process.env.COMPANION_EMBEDDING_PROVIDER === "api" ? "api" : "local";
    const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
    const remoteConfigured = requestedProvider === "api" && hasApiKey;
    const provider = remoteConfigured
      ? new ApiEmbeddingProvider({ redactBeforeSend: true })
      : new LocalLexicalEmbeddingProvider();
    this.configuredReason = requestedProvider === "api" && !hasApiKey
      ? "api_requested_but_missing_OPENAI_API_KEY_local_fallback"
      : remoteConfigured
        ? "explicit_api_embedding_provider"
        : "local_lexical_embedding_provider";
    this.embeddings = new EmbeddingService(provider);
    this.vectors = new LanceDbVectorStore(path.join(storage.storageRoot, "lancedb"));
  }

  status(retrievedCount?: number): CompanionVectorStatus {
    const embedding = this.embeddings.status();
    const vectorStore = this.vectors.status();
    const reasons = [this.configuredReason, embedding.reason, vectorStore.reason].filter(Boolean);
    return CompanionVectorStatusSchema.parse({
      enabled: true,
      namespace: `companion:${this.storage.storageRoot}`,
      provider: embedding.provider,
      capability: embedding.capability,
      dimension: embedding.dimension,
      remoteEnabled: embedding.remote,
      backend: vectorStore.backend,
      persistent: vectorStore.persistent,
      degraded: embedding.degraded || vectorStore.degraded,
      requiresRebuild: vectorStore.requiresRebuild,
      itemCount: this.storage.countVectorItems(),
      retrievedCount,
      reason: [...new Set(reasons)].join(";") || undefined,
    });
  }

  async indexMemory(memory: CompanionMemory): Promise<void> {
    if (memory.status !== "confirmed") {
      await this.remove("memory", memory.id);
      return;
    }
    const content = `${memory.summary}\n${memory.value}`.trim();
    const vector = await this.embedCompanionText(content);
    await this.vectors.updateItem({
      id: vectorId("memory", memory.id),
      itemType: "memory",
      scope: "global",
      sourceType: "companion_memory",
      sourceId: memory.id,
      content,
      summary: memory.summary,
      vector,
      tags: ["companion", `companion:${memory.outputMode}`, `memory:${memory.kind}`],
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    });
    this.storage.upsertVectorItem({
      sourceType: "memory",
      sourceId: memory.id,
      outputMode: memory.outputMode,
      content,
      summary: memory.summary,
    });
  }

  async indexSummary(summary: CompanionSummary): Promise<void> {
    const outputMode = summary.topics.includes("mode:unrestricted") ? "unrestricted" : "bounded";
    const vector = await this.embedCompanionText(summary.summary);
    await this.vectors.updateItem({
      id: vectorId("summary", summary.id),
      itemType: "summary",
      scope: "global",
      sourceType: "companion_summary",
      sourceId: summary.id,
      content: summary.summary,
      summary: summary.summary,
      vector,
      tags: ["companion", `companion:${outputMode}`, "summary:conversation"],
      createdAt: summary.createdAt,
      updatedAt: summary.createdAt,
    });
    this.storage.upsertVectorItem({
      sourceType: "summary",
      sourceId: summary.id,
      outputMode,
      content: summary.summary,
      summary: summary.summary,
    });
  }

  async remove(sourceType: "memory" | "summary", sourceId: string): Promise<void> {
    await this.vectors.deleteItem(vectorId(sourceType, sourceId));
    this.storage.deleteVectorItem(sourceType, sourceId);
  }

  async rebuild(): Promise<CompanionVectorStatus> {
    const items: SemanticItem[] = [];
    const metadata: Array<{
      sourceType: "memory" | "summary";
      sourceId: string;
      outputMode: CompanionOutputMode;
      content: string;
      summary: string;
    }> = [];
    for (const memory of this.storage.listMemories({ status: "confirmed", limit: 2_000 })) {
      const content = `${memory.summary}\n${memory.value}`.trim();
      items.push({
        id: vectorId("memory", memory.id),
        itemType: "memory",
        scope: "global",
        sourceType: "companion_memory",
        sourceId: memory.id,
        content,
        summary: memory.summary,
        vector: await this.embedCompanionText(content),
        tags: ["companion", `companion:${memory.outputMode}`, `memory:${memory.kind}`],
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
      });
      metadata.push({
        sourceType: "memory",
        sourceId: memory.id,
        outputMode: memory.outputMode,
        content,
        summary: memory.summary,
      });
    }
    for (const summary of this.storage.listAllSummaries(2_000)) {
      const outputMode = summary.topics.includes("mode:unrestricted") ? "unrestricted" : "bounded";
      items.push({
        id: vectorId("summary", summary.id),
        itemType: "summary",
        scope: "global",
        sourceType: "companion_summary",
        sourceId: summary.id,
        content: summary.summary,
        summary: summary.summary,
        vector: await this.embedCompanionText(summary.summary),
        tags: ["companion", `companion:${outputMode}`, "summary:conversation"],
        createdAt: summary.createdAt,
        updatedAt: summary.createdAt,
      });
      metadata.push({
        sourceType: "summary",
        sourceId: summary.id,
        outputMode,
        content: summary.summary,
        summary: summary.summary,
      });
    }
    await this.vectors.replaceAll(items);
    this.storage.clearVectorItems();
    for (const item of metadata) this.storage.upsertVectorItem(item);
    return this.status();
  }

  async search(input: {
    query: string;
    outputMode: CompanionOutputMode;
    topK?: number;
  }): Promise<CompanionVectorSearchResult> {
    const query = input.query.trim();
    if (!query) return { memories: [], summaries: [], matches: [], status: this.status(0) };
    const topK = Math.min(50, Math.max(1, input.topK ?? 6));
    const vector = await this.embedCompanionText(query);
    const raw = await this.vectors.search(vector, undefined, Math.max(topK, 6) * 4);
    const allowedModes = input.outputMode === "unrestricted"
      ? new Set(["companion:bounded", "companion:unrestricted"])
      : new Set(["companion:bounded"]);
    const ranked = raw
      .filter((item) => item.tags?.includes("companion"))
      .filter((item) => item.tags?.some((tag) => allowedModes.has(tag)))
      .map((item) => ({
        item,
        outputMode: item.tags?.includes("companion:unrestricted")
          ? "unrestricted" as const
          : "bounded" as const,
        score: cosineSimilarity(vector, item.vector),
      }))
      .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id));
    const memories: CompanionMemory[] = [];
    const summaries: CompanionSummary[] = [];
    const matches: CompanionVectorSearchMatch[] = [];
    for (const match of ranked) {
      const { item } = match;
      if (item.itemType === "memory") {
        const memory = this.storage.getMemory(item.sourceId);
        if (memory?.status !== "confirmed") continue;
        if (input.outputMode === "bounded" && memory.outputMode !== "bounded") continue;
        memories.push(memory);
        matches.push({ ...match, outputMode: memory.outputMode });
      } else if (item.itemType === "summary") {
        const summary = this.storage.getSummary(item.sourceId);
        if (!summary) continue;
        const outputMode = summary.topics.includes("mode:unrestricted")
          ? "unrestricted" as const
          : "bounded" as const;
        if (input.outputMode === "bounded" && outputMode !== "bounded") continue;
        summaries.push(summary);
        matches.push({ ...match, outputMode });
      } else continue;
      if (matches.length >= topK) break;
    }
    return { memories, summaries, matches, status: this.status(matches.length) };
  }

  private embedCompanionText(text: string): Promise<number[]> {
    const sensitivity = classifyMemorySensitivity(text);
    if (sensitivity === "high" || sensitivity === "critical") {
      return this.localEmbeddings.embedText(text);
    }
    return this.embeddings.embedText(text);
  }
}

export function companionVectorStatus(storage: CompanionStorage): CompanionVectorStatus {
  return new CompanionVectorIndex(storage).status();
}

function vectorId(sourceType: "memory" | "summary", sourceId: string): string {
  return `companion:${sourceType}:${sourceId}`;
}
