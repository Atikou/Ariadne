import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { canonicalPublicProjectionJson, MAX_PUBLIC_PROJECTION_PAGE_BYTES, type PublicProjectionChange,
  type PublicProjectionFeatureWindow, type PublicProjectionScope } from '@ariadne/protocol/public';
import type { SqliteProjectionSnapshotReader, SnapshotVersionRow } from './SqliteProjectionSnapshotReader.js';

/** Scope and C come directly from the caller's validated lease. This helper
 * does not create or convert manifests between representations. */
export function readProjectionFeatureWindowRows(database: DatabaseSync, reader: SqliteProjectionSnapshotReader,
  scopeValue: PublicProjectionScope, boundaryCursor: number, window: PublicProjectionFeatureWindow, reserveBytes: number,
  changeFromRow: (row: SnapshotVersionRow) => PublicProjectionChange):
  { status: 'anchor_unavailable' } | { status: 'ok'; changes: PublicProjectionChange[]; hasEarlier: boolean } {
  const scope = reader.scopePredicate(scopeValue, boundaryCursor, false);
  const predicates = ['v.feature=?', 'v.commit_cursor<=?', `NOT EXISTS (SELECT 1 FROM projection_versions newer
    WHERE newer.feature=v.feature AND newer.aggregate_id=v.aggregate_id AND newer.aggregate_version>v.aggregate_version
      AND newer.commit_cursor<=?)`, "v.operation='upsert'", `(${scope.sql})`];
  const parameters: SQLInputValue[] = [window.feature, boundaryCursor, boundaryCursor, ...scope.parameters];
  if (window.filter === 'streaming') predicates.push("json_extract(v.dto_json,'$.status')='streaming'");
  if (window.runIds !== undefined) {
    predicates.push(`json_extract(v.dto_json,'$.runId') IN (${window.runIds.map(() => '?').join(',')})`); parameters.push(...window.runIds);
  }
  if (window.beforeAggregateId !== undefined) {
    const anchor = database.prepare(`SELECT v.* FROM projection_versions v WHERE ${predicates.join(' AND ')} AND v.aggregate_id=? LIMIT 1`)
      .get(...parameters, window.beforeAggregateId) as unknown as SnapshotVersionRow | undefined;
    if (anchor === undefined) return { status: 'anchor_unavailable' };
    const change = changeFromRow(anchor); predicates.push('(v.projected_at<? OR (v.projected_at=? AND v.aggregate_id>?))');
    parameters.push(change.projectedAt, change.projectedAt, change.aggregateId);
  }
  parameters.push(window.limit + 1); const changes: PublicProjectionChange[] = [];
  let bytes = 0, hasEarlier = false;
  for (const value of database.prepare(`SELECT v.* FROM projection_versions v WHERE ${predicates.join(' AND ')}
    ORDER BY v.projected_at DESC, v.aggregate_id LIMIT ?`).iterate(...parameters)) {
    const change = changeFromRow(value as unknown as SnapshotVersionRow), size = Buffer.byteLength(canonicalPublicProjectionJson(change));
    if (changes.length >= window.limit || reserveBytes + bytes + size + changes.length > MAX_PUBLIC_PROJECTION_PAGE_BYTES) {
      if (changes.length === 0) throw new Error('projection_feature_window_entity_exceeds_capacity');
      hasEarlier = true; break;
    }
    changes.push(change); bytes += size;
  }
  return { status: 'ok', changes, hasEarlier };
}
