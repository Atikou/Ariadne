import { markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { assertRunDocumentQueryResult, canonicalPublicProjectionJson, comparePublicProjectionMessages, messageMetadataOf,
  messageMetadataDigestData, MAX_RUN_DOCUMENT_QUERY_BYTES, MESSAGE_METADATA_QUERY_VERSION,
  publicMessageMetadataSchema, publicMessageBodyReferenceSchema, publicMessageBodyRequestSchema, publicMessageBodyResultSchema,
  publicMessageMetadataWindowRequestSchema, publicMessageMetadataWindowResultSchema, publicMessageMetadataRowSchema,
  publicProjectionCanonicalIdSchema, publicProjectionDigestSchema,
  type PublicMessageBodyReference, type PublicMessageMetadataRow, type PublicMessageMetadataWindowResult,
  type PublicMessageBodyResult, type PublicProjectionCatalogManifest } from '@ariadne/protocol/public';
import type { SqliteProjectionSnapshotReader, SnapshotVersionRow } from './SqliteProjectionSnapshotReader.js';
import type { SqliteProjectionCatalogMetadataCache } from './SqliteProjectionCatalogMetadataCache.js';
import { projectionDigest, storedVersionRowAsChange } from './StoredProjectionRecords.js';
import { SqliteMessageMetadataSources, type MessageMetadataSourceRow, type MessageMetadataOrderKey } from './SqliteMessageMetadataSources.js';
import type { SqliteRunDocumentQueryReader, RunDocumentMetadataReadView } from './SqliteRunDocumentQueryReader.js';

type Reset = Extract<PublicMessageMetadataWindowResult, { status: 'reset_required' }>;
const bodyClaims = z.object({ kind: z.literal('message-body.v1'), snapshotId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema, boundaryCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  boundaryDigest: publicProjectionDigestSchema, ...publicMessageBodyReferenceSchema.omit({ bodyCursor: true }).shape }).strict();

/** Bodies remain in their immutable source. A window retains at most four
 * bounded legacy parents; document candidates select only metadata/proofs. */
export class SqliteMessageMetadataQueryReader {
  constructor(private readonly database: DatabaseSync, private readonly snapshots: SqliteProjectionSnapshotReader,
    private readonly metadata: SqliteProjectionCatalogMetadataCache, private readonly documents: SqliteRunDocumentQueryReader,
    private readonly streamId: string) {}
  window(value: unknown): PublicMessageMetadataWindowResult {
    return assertRunDocumentQueryResult(publicMessageMetadataWindowResultSchema, this.fenced(() => {
      const request = publicMessageMetadataWindowRequestSchema.parse(value), manifest = this.resolve(request);
      if ('status' in manifest) return manifest;
      const sources = new SqliteMessageMetadataSources(this.database, manifest);
      const views = new Map<string, RunDocumentMetadataReadView>();
      const row = (source: MessageMetadataSourceRow): PublicMessageMetadataRow => {
        let metadata: ReturnType<typeof publicMessageMetadataSchema.parse>;
        try { metadata = publicMessageMetadataSchema.parse(JSON.parse(source.metadata_json)); }
        catch { throw corruption('metadata_schema_invalid'); }
        if (metadata.messageId !== source.message_id || manifest.scope.kind !== 'session' || metadata.sessionId !== manifest.scope.sessionId) throw corruption('row_owner_mismatch');
        if (source.kind === 'message') {
          if (source.feature !== 'messages' || source.operation !== 'upsert' || metadata.version !== source.aggregate_version
            || source.aggregate_id !== metadata.messageId) throw corruption('message_identity_mismatch');
          return publicMessageMetadataRowSchema.parse({ kind: 'message', metadata, body: this.reference(manifest, source, metadata) });
        }
        if (source.feature !== 'runs' || source.item_ordinal === null || !Number.isSafeInteger(source.item_ordinal) || source.item_ordinal < 0) throw corruption('document_identity_mismatch');
        let view = views.get(source.aggregate_id);
        if (view === undefined) {
          let opened: ReturnType<SqliteRunDocumentQueryReader['openMetadataView']>;
          try { opened = this.documents.openMetadataView(manifest, source.aggregate_id); }
          catch { throw corruption('document_parent_invalid'); }
          if ('status' in opened) throw new SnapshotReset(opened);
          while (views.size >= 4) views.delete(views.keys().next().value!);
          views.set(source.aggregate_id, opened); view = opened;
        }
        if (view.document.runVersion !== source.aggregate_version || view.document.versionCommitCursor !== source.commit_cursor) throw corruption('document_version_mismatch');
        let proof: ReturnType<RunDocumentMetadataReadView['metadata']>;
        try { proof = view.metadata('interactionMessages', source.item_ordinal); }
        catch { throw corruption('document_proof_invalid'); }
        if (proof === null || proof.metadata.collection !== 'interactionMessages'
          || canonicalPublicProjectionJson(proof.metadata.value) !== canonicalPublicProjectionJson(metadata)) throw corruption('document_metadata_mismatch');
        return publicMessageMetadataRowSchema.parse({ kind: 'run_document', header: view.header, document: view.document, proof });
      };
      const descriptor = request.window;
      let anchor: PublicMessageMetadataRow | null = null;
      if (descriptor.kind !== 'latest') {
        const source = sources.anchor(descriptor.anchorMessageId);
        if (source === undefined) return { status: 'anchor_unavailable', queryContractVersion: MESSAGE_METADATA_QUERY_VERSION, manifest, window: descriptor };
        anchor = row(source);
      }
      const rows: PublicMessageMetadataRow[] = [];
      const envelope = { status: 'ok' as const, queryContractVersion: MESSAGE_METADATA_QUERY_VERSION, manifest, window: descriptor, anchor };
      const reserve = Buffer.byteLength(canonicalPublicProjectionJson({ ...envelope, rows: [], hasEarlier: false, hasLater: false,
        windowDigest: `sha256:${'0'.repeat(64)}` }));
      let bytes = 0;
      const admit = (candidate: PublicMessageMetadataRow) => {
        const size = Buffer.byteLength(canonicalPublicProjectionJson(candidate));
        if (reserve + bytes + size + rows.length > MAX_RUN_DOCUMENT_QUERY_BYTES) return false;
        rows.push(candidate); bytes += size; return true;
      };
      const older = sources.rows('older', descriptor.limit + 1, anchor === null ? undefined : key(anchor));
      let newer: IterableIterator<MessageMetadataSourceRow> | undefined;
      try {
        if (descriptor.kind === 'around' && anchor !== null) {
          if (!admit(anchor)) throw corruption('anchor_exceeds_capacity');
          newer = sources.rows('newer', descriptor.limit + 1, key(anchor));
          let olderDone = false, newerDone = false, turn = 0;
          while (rows.length < descriptor.limit && !(olderDone && newerDone)) {
            const takeOlder = !olderDone && (newerDone || turn++ % 2 === 0), candidate = takeOlder ? older.next() : newer.next();
            if (candidate.done) { if (takeOlder) olderDone = true; else newerDone = true; continue; }
            if (!admit(row(candidate.value))) break;
          }
        } else for (const source of older) { if (rows.length >= descriptor.limit || !admit(row(source))) break; }
      } finally { older.return?.(); newer?.return?.(); }
      rows.sort((a, b) => comparePublicProjectionMessages(messageMetadataOf(a), messageMetadataOf(b)));
      const first = rows[0], last = rows.at(-1);
      const payload = { ...envelope, rows, hasEarlier: first === undefined ? false : sources.exists('older', key(first)),
        hasLater: last === undefined ? anchor !== null : sources.exists('newer', key(last)) };
      return { ...payload, windowDigest: projectionDigest(canonicalPublicProjectionJson(payload)) };
    }));
  }
  body(value: unknown): PublicMessageBodyResult {
    return assertRunDocumentQueryResult(publicMessageBodyResultSchema, this.fenced(() => {
      const request = publicMessageBodyRequestSchema.parse(value), manifest = this.resolve(request);
      if ('status' in manifest) return manifest;
      const decoded = bodyClaims.safeParse(this.snapshots.verifyCursor(request.body.bodyCursor));
      if (!decoded.success || canonicalPublicProjectionJson(decoded.data) !== canonicalPublicProjectionJson(this.claims(manifest, request.body))) return this.reset('page_cursor_invalid');
      const source = this.database.prepare(`SELECT v.* FROM projection_versions v WHERE v.feature='messages' AND v.aggregate_id=?
        AND v.commit_cursor<=? ORDER BY v.aggregate_version DESC LIMIT 1`).get(request.body.messageId, manifest.boundaryCursor) as unknown as SnapshotVersionRow | undefined;
      if (source === undefined) throw corruption('body_version_missing');
      let change: ReturnType<typeof storedVersionRowAsChange>;
      try { change = storedVersionRowAsChange(source); } catch { throw corruption('body_record_invalid'); }
      if (change.feature !== 'messages' || change.dto === null || change.operation !== 'upsert' || manifest.scope.kind !== 'session'
        || change.dto.sessionId !== manifest.scope.sessionId) throw corruption('body_owner_mismatch');
      const { content: _content, ...metadata } = change.dto;
      if (canonicalPublicProjectionJson(this.reference(manifest, source, metadata)) !== canonicalPublicProjectionJson(request.body)) throw corruption('body_reference_mismatch');
      const payload = { status: 'ok' as const, queryContractVersion: MESSAGE_METADATA_QUERY_VERSION, manifest, body: request.body, message: change.dto };
      return { ...payload, bodyDigest: projectionDigest(canonicalPublicProjectionJson(payload)) };
    }));
  }
  private reference(manifest: PublicProjectionCatalogManifest, source: Omit<SnapshotVersionRow, 'dto_json'>,
    metadata: ReturnType<typeof publicMessageMetadataSchema.parse>): PublicMessageBodyReference {
    const fields = { messageId: metadata.messageId, messageVersion: metadata.version, versionCommitCursor: source.commit_cursor,
      projectedAt: source.projected_at, payloadDigest: source.payload_digest, metadataDigest: projectionDigest(messageMetadataDigestData(metadata)) };
    return publicMessageBodyReferenceSchema.parse({ ...fields, bodyCursor: this.snapshots.signCursor(this.claims(manifest, fields)) });
  }
  private claims(manifest: PublicProjectionCatalogManifest, body: Omit<PublicMessageBodyReference, 'bodyCursor'>) {
    if (manifest.scope.kind !== 'session') throw new Error('message_metadata_session_required');
    const { bodyCursor: _cursor, ...fields } = body as PublicMessageBodyReference;
    return { kind: 'message-body.v1', snapshotId: manifest.snapshotId, sessionId: manifest.scope.sessionId,
      boundaryCursor: manifest.boundaryCursor, boundaryDigest: manifest.boundaryDigest, ...fields };
  }
  private resolve(request: { queryContractVersion: string; manifest: PublicProjectionCatalogManifest }) {
    if (request.queryContractVersion !== MESSAGE_METADATA_QUERY_VERSION) return this.reset('contract_mismatch');
    return this.snapshots.resolveCatalog(request.manifest);
  }
  private reset(reason: Reset['reason']): Reset { return { status: 'reset_required', streamId: this.streamId, reason }; }
  private fenced<T>(read: () => T): T | Reset {
    this.metadata.assertStorageUnchanged();
    let result: T | Reset;
    try { result = read(); } catch (error) { if (!(error instanceof SnapshotReset)) throw error; result = error.result; }
    this.metadata.assertStorageUnchanged(); return result;
  }
}
class SnapshotReset extends Error { constructor(readonly result: Reset) { super(`message_metadata_snapshot_reset:${result.reason}`); } }
function corruption(reason: string) { return markAuthorityIntegrityError('projection', new Error(`public_projection_storage_corruption:message_metadata:${reason}`)); }
function key(row: PublicMessageMetadataRow): MessageMetadataOrderKey {
  const metadata = messageMetadataOf(row);
  return [metadata.createdAt, metadata.role === 'user' ? 0 : metadata.role === 'assistant' ? 1 : 2, metadata.messageId];
}
