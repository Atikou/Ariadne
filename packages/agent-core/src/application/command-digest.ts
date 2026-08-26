import { AgentRunInvariantError } from '../domain/errors.js';
import type { AgentRunCommand } from './commands.js';

export interface AgentRunCommandDigester {
  digest(command: AgentRunCommand): Promise<string>;
}

/**
 * Stable application-level command identity. Object keys are sorted, omitted
 * properties stay omitted, and array order remains significant before hashing.
 */
export const sha256AgentRunCommandDigester: AgentRunCommandDigester = {
  async digest(command) {
    const canonical = canonicalizeAgentRunCommand(command);
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
      throw new AgentRunInvariantError(
        'SHA-256 command identity requires the standard Web Crypto API.'
      );
    }
    const bytes = new TextEncoder().encode(canonical);
    const digest = await subtle.digest('SHA-256', bytes);
    return `sha256:${toHex(new Uint8Array(digest))}`;
  }
};

export function digestAgentRunCommand(
  command: AgentRunCommand
): Promise<string> {
  return sha256AgentRunCommandDigester.digest(command);
}

export function canonicalizeAgentRunCommand(
  command: AgentRunCommand
): string {
  return canonicalize(command, new Set<object>(), 'command');
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  path: string
): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new AgentRunInvariantError(`${path} must not contain a non-finite number.`);
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'undefined':
      throw new AgentRunInvariantError(`${path} must not contain undefined in an array.`);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new AgentRunInvariantError(`${path} contains a non-canonical value.`);
    case 'object':
      break;
  }

  if (ancestors.has(value)) {
    throw new AgentRunInvariantError(`${path} must not contain a cyclic reference.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) =>
        canonicalize(item, ancestors, `${path}[${String(index)}]`)
      ).join(',')}]`;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) =>
        `${JSON.stringify(key)}:${canonicalize(record[key], ancestors, `${path}.${key}`)}`
      );
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
