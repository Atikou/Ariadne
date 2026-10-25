import type { DatabaseSync } from 'node:sqlite';
import { PUBLIC_PROJECTION_GENESIS_DIGEST, canonicalPublicProjectionJson, assertProjectionCatalogResult,
  publicProjectionFeatureWindowResultSchema, type PublicProjectionFeatureWindowRequest,
  type PublicProjectionFeatureWindowResult, type PublicProjectionChange } from '@ariadne/protocol/public';
import type { SqliteProjectionSnapshotReader, SnapshotVersionRow } from './SqliteProjectionSnapshotReader.js';
import { readProjectionFeatureWindowRows } from './SqliteProjectionFeatureWindowRows.js';
import { projectionDigest } from './StoredProjectionRecords.js';

export function readProjectionFeatureWindow(database: DatabaseSync, reader: SqliteProjectionSnapshotReader,
  request: PublicProjectionFeatureWindowRequest, changeFromRow: (row: SnapshotVersionRow) => PublicProjectionChange): PublicProjectionFeatureWindowResult {
  const { manifest, window } = request;
  const envelope = { status: 'ok' as const, windowContractVersion: '1.0' as const, manifest, window };
  const reserve = Buffer.byteLength(canonicalPublicProjectionJson({ ...envelope, changes: [], hasEarlier: true, windowDigest: PUBLIC_PROJECTION_GENESIS_DIGEST }));
  const result = readProjectionFeatureWindowRows(database, reader, manifest.scope, manifest.boundaryCursor, window, reserve, changeFromRow);
  if (result.status !== 'ok') return { status: 'anchor_unavailable', snapshotId: manifest.snapshotId };
  const payload = { ...envelope, changes: result.changes, hasEarlier: result.hasEarlier };
  return assertProjectionCatalogResult(publicProjectionFeatureWindowResultSchema, { ...payload,
    windowDigest: projectionDigest(canonicalPublicProjectionJson(payload)) });
}
