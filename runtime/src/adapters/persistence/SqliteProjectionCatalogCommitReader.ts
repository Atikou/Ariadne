import { markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';
import type { DatabaseSync } from 'node:sqlite';
import { assertProjectionCatalogResult, canonicalPublicProjectionJson, catalogRowMatches,
  MAX_PUBLIC_PROJECTION_PAGE_BYTES, publicProjectionCatalogBatchResultSchema,
  type PublicProjectionCatalogManifest, type PublicProjectionCatalogReadRequest, type PublicProjectionCatalogBatchResult,
  type PublicProjectionCatalogRow } from '@ariadne/protocol/public';
import { assertStoredCommitHistoryLink, parseStoredCommitRow, projectionDigest, storedProjectionCatalogRow,
  type StoredCommitRow, type StoredProjectionChange } from './StoredProjectionRecords.js';
import { CATALOG_VERSION_HEADER_COLUMNS, type CatalogVersionHeader,
  type SqliteProjectionCatalogMetadataCache } from './SqliteProjectionCatalogMetadataCache.js';

/** Catalog representation is independent of the stored Commit format. Retain
 * each original payload/history digest and global position, even for a commit
 * with no relevant metadata. Never load document chunks or publish full DTOs. */
export function readProjectionCatalogCommits(database: DatabaseSync, metadata: SqliteProjectionCatalogMetadataCache,
  manifest: PublicProjectionCatalogManifest, request: PublicProjectionCatalogReadRequest,
  currentCursor: () => number, boundaryDigest: (cursor: number) => string | undefined): PublicProjectionCatalogBatchResult {
  metadata.assertStorageUnchanged();
  const result = read(); metadata.assertStorageUnchanged();
  return assertProjectionCatalogResult(publicProjectionCatalogBatchResultSchema, result);

  function reset(reason: Extract<PublicProjectionCatalogBatchResult, { status: 'reset_required' }>['reason']) {
    return { status: 'reset_required' as const, streamId: manifest.streamId, reason };
  }
  function read(): PublicProjectionCatalogBatchResult {
    const current = currentCursor();
    if (request.afterCursor < manifest.boundaryCursor) return reset('boundary_mismatch');
    if (request.afterCursor > current) return reset('cursor_gap');
    const digest = boundaryDigest(request.afterCursor);
    if (digest === undefined) return reset('cursor_gap');
    if (digest !== request.afterDigest) return reset('history_mismatch');
    if (manifest.scope.kind === 'session'
      && !metadata.sessionOwnsWorkspace(manifest.scope.sessionId, manifest.scope.workspaceId, request.afterCursor)) return reset('scope_mismatch');
    const entries: Extract<PublicProjectionCatalogBatchResult, { status: 'ok' }>['entries'] = [];
    const envelope = { status: 'ok' as const, manifest, afterCursor: request.afterCursor, afterDigest: request.afterDigest };
    const reserve = Buffer.byteLength(canonicalPublicProjectionJson({ ...envelope, nextCursor: Number.MAX_SAFE_INTEGER,
      nextDigest: request.afterDigest, hasMore: false, entries: [], batchDigest: request.afterDigest }));
    let bytes = 0, previousDigest = request.afterDigest, expectedCursor = request.afterCursor + 1, hasMore = false;
    const rows = database.prepare(`SELECT cursor,event_id,source_id,source_cursor,contract_version,occurred_at,
      commit_json,payload_digest,history_digest FROM projection_commits
      WHERE cursor>? AND cursor<=? ORDER BY cursor LIMIT ?`).iterate(request.afterCursor, current, request.limit + 1);
    for (const value of rows) {
      const row = value as unknown as StoredCommitRow;
      if (row.cursor !== expectedCursor) return reset('cursor_gap');
      if (entries.length >= request.limit) { hasMore = true; break; }
      const commit = parseStoredCommitRow(row); assertStoredCommitHistoryLink(row, previousDigest);
      const changes: Extract<PublicProjectionCatalogBatchResult, { status: 'ok' }>['entries'][number]['changes'] = [];
      for (const change of commit.changes) {
        // Moving/deleting a Session can change every dependent Run/Decision's
        // membership without changing those entities. Rebuild that scoped
        // catalog rather than silently retaining its old members.
        if (sessionMembershipChanged(change, row.cursor)) return reset('scope_mismatch');
        if (change.feature !== manifest.feature) continue;
        const next = change.dto === null ? null : storedProjectionCatalogRow(change);
        const old = previous(change, row.cursor);
        const nextOwned = next !== null && inScope(next, row.cursor);
        const previouslyOwned = old !== null && inScope(old, row.cursor - 1);
        if (!nextOwned && !previouslyOwned) continue;
        const included = nextOwned && next !== null && catalogRowMatches(next, manifest);
        changes.push({ feature: manifest.feature, aggregateId: change.aggregateId, aggregateVersion: change.aggregateVersion,
          projectedAt: change.projectedAt, operation: included ? 'upsert' : 'remove', row: included ? next : null });
      }
      const entry = { cursor: row.cursor, cursorDigest: row.history_digest, payloadDigest: row.payload_digest,
        eventId: commit.eventId, sourceId: commit.sourceId, sourceCursor: commit.sourceCursor, occurredAt: commit.occurredAt, changes };
      const size = Buffer.byteLength(canonicalPublicProjectionJson(entry));
      if (reserve + bytes + size + entries.length > MAX_PUBLIC_PROJECTION_PAGE_BYTES) {
        if (entries.length === 0) throw markAuthorityIntegrityError('projection', new Error('public_projection_storage_corruption:catalog:entry_exceeds_capacity'));
        hasMore = true; break;
      }
      entries.push(entry); bytes += size; previousDigest = row.history_digest; expectedCursor++;
    }
    const last = entries.at(-1), nextCursor = last?.cursor ?? request.afterCursor;
    if (!hasMore && nextCursor !== current) return reset('cursor_gap');
    const payload = { ...envelope, nextCursor, nextDigest: last?.cursorDigest ?? request.afterDigest, hasMore, entries };
    return { ...payload, batchDigest: projectionDigest(canonicalPublicProjectionJson(payload)) };
  }
  function previous(change: StoredProjectionChange, cursor: number, includeDeleted = false): PublicProjectionCatalogRow | null {
    const row = database.prepare(`SELECT ${CATALOG_VERSION_HEADER_COLUMNS} FROM projection_versions
      WHERE feature=? AND aggregate_id=? AND aggregate_version<? AND commit_cursor<=? AND (?=1 OR operation='upsert')
      ORDER BY aggregate_version DESC LIMIT 1`).get(change.feature, change.aggregateId, change.aggregateVersion, cursor, includeDeleted ? 1 : 0) as unknown as CatalogVersionHeader | undefined;
    return row === undefined ? null : metadata.read(row);
  }
  function inScope(row: PublicProjectionCatalogRow, cursor: number): boolean {
    const scope = manifest.scope;
    if (scope.kind === 'session') return row.feature !== 'sessions' && row.dto.sessionId === scope.sessionId;
    if (scope.workspaceId === undefined) return true;
    if (scope.kind === 'directory') return row.feature === 'sessions' && row.dto.workspaceId === scope.workspaceId;
    return row.feature !== 'sessions' && row.dto.sessionId !== undefined
      && metadata.sessionOwnsWorkspace(row.dto.sessionId, scope.workspaceId, cursor);
  }
  function sessionMembershipChanged(change: StoredProjectionChange, cursor: number): boolean {
    if (change.feature !== 'sessions' || manifest.scope.kind === 'directory') return false;
    const scope = manifest.scope;
    if (scope.workspaceId === undefined) return false;
    const old = previous(change, cursor, true), oldWorkspace = old?.feature === 'sessions' ? old.dto.workspaceId : undefined;
    const nextWorkspace = change.dto?.workspaceId;
    if (oldWorkspace === nextWorkspace) return false;
    if (scope.kind === 'session') return change.aggregateId === scope.sessionId;
    return oldWorkspace === scope.workspaceId || nextWorkspace === scope.workspaceId;
  }
}
