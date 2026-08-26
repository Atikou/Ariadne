import { AgentRunInvariantError } from '../domain/errors.js';
import {
  assertAgentControlJsonValue,
  type AgentControlJsonValue
} from '../domain/plan-budget-delegation.js';

export function canonicalizeAgentControlData(value: unknown): string {
  assertAgentControlJsonValue(value, 'canonical control data');
  return canonicalize(value as AgentControlJsonValue);
}

export async function sha256AgentControlData(
  value: unknown
): Promise<string> {
  const canonical = canonicalizeAgentControlData(value);
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new AgentRunInvariantError(
      'SHA-256 control identity requires the standard Web Crypto API.'
    );
  }
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical)
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function canonicalize(value: AgentControlJsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const record = value as { readonly [key: string]: AgentControlJsonValue };
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize(record[key]!)}`
  ).join(',')}}`;
}
