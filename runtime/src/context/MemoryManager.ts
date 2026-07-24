import type { MemoryStore } from "./stores.js";
import type { MemoryCandidate, MemoryRecord, MemoryScope, MemoryType } from "./types.js";

export interface MemoryFilter {
  scope?: MemoryScope;
  scopeId?: string;
  memoryType?: MemoryType;
  activeOnly?: boolean;
  limit?: number;
}

/** 长期记忆的写入、停用与查询。 */
export class MemoryManager {
  constructor(private readonly memories: MemoryStore) {}

  upsert(candidate: MemoryCandidate): MemoryRecord {
    return this.memories.upsert({
      scope: candidate.scope,
      scopeId: candidate.scopeId,
      memoryType: candidate.memoryType,
      key: candidate.key,
      value: candidate.value,
      summary: candidate.summary,
      importance: candidate.importance,
      confidence: candidate.confidence,
      source: candidate.source,
      sourceId: candidate.sourceId,
    });
  }

  deactivate(memoryId: string, _reason: string): void {
    this.memories.deactivate(memoryId);
  }

  getActiveMemories(filter: MemoryFilter = {}): MemoryRecord[] {
    if (!filter.scope) {
      return this.memories.listActive("global", undefined, filter.limit ?? 20);
    }
    return this.memories.listActive(filter.scope, filter.scopeId, filter.limit ?? 20);
  }

  listGlobalPreferences(limit = 10): MemoryRecord[] {
    return this.memories.listByType("global", undefined, "preference", limit);
  }

  listProjectMemories(projectId: string, limit = 10): MemoryRecord[] {
    return this.memories.listActive("project", projectId, limit);
  }
}
