import { createHash } from 'node:crypto';
import { legacyRuntimeCommandValues, stableRuntimeCommandValue } from '@ariadne/protocol/compatibility';
import { boundedCanonicalJson } from './BoundedCanonicalJson.js';

export function runtimeCommandIdentity(command: unknown): { digest: string; previousDigests: readonly string[] } {
  const digest = hash(stableRuntimeCommandValue(command));
  return { digest, previousDigests: [...new Set(legacyRuntimeCommandValues(command).map(hash))].filter(value => value !== digest) };
}
function hash(value: unknown): string { return createHash('sha256').update(boundedCanonicalJson(value), 'utf8').digest('hex'); }
