import type { DatabaseSync } from 'node:sqlite';
import { assertProjectionCatalogResult, canonicalPublicProjectionJson, publicConversationReceiptResultSchema,
  type PublicConversationReceiptRequest, type PublicConversationReceiptResult } from '@ariadne/protocol/public';
import { projectionDigest } from './StoredProjectionRecords.js';
import type { SqliteProjectionCatalogMetadataCache } from './SqliteProjectionCatalogMetadataCache.js';
import { scanProjectionReceiptEntries, receiptSessionMembershipChanged, receiptOwnerSession,
  previousReceiptOwnerSession, type ProjectionReceiptSelection } from './SqliteProjectionReceiptScan.js';

export function readConversationReceipts(database: DatabaseSync, metadata: SqliteProjectionCatalogMetadataCache,
  request: PublicConversationReceiptRequest, currentCursor: () => number,
  boundaryDigest: (cursor: number) => string | undefined): PublicConversationReceiptResult {
  metadata.assertStorageUnchanged(); const result = read(); metadata.assertStorageUnchanged();
  return assertProjectionCatalogResult(publicConversationReceiptResultSchema, result);
  function reset(reason: Extract<PublicConversationReceiptResult, { status: 'reset_required' }>['reason']) {
    return { status: 'reset_required' as const, queryVersion: '1.0' as const, manifest: request.manifest,
      afterCursor: request.afterCursor, afterDigest: request.afterDigest, reason };
  }
  function read(): PublicConversationReceiptResult {
    const { manifest } = request, scope = manifest.scope;
    if (scope.kind !== 'session') throw new Error('public_projection_storage_corruption:conversation_receipts:scope_invalid');
    if (request.afterCursor < manifest.boundaryCursor) return reset('boundary_mismatch');
    if (!metadata.sessionOwnsWorkspace(scope.sessionId, scope.workspaceId, request.afterCursor)) return reset('scope_mismatch');
    const envelope = { status: 'ok' as const, queryVersion: '1.0' as const, manifest,
      afterCursor: request.afterCursor, afterDigest: request.afterDigest };
    const reserve = Buffer.byteLength(canonicalPublicProjectionJson({ ...envelope, entries: [],
      nextCursor: Number.MAX_SAFE_INTEGER, nextDigest: request.afterDigest, hasMore: false, batchDigest: request.afterDigest }));
    type Entry = Extract<PublicConversationReceiptResult, { status: 'ok' }>['entries'][number];
    const scan = scanProjectionReceiptEntries(database, request, currentCursor(), reserve, boundaryDigest, 'conversation_receipts',
      (commit, row): ProjectionReceiptSelection<Entry> => {
        const receipts: Entry['receipts'] = [];
        for (const change of commit.changes) {
          if (receiptSessionMembershipChanged(database, metadata, change, scope.sessionId, row.cursor)) return { kind: 'reset', reason: 'scope_mismatch' };
          if (change.feature !== 'messages' && change.feature !== 'runs' && change.feature !== 'inference_streams') continue;
          const oldOwned = previousReceiptOwnerSession(database, metadata, change, row.cursor) === scope.sessionId;
          const nextOwned = receiptOwnerSession(change) === scope.sessionId;
          if (!oldOwned && !nextOwned) continue;
          receipts.push({ feature: change.feature, aggregateId: change.aggregateId, aggregateVersion: change.aggregateVersion,
            projectedAt: change.projectedAt, operation: nextOwned ? 'upsert' : 'remove' });
        }
        return { kind: 'entry', entry: { cursor: row.cursor, cursorDigest: row.history_digest, payloadDigest: row.payload_digest,
          eventId: commit.eventId, sourceId: commit.sourceId, sourceCursor: commit.sourceCursor, occurredAt: commit.occurredAt, receipts } };
      });
    if (scan.status !== 'ok') return reset(scan.reason);
    const payload = { ...envelope, ...scan }; return { ...payload, batchDigest: projectionDigest(canonicalPublicProjectionJson(payload)) };
  }
}
