import type { DatabaseSync } from 'node:sqlite';
import { assertProjectionCatalogResult, canonicalPublicProjectionJson, publicProjectionFeatureReceiptResultSchema,
  type PublicProjectionFeatureReceiptRequest, type PublicProjectionFeatureReceiptResult } from '@ariadne/protocol/public';
import { projectionDigest } from './StoredProjectionRecords.js';
import type { SqliteProjectionCatalogMetadataCache } from './SqliteProjectionCatalogMetadataCache.js';
import { scanProjectionReceiptEntries, receiptSessionMembershipChanged, receiptOwnerSession,
  previousReceiptOwnerSession, type ProjectionReceiptSelection } from './SqliteProjectionReceiptScan.js';

export function readProjectionFeatureReceipts(database: DatabaseSync, metadata: SqliteProjectionCatalogMetadataCache,
  request: PublicProjectionFeatureReceiptRequest, currentCursor: () => number,
  boundaryDigest: (cursor: number) => string | undefined): PublicProjectionFeatureReceiptResult {
  metadata.assertStorageUnchanged(); const result = read(); metadata.assertStorageUnchanged();
  return assertProjectionCatalogResult(publicProjectionFeatureReceiptResultSchema, result);
  function reset(reason: Extract<PublicProjectionFeatureReceiptResult, { status: 'reset_required' }>['reason']) {
    return { status: 'reset_required' as const, queryVersion: '1.0' as const, manifest: request.manifest,
      afterCursor: request.afterCursor, afterDigest: request.afterDigest, reason };
  }
  function read(): PublicProjectionFeatureReceiptResult {
    const { manifest } = request;
    if (request.afterCursor < manifest.boundaryCursor) return reset('boundary_mismatch');
    if (manifest.scope.kind === 'session' && !metadata.sessionOwnsWorkspace(manifest.scope.sessionId,
      manifest.scope.workspaceId, request.afterCursor)) return reset('scope_mismatch');
    const envelope = { status: 'ok' as const, queryVersion: '1.0' as const, manifest,
      afterCursor: request.afterCursor, afterDigest: request.afterDigest };
    const reserve = Buffer.byteLength(canonicalPublicProjectionJson({ ...envelope, entries: [],
      nextCursor: Number.MAX_SAFE_INTEGER, nextDigest: request.afterDigest, hasMore: false, batchDigest: request.afterDigest }));
    type Entry = Extract<PublicProjectionFeatureReceiptResult, { status: 'ok' }>['entries'][number];
    const scan = scanProjectionReceiptEntries(database, request, currentCursor(), reserve, boundaryDigest, 'feature_receipts',
      (commit, row): ProjectionReceiptSelection<Entry> => {
        const receipts: Entry['receipts'] = [];
        for (const change of commit.changes) {
          const scope = manifest.scope;
          if (scope.kind === 'session' && receiptSessionMembershipChanged(database, metadata, change, scope.sessionId, row.cursor)) return { kind: 'reset', reason: 'scope_mismatch' };
          if (change.feature !== 'models' && change.feature !== 'diagnostics' && change.feature !== 'inference_streams') continue;
          if (!manifest.selectedFeatures.includes(change.feature)) continue;
          let included = change.dto !== null;
          if (change.feature === 'inference_streams') {
            if (scope.kind !== 'session') throw new Error('public_projection_storage_corruption:feature_receipts:selection_invalid');
            const oldOwned = previousReceiptOwnerSession(database, metadata, change, row.cursor) === scope.sessionId;
            const nextOwned = receiptOwnerSession(change) === scope.sessionId;
            if (!oldOwned && !nextOwned) continue; included = nextOwned;
          }
          receipts.push({ feature: change.feature, aggregateId: change.aggregateId, aggregateVersion: change.aggregateVersion,
            projectedAt: change.projectedAt, operation: included ? 'upsert' : 'remove' });
        }
        return { kind: 'entry', entry: { cursor: row.cursor, cursorDigest: row.history_digest, payloadDigest: row.payload_digest,
          eventId: commit.eventId, sourceId: commit.sourceId, sourceCursor: commit.sourceCursor, occurredAt: commit.occurredAt, receipts } };
      });
    if (scan.status !== 'ok') return reset(scan.reason);
    const payload = { ...envelope, ...scan };
    return { ...payload, batchDigest: projectionDigest(canonicalPublicProjectionJson(payload)) };
  }
}
