import { createHash } from 'node:crypto';

import {
  AgentRunInvariantError,
  type AgentEffectInputDigester,
  type AgentJsonValue
} from '@ariadne/agent-core';

/** Runtime-owned canonical effect input identity; AgentEngine is not authoritative. */
export class Sha256AgentEffectInputDigester implements AgentEffectInputDigester {
  public digest(
    input: AgentJsonValue,
    context: { readonly runId: string; readonly effectId: string }
  ): string {
    if (context.runId.length === 0 || context.effectId.length === 0) {
      throw new AgentRunInvariantError('Effect input digest context must be non-empty.');
    }
    const canonical = canonicalizeJson({
      runId: context.runId,
      effectId: context.effectId,
      input
    });
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  }
}

function canonicalizeJson(value: AgentJsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AgentRunInvariantError('Effect input must contain finite JSON numbers.');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  const record = value as Readonly<Record<string, AgentJsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalizeJson(record[key] as AgentJsonValue)}`
  ).join(',')}}`;
}
