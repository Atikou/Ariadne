import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  MAX_PUBLIC_PROJECTION_SCOPED_READ_BYTES, PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_SCOPED_READ_VERSION, assertPublicProjectionScopedReadBatch,
  canonicalPublicProjectionJson, publicProjectionScopeFeatures,
  publicProjectionScopedReadDigestPayload,
  type PublicProjectionChange, type PublicProjectionReadBatch, type PublicProjectionScope,
  type PublicProjectionScopedReadRequest, type PublicProjectionScopedReadBatch,
  type PublicProjectionScopedReadOk
} from '@ariadne/protocol/public';
import type { SnapshotVersionRow } from './SqliteProjectionSnapshotReader.js';

/** Stateless projection of an already validated, bounded ledger scan. */
export function filterScopedProjectionRead(database: DatabaseSync,
  request: PublicProjectionScopedReadRequest, scan: PublicProjectionReadBatch,
  changeFromRow: (row: SnapshotVersionRow) => PublicProjectionChange): PublicProjectionScopedReadBatch {
  if (scan.status !== 'ok') return { status: 'reset_required', readContractVersion: PUBLIC_PROJECTION_SCOPED_READ_VERSION,
    streamId: scan.streamId, currentCursor: scan.currentCursor, reason: scan.reason };
  const scope = request.scope;
  if (scope.kind === 'session' && sessionWorkspaceAt(database, scope.sessionId,
    request.afterCursor, changeFromRow) !== scope.workspaceId) {
    return { status: 'reset_required', readContractVersion: PUBLIC_PROJECTION_SCOPED_READ_VERSION,
      streamId: scan.streamId, currentCursor: scan.nextCursor, reason: 'scope_mismatch' };
  }
  const entries: PublicProjectionScopedReadOk['entries'] = [];
  let rowBytes = 0;
  let truncated = false;
  const envelope = { status: 'ok' as const, readContractVersion: PUBLIC_PROJECTION_SCOPED_READ_VERSION,
    projectionContractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, streamId: scan.streamId, scope,
    afterCursor: scan.afterCursor, afterDigest: scan.afterDigest,
    nextCursor: scan.afterCursor, nextDigest: scan.afterDigest, hasMore: false,
    entries: [], batchDigest: scan.afterDigest };
  // Reserve larger cursor digits and envelope so a selected entry always fits.
  const envelopeBytes = Buffer.byteLength(canonicalPublicProjectionJson({ ...envelope, nextCursor: Number.MAX_SAFE_INTEGER }));
  for (const scanned of scan.commits) {
    const original = scanned.commit;
    const entry = { cursor: scanned.cursor, cursorDigest: scanned.cursorDigest,
      payloadDigest: sha256(canonicalPublicProjectionJson(original)),
      eventId: original.eventId, sourceId: original.sourceId, sourceCursor: original.sourceCursor,
      occurredAt: original.occurredAt, changes: original.changes.filter(change =>
        changeInScope(database, change, scope, scanned.cursor, changeFromRow)) };
    const bytes = Buffer.byteLength(canonicalPublicProjectionJson(entry));
    if (envelopeBytes + rowBytes + bytes + entries.length > MAX_PUBLIC_PROJECTION_SCOPED_READ_BYTES) {
      if (entries.length === 0) throw new Error('public_projection_scoped_entry_exceeds_capacity');
      truncated = true;
      break;
    }
    entries.push(entry);
    rowBytes += bytes;
  }
  const last = entries.at(-1);
  const payload = { ...envelope, entries, nextCursor: last?.cursor ?? scan.afterCursor,
    nextDigest: last?.cursorDigest ?? scan.afterDigest, hasMore: truncated || scan.hasMore };
  const { batchDigest: _placeholder, ...digestPayload } = payload;
  return assertPublicProjectionScopedReadBatch({ ...digestPayload,
    batchDigest: sha256(publicProjectionScopedReadDigestPayload(digestPayload)) });
}

function changeInScope(database: DatabaseSync, change: PublicProjectionChange,
  scope: PublicProjectionScope, cursor: number,
  changeFromRow: (row: SnapshotVersionRow) => PublicProjectionChange): boolean {
  if (!publicProjectionScopeFeatures(scope).includes(change.feature)) return false;
  const owner = change.dto ?? previousVisible(database, change, cursor, changeFromRow)?.dto;
  if (scope.kind === 'session') return owner != null && 'sessionId' in owner && owner.sessionId === scope.sessionId;
  if (scope.workspaceId === undefined) return true;
  if (scope.kind === 'directory') {
    return change.feature !== 'sessions' || (owner != null && 'workspaceId' in owner && owner.workspaceId === scope.workspaceId);
  }
  return owner != null && 'sessionId' in owner && typeof owner.sessionId === 'string'
    && sessionWorkspaceAt(database, owner.sessionId, cursor, changeFromRow) === scope.workspaceId;
}

function previousVisible(database: DatabaseSync, change: PublicProjectionChange, cursor: number,
  changeFromRow: (row: SnapshotVersionRow) => PublicProjectionChange): PublicProjectionChange | undefined {
  const row = database.prepare(`SELECT * FROM projection_versions WHERE feature=? AND aggregate_id=?
    AND aggregate_version<? AND commit_cursor<=? AND operation='upsert'
    ORDER BY aggregate_version DESC LIMIT 1`).get(change.feature, change.aggregateId,
      change.aggregateVersion, cursor) as unknown as SnapshotVersionRow | undefined;
  return row === undefined ? undefined : changeFromRow(row);
}
function sessionWorkspaceAt(database: DatabaseSync, sessionId: string, cursor: number,
  changeFromRow: (row: SnapshotVersionRow) => PublicProjectionChange): string | undefined {
  const row = database.prepare(`SELECT * FROM projection_versions WHERE feature='sessions'
    AND aggregate_id=? AND commit_cursor<=? ORDER BY aggregate_version DESC LIMIT 1`)
    .get(sessionId, cursor) as unknown as SnapshotVersionRow | undefined;
  const change = row === undefined ? undefined : changeFromRow(row);
  return change?.feature === 'sessions' && change.dto !== null ? change.dto.workspaceId : undefined;
}
function sha256(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
