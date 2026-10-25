import type { MemoryToolRequest } from '@ariadne/protocol/host';
import type { LongMemoryResult } from '@ariadne/protocol/public';

/** Resolves scope from the durable Run, rather than from model-supplied IDs. */
export interface AgentMemoryToolAuthority {
  invoke(invocation: { readonly runId: string; readonly effectId: string; readonly idempotencyKey: string; readonly request: MemoryToolRequest },
    signal: AbortSignal): Promise<LongMemoryResult>;
}
