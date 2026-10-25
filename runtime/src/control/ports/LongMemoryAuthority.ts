import type { LongMemoryCommand, LongMemoryContent, LongMemoryRecord, LongMemoryResult } from '@ariadne/protocol/public';
export type LongMemoryMutation = Extract<LongMemoryCommand, { kind: 'memory.put' | 'memory.transition' | 'memory.delete' }>;
export type LongMemoryOwnerScope = { readonly workspaceId: string; readonly sessionId: string };
export interface LongMemoryAuthority {
  readonly schemaVersion: number;
  execute(commandId: string, command: LongMemoryCommand, signal: AbortSignal): Promise<LongMemoryResult>;
  reconcile(commandId: string, command: LongMemoryMutation): Promise<LongMemoryResult | null>;
  recall(scope: LongMemoryOwnerScope, query: string, limit: number, signal: AbortSignal): Promise<Extract<LongMemoryResult, { kind: 'memory.recall_result' }>>;
  instructionMemories(scope: LongMemoryOwnerScope, signal: AbortSignal): Promise<readonly LongMemoryRecord[]>;
  stageCandidate(commandId: string, input: LongMemoryOwnerScope & LongMemoryContent & { readonly memoryId: string; readonly runId: string }, signal: AbortSignal): Promise<LongMemoryResult>;
}
