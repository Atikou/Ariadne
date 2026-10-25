import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { encodeProjectionCursorBytes, decodeProjectionCursorBytes } from './ProjectionSnapshotCursorEncoding.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  MAX_PUBLIC_PROJECTION_PAGE_BYTES,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST,
  PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION,
  assertPublicProjectionSnapshotPage,
  canonicalPublicProjectionJson,
  publicProjectionScopeFeatures,
  publicProjectionSnapshotBeginRequestSchema,
  publicProjectionSnapshotManifestSchema,
  publicProjectionSnapshotPageRequestSchema,
  type PublicProjectionChange,
  type PublicProjectionFeature,
  type PublicProjectionScope,
  type PublicProjectionSnapshotManifest,
  type PublicProjectionSnapshotPageResult
} from '@ariadne/protocol/public';
import { PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION, publicProjectionViewBeginRequestSchema,
  publicProjectionViewManifestSchema, publicProjectionViewPageRequestSchema, assertPublicProjectionViewPage,
  type PublicProjectionViewManifest, type PublicProjectionViewPageResult } from '@ariadne/protocol/public';
import { PUBLIC_PROJECTION_CATALOG_VERSION, publicProjectionCatalogBeginRequestSchema, publicProjectionCatalogManifestSchema,
  type PublicProjectionCatalogManifest } from '@ariadne/protocol/public';

export interface SnapshotVersionRow {
  readonly feature: PublicProjectionFeature;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly operation: 'upsert' | 'delete';
  readonly projected_at: string;
  readonly dto_json: string | null;
  readonly payload_digest: string;
  readonly commit_cursor: number;
  readonly change_index: number;
}

interface Continuation {
  readonly snapshotId: string;
  readonly pageIndex: number;
  readonly feature: string;
  readonly aggregateId: string;
  readonly previousPageDigest: string;
}

type Reset = Extract<PublicProjectionSnapshotPageResult, { status: 'reset_required' }>;
const SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_SNAPSHOTS = 64;

/** Versioned reads at C; no transaction or complete snapshot survives an IPC request. */
export class SqliteProjectionSnapshotReader {
  private readonly generations = new Map<string, PublicProjectionSnapshotManifest | PublicProjectionViewManifest | PublicProjectionCatalogManifest>();
  private readonly cursorKey = randomBytes(32);

  constructor(
    private readonly database: DatabaseSync,
    private readonly streamId: string,
    private readonly now: () => Date,
    private readonly boundary: () => { readonly cursor: number; readonly cursorDigest: string },
    private readonly boundaryDigest: (cursor: number) => string | undefined,
    private readonly changeFromRow: (row: SnapshotVersionRow) => PublicProjectionChange
  ) {}

  begin(value: unknown): PublicProjectionSnapshotManifest | Reset {
    const request = publicProjectionSnapshotBeginRequestSchema.parse(value);
    if (request.pageContractVersion !== PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION) return this.reset('contract_mismatch');
    this.purgeExpired();
    const boundary = this.boundary();
    if (request.scope.kind === 'session' && !this.sessionOwnsWorkspace(
      request.scope.sessionId, request.scope.workspaceId, boundary.cursor
    )) return this.reset('scope_mismatch');
    const capturedAt = this.now();
    const manifest = publicProjectionSnapshotManifestSchema.parse({
      pageContractVersion: PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION,
      projectionContractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      snapshotId: randomUUID(), streamId: this.streamId,
      boundaryCursor: boundary.cursor, boundaryDigest: boundary.cursorDigest,
      scope: request.scope, capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(capturedAt.getTime() + SNAPSHOT_TTL_MS).toISOString()
    });
    while (this.generations.size >= MAX_SNAPSHOTS) {
      const oldest = this.generations.keys().next().value;
      if (oldest !== undefined) this.generations.delete(oldest);
    }
    this.generations.set(manifest.snapshotId, structuredClone(manifest));
    return manifest;
  }

  page(value: unknown): PublicProjectionSnapshotPageResult {
    return assertPublicProjectionSnapshotPage(this.pageNow(publicProjectionSnapshotPageRequestSchema.parse(value), PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION));
  }

  beginView(value: unknown): PublicProjectionViewManifest | Reset {
    const request = publicProjectionViewBeginRequestSchema.parse(value);
    if (request.pageContractVersion !== PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION) return this.reset('contract_mismatch');
    const captured = this.begin({ pageContractVersion: PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION, scope: request.scope });
    if ('status' in captured) return captured;
    const manifest = publicProjectionViewManifestSchema.parse({ ...captured,
      pageContractVersion: PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION, selectedFeatures: request.features });
    this.generations.set(manifest.snapshotId, structuredClone(manifest));
    return manifest;
  }

  pageView(value: unknown): PublicProjectionViewPageResult {
    return assertPublicProjectionViewPage(this.pageNow(publicProjectionViewPageRequestSchema.parse(value), PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION));
  }

  beginCatalog(value: unknown): PublicProjectionCatalogManifest | Reset {
    const request = publicProjectionCatalogBeginRequestSchema.parse(value);
    if (request.pageContractVersion !== PUBLIC_PROJECTION_CATALOG_VERSION) return this.reset('contract_mismatch');
    const captured = this.begin({ pageContractVersion: PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION, scope: request.scope });
    if ('status' in captured) return captured;
    const manifest = publicProjectionCatalogManifestSchema.parse({ ...captured,
      pageContractVersion: PUBLIC_PROJECTION_CATALOG_VERSION, feature: request.feature, filter: request.filter });
    this.generations.set(manifest.snapshotId, structuredClone(manifest));
    return manifest;
  }

  resolveCatalog(value: PublicProjectionCatalogManifest): PublicProjectionCatalogManifest | Reset {
    if (value.streamId !== this.streamId) return this.reset('stream_mismatch');
    this.purgeExpired();
    const stored = this.generations.get(value.snapshotId);
    if (stored === undefined) return this.reset('snapshot_expired');
    if (stored.pageContractVersion !== PUBLIC_PROJECTION_CATALOG_VERSION) return this.reset('contract_mismatch');
    if (canonicalPublicProjectionJson(stored) !== canonicalPublicProjectionJson(value)) return this.reset('scope_mismatch');
    if (this.boundaryDigest(stored.boundaryCursor) !== stored.boundaryDigest) return this.reset('history_unavailable');
    return stored;
  }

  resolveView(value: PublicProjectionViewManifest): PublicProjectionViewManifest | Reset {
    if (value.streamId !== this.streamId) return this.reset('stream_mismatch');
    this.purgeExpired();
    const stored = this.generations.get(value.snapshotId);
    if (stored === undefined) return this.reset('snapshot_expired');
    if (stored.pageContractVersion !== PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION) return this.reset('contract_mismatch');
    if (canonicalPublicProjectionJson(stored) !== canonicalPublicProjectionJson(value)) return this.reset('scope_mismatch');
    if (this.boundaryDigest(stored.boundaryCursor) !== stored.boundaryDigest) return this.reset('history_unavailable');
    return stored;
  }

  private pageNow(request: ReturnType<typeof publicProjectionSnapshotPageRequestSchema.parse>
    | ReturnType<typeof publicProjectionViewPageRequestSchema.parse>, version: '1.0' | '2.0') {
    if (request.pageContractVersion !== version) return this.reset('contract_mismatch');
    if (request.streamId !== this.streamId) return this.reset('stream_mismatch');
    this.purgeExpired();
    const manifest = this.generations.get(request.snapshotId);
    if (manifest === undefined) return this.reset('snapshot_expired');
    if (manifest.pageContractVersion !== version) return this.reset('contract_mismatch');
    if (manifest.pageContractVersion === PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION
      && (!('selectedFeatures' in request) || canonicalPublicProjectionJson(request.selectedFeatures)
        !== canonicalPublicProjectionJson(manifest.selectedFeatures))) return this.reset('scope_mismatch');
    if (canonicalPublicProjectionJson(request.scope) !== canonicalPublicProjectionJson(manifest.scope)) return this.reset('scope_mismatch');
    if (request.boundaryCursor !== manifest.boundaryCursor || request.boundaryDigest !== manifest.boundaryDigest) return this.reset('boundary_mismatch');
    if (this.boundaryDigest(manifest.boundaryCursor) !== manifest.boundaryDigest) return this.reset('history_unavailable');
    const continuation = request.pageCursor === undefined ? {
      snapshotId: manifest.snapshotId, pageIndex: 0, feature: '', aggregateId: '',
      previousPageDigest: PUBLIC_PROJECTION_GENESIS_DIGEST
    } : this.decodeCursor(request.pageCursor, manifest.snapshotId);
    if (continuation === null) return this.reset('page_cursor_invalid');

    const { sql, parameters } = this.query(manifest, continuation, request.limit + 1);
    const changes: PublicProjectionChange[] = [];
    let hasMore = false;
    let last: SnapshotVersionRow | undefined;
    let rowBytes = 0;
    for (const value of this.database.prepare(sql).iterate(...parameters)) {
      const row = value as unknown as SnapshotVersionRow;
      const change = this.changeFromRow(row);
      const candidateBytes = Buffer.byteLength(canonicalPublicProjectionJson(change));
      // Reserve the entire continuation envelope, not only the row payloads.
      const envelopeBytes = Buffer.byteLength(canonicalPublicProjectionJson({
        status: 'ok', manifest, pageIndex: continuation.pageIndex,
        previousPageDigest: continuation.previousPageDigest,
        pageDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
        changes: [], hasMore: false, nextPageCursor: 'x'.repeat(2048)
      }));
      if (changes.length >= request.limit
        || envelopeBytes + rowBytes + candidateBytes + changes.length > MAX_PUBLIC_PROJECTION_PAGE_BYTES) {
        if (changes.length === 0) throw new Error('public_projection_entity_exceeds_page_capacity');
        hasMore = true;
        break;
      }
      changes.push(change);
      rowBytes += candidateBytes;
      last = row;
    }
    const payload = {
      status: 'ok' as const, manifest, pageIndex: continuation.pageIndex,
      previousPageDigest: continuation.previousPageDigest, changes, hasMore
    };
    const pageDigest = sha256(canonicalPublicProjectionJson(payload));
    const page = {
      ...payload, pageDigest,
      ...(hasMore && last !== undefined ? { nextPageCursor: this.encodeCursor({
        snapshotId: manifest.snapshotId, pageIndex: continuation.pageIndex + 1,
        feature: last.feature, aggregateId: last.aggregate_id, previousPageDigest: pageDigest
      }) } : {})
    };
    return page;
  }

  private query(manifest: PublicProjectionSnapshotManifest | PublicProjectionViewManifest, after: Continuation, limit: number): {
    readonly sql: string; readonly parameters: SQLInputValue[]
  } {
    const features = manifest.pageContractVersion === PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION
      ? manifest.selectedFeatures : publicProjectionScopeFeatures(manifest.scope);
    const scope = this.scopePredicate(manifest.scope, manifest.boundaryCursor);
    return {
      sql: `SELECT v.* FROM projection_versions v
        WHERE v.feature IN (${features.map(() => '?').join(',')})
          AND (v.feature > ? OR (v.feature = ? AND v.aggregate_id > ?))
          AND v.commit_cursor <= ?
          AND NOT EXISTS (SELECT 1 FROM projection_versions newer
            WHERE newer.feature=v.feature AND newer.aggregate_id=v.aggregate_id
              AND newer.aggregate_version>v.aggregate_version AND newer.commit_cursor<=?)
          AND (${scope.sql})
        ORDER BY v.feature, v.aggregate_id LIMIT ?`,
      parameters: [...features, after.feature, after.feature, after.aggregateId,
        manifest.boundaryCursor, manifest.boundaryCursor, ...scope.parameters, limit]
    };
  }

  scopePredicate(scope: PublicProjectionScope, boundary: number, pendingOnly = true): { sql: string; parameters: SQLInputValue[] } {
    // Tombstone ownership is read from its last immutable non-null version.
    const dto = `COALESCE(v.dto_json, (SELECT previous.dto_json FROM projection_versions previous
      WHERE previous.feature=v.feature AND previous.aggregate_id=v.aggregate_id
        AND previous.aggregate_version<v.aggregate_version AND previous.dto_json IS NOT NULL
      ORDER BY previous.aggregate_version DESC LIMIT 1))`;
    const sessionId = `COALESCE(json_extract(${dto}, '$.summary.sessionId'), json_extract(${dto}, '$.sessionId'))`;
    if (scope.kind === 'session') return { sql: `${sessionId}=?`, parameters: [scope.sessionId] };
    const pending = pendingOnly && scope.kind === 'decisions' ? "v.operation='upsert' AND json_extract(v.dto_json, '$.status')='pending'" : '1=1';
    if (scope.workspaceId === undefined) return { sql: pending, parameters: [] };
    if (scope.kind === 'directory') return {
      sql: `v.feature!='sessions' OR json_extract(${dto}, '$.workspaceId')=?`, parameters: [scope.workspaceId]
    };
    return {
      sql: `${pending} AND EXISTS (SELECT 1 FROM projection_versions session
        WHERE session.feature='sessions' AND session.aggregate_id=${sessionId}
          AND session.commit_cursor<=? AND json_extract(session.dto_json, '$.workspaceId')=?
          AND NOT EXISTS (SELECT 1 FROM projection_versions newerSession
            WHERE newerSession.feature='sessions' AND newerSession.aggregate_id=session.aggregate_id
              AND newerSession.aggregate_version>session.aggregate_version AND newerSession.commit_cursor<=?))`,
      parameters: [boundary, scope.workspaceId, boundary]
    };
  }

  private sessionOwnsWorkspace(sessionId: string, workspaceId: string, boundary: number): boolean {
    const row = this.database.prepare(`SELECT * FROM projection_versions
      WHERE feature='sessions' AND aggregate_id=? AND commit_cursor<=?
      ORDER BY aggregate_version DESC LIMIT 1`).get(sessionId, boundary) as unknown as SnapshotVersionRow | undefined;
    const change = row === undefined ? undefined : this.changeFromRow(row);
    return change?.feature === 'sessions' && change.dto !== null && change.dto.workspaceId === workspaceId;
  }

  signCursor(value: unknown): string {
    const payload = encodeProjectionCursorBytes(Buffer.from(canonicalPublicProjectionJson(value)));
    return `${payload}.${encodeProjectionCursorBytes(createHmac('sha256', this.cursorKey).update(payload).digest())}`;
  }

  verifyCursor(token: string): unknown | null {
    const [payload, signature, extra] = token.split('.');
    if (payload === undefined || signature === undefined || extra !== undefined) return null;
    const expected = createHmac('sha256', this.cursorKey).update(payload).digest();
    const supplied = decodeProjectionCursorBytes(signature), decoded = decodeProjectionCursorBytes(payload);
    if (supplied === null || decoded === null) return null;
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    try { return JSON.parse(decoded.toString('utf8')); }
    catch { return null; }
  }

  private encodeCursor(value: Continuation): string { return this.signCursor(value); }

  private decodeCursor(token: string, snapshotId: string): Continuation | null {
    try {
      const value = this.verifyCursor(token) as Continuation | null;
      if (value === null || value.snapshotId !== snapshotId || !Number.isSafeInteger(value.pageIndex) || value.pageIndex < 1
        || typeof value.feature !== 'string' || typeof value.aggregateId !== 'string'
        || !/^sha256:[0-9a-f]{64}$/u.test(value.previousPageDigest)) return null;
      return value;
    } catch { return null; }
  }

  private purgeExpired(): void {
    const now = this.now().toISOString();
    for (const [id, manifest] of this.generations) if (manifest.expiresAt <= now) this.generations.delete(id);
  }

  private reset(reason: Reset['reason']): Reset { return { status: 'reset_required', reason, streamId: this.streamId }; }
}

function sha256(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
