import type { MemoryStore } from "./stores.js";
import type {
  MemoryCandidate,
  MemoryLifecycleState,
  MemoryRecord,
  MemoryScope,
  MemoryType,
} from "./types.js";

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

  upsert(candidate: MemoryCandidate, lifecycleState: "candidate" | "active"): MemoryRecord {
    return this.memories.upsert({
      scope: candidate.scope,
      scopeId: candidate.scopeId,
      memoryType: candidate.memoryType,
      key: candidate.key,
      value: candidate.value,
      summary: candidate.summary,
      importance: candidate.importance,
      confidence: candidate.confidence,
      lifecycleState,
      provenance: candidate.provenance,
      sensitivity: candidate.sensitivity,
      retentionUntil: candidate.retentionUntil,
    });
  }

  transition(memoryId: string, next: MemoryLifecycleState): MemoryRecord {
    return this.memories.transition(memoryId, next);
  }

  delete(memoryId: string): boolean {
    return this.memories.delete(memoryId);
  }

  get(memoryId: string): MemoryRecord | null {
    return this.memories.get(memoryId);
  }

  list(filter: {
    scope?: MemoryScope;
    scopeId?: string;
    lifecycleState?: MemoryLifecycleState;
    limit?: number;
  } = {}): MemoryRecord[] {
    return this.memories.list(filter);
  }

  update(
    memoryId: string,
    patch: {
      value?: string;
      summary?: string | null;
      importance?: number;
      confidence?: number;
      lifecycleState?: Exclude<MemoryLifecycleState, "superseded">;
      sensitivity?: MemoryRecord["sensitivity"];
      retentionUntil?: string | null;
    },
  ): MemoryRecord {
    const contentChanged = patch.value !== undefined
      || patch.summary !== undefined
      || patch.importance !== undefined
      || patch.confidence !== undefined
      || patch.sensitivity !== undefined
      || patch.retentionUntil !== undefined;
    if (contentChanged && patch.lifecycleState && patch.lifecycleState !== "active") {
      throw new Error("memory_content_update_requires_active_lifecycle");
    }
    let memory = contentChanged
      ? this.memories.replace(memoryId, patch)
      : this.memories.get(memoryId);
    if (!memory) throw new Error("memory_not_found");
    if (patch.lifecycleState && patch.lifecycleState !== memory.lifecycleState) {
      memory = this.memories.transition(memory.id, patch.lifecycleState);
    }
    return memory;
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
