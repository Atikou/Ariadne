import {
  MAX_PUBLIC_PROJECTION_COMMIT_BYTES,
  MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES,
  MAX_PUBLIC_PROJECTION_SNAPSHOT_BYTES,
  assertPublicProjectionCommitV3,
  assertPublicProjectionPayloadSafeV3,
  assertPublicProjectionReadBatchV3,
  assertPublicProjectionReadRequestV3,
  assertPublicProjectionSnapshotV3,
  canonicalPublicProjectionJsonV3,
  type ProjectionCommitV3,
  type PublicProjectionReadBatchV3,
  type PublicProjectionReadRequestV3,
  type PublicProjectionSnapshotV3
} from '@ariadne/protocol/public';

export {
  MAX_PUBLIC_PROJECTION_COMMIT_BYTES,
  MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES,
  MAX_PUBLIC_PROJECTION_SNAPSHOT_BYTES
};

/** Pure Runtime boundary for a commit before a future projector publishes it. */
export function assertValidProjectionCommitV3(value: unknown): ProjectionCommitV3 {
  return assertPublicProjectionCommitV3(value);
}

/** Pure Runtime boundary for one cursor-consistent, complete public snapshot. */
export function assertValidPublicProjectionSnapshotV3(
  value: unknown
): PublicProjectionSnapshotV3 {
  return assertPublicProjectionSnapshotV3(value);
}

export function assertValidPublicProjectionReadRequestV3(
  value: unknown
): PublicProjectionReadRequestV3 {
  return assertPublicProjectionReadRequestV3(value);
}

export function assertValidPublicProjectionReadBatchV3(
  value: unknown
): PublicProjectionReadBatchV3 {
  return assertPublicProjectionReadBatchV3(value);
}

export function assertPublicProjectionPayloadSafe(value: unknown): void {
  assertPublicProjectionPayloadSafeV3(value);
}

export function canonicalPublicProjectionJson(value: unknown): string {
  return canonicalPublicProjectionJsonV3(value);
}
