import type { DatabaseSync } from 'node:sqlite';
import { assertProjectionCatalogResult, canonicalPublicProjectionJson, PUBLIC_PROJECTION_GENESIS_DIGEST,
  publicConversationInferenceResultSchema, type PublicConversationInferenceRequest,
  type PublicConversationInferenceResult, type PublicProjectionChange } from '@ariadne/protocol/public';
import type { SqliteProjectionSnapshotReader, SnapshotVersionRow } from './SqliteProjectionSnapshotReader.js';
import { readProjectionFeatureWindowRows } from './SqliteProjectionFeatureWindowRows.js';
import { projectionDigest } from './StoredProjectionRecords.js';

export function readConversationInferenceWindow(database: DatabaseSync, reader: SqliteProjectionSnapshotReader,
  request: PublicConversationInferenceRequest, changeFromRow: (row: SnapshotVersionRow) => PublicProjectionChange): PublicConversationInferenceResult {
  const { manifest, window } = request, envelope = { queryVersion: '1.0' as const, manifest, window };
  const reserve = Buffer.byteLength(canonicalPublicProjectionJson({ ...envelope, status: 'ok', changes: [],
    hasEarlier: true, windowDigest: PUBLIC_PROJECTION_GENESIS_DIGEST }));
  const result = readProjectionFeatureWindowRows(database, reader, manifest.scope, manifest.boundaryCursor, window, reserve, changeFromRow);
  if (result.status !== 'ok') return assertProjectionCatalogResult(publicConversationInferenceResultSchema, { ...envelope, ...result });
  const payload = { ...envelope, ...result };
  return assertProjectionCatalogResult(publicConversationInferenceResultSchema, { ...payload, windowDigest: projectionDigest(canonicalPublicProjectionJson(payload)) });
}
