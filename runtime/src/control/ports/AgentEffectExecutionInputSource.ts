import type {
  AgentEffectPayload,
  AgentRunUnitOfWork
} from '@ariadne/agent-core';

/**
 * Narrow protected-payload source required by Effect dispatch.
 *
 * The Control layer owns this Port; concrete SQLite ownership remains an
 * Adapter/Composition concern.
 */
export interface AgentEffectExecutionInputSource
extends Pick<AgentRunUnitOfWork, 'transaction'> {
  loadEffectExecutionInput(
    runId: string,
    effectId: string
  ): Promise<Omit<AgentEffectPayload, 'result'>>;
}
