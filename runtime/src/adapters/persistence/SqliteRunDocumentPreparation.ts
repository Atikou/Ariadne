import { markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalPublicProjectionJson, publicRunDocumentHeaderSchema, RUN_DOCUMENT_COLLECTIONS,
  RunDocumentItemAssembler, runDocumentItemId, runDocumentItemMetadata, verifyRunDocumentHeader,
  verifyRunDocumentHeaderSteps, verifyRunDocumentLeafSteps, verifyRunDocumentItemMetadataSteps,
  type PublicRunDocumentHeader, type PublicRunDocumentLeaf } from '@ariadne/protocol/public';
import type { RunDocumentPlan } from '../../projection/RunDocumentPlan.js';
import { runDocumentCheckSync } from './RunDocumentSqliteVerifier.js';

type Collection = typeof RUN_DOCUMENT_COLLECTIONS[number];
interface LeafRow { leaf_index: number; descriptor_json: string; siblings_json: string; chunk_bytes: Uint8Array }

/** Same-owner preparation only: never creates a public Commit, head, cursor,
 * source checkpoint or ACK. Each complete validated item is one transaction. */
export class SqliteRunDocumentPreparation {
  constructor(private readonly database: DatabaseSync) {}

  async prepare(plan: RunDocumentPlan, afterItem?: () => void): Promise<PublicRunDocumentHeader> {
    const header = await verifyRunDocumentHeader(plan.header);
    const { runId, version } = header.summary;
    const headerJson = canonicalPublicProjectionJson(header);
    let foreignVersion = 0;
    this.transaction(() => {
      this.database.prepare(`INSERT OR IGNORE INTO projection_run_documents
        (run_id,run_version,document_digest,header_json,preparation_state) VALUES (?,?,?,?,'preparing')`)
        .run(runId, version, header.documentDigest, headerJson);
      const row = this.database.prepare('SELECT header_json,document_digest FROM projection_run_documents WHERE run_id=? AND run_version=?').get(runId, version);
      if (row?.header_json !== headerJson || row.document_digest !== header.documentDigest) throw new Error('run_document_preparation_identity_conflict');
      foreignVersion = this.dataVersion();
    });
    for (const collection of RUN_DOCUMENT_COLLECTIONS) {
      for (let ordinal = 0; ordinal < header.collections[collection].itemCount; ordinal++) {
        const assembler = new RunDocumentItemAssembler(header, collection, ordinal);
        // Bounded by the explicit single-item limit, never a whole Run.
        const leaves: PublicRunDocumentLeaf[] = []; let item = null;
        for (const leaf of plan.itemLeaves(collection, ordinal)) {
          item = await assembler.accept(leaf); leaves.push(leaf);
        }
        if (item === null || leaves.length === 0) throw new Error('run_document_preparation_incomplete_item');
        const first = leaves[0]!.descriptor;
        const metadataJson = canonicalPublicProjectionJson(runDocumentItemMetadata(item));
        this.transaction(() => {
          this.assertPreparationFence(header, headerJson, foreignVersion);
          this.database.prepare(`INSERT OR IGNORE INTO projection_run_document_items
            (run_id,run_version,collection,item_ordinal,item_id,first_leaf,chunk_count,metadata_json) VALUES (?,?,?,?,?,?,?,?)`)
            .run(runId, version, collection, ordinal, first.itemId, first.leafIndex, first.chunkCount, metadataJson);
          const stored = this.database.prepare(`SELECT item_id,first_leaf,chunk_count,metadata_json FROM projection_run_document_items
            WHERE run_id=? AND run_version=? AND collection=? AND item_ordinal=?`).get(runId, version, collection, ordinal);
          if (stored?.item_id !== first.itemId || stored.first_leaf !== first.leafIndex || stored.chunk_count !== first.chunkCount
            || stored.metadata_json !== metadataJson) throw new Error('run_document_preparation_item_conflict');
          const insert = this.database.prepare(`INSERT OR IGNORE INTO projection_run_document_leaves
            (run_id,run_version,collection,item_ordinal,chunk_ordinal,leaf_index,descriptor_json,siblings_json,chunk_bytes) VALUES (?,?,?,?,?,?,?,?,?)`);
          const read = this.database.prepare(`SELECT leaf_index,descriptor_json,siblings_json,chunk_bytes FROM projection_run_document_leaves
            WHERE run_id=? AND run_version=? AND collection=? AND item_ordinal=? AND chunk_ordinal=?`);
          for (const leaf of leaves) {
            const d = leaf.descriptor, descriptor = canonicalPublicProjectionJson(d), siblings = canonicalPublicProjectionJson(leaf.siblings);
            const bytes = Buffer.from(leaf.contentBase64, 'base64');
            insert.run(runId, version, collection, ordinal, d.chunkOrdinal, d.leafIndex, descriptor, siblings, bytes);
            const storedLeaf = read.get(runId, version, collection, ordinal, d.chunkOrdinal);
            if (storedLeaf?.leaf_index !== d.leafIndex || storedLeaf.descriptor_json !== descriptor || storedLeaf.siblings_json !== siblings
              || !(storedLeaf.chunk_bytes instanceof Uint8Array) || !bytes.equals(storedLeaf.chunk_bytes)) throw new Error('run_document_preparation_leaf_conflict');
          }
        });
        afterItem?.();
      }
    }
    this.transaction(() => {
      this.assertPreparationFence(header, headerJson, foreignVersion);
      for (const collection of RUN_DOCUMENT_COLLECTIONS) {
        const items = this.database.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(chunk_count),0) AS leaves FROM projection_run_document_items
          WHERE run_id=? AND run_version=? AND collection=?`).get(runId, version, collection)!;
        const leaves = this.database.prepare(`SELECT COUNT(*) AS count FROM projection_run_document_leaves
          WHERE run_id=? AND run_version=? AND collection=?`).get(runId, version, collection)!;
        const expected = header.collections[collection];
        if (items.count !== expected.itemCount || items.leaves !== expected.leafCount || leaves.count !== expected.leafCount) throw new Error('run_document_preparation_coverage_mismatch');
      }
      this.database.prepare(`UPDATE projection_run_documents SET preparation_state='prepared' WHERE run_id=? AND run_version=? AND document_digest=?`)
        .run(runId, version, header.documentDigest);
    });
    return header;
  }

  async readPreparedHeader(runId: string, version: number): Promise<PublicRunDocumentHeader | null> {
    return this.readPreparedHeaderSync(runId, version);
  }
  readPreparedHeaderSync(runId: string, version: number): PublicRunDocumentHeader | null {
    const row = this.database.prepare(`SELECT header_json,document_digest FROM projection_run_documents
      WHERE run_id=? AND run_version=? AND preparation_state='prepared'`).get(runId, version);
    if (!row) return null;
    const header = runDocumentCheckSync(verifyRunDocumentHeaderSteps(JSON.parse(String(row.header_json))));
    if (header.summary.runId !== runId || header.summary.version !== version || header.documentDigest !== row.document_digest
      || canonicalPublicProjectionJson(header) !== row.header_json) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_header_mismatch'));
    return header;
  }

  async readItemMetadata(header: PublicRunDocumentHeader, collection: Collection, ordinal: number) {
    return this.readItemMetadataSync(header, collection, ordinal);
  }
  readItemMetadataSync(header: PublicRunDocumentHeader, collection: Collection, ordinal: number) {
    this.assertPreparedIdentity(header);
    this.assertPosition(collection, ordinal);
    if (ordinal >= header.collections[collection].itemCount) return null;
    const row = this.database.prepare(`SELECT item_id,first_leaf,chunk_count,metadata_json FROM projection_run_document_items
      WHERE run_id=? AND run_version=? AND collection=? AND item_ordinal=?`).get(header.summary.runId, header.summary.version, collection, ordinal);
    if (!row) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_item_missing'));
    const first = this.database.prepare(`SELECT descriptor_json,siblings_json FROM projection_run_document_leaves
      WHERE run_id=? AND run_version=? AND collection=? AND item_ordinal=? AND chunk_ordinal=0`)
      .get(header.summary.runId, header.summary.version, collection, ordinal);
    if (!first) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_metadata_proof_missing'));
    const descriptor = JSON.parse(String(first.descriptor_json)), siblings = JSON.parse(String(first.siblings_json));
    const metadata = runDocumentCheckSync(verifyRunDocumentItemMetadataSteps(header, descriptor, siblings, JSON.parse(String(row.metadata_json))));
    if (metadata.collection !== collection || descriptor.itemOrdinal !== ordinal || descriptor.itemId !== row.item_id
      || runDocumentItemId(metadata) !== row.item_id || descriptor.leafIndex !== row.first_leaf
      || descriptor.chunkCount !== row.chunk_count || descriptor.chunkOrdinal !== 0) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_item_mismatch'));
    return { metadata, descriptor, siblings };
  }

  async readItemLeaf(header: PublicRunDocumentHeader, collection: Collection, ordinal: number, chunk: number): Promise<PublicRunDocumentLeaf | null> {
    return this.readItemLeafSync(header, collection, ordinal, chunk);
  }
  readItemLeafSync(header: PublicRunDocumentHeader, collection: Collection, ordinal: number, chunk: number): PublicRunDocumentLeaf | null {
    this.assertPreparedIdentity(header);
    this.assertPosition(collection, ordinal);
    if (!Number.isSafeInteger(chunk) || chunk < 0) throw new Error('run_document_position_invalid');
    if (ordinal >= header.collections[collection].itemCount) return null;
    const item = this.readItemMetadataSync(header, collection, ordinal);
    if (!item) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_item_missing'));
    if (chunk >= item.descriptor.chunkCount) return null;
    const row = this.database.prepare(`SELECT leaf_index,descriptor_json,siblings_json,chunk_bytes FROM projection_run_document_leaves
      WHERE run_id=? AND run_version=? AND collection=? AND item_ordinal=? AND chunk_ordinal=?`)
      .get(header.summary.runId, header.summary.version, collection, ordinal, chunk) as unknown as LeafRow | undefined;
    if (!row) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_leaf_missing'));
    const leaf = { descriptor: JSON.parse(row.descriptor_json), siblings: JSON.parse(row.siblings_json), contentBase64: Buffer.from(row.chunk_bytes).toString('base64') };
    runDocumentCheckSync(verifyRunDocumentLeafSteps(header, leaf));
    if (leaf.descriptor.collection !== collection || leaf.descriptor.itemOrdinal !== ordinal || leaf.descriptor.chunkOrdinal !== chunk
      || leaf.descriptor.leafIndex !== row.leaf_index || leaf.descriptor.chunkCount !== item.descriptor.chunkCount) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_leaf_identity_mismatch'));
    return leaf;
  }

  private assertPreparedIdentity(header: PublicRunDocumentHeader): void {
    const parsed = publicRunDocumentHeaderSchema.parse(header);
    const stored = this.readPreparedHeaderSync(parsed.summary.runId, parsed.summary.version);
    if (!stored || canonicalPublicProjectionJson(stored) !== canonicalPublicProjectionJson(parsed)) throw new Error('run_document_prepared_identity_mismatch');
  }
  private assertPosition(collection: Collection, ordinal: number): void {
    if (!RUN_DOCUMENT_COLLECTIONS.includes(collection) || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('run_document_position_invalid');
  }
  private dataVersion(): number { return Number(this.database.prepare('PRAGMA data_version').get()!.data_version); }
  private assertPreparationFence(header: PublicRunDocumentHeader, headerJson: string, foreignVersion: number): void {
    // Any external commit invalidates validation done between short transactions,
    // including a body-only change that leaves all stored hashes untouched.
    if (this.dataVersion() !== foreignVersion) throw new Error('run_document_preparation_foreign_write');
    const row = this.database.prepare('SELECT header_json,document_digest FROM projection_run_documents WHERE run_id=? AND run_version=?')
      .get(header.summary.runId, header.summary.version);
    if (row?.header_json !== headerJson || row.document_digest !== header.documentDigest) throw new Error('run_document_preparation_identity_conflict');
  }
  private transaction(operation: () => void): void {
    if (this.database.isTransaction) throw new Error('run_document_preparation_transaction_active');
    this.database.exec('BEGIN IMMEDIATE;');
    try { operation(); this.database.exec('COMMIT;'); }
    catch (error) { if (this.database.isTransaction) this.database.exec('ROLLBACK;'); throw error; }
  }
}
