import { markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalPublicProjectionJson, isRunDocumentChange, MAX_PUBLIC_PROJECTION_PAGE_BYTES } from '@ariadne/protocol/public';
import { assertStoredCommitHistoryLink, parseStoredCommitRow, storedVersionRowAsChange,
  type StoredCommitRow, type StoredProjectionCommit, type StoredProjectionChange, type StoredVersionRow } from './StoredProjectionRecords.js';
import { CATALOG_VERSION_HEADER_COLUMNS, type CatalogVersionHeader, type SqliteProjectionCatalogMetadataCache } from './SqliteProjectionCatalogMetadataCache.js';

export interface ProjectionReceiptEntry { cursor: number; cursorDigest: string }
export type ProjectionReceiptSelection<T> = { kind: 'entry'; entry: T } | { kind: 'reset'; reason: 'scope_mismatch' };
type ScanReset = { status: 'reset_required'; reason: 'cursor_gap' | 'history_mismatch' | 'scope_mismatch' };
/** One original bounded Commit at a time; no representation-specific scope
 * parser runs before the owner selects invalidation metadata. */
export function scanProjectionReceiptEntries<T extends ProjectionReceiptEntry>(database: DatabaseSync,
  request: { afterCursor: number; afterDigest: string; limit: number }, current: number, reserveBytes: number,
  boundaryDigest: (cursor: number) => string | undefined, errorScope: string,
  select: (commit: StoredProjectionCommit, row: StoredCommitRow) => ProjectionReceiptSelection<T>):
  ScanReset | { status: 'ok'; entries: T[]; nextCursor: number; nextDigest: string; hasMore: boolean } {
  if (request.afterCursor > current) return { status: 'reset_required', reason: 'cursor_gap' };
  const digest = boundaryDigest(request.afterCursor);
  if (digest === undefined) return { status: 'reset_required', reason: 'cursor_gap' };
  if (digest !== request.afterDigest) return { status: 'reset_required', reason: 'history_mismatch' };
  const entries: T[] = []; let bytes = 0, previous = digest, expected = request.afterCursor + 1, hasMore = false;
  for (const value of database.prepare(`SELECT cursor,event_id,source_id,source_cursor,contract_version,occurred_at,
    commit_json,payload_digest,history_digest FROM projection_commits WHERE cursor>? AND cursor<=? ORDER BY cursor LIMIT ?`)
    .iterate(request.afterCursor, current, request.limit + 1)) {
    const row = value as unknown as StoredCommitRow;
    if (row.cursor !== expected) return { status: 'reset_required', reason: 'cursor_gap' };
    if (entries.length >= request.limit) { hasMore = true; break; }
    let commit;
    try { commit = parseStoredCommitRow(row); assertStoredCommitHistoryLink(row, previous); }
    catch { throw markAuthorityIntegrityError('projection', new Error(`public_projection_storage_corruption:${errorScope}:commit_invalid`)); }
    const selection = select(commit, row);
    if (selection.kind === 'reset') return { status: 'reset_required', reason: selection.reason };
    const size = Buffer.byteLength(canonicalPublicProjectionJson(selection.entry));
    if (reserveBytes + bytes + size + entries.length > MAX_PUBLIC_PROJECTION_PAGE_BYTES) {
      if (entries.length === 0) throw markAuthorityIntegrityError('projection', new Error(`public_projection_storage_corruption:${errorScope}:entry_exceeds_capacity`));
      hasMore = true; break;
    }
    entries.push(selection.entry); bytes += size; previous = row.history_digest; expected++;
  }
  const last = entries.at(-1), nextCursor = last?.cursor ?? request.afterCursor;
  if (!hasMore && nextCursor !== current) return { status: 'reset_required', reason: 'cursor_gap' };
  return { status: 'ok', entries, nextCursor, nextDigest: last?.cursorDigest ?? request.afterDigest, hasMore };
}
export function receiptSessionMembershipChanged(database: DatabaseSync, metadata: SqliteProjectionCatalogMetadataCache,
  change: StoredProjectionChange, sessionId: string, cursor: number): boolean {
  if (change.feature !== 'sessions' || change.aggregateId !== sessionId) return false;
  const old = database.prepare(`SELECT ${CATALOG_VERSION_HEADER_COLUMNS} FROM projection_versions WHERE feature='sessions'
    AND aggregate_id=? AND aggregate_version<? AND commit_cursor<? ORDER BY aggregate_version DESC LIMIT 1`)
    .get(change.aggregateId, change.aggregateVersion, cursor) as unknown as CatalogVersionHeader | undefined;
  const oldRow = old === undefined ? null : metadata.read(old);
  const oldWorkspace = oldRow?.feature === 'sessions' ? oldRow.dto.workspaceId : undefined;
  return oldWorkspace !== change.dto?.workspaceId;
}
export function receiptOwnerSession(change: StoredProjectionChange): string | undefined {
  if (isRunDocumentChange(change)) return change.dto.summary.sessionId;
  return change.dto !== null && 'sessionId' in change.dto ? change.dto.sessionId : undefined;
}
export function previousReceiptOwnerSession(database: DatabaseSync, metadata: SqliteProjectionCatalogMetadataCache,
  change: StoredProjectionChange, cursor: number): string | undefined {
  if (change.feature === 'runs') {
    const row = database.prepare(`SELECT ${CATALOG_VERSION_HEADER_COLUMNS} FROM projection_versions WHERE feature='runs'
      AND aggregate_id=? AND aggregate_version<? AND commit_cursor<? AND operation='upsert' ORDER BY aggregate_version DESC LIMIT 1`)
      .get(change.aggregateId, change.aggregateVersion, cursor) as unknown as CatalogVersionHeader | undefined;
    const old = row === undefined ? null : metadata.read(row); return old?.feature === 'runs' ? old.dto.sessionId : undefined;
  }
  const row = database.prepare(`SELECT * FROM projection_versions WHERE feature=? AND aggregate_id=? AND aggregate_version<?
    AND commit_cursor<? AND operation='upsert' ORDER BY aggregate_version DESC LIMIT 1`)
    .get(change.feature, change.aggregateId, change.aggregateVersion, cursor) as unknown as StoredVersionRow | undefined;
  try { return row === undefined ? undefined : receiptOwnerSession(storedVersionRowAsChange(row)); }
  catch { throw markAuthorityIntegrityError('projection', new Error('public_projection_storage_corruption:receipt_scan:previous_invalid')); }
}
