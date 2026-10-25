import { markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { assertRunDocumentQueryResult, canonicalPublicProjectionJson, isRunDocumentChange,
  MAX_RUN_DOCUMENT_QUERY_BYTES, PUBLIC_PROJECTION_GENESIS_DIGEST, RUN_DOCUMENT_QUERY_VERSION,
  publicRunDocumentRootRequestSchema, publicRunDocumentRootResultSchema,
  publicRunDocumentMetadataRequestSchema, publicRunDocumentMetadataResultSchema,
  publicRunDocumentInboxRequestSchema, publicRunDocumentInboxResultSchema,
  publicRunDocumentChunkRequestSchema, publicRunDocumentChunkResultSchema,
  publicProjectionCanonicalIdSchema, publicProjectionDigestSchema, RUN_DOCUMENT_COLLECTIONS,
  type PublicRunDocumentHeader, type PublicRunDocumentReference, type PublicRunDocumentMetadataProof,
  type PublicRunDocumentRootResult, type PublicRunDocumentMetadataResult, type PublicRunDocumentInboxResult,
  type PublicRunDocumentChunkResult, type PublicProjectionCatalogManifest } from '@ariadne/protocol/public';
import type { RunDocumentPlan } from '../../projection/RunDocumentPlan.js';
import type { SqliteProjectionSnapshotReader, SnapshotVersionRow } from './SqliteProjectionSnapshotReader.js';
import type { SqliteProjectionCatalogMetadataCache } from './SqliteProjectionCatalogMetadataCache.js';
import { deriveLegacyRunDocument, projectionDigest, storedVersionRowAsChange } from './StoredProjectionRecords.js';
import { SqliteRunDocumentPreparation } from './SqliteRunDocumentPreparation.js';

type Collection = typeof RUN_DOCUMENT_COLLECTIONS[number];
type Reset = Extract<PublicRunDocumentRootResult, { status: 'reset_required' }>;
interface Context { header: PublicRunDocumentHeader; document: PublicRunDocumentReference; legacy?: RunDocumentPlan }
export interface RunDocumentMetadataReadView {
  readonly header: PublicRunDocumentHeader;
  readonly document: PublicRunDocumentReference;
  metadata(collection: Collection, ordinal: number): PublicRunDocumentMetadataProof | null;
}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const claims = { snapshotId: publicProjectionCanonicalIdSchema, runId: publicProjectionCanonicalIdSchema,
  runVersion: integer.positive(), documentDigest: publicProjectionDigestSchema, versionCommitCursor: integer.positive(),
  boundaryCursor: integer, boundaryDigest: publicProjectionDigestSchema };
const bodyToken = z.object({ kind: z.literal('run-document.v1'), ...claims }).strict();
const pageToken = z.object({ kind: z.literal('run-document-items.v1'), ...claims,
  collection: z.enum(RUN_DOCUMENT_COLLECTIONS), nextOrdinal: integer.positive(), pageIndex: integer.positive(),
  previousPageDigest: publicProjectionDigestSchema }).strict();

/** Uses the owner's existing connection, snapshot leases and foreign-write
 * fence. Only one requested chunk is loaded; metadata queries never select a
 * chunk BLOB. Legacy 5.0 bodies are bounded by their original Commit contract. */
export class SqliteRunDocumentQueryReader {
  private readonly prepared: SqliteRunDocumentPreparation;
  constructor(private readonly database: DatabaseSync, private readonly snapshots: SqliteProjectionSnapshotReader,
    private readonly metadata: SqliteProjectionCatalogMetadataCache, private readonly streamId: string) {
    this.prepared = new SqliteRunDocumentPreparation(database);
  }
  root(value: unknown): PublicRunDocumentRootResult {
    return assertRunDocumentQueryResult(publicRunDocumentRootResultSchema, this.fenced(() => {
      const request = publicRunDocumentRootRequestSchema.parse(value);
      const manifest = this.manifest(request); if ('status' in manifest) return manifest;
      const row = this.version(manifest, request.runId);
      const unavailable = (reason: 'not_found' | 'deleted' | 'version_mismatch') => ({ status: 'unavailable' as const,
        queryContractVersion: RUN_DOCUMENT_QUERY_VERSION, manifest, runId: request.runId, reason });
      if (row === undefined) return unavailable('not_found');
      if (row.operation === 'delete') { storedVersionRowAsChange(row); return unavailable('deleted'); }
      if (request.expectedRunVersion !== undefined && request.expectedRunVersion !== row.aggregate_version) return unavailable('version_mismatch');
      const context = this.context(manifest, row);
      const payload = this.envelope(manifest, context);
      return assertRunDocumentQueryResult(publicRunDocumentRootResultSchema, { ...payload,
        rootDigest: projectionDigest(canonicalPublicProjectionJson(payload)) });
    }));
  }
  /** One request may retain at most a few of these views. No view is cached by
   * this owner: a legacy view holds only its original bounded Commit body. */
  openMetadataView(value: PublicProjectionCatalogManifest, runId: string): RunDocumentMetadataReadView | Reset {
    return this.fenced(() => {
      const request = publicRunDocumentRootRequestSchema.parse({ queryContractVersion: RUN_DOCUMENT_QUERY_VERSION, manifest: value, runId });
      const manifest = this.manifest(request); if ('status' in manifest) return manifest;
      const row = this.version(manifest, runId);
      if (row === undefined || row.operation !== 'upsert') throw markAuthorityIntegrityError('projection', new Error('public_projection_storage_corruption:message_metadata:parent_unavailable'));
      const context = this.context(manifest, row);
      return { header: context.header, document: context.document,
        metadata: (collection: Collection, ordinal: number) => this.fenced(() => this.itemMetadata(context, collection, ordinal)) };
    });
  }
  metadataPage(value: unknown): PublicRunDocumentMetadataResult {
    return assertRunDocumentQueryResult(publicRunDocumentMetadataResultSchema, this.fenced(() => {
      const request = publicRunDocumentMetadataRequestSchema.parse(value), resolved = this.resolve(request);
      if ('status' in resolved) return resolved;
      const { manifest, context } = resolved;
      const parsed = request.pageCursor === undefined ? undefined : pageToken.safeParse(this.snapshots.verifyCursor(request.pageCursor));
      if (parsed !== undefined && (!parsed.success || parsed.data.collection !== request.collection
        || canonicalPublicProjectionJson(this.tokenClaims(manifest, context.document)) !== canonicalPublicProjectionJson(this.onlyClaims(parsed.data)))) {
        return this.reset('page_cursor_invalid');
      }
      const after = parsed?.success ? parsed.data : undefined;
      const startOrdinal = after?.nextOrdinal ?? 0, count = context.header.collections[request.collection].itemCount;
      if (startOrdinal > count || (after !== undefined && startOrdinal === count)) return this.reset('page_cursor_invalid');
      const rows: PublicRunDocumentMetadataProof[] = [];
      const envelope = { ...this.envelope(manifest, context), collection: request.collection, startOrdinal,
        pageIndex: after?.pageIndex ?? 0, previousPageDigest: after?.previousPageDigest ?? PUBLIC_PROJECTION_GENESIS_DIGEST };
      const reserve = Buffer.byteLength(canonicalPublicProjectionJson({ ...envelope, rows: [], hasMore: true,
        pageDigest: PUBLIC_PROJECTION_GENESIS_DIGEST, nextPageCursor: 'x'.repeat(2048) }));
      let bytes = 0;
      for (let ordinal = startOrdinal; ordinal < count && rows.length < request.limit; ordinal++) {
        const proof = this.itemMetadata(context, request.collection, ordinal);
        if (proof === null) throw new Error('run_document_query_metadata_coverage_missing');
        const size = Buffer.byteLength(canonicalPublicProjectionJson(proof));
        if (reserve + bytes + size + rows.length > MAX_RUN_DOCUMENT_QUERY_BYTES) {
          if (rows.length === 0) throw new Error('run_document_query_metadata_row_exceeds_capacity');
          break;
        }
        rows.push(proof); bytes += size;
      }
      const hasMore = startOrdinal + rows.length < count, payload = { ...envelope, rows, hasMore };
      const pageDigest = projectionDigest(canonicalPublicProjectionJson(payload));
      return assertRunDocumentQueryResult(publicRunDocumentMetadataResultSchema, { ...payload, pageDigest,
        ...(hasMore ? { nextPageCursor: this.snapshots.signCursor({ kind: 'run-document-items.v1',
          ...this.tokenClaims(manifest, context.document), collection: request.collection,
          nextOrdinal: startOrdinal + rows.length, pageIndex: envelope.pageIndex + 1, previousPageDigest: pageDigest }) } : {}) });
    }));
  }
  inbox(value: unknown): PublicRunDocumentInboxResult {
    return assertRunDocumentQueryResult(publicRunDocumentInboxResultSchema, this.fenced(() => {
      const request = publicRunDocumentInboxRequestSchema.parse(value), resolved = this.resolve(request);
      if ('status' in resolved) return resolved;
      const { manifest, context } = resolved;
      let ordinal: number | undefined;
      if (context.legacy !== undefined) {
        for (let index = 0; index < context.header.collections.inbox.itemCount; index++) {
          const metadata = context.legacy.itemMetadata('inbox', index);
          if (metadata.collection === 'inbox' && metadata.value.inputId === request.inputId) { ordinal = index; break; }
        }
      } else {
        const count = this.database.prepare(`SELECT COUNT(*) AS count FROM projection_run_document_items
          WHERE run_id=? AND run_version=? AND collection='inbox'`).get(context.document.runId, context.document.runVersion)!;
        if (count.count !== context.header.collections.inbox.itemCount) throw new Error('run_document_query_inbox_coverage_missing');
        const row = this.database.prepare(`SELECT item_ordinal FROM projection_run_document_items
          WHERE run_id=? AND run_version=? AND collection='inbox' AND item_id=?`)
          .get(context.document.runId, context.document.runVersion, request.inputId);
        if (row !== undefined) ordinal = Number(row.item_ordinal);
      }
      const proof = ordinal === undefined ? null : this.itemMetadata(context, 'inbox', ordinal);
      if (ordinal !== undefined && proof === null) throw new Error('run_document_query_inbox_coverage_missing');
      const payload = { ...this.envelope(manifest, context), inputId: request.inputId, proof };
      return assertRunDocumentQueryResult(publicRunDocumentInboxResultSchema, { ...payload,
        resultDigest: projectionDigest(canonicalPublicProjectionJson(payload)) });
    }));
  }
  chunk(value: unknown): PublicRunDocumentChunkResult {
    return assertRunDocumentQueryResult(publicRunDocumentChunkResultSchema, this.fenced(() => {
      const request = publicRunDocumentChunkRequestSchema.parse(value), resolved = this.resolve(request);
      if ('status' in resolved) return resolved;
      const { manifest, context } = resolved;
      const positions = { collection: request.collection, itemOrdinal: request.itemOrdinal, chunkOrdinal: request.chunkOrdinal };
      let leaf = null;
      if (request.itemOrdinal < context.header.collections[request.collection].itemCount) {
        if (context.legacy !== undefined) {
          for (const candidate of context.legacy.itemLeaves(request.collection, request.itemOrdinal)) {
            if (candidate.descriptor.chunkOrdinal === request.chunkOrdinal) { leaf = candidate; break; }
          }
        } else leaf = this.prepared.readItemLeafSync(context.header, request.collection, request.itemOrdinal, request.chunkOrdinal);
      }
      if (leaf === null) return assertRunDocumentQueryResult(publicRunDocumentChunkResultSchema, {
        status: 'item_unavailable', queryContractVersion: RUN_DOCUMENT_QUERY_VERSION, manifest, document: context.document, ...positions });
      const payload = { ...this.envelope(manifest, context), ...positions, leaf };
      return assertRunDocumentQueryResult(publicRunDocumentChunkResultSchema, { ...payload,
        resultDigest: projectionDigest(canonicalPublicProjectionJson(payload)) });
    }));
  }
  private itemMetadata(context: Context, collection: Collection, ordinal: number): PublicRunDocumentMetadataProof | null {
    if (context.legacy === undefined) return this.prepared.readItemMetadataSync(context.header, collection, ordinal);
    const first = context.legacy.itemLeaves(collection, ordinal).next().value;
    if (first === undefined) throw new Error('run_document_query_legacy_proof_missing');
    return { descriptor: first.descriptor, siblings: first.siblings, metadata: context.legacy.itemMetadata(collection, ordinal) };
  }
  private manifest(request: { queryContractVersion: string; manifest: PublicProjectionCatalogManifest }) {
    if (request.queryContractVersion !== RUN_DOCUMENT_QUERY_VERSION) return this.reset('contract_mismatch');
    return this.snapshots.resolveCatalog(request.manifest);
  }
  private resolve(request: { queryContractVersion: string; manifest: PublicProjectionCatalogManifest; document: PublicRunDocumentReference }) {
    const manifest = this.manifest(request); if ('status' in manifest) return manifest;
    const token = bodyToken.safeParse(this.snapshots.verifyCursor(request.document.bodyCursor));
    if (!token.success || canonicalPublicProjectionJson(this.onlyClaims(token.data))
      !== canonicalPublicProjectionJson(this.tokenClaims(manifest, request.document))) return this.reset('page_cursor_invalid');
    const row = this.version(manifest, request.document.runId);
    if (row === undefined || row.operation === 'delete' || row.aggregate_version !== request.document.runVersion
      || row.commit_cursor !== request.document.versionCommitCursor) return this.reset('boundary_mismatch');
    const context = this.context(manifest, row);
    if (canonicalPublicProjectionJson(context.document) !== canonicalPublicProjectionJson(request.document)) return this.reset('boundary_mismatch');
    return { manifest, context };
  }
  private version(manifest: PublicProjectionCatalogManifest, runId: string): SnapshotVersionRow | undefined {
    const scope = this.snapshots.scopePredicate(manifest.scope, manifest.boundaryCursor, false);
    return this.database.prepare(`SELECT v.* FROM projection_versions v WHERE v.feature='runs' AND v.aggregate_id=?
      AND v.commit_cursor<=? AND NOT EXISTS (SELECT 1 FROM projection_versions newer WHERE newer.feature=v.feature
        AND newer.aggregate_id=v.aggregate_id AND newer.aggregate_version>v.aggregate_version AND newer.commit_cursor<=?)
      AND (${scope.sql}) LIMIT 1`).get(runId, manifest.boundaryCursor, manifest.boundaryCursor, ...scope.parameters) as unknown as SnapshotVersionRow | undefined;
  }
  private context(manifest: PublicProjectionCatalogManifest, row: SnapshotVersionRow): Context {
    const change = storedVersionRowAsChange(row); let header: PublicRunDocumentHeader, legacy: RunDocumentPlan | undefined;
    if (isRunDocumentChange(change)) {
      header = change.dto;
      const published = this.database.prepare(`SELECT header_json,document_digest,published_cursor,preparation_state
        FROM projection_run_documents WHERE run_id=? AND run_version=?`).get(change.aggregateId, change.aggregateVersion);
      if (published?.published_cursor !== row.commit_cursor || published.preparation_state !== 'prepared'
        || published.document_digest !== header.documentDigest || published.header_json !== canonicalPublicProjectionJson(header)) {
        throw new Error('run_document_query_publication_link_mismatch');
      }
    } else { legacy = deriveLegacyRunDocument(change); header = legacy.header; }
    const document = { runId: header.summary.runId, runVersion: header.summary.version, documentDigest: header.documentDigest,
      versionCommitCursor: row.commit_cursor, bodyCursor: this.snapshots.signCursor({ kind: 'run-document.v1',
        ...this.tokenClaims(manifest, { runId: header.summary.runId, runVersion: header.summary.version,
          documentDigest: header.documentDigest, versionCommitCursor: row.commit_cursor }) }) };
    return { header, document, ...(legacy === undefined ? {} : { legacy }) };
  }
  private tokenClaims(manifest: PublicProjectionCatalogManifest, document: Omit<PublicRunDocumentReference, 'bodyCursor'>) {
    return { snapshotId: manifest.snapshotId, runId: document.runId, runVersion: document.runVersion,
      documentDigest: document.documentDigest, versionCommitCursor: document.versionCommitCursor,
      boundaryCursor: manifest.boundaryCursor, boundaryDigest: manifest.boundaryDigest };
  }
  private onlyClaims(value: z.infer<typeof bodyToken> | z.infer<typeof pageToken>) {
    return { snapshotId: value.snapshotId, runId: value.runId, runVersion: value.runVersion,
      documentDigest: value.documentDigest, versionCommitCursor: value.versionCommitCursor,
      boundaryCursor: value.boundaryCursor, boundaryDigest: value.boundaryDigest };
  }
  private envelope(manifest: PublicProjectionCatalogManifest, context: Context) {
    return { status: 'ok' as const, queryContractVersion: RUN_DOCUMENT_QUERY_VERSION, manifest,
      header: context.header, document: context.document };
  }
  private reset(reason: Reset['reason']): Reset { return { status: 'reset_required', streamId: this.streamId, reason }; }
  private fenced<T>(read: () => T): T {
    this.metadata.assertStorageUnchanged(); const result = read(); this.metadata.assertStorageUnchanged(); return result;
  }
}
