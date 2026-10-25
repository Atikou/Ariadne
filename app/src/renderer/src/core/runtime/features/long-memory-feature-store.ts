import { PUBLIC_PROJECTION_CONTRACT_VERSION, type LongMemoryContent, type LongMemoryRecord, type LongMemoryResult } from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';

export type MemoryPage = Extract<LongMemoryResult, { kind: 'memory.query_result' }>;
export type MemoryRecall = Extract<LongMemoryResult, { kind: 'memory.recall_result' }>;
export type MemoryOwnerScope = { readonly workspaceId: string; readonly sessionId: string };
/** All memory operations use the production command owner and explicit optimistic versions. */
export class LongMemoryFeatureStore {
  constructor(private readonly gateway: RuntimeFeatureCommandGateway) {}
  async query(owner: MemoryOwnerScope, status: 'all' | LongMemoryRecord['status'] = 'all', before: MemoryPage['nextCursor'] = null): Promise<MemoryPage> {
    const result = await this.gateway.execute({ kind: 'memory.query', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, ...commandScope(owner),
      scope: null, status, before, limit: 50 });
    if (result.kind !== 'memory.query_result') throw new Error(`runtime_result_invalid:${result.kind}`); return result;
  }
  async read(owner: MemoryOwnerScope, memoryId: string): Promise<LongMemoryRecord | null> {
    const result = await this.gateway.execute({ kind: 'memory.read', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, ...commandScope(owner), memoryId });
    if (result.kind !== 'memory.read_result') throw new Error(`runtime_result_invalid:${result.kind}`); return result.memory;
  }
  async put(owner: MemoryOwnerScope, memoryId: string, expectedVersion: number | null, content: LongMemoryContent): Promise<void> {
    const result = await this.gateway.execute({ kind: 'memory.put', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...commandScope(owner), ...content, memoryId, expectedVersion });
    if (result.kind !== 'memory.updated' || result.memoryId !== memoryId) throw new Error(`runtime_result_invalid:${result.kind}`);
  }
  async transition(owner: MemoryOwnerScope, memory: Pick<LongMemoryRecord, 'memoryId' | 'version'>, action: 'activate' | 'deactivate' | 'reject'): Promise<void> {
    const result = await this.gateway.execute({ kind: 'memory.transition', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...commandScope(owner), memoryId: memory.memoryId, expectedVersion: memory.version, action });
    if (result.kind !== 'memory.updated' || result.memoryId !== memory.memoryId) throw new Error(`runtime_result_invalid:${result.kind}`);
  }
  async forget(owner: MemoryOwnerScope, memory: Pick<LongMemoryRecord, 'memoryId' | 'version'>): Promise<void> {
    const result = await this.gateway.execute({ kind: 'memory.delete', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...commandScope(owner), memoryId: memory.memoryId, expectedVersion: memory.version });
    if (result.kind !== 'memory.deleted' || result.memoryId !== memory.memoryId) throw new Error(`runtime_result_invalid:${result.kind}`);
  }
  async recall(owner: MemoryOwnerScope, query: string): Promise<MemoryRecall> {
    const result = await this.gateway.execute({ kind: 'memory.recall', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, ...commandScope(owner), query, limit: 20 });
    if (result.kind !== 'memory.recall_result') throw new Error(`runtime_result_invalid:${result.kind}`); return result;
  }
}
function commandScope(owner: MemoryOwnerScope): MemoryOwnerScope {
  return { workspaceId: owner.workspaceId, sessionId: owner.sessionId };
}
