import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
import type { RuntimeAuthorityHealthSource } from '../ingress/RuntimeAuthorityHealthSource.js';
import { classifySqliteAuthorityFault, SqliteAuthorityUnavailableError } from '../adapters/persistence/SqliteAuthorityHealth.js';
import { createProductionLongMemoryService, type ProductionLongMemoryService } from './ProductionLongMemoryService.js';

export function isMemoryAuthorityFault(error: unknown): boolean {
  return classifySqliteAuthorityFault('memory', error) !== null
    || (error instanceof SqliteAuthorityUnavailableError && error.source === 'memory');
}
/** Only confirmed, cleaned-up optional source faults isolate memory. Unknown
 * opening/cleanup/lease errors still stop composition with their original cause. */
export function composeProductionLongMemorySource(dataRoot: string, policy: RuntimePolicySnapshot['embedding']): {
  readonly memory?: ProductionLongMemoryService; readonly health: RuntimeAuthorityHealthSource;
} {
  try {
    const memory = createProductionLongMemoryService(dataRoot, policy);
    return { memory, health: memory };
  } catch (error) {
    if (!isMemoryAuthorityFault(error)) throw error;
    return { health: { assertHealthy: () => { throw error; } } };
  }
}
