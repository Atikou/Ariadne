import { createHash } from 'node:crypto';
import { canonicalJson } from './AgentModelProtocol.js';

/** Stable Provider-visible identity for an exact historical Core Tool invocation. */
export function historicalProviderToolCallId(runId: string, effectId: string, toolCallId: string): string {
  return `history_${createHash('sha256').update(canonicalJson({ runId, effectId, toolCallId })).digest('hex').slice(0, 40)}`;
}
