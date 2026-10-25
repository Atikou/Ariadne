import type { DatabaseSync } from 'node:sqlite';
import { assertPublicRunDocumentCommit, canonicalPublicProjectionJson, isRunDocumentChange, RUN_DOCUMENT_COMMIT_VERSION } from '@ariadne/protocol/public';
import type { RunDocumentPlan } from '../../projection/RunDocumentPlan.js';
import type { ProjectionLedgerAppender, PublicProjectionAppendResult,
  PublicProjectionPersistenceFaultInjector } from './ProjectionLedgerWritePorts.js';
import { SqliteRunDocumentPreparation } from './SqliteRunDocumentPreparation.js';
import { verifyStoredRunDocument } from './RunDocumentSqliteVerifier.js';
import { readMetadata } from './PublicProjectionDbSchema.js';

/** Supplied by the same Projection owner after preparation; this adapter has
 * no database opener, Core state, Outbox ACK or secondary business journal. */
export class SqliteRunDocumentPublication {
  private readonly preparation: SqliteRunDocumentPreparation;
  private readonly storageVersion: number;
  constructor(private readonly database: DatabaseSync, private readonly streamId: string,
    private readonly appendLedger: ProjectionLedgerAppender,
    private readonly faults: PublicProjectionPersistenceFaultInjector & { afterVerification?: () => void } = {}) {
    if (readMetadata(database).streamId !== streamId) throw new Error('run_document_publication_stream_mismatch');
    this.preparation = new SqliteRunDocumentPreparation(database);
    this.storageVersion = this.dataVersion();
  }
  async publish(value: unknown, plan: RunDocumentPlan): Promise<PublicProjectionAppendResult> {
    if (this.dataVersion() !== this.storageVersion) throw new Error('run_document_publication_foreign_write');
    const commit = assertPublicRunDocumentCommit(value), change = commit.changes[0]!;
    if (!isRunDocumentChange(change) || canonicalPublicProjectionJson(change.dto) !== canonicalPublicProjectionJson(plan.header)) {
      throw new Error('run_document_publication_plan_mismatch');
    }
    await this.preparation.prepare(plan);
    const foreignVersion = this.dataVersion();
    verifyStoredRunDocument(this.database, change.dto);
    this.faults.afterVerification?.();
    const root = () => this.database.prepare(`SELECT header_json,document_digest,preparation_state,published_cursor
      FROM projection_run_documents WHERE run_id=? AND run_version=?`).get(change.aggregateId, change.aggregateVersion);
    const result = this.appendLedger(this.database, this.streamId, commit, this.faults, {
      beforeChanges: () => {
        if (this.dataVersion() !== foreignVersion) throw new Error('run_document_publication_foreign_write');
        const row = root();
        if (row?.header_json !== canonicalPublicProjectionJson(change.dto) || row.document_digest !== change.dto.documentDigest
          || row.preparation_state !== 'prepared') throw new Error('run_document_publication_root_changed');
      },
      afterChanges: cursor => {
        const updated = this.database.prepare(`UPDATE projection_run_documents SET published_cursor=?
          WHERE run_id=? AND run_version=? AND document_digest=? AND preparation_state='prepared' AND published_cursor IS NULL`)
          .run(cursor, change.aggregateId, change.aggregateVersion, change.dto.documentDigest);
        if (updated.changes !== 1) throw new Error('run_document_publication_marker_conflict');
      },
      onReplay: (existing, cursor) => {
        const expected = existing.contractVersion === RUN_DOCUMENT_COMMIT_VERSION ? cursor : null;
        if (root()?.published_cursor !== expected) throw new Error('run_document_publication_replay_marker_mismatch');
      }
    });
    return { cursor: result.cursor, streamId: result.streamId, replayed: result.replayed };
  }
  private dataVersion(): number { return Number(this.database.prepare('PRAGMA data_version').get()!.data_version); }
}
