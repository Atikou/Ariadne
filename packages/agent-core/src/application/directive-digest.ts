import {
  type AgentCommittedDirective,
  type AgentDirective,
  assertValidCommittedAgentDirective,
  assertValidAgentDirective
} from '../domain/directive.js';
import { AgentRunInvariantError } from '../domain/errors.js';

export interface AgentDirectiveDigester {
  digest(directive: AgentDirective): Promise<string>;
}

export interface AgentCommittedDirectiveDigester {
  digest(directive: AgentCommittedDirective): Promise<string>;
}

export const sha256AgentDirectiveDigester: AgentDirectiveDigester = {
  async digest(directive) {
    const canonical = canonicalizeAgentDirective(directive);
    return sha256CanonicalDirective(canonical);
  }
};

export const sha256AgentCommittedDirectiveDigester: AgentCommittedDirectiveDigester = {
  async digest(directive) {
    const canonical = canonicalizeAgentCommittedDirective(directive);
    return sha256CanonicalDirective(canonical);
  }
};

export function digestAgentDirective(directive: AgentDirective): Promise<string> {
  return sha256AgentDirectiveDigester.digest(directive);
}

export function canonicalizeAgentDirective(directive: AgentDirective): string {
  assertValidAgentDirective(directive);
  return canonicalize(directive);
}

export function digestAgentCommittedDirective(
  directive: AgentCommittedDirective
): Promise<string> {
  return sha256AgentCommittedDirectiveDigester.digest(directive);
}

export function canonicalizeAgentCommittedDirective(
  directive: AgentCommittedDirective
): string {
  assertValidCommittedAgentDirective(directive);
  return canonicalize(directive);
}

async function sha256CanonicalDirective(canonical: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new AgentRunInvariantError(
      'SHA-256 directive identity requires the standard Web Crypto API.'
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}
