import { markAuthorityIntegrityError, readPersistedAuthorityJson } from './SqliteAuthorityHealth.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalPublicProjectionJson, RUN_DOCUMENT_COLLECTIONS, RunDocumentItemAssembler,
  publicRunDocumentLeafDescriptorSchema,
  verifyRunDocumentHeaderSteps, verifyRunDocumentItemMetadataSteps, runDocumentItemId,
  type PublicRunDocumentHeader, type RunDocumentCheck } from '@ariadne/protocol/public';

export function runDocumentCheckSync<T>(check: RunDocumentCheck<T>): T {
  let step = check.next();
  while (!step.done) step = check.next(`sha256:${createHash('sha256').update(step.value).digest('hex')}`);
  return step.value;
}

/** Complete SQLite verification keeps only one bounded item resident. The
 * caller owns its read transaction or checks data_version before publication. */
export function verifyStoredRunDocument(database: DatabaseSync, headerValue: unknown, publishedCursor?: number): PublicRunDocumentHeader {
  const header = runDocumentCheckSync(verifyRunDocumentHeaderSteps(headerValue)), { runId, version } = header.summary;
  const root = database.prepare('SELECT * FROM projection_run_documents WHERE run_id=? AND run_version=?').get(runId, version);
  if (root?.header_json !== canonicalPublicProjectionJson(header) || root.document_digest !== header.documentDigest
    || root.preparation_state !== 'prepared' || (publishedCursor !== undefined && root.published_cursor !== publishedCursor)) {
    throw markAuthorityIntegrityError('projection', new Error('run_document_stored_root_mismatch'));
  }
  const items = database.prepare(`SELECT * FROM projection_run_document_items
    WHERE run_id=? AND run_version=? AND collection=? ORDER BY item_ordinal`);
  const leaves = database.prepare(`SELECT * FROM projection_run_document_leaves
    WHERE run_id=? AND run_version=? AND collection=? AND item_ordinal=? ORDER BY chunk_ordinal`);
  let queued = 0, claimed = 0;
  for (const collection of RUN_DOCUMENT_COLLECTIONS) {
    let ordinal = 0, nextLeaf = 0;
    for (const item of items.iterate(runId, version, collection)) {
      if (item.item_ordinal !== ordinal || item.first_leaf !== nextLeaf) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_item_index_mismatch'));
      const assembler = new RunDocumentItemAssembler(header, collection, ordinal); let complete = null, chunks = 0;
      for (const row of leaves.iterate(runId, version, collection, ordinal)) {
        if (!(row.chunk_bytes instanceof Uint8Array)) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_chunk_type_mismatch'));
        const descriptor = readPersistedAuthorityJson('projection', String(row.descriptor_json), value => publicRunDocumentLeafDescriptorSchema.parse(value)),
          siblings = readPersistedAuthorityJson('projection', String(row.siblings_json));
        if (canonicalPublicProjectionJson(descriptor) !== row.descriptor_json || canonicalPublicProjectionJson(siblings) !== row.siblings_json) {
          throw markAuthorityIntegrityError('projection', new Error('run_document_stored_leaf_noncanonical'));
        }
        if (row.chunk_ordinal !== chunks || row.leaf_index !== nextLeaf || descriptor.leafIndex !== nextLeaf
          || descriptor.itemId !== item.item_id || descriptor.chunkCount !== item.chunk_count) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_leaf_index_mismatch'));
        if (chunks === 0) {
          const metadata = readPersistedAuthorityJson('projection', String(item.metadata_json),
            value => runDocumentCheckSync(verifyRunDocumentItemMetadataSteps(header, descriptor, siblings, value)));
          if (canonicalPublicProjectionJson(metadata) !== item.metadata_json) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_metadata_noncanonical'));
        }
        try { complete = runDocumentCheckSync(assembler.acceptSteps({ descriptor, siblings, contentBase64: Buffer.from(row.chunk_bytes).toString('base64') })); }
        catch (cause) { throw markAuthorityIntegrityError('projection', cause instanceof Error
          ? cause : new Error('run_document_stored_chunk_proof_invalid', { cause })); }
        chunks++; nextLeaf++;
      }
      if (complete === null || chunks !== item.chunk_count || runDocumentItemId(complete) !== item.item_id) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_item_incomplete'));
      if (complete.collection === 'inbox') { if (complete.value.state === 'queued') queued++; else claimed++; }
      ordinal++;
    }
    const actualLeaves = database.prepare(`SELECT COUNT(*) AS total FROM projection_run_document_leaves WHERE run_id=? AND run_version=? AND collection=?`)
      .get(runId, version, collection)!.total;
    if (ordinal !== header.collections[collection].itemCount || nextLeaf !== header.collections[collection].leafCount
      || actualLeaves !== nextLeaf) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_collection_incomplete'));
  }
  if (queued !== header.summary.queuedInputCount || claimed !== header.summary.claimedInputCount) throw markAuthorityIntegrityError('projection', new Error('run_document_stored_inbox_counts_mismatch'));
  return header;
}
