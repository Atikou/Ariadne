import { createHash } from 'node:crypto';
import { canonicalPublicProjectionJson } from '@ariadne/protocol/public';
import { legacyRuntimeCommandValues, stableRuntimeCommandValue } from '@ariadne/protocol/compatibility';

/** Stable semantic fingerprint plus exact historical serialization proofs for the same input. */
export function commandReceiptIdentity(command: unknown): { fingerprint: string; previousFingerprints: readonly string[] } {
  const fingerprint = digest(canonicalPublicProjectionJson(stableRuntimeCommandValue(command)));
  return { fingerprint, previousFingerprints: [...new Set(legacyRuntimeCommandValues(command).map(value => digest(JSON.stringify(value))))]
    .filter(value => value !== fingerprint) };
}
function digest(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
