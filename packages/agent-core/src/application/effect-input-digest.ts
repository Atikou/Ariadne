import type { AgentJsonValue } from '../domain/json-value.js';

export interface AgentEffectInputDigestContext {
  readonly runId: string;
  readonly effectId: string;
}

/**
 * Domain identity for the exact input approved and later executed.
 *
 * Control owns this operation after assigning run/effect IDs. AgentEngine and
 * persistence codecs are not authoritative digest producers.
 */
export interface AgentEffectInputDigester {
  digest(
    input: AgentJsonValue,
    context: AgentEffectInputDigestContext
  ): string;
}
