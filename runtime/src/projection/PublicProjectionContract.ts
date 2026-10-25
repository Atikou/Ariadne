import {
  MAX_PUBLIC_PROJECTION_COMMIT_BYTES,
  MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES,
  MAX_PUBLIC_PROJECTION_SNAPSHOT_BYTES,
  assertPublicProjectionCommit,
  assertPublicProjectionReadBatch,
  assertPublicProjectionReadRequest,
  assertPublicProjectionSnapshot,
  type ProjectionCommit,
  type PublicProjectionReadBatch,
  type PublicProjectionReadRequest,
  type PublicProjectionSnapshot
} from '@ariadne/protocol/public';

export {
  MAX_PUBLIC_PROJECTION_COMMIT_BYTES,
  MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES,
  MAX_PUBLIC_PROJECTION_SNAPSHOT_BYTES
};
export { assertPublicProjectionPayloadSafe, canonicalPublicProjectionJson } from '@ariadne/protocol/public';

/** Pure Runtime boundary for a commit before a future projector publishes it. */
const validatedCommits = new WeakSet<object>();

export function assertValidProjectionCommit(value: unknown): ProjectionCommit {
  if (value !== null && typeof value === 'object' && validatedCommits.has(value)) {
    return value as ProjectionCommit;
  }
  // The protocol parser owns a fresh, bounded JSON tree. Freeze that tree,
  // never the caller's input, before remembering its identity. Publisher,
  // admission and final ledger can then share one validation without trusting
  // an arbitrary frozen object or retaining history in a strong cache.
  const commit = assertPublicProjectionCommit(value);
  const pending: object[] = [commit];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
    Object.freeze(current);
  }
  validatedCommits.add(commit);
  return commit;
}

/** Pure Runtime boundary for one cursor-consistent, complete public snapshot. */
export function assertValidPublicProjectionSnapshot(
  value: unknown
): PublicProjectionSnapshot {
  return assertPublicProjectionSnapshot(value);
}

export function assertValidPublicProjectionReadRequest(
  value: unknown
): PublicProjectionReadRequest {
  return assertPublicProjectionReadRequest(value);
}

export function assertValidPublicProjectionReadBatch(
  value: unknown
): PublicProjectionReadBatch {
  return assertPublicProjectionReadBatch(value);
}
