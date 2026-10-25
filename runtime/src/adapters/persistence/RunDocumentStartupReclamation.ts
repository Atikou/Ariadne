import type { DatabaseSync } from 'node:sqlite';

export interface RunDocumentStartupReclamation {
  readonly rootsRemoved: number;
  readonly itemsRemoved: number;
  readonly leavesRemoved: number;
  /** Released BLOB bytes become SQLite reusable pages; no file shrink claim. */
  readonly bodyBytesRemoved: number;
}

/** Call only after the new owner's full audit, before it admits any query or
 * writer. Legacy 5.0 reads can lease unpublished prepared documents during a
 * live owner, so this is deliberately not a timer or append-time collector.
 * Published roots/history/heads/tombstones/source receipts are never removed.
 * A crashed preparation can be rebuilt from its unchanged authority receipt. */
export function reclaimRunDocumentPreparationAtStartup(database: DatabaseSync,
  afterDeletion?: () => void): RunDocumentStartupReclamation {
  if (database.isTransaction) throw new Error('run_document_reclamation_transaction_active');
  database.exec('BEGIN IMMEDIATE;');
  try {
    const root = database.prepare(`SELECT run_id,run_version FROM projection_run_documents
      WHERE published_cursor IS NULL LIMIT 1`).get() as
      { run_id: string; run_version: number } | undefined;
    let result: RunDocumentStartupReclamation = { rootsRemoved: 0, itemsRemoved: 0, leavesRemoved: 0, bodyBytesRemoved: 0 };
    if (root !== undefined) {
      // An invalid publication marker is corruption, never garbage. The full
      // owner audit already checks this; retain the local deletion precondition.
      const published = database.prepare(`SELECT 1 FROM projection_versions
        WHERE feature='runs' AND aggregate_id=? AND aggregate_version=?
          AND json_extract(dto_json,'$.documentContractVersion')='1.0'`).get(root.run_id, root.run_version);
      if (published !== undefined) throw new Error('run_document_reclamation_publication_marker_missing');
      const leaves = database.prepare(`SELECT collection,item_ordinal,chunk_ordinal,length(chunk_bytes) AS bytes
        FROM projection_run_document_leaves WHERE run_id=? AND run_version=?
        ORDER BY collection,item_ordinal,chunk_ordinal LIMIT 8`).all(root.run_id, root.run_version) as unknown as
        Array<{ collection: string; item_ordinal: number; chunk_ordinal: number; bytes: number }>;
      const changed = database.prepare(`UPDATE projection_run_documents SET preparation_state='preparing'
        WHERE run_id=? AND run_version=? AND published_cursor IS NULL`).run(root.run_id, root.run_version);
      if (changed.changes !== 1) throw new Error('run_document_reclamation_owner_changed');
      const removeLeaf = database.prepare(`DELETE FROM projection_run_document_leaves
        WHERE run_id=? AND run_version=? AND collection=? AND item_ordinal=? AND chunk_ordinal=?`);
      for (const leaf of leaves) {
        if (removeLeaf.run(root.run_id, root.run_version, leaf.collection, leaf.item_ordinal, leaf.chunk_ordinal).changes !== 1) {
          throw new Error('run_document_reclamation_leaf_changed');
        }
      }
      const items = database.prepare(`SELECT collection,item_ordinal FROM projection_run_document_items item
        WHERE run_id=? AND run_version=? AND NOT EXISTS
          (SELECT 1 FROM projection_run_document_leaves leaf WHERE leaf.run_id=item.run_id
            AND leaf.run_version=item.run_version AND leaf.collection=item.collection AND leaf.item_ordinal=item.item_ordinal)
        ORDER BY collection,item_ordinal LIMIT 8`).all(root.run_id, root.run_version) as unknown as
        Array<{ collection: string; item_ordinal: number }>;
      const removeItem = database.prepare(`DELETE FROM projection_run_document_items
        WHERE run_id=? AND run_version=? AND collection=? AND item_ordinal=?`);
      for (const item of items) removeItem.run(root.run_id, root.run_version, item.collection, item.item_ordinal);
      const removed = database.prepare(`DELETE FROM projection_run_documents WHERE run_id=? AND run_version=?
        AND published_cursor IS NULL AND NOT EXISTS (SELECT 1 FROM projection_run_document_items WHERE run_id=? AND run_version=?)
        AND NOT EXISTS (SELECT 1 FROM projection_run_document_leaves WHERE run_id=? AND run_version=?)`)
        .run(root.run_id, root.run_version, root.run_id, root.run_version, root.run_id, root.run_version);
      result = { rootsRemoved: Number(removed.changes), itemsRemoved: items.length, leavesRemoved: leaves.length,
        bodyBytesRemoved: leaves.reduce((total, leaf) => total + leaf.bytes, 0) };
    }
    afterDeletion?.();
    database.exec('COMMIT;'); return result;
  } catch (error) { if (database.isTransaction) database.exec('ROLLBACK;'); throw error; }
}
