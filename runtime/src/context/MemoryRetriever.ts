import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "./DatabaseManager.js";
import { filterTrustedMemories, isUntrustedCompletionMemoryText } from "./contextTrust.js";
import { inferMemoryTags, inferSummaryTags, matchesTagFilter } from "./contextTags.js";
import type { EmbeddingService } from "./EmbeddingService.js";
import type { MemoryManager } from "./MemoryManager.js";
import type { MemoryStore } from "./stores.js";
import type { VectorStore } from "./VectorStore.js";
import type {
  MemoryRecord,
  MemoryRetrieveInput,
  MemoryRetrieveReason,
  MemoryScope,
  MemoryType,
  MemoryTrustLevel,
  RetrievedMemory,
  SearchHit,
  SemanticItem,
  StructuredSummary,
  SummaryType,
} from "./types.js";

export interface MemoryRetrieverOptions {
  topK?: number;
}

/** 多路记忆检索：固定注入 + FTS + 语义，按评分公式合并去重。 */
export class MemoryRetriever {
  private readonly topK: number;

  constructor(
    _db: DatabaseManager,
    private readonly memories: MemoryStore,
    private readonly memoryManager: MemoryManager,
    private readonly embeddings: EmbeddingService,
    private readonly vectors: VectorStore,
    options: MemoryRetrieverOptions = {},
  ) {
    this.topK = options.topK ?? 8;
  }

  async retrieve(input: MemoryRetrieveInput): Promise<RetrievedMemory[]> {
    const limit = input.limit ?? this.topK;
    const merged = new Map<string, RetrievedMemory>();

    const add = (memory: MemoryRecord, relevance: number, reason: MemoryRetrieveReason) => {
      const score = computeScore(memory, relevance);
      const trust = inferMemoryTrust(memory);
      const existing = merged.get(memory.id);
      if (!existing || score > existing.score) {
        merged.set(memory.id, {
          memory,
          score,
          reason,
          trustLevel: trust.trustLevel,
          sourceKind: trust.sourceKind,
        });
      } else if (existing && score > 0) {
        existing.score = Math.max(existing.score, score);
      }
    };

    for (const m of this.memoryManager.listGlobalPreferences(10)) {
      add(m, 1, "fixed_preference");
    }

    if (input.projectId) {
      for (const m of this.memoryManager.listProjectMemories(input.projectId, 8)) {
        add(m, 0.95, "project_context");
      }
    }

    if (input.taskId) {
      const taskMem = this.memories.listActive("task", input.taskId, 5);
      for (const m of taskMem) {
        add(m, 0.9, "task_context");
      }
    }

    const query = input.userInput.trim();
    if (query) {
      for (const memory of this.memories.searchActive(query, limit)) {
        add(memory, 0.75, "fts");
      }

      try {
        const vector = await this.embeddings.embedText(query);
        const filter = input.projectId
          ? { scope: "project" as MemoryScope, scopeId: input.projectId, tags: input.tags }
          : { scope: "session" as MemoryScope, scopeId: input.sessionId, tags: input.tags };
        const items = await this.vectors.search(vector, filter, limit);
        for (const item of items) {
          if (!matchesTagFilter(item.tags, input.tags)) continue;
          if (item.itemType !== "memory") continue;
          const memory = this.memories.get(item.sourceId);
          if (!memory?.isActive) continue;
          add(memory, 0.85, "semantic");
        }
      } catch {
        // LanceDB 故障降级。
      }
    }

    const recent = this.memories.listActive("session", input.sessionId, 5);
    for (const m of recent) {
      if (m.importance >= 0.7) {
        add(m, 0.6, "recent");
      }
    }

    const results = filterTrustedMemories([...merged.values()])
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (!input.tags?.length) return results;
    return results.filter((r) => matchesTagFilter(inferMemoryTags(r.memory), input.tags));
  }

  /** 兼容旧 search API。 */
  async search(
    query: string,
    scope?: MemoryScope,
    scopeId?: string,
    tags?: string[],
  ): Promise<SearchHit[]> {
    const retrieved = await this.retrieve({
      userInput: query,
      sessionId: scopeId ?? "global",
      projectId: scope === "project" ? scopeId : undefined,
      taskId: scope === "task" ? scopeId : undefined,
      limit: this.topK,
      tags,
    });
    return retrieved.map((r) => ({
      source: r.reason === "semantic" ? "vector" : "fts",
      itemType: "memory",
      sourceId: r.memory.id,
      content: r.memory.summary ?? r.memory.value,
      score: r.score,
      tags: inferMemoryTags(r.memory),
    }));
  }

  async indexSummary(
    sourceId: string,
    content: string,
    scope: MemoryScope,
    scopeId?: string,
    summary?: string,
    summaryType: SummaryType = "chunk_summary",
    structured?: StructuredSummary,
  ): Promise<SemanticItem> {
    const vector = await this.embeddings.embedText(summary ?? content);
    const item: SemanticItem = {
      id: randomUUID(),
      itemType: "summary",
      scope,
      scopeId,
      sourceType: "summary",
      sourceId,
      content,
      summary,
      vector,
      tags: inferSummaryTags(summaryType, structured),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.vectors.addItem(item);
    return item;
  }

  async indexMemory(
    memoryId: string,
    value: string,
    scope: MemoryScope,
    scopeId?: string,
    summary?: string,
    memoryType: MemoryType = "fact",
  ): Promise<SemanticItem> {
    const vector = await this.embeddings.embedText(summary ?? value);
    const item: SemanticItem = {
      id: randomUUID(),
      itemType: "memory",
      scope,
      scopeId,
      sourceType: "memory",
      sourceId: memoryId,
      content: value,
      summary,
      vector,
      tags: inferMemoryTags({ memoryType, scope }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.vectors.addItem(item);
    return item;
  }
}

function computeScore(memory: MemoryRecord, relevance: number): number {
  const importance = memory.importance;
  const confidence = memory.confidence;
  const recency = recencyScore(memory.updatedAt);
  return relevance * 0.45 + importance * 0.25 + confidence * 0.2 + recency * 0.1;
}

function recencyScore(iso: string): number {
  const ageMs = Date.now() - new Date(iso).getTime();
  const days = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - days / 30);
}

function inferMemoryTrust(memory: MemoryRecord): {
  trustLevel: MemoryTrustLevel;
  sourceKind: string;
} {
  if (memory.source === "tool_ledger") {
    return { trustLevel: "verified", sourceKind: "tool_ledger" };
  }
  const text = `${memory.value}\n${memory.summary ?? ""}`;
  if (isUntrustedCompletionMemoryText(text)) {
    return { trustLevel: "unverified", sourceKind: memory.memoryType };
  }
  if (memory.confidence >= 0.8 && memory.importance >= 0.7) {
    return { trustLevel: "inferred", sourceKind: memory.memoryType };
  }
  return { trustLevel: "inferred", sourceKind: memory.memoryType };
}
