import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "./DatabaseManager.js";
import { inferFileSnippetTags, matchesTagFilter } from "./contextTags.js";
import type { EmbeddingService } from "./EmbeddingService.js";
import type { VectorStore } from "./VectorStore.js";
import type { MemoryScope, SemanticHit, SemanticItem, SemanticSearchInput } from "./types.js";

export interface SemanticRetrieverOptions {
  defaultLimit?: number;
}

/** LanceDB + FTS 语义检索，与 MemoryRetriever 分工：专注多模态/相似内容召回。 */
export class SemanticRetriever {
  private readonly defaultLimit: number;

  constructor(
    private readonly db: DatabaseManager,
    private readonly embeddings: EmbeddingService,
    private readonly vectors: VectorStore,
    options: SemanticRetrieverOptions = {},
  ) {
    this.defaultLimit = options.defaultLimit ?? 6;
  }

  async search(input: SemanticSearchInput): Promise<SemanticHit[]> {
    const query = input.query.trim();
    if (!query) return [];

    const limit = input.limit ?? this.defaultLimit;
    const hits: SemanticHit[] = [];
    const seen = new Set<string>();

    try {
      const vector = await this.embeddings.embedText(query);
      const filter = input.projectId
        ? {
            scope: "project" as MemoryScope,
            scopeId: input.projectId,
            tags: input.tags,
          }
        : input.sessionId
          ? {
              scope: "session" as MemoryScope,
              scopeId: input.sessionId,
              tags: input.tags,
            }
          : input.tags
            ? { tags: input.tags }
            : undefined;
      const items = await this.vectors.search(vector, filter, limit);
      for (const item of items) {
        if (!matchesTagFilter(item.tags, input.tags)) continue;
        const key = `${item.sourceType}:${item.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ item, score: 0.85, reason: "semantic" });
      }
    } catch {
      // LanceDB 故障时降级为空，不阻断主循环。
    }

    for (const [ftsName, itemType] of [
      ["summaries_fts", "summary"],
      ["messages_fts", "chat"],
    ] as const) {
      const rows = this.db.searchFts(ftsName, query, limit);
      for (const row of rows) {
        const sourceId = String(row.rowid);
        const key = `${itemType}:${sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          item: {
            id: randomUUID(),
            itemType,
            scope: input.sessionId ? "session" : "global",
            scopeId: input.sessionId,
            sourceType: itemType,
            sourceId,
            content: row.content,
            summary: row.content.slice(0, 200),
            vector: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          score: 0.7,
          reason: "semantic",
        });
      }
    }

    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async indexItem(item: Omit<SemanticItem, "id" | "createdAt" | "updatedAt">): Promise<SemanticItem> {
    const vector = item.vector?.length
      ? item.vector
      : await this.embeddings.embedText(item.summary ?? item.content);
    const full: SemanticItem = {
      ...item,
      id: randomUUID(),
      vector,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.vectors.addItem(full);
    return full;
  }

  /** 将代码/文件片段写入向量索引，便于按标签召回。 */
  async indexCodeFragment(input: {
    sourceId: string;
    path: string;
    content: string;
    scope: MemoryScope;
    scopeId?: string;
    tags?: string[];
  }): Promise<SemanticItem> {
    const tags = input.tags ?? inferFileSnippetTags({ path: input.path, tool: "read_file" });
    return this.indexItem({
      itemType: "code",
      scope: input.scope,
      scopeId: input.scopeId,
      sourceType: "file",
      sourceId: input.sourceId,
      content: input.content,
      summary: `${input.path}`,
      vector: [],
      tags,
    });
  }
}
