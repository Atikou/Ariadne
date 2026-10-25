import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { PUBLIC_PROJECTION_GENESIS_DIGEST, MAX_PUBLIC_PROJECTION_PAGE_BYTES,
  assertProjectionCatalogResult, canonicalPublicProjectionJson, catalogRowKey, catalogRowMatches, compareCatalogRows,
  publicProjectionCatalogPageResultSchema, publicProjectionCatalogDetailResultSchema,
  publicProjectionCanonicalIdSchema, publicProjectionCanonicalTimestampSchema,
  publicProjectionDigestSchema, type PublicProjectionCatalogManifest, type PublicProjectionCatalogPageRequest,
  type PublicProjectionCatalogDetailRequest, type PublicProjectionChange,
  type PublicProjectionCatalogRow } from '@ariadne/protocol/public';
import type { SqliteProjectionSnapshotReader, SnapshotVersionRow } from './SqliteProjectionSnapshotReader.js';
import { CATALOG_VERSION_HEADER_COLUMNS, type CatalogVersionHeader,
  type SqliteProjectionCatalogMetadataCache } from './SqliteProjectionCatalogMetadataCache.js';

const cursorSchema = z.object({ kind: z.literal('catalog.v3'), snapshotId: publicProjectionCanonicalIdSchema,
  pageIndex: z.number().int().positive(), rank: z.number().int().min(0).max(1),
  at: publicProjectionCanonicalTimestampSchema, id: publicProjectionCanonicalIdSchema,
  previousPageDigest: publicProjectionDigestSchema }).strict();
const latestSql = `v.commit_cursor<=? AND NOT EXISTS (SELECT 1 FROM projection_versions newer
  WHERE newer.feature=v.feature AND newer.aggregate_id=v.aggregate_id
    AND newer.aggregate_version>v.aggregate_version AND newer.commit_cursor<=?)`;
type ChangeReader = (row: SnapshotVersionRow) => PublicProjectionChange;

export function readProjectionCatalogPage(database: DatabaseSync, reader: SqliteProjectionSnapshotReader,
  manifest: PublicProjectionCatalogManifest, request: PublicProjectionCatalogPageRequest, metadata: SqliteProjectionCatalogMetadataCache) {
  const decoded = request.pageCursor === undefined ? null : cursorSchema.safeParse(reader.verifyCursor(request.pageCursor));
  if (decoded !== null && (!decoded.success || decoded.data.snapshotId !== manifest.snapshotId)) {
    return { status: 'reset_required' as const, streamId: manifest.streamId, reason: 'page_cursor_invalid' as const };
  }
  const after = decoded?.success ? decoded.data : undefined;
  metadata.assertStorageUnchanged();
  const statusCounts: Record<string, number> = {}, decisionKindCounts: Record<string, number> = {};
  let totalRows = 0, eligibleRows = 0;
  const candidates: { row: PublicProjectionCatalogRow; bytes: number }[] = [];
  let candidateBytes = 0;
  const owners = new Map<string, boolean>();
  const selectedHeaders = database.prepare(`SELECT ${CATALOG_VERSION_HEADER_COLUMNS.split(', ').map(column => `v.${column}`).join(', ')}
    FROM projection_versions v WHERE v.feature=? AND ${latestSql} AND v.operation='upsert'
    ORDER BY v.aggregate_id`).iterate(manifest.feature, manifest.boundaryCursor, manifest.boundaryCursor);
  for (const value of selectedHeaders) {
    const row = metadata.read(value as unknown as CatalogVersionHeader);
    if (row === null || !catalogRowMatches(row, manifest)) continue;
    if ((manifest.scope.kind === 'tasks' || manifest.scope.kind === 'decisions') && manifest.scope.workspaceId !== undefined) {
      const sessionId = row.dto.sessionId;
      if (sessionId === undefined) continue;
      let owned = owners.get(sessionId);
      if (owned === undefined) {
        owned = metadata.sessionOwnsWorkspace(sessionId, manifest.scope.workspaceId, manifest.boundaryCursor);
        if (owners.size >= 128) owners.delete(owners.keys().next().value!);
        owners.set(sessionId, owned);
      }
      if (!owned) continue;
    }
    totalRows++; statusCounts[row.dto.status] = (statusCounts[row.dto.status] ?? 0) + 1;
    if (row.feature === 'decisions') decisionKindCounts[row.dto.kind] = (decisionKindCounts[row.dto.kind] ?? 0) + 1;
    const key = catalogRowKey(row);
    if (after !== undefined && (key.rank < after.rank || (key.rank === after.rank
      && (key.at > after.at || (key.at === after.at && key.id <= after.id))))) continue;
    eligibleRows++;
    let low = 0, high = candidates.length;
    while (low < high) { const middle = (low + high) >>> 1;
      if (compareCatalogRows(candidates[middle]!.row, row) < 0) low = middle + 1; else high = middle;
    }
    if (low > request.limit) continue;
    const bytes = Buffer.byteLength(canonicalPublicProjectionJson(row));
    candidates.splice(low, 0, { row, bytes }); candidateBytes += bytes;
    // A bounded best-page set, not an array of the complete directory. Keep
    // one overflow row only long enough to reject an oversized first row.
    while (candidates.length > request.limit + 1 || (candidateBytes > MAX_PUBLIC_PROJECTION_PAGE_BYTES && candidates.length > 1)) {
      candidateBytes -= candidates.pop()!.bytes;
    }
  }
  const rows: PublicProjectionCatalogRow[] = [];
  let hasMore = false;
  let bytes = 0;
  const envelope = { status: 'ok' as const, manifest, pageIndex: after?.pageIndex ?? 0,
    previousPageDigest: after?.previousPageDigest ?? PUBLIC_PROJECTION_GENESIS_DIGEST, totalRows, statusCounts, decisionKindCounts };
  const reserve = Buffer.byteLength(canonicalPublicProjectionJson({ ...envelope, rows: [], hasMore: true,
    pageDigest: PUBLIC_PROJECTION_GENESIS_DIGEST, nextPageCursor: 'x'.repeat(2048) }));
  for (const { row, bytes: size } of candidates) {
    if (rows.length >= request.limit || reserve + bytes + size + rows.length > MAX_PUBLIC_PROJECTION_PAGE_BYTES) {
      if (rows.length === 0) throw new Error('projection_catalog_row_exceeds_capacity');
      hasMore = true; break;
    }
    rows.push(row); bytes += size;
  }
  hasMore ||= eligibleRows > rows.length;
  metadata.assertStorageUnchanged();
  const payload = { ...envelope, rows, hasMore };
  const pageDigest = digest(canonicalPublicProjectionJson(payload));
  const last = rows.at(-1);
  return assertProjectionCatalogResult(publicProjectionCatalogPageResultSchema, { ...payload, pageDigest,
    ...(hasMore && last !== undefined ? { nextPageCursor: reader.signCursor({ kind: 'catalog.v3',
      snapshotId: manifest.snapshotId, pageIndex: envelope.pageIndex + 1, ...catalogRowKey(last), previousPageDigest: pageDigest }) } : {}) });
}

export function readProjectionCatalogDetail(database: DatabaseSync, reader: SqliteProjectionSnapshotReader,
  manifest: PublicProjectionCatalogManifest, request: PublicProjectionCatalogDetailRequest, changeFromRow: ChangeReader) {
  const scope = reader.scopePredicate(manifest.scope, manifest.boundaryCursor, false);
  const row = database.prepare(`SELECT v.* FROM projection_versions v WHERE v.feature=? AND v.aggregate_id=?
    AND ${latestSql} AND (${scope.sql}) LIMIT 1`).get(manifest.feature, request.aggregateId,
      manifest.boundaryCursor, manifest.boundaryCursor, ...scope.parameters) as unknown as SnapshotVersionRow | undefined;
  const change = row === undefined ? null : changeFromRow(row);
  const payload = { status: 'ok', manifest, aggregateId: request.aggregateId, change };
  return assertProjectionCatalogResult(publicProjectionCatalogDetailResultSchema, {
    ...payload, detailDigest: digest(canonicalPublicProjectionJson(payload)) });
}

function digest(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
