import { createHash } from 'node:crypto';
import { attributeSqliteOpeningFault, classifySqliteAuthorityFault, markAuthorityIntegrityError,
  markAuthorityUnavailableError } from './SqliteAuthorityHealth.js';
import { SqliteRunDocumentQueryReader } from './SqliteRunDocumentQueryReader.js';
import { SqliteMessageMetadataQueryReader } from './SqliteMessageMetadataQueryReader.js';
import type { PublicProjectionMessageMetadataQueryStoreV1 } from '../../projection/PublicProjectionMessageMetadataQueryPortsV1.js';
import { readProjectionCatalogCommits } from './SqliteProjectionCatalogCommitReader.js';
import { readProjectionFeatureReceipts } from './SqliteProjectionFeatureReceipts.js';
import { publicProjectionFeatureReceiptRequestSchema, assertProjectionCatalogResult,
  publicProjectionFeatureReceiptResultSchema } from '@ariadne/protocol/public';
import type { PublicProjectionFeatureReceiptQueryStoreV1 } from '../../projection/PublicProjectionFeatureReceiptQueryPortsV1.js';
import type { PublicConversationQueryStoreV1 } from '../../projection/PublicConversationQueryPortsV1.js';
import { publicConversationReceiptRequestSchema, publicConversationReceiptResultSchema,
  publicConversationInferenceRequestSchema, publicConversationInferenceResultSchema } from '@ariadne/protocol/public';
import { readConversationReceipts } from './SqliteConversationReceipts.js';
import { readConversationInferenceWindow } from './SqliteConversationInferenceWindow.js';
import type { PublicProjectionRunDocumentQueryStoreV1 } from '../../projection/PublicProjectionRunDocumentQueryPortsV1.js';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { assertStoredProjectionCommit, assertStoredCommitRowBinding, parseStoredCommitRow, storedVersionRowAsChange,
  assertStoredVersionMatchesChange, assertStoredCommitHistoryLink, storedCommitsEquivalent, type StoredProjectionCommit,
  type StoredProjectionChange } from './StoredProjectionRecords.js';
import { verifyStoredRunDocument } from './RunDocumentSqliteVerifier.js';
import { isRunDocumentChange } from '@ariadne/protocol/public';
import { assertPublicRunDocumentCommit, type PublicRunDocumentCommit } from '@ariadne/protocol/public';
import type { RunDocumentPlan } from '../../projection/RunDocumentPlan.js';
import type { PublicProjectionRunDocumentCommitSinkV1 } from '../../projection/PublicProjectionRunDocumentWritePortsV1.js';
import { SqliteRunDocumentPublication } from './SqliteRunDocumentPublication.js';
import type { PublicProjectionAppendResult, PublicProjectionPersistenceFaultInjector } from './ProjectionLedgerWritePorts.js';
export type { PublicProjectionAppendResult, PublicProjectionPersistenceFaultInjector } from './ProjectionLedgerWritePorts.js';

import {
  MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES,
  MAX_PUBLIC_PROJECTION_SNAPSHOT_BYTES,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST,
  PUBLIC_PROJECTION_HISTORY_DOMAIN,
  publicProjectionCanonicalIdSchema,
  type ProjectionCommit,
  type PublicProjectionChange,
  type PublicProjectionFeature,
  type PublicProjectionReadBatch,
  type PublicProjectionReadRequest,
  type PublicProjectionSnapshot,
  type PublicProjectionTombstone
} from '@ariadne/protocol/public';
import { PUBLIC_PROJECTION_SCOPED_READ_VERSION, publicProjectionScopedReadRequestSchema,
  type PublicProjectionScopedReadRequest, type PublicProjectionScopedReadBatch } from '@ariadne/protocol/public';

import {
  assertValidProjectionCommit as assertPublicProjectionCommit,
  assertValidPublicProjectionReadBatch as assertPublicProjectionReadBatch,
  assertValidPublicProjectionReadRequest as assertPublicProjectionReadRequest,
  assertValidPublicProjectionSnapshot as assertPublicProjectionSnapshot,
  canonicalPublicProjectionJson as canonicalPublicProjectionJson
} from '../../projection/PublicProjectionContract.js';
import type {
  ModelCatalogProjectionHead
} from '../../projection/ModelCatalogProjectionPorts.js';
import type {
  InferenceStreamProjectionHead
} from '../../projection/InferenceStreamProjectionPorts.js';
import { openPublicProjectionDatabase, type PublicProjectionDatabaseOpenStage } from './PublicProjectionDbSchema.js';
import { upgradeRunDocumentSchema } from './RunDocumentDbSchema.js';
import { reclaimRunDocumentPreparationAtStartup } from './RunDocumentStartupReclamation.js';
import { PublicProjectionRepresentationUpgradeRequired } from '../../projection/PublicProjectionRepresentationUpgradeRequired.js';
import { SqliteProjectionSnapshotReader } from './SqliteProjectionSnapshotReader.js';
import type { PublicProjectionPagedQueryStoreV1 } from '../../projection/PublicProjectionPagedQueryPortsV1.js';
import type { PublicProjectionScopedQueryStoreV1 } from '../../projection/PublicProjectionScopedQueryPortsV1.js';
import { filterScopedProjectionRead } from './SqliteProjectionScopedRead.js';
import { publicProjectionMessageWindowRequestSchema } from '@ariadne/protocol/public';
import { readProjectionMessageWindow } from './SqliteProjectionMessageWindow.js';
import { publicProjectionCatalogPageRequestSchema, publicProjectionCatalogDetailRequestSchema,
  publicProjectionCatalogReadRequestSchema } from '@ariadne/protocol/public';
import { readProjectionCatalogPage, readProjectionCatalogDetail } from './SqliteProjectionCatalogRead.js';
import { SqliteProjectionCatalogMetadataCache } from './SqliteProjectionCatalogMetadataCache.js';
import type { PublicProjectionViewQueryStoreV2 } from '../../projection/PublicProjectionViewQueryPortsV2.js';
import type { PublicProjectionCatalogQueryStoreV3 } from '../../projection/PublicProjectionCatalogQueryPortsV3.js';
import type { PublicProjectionFeatureWindowQueryStoreV1 } from '../../projection/PublicProjectionFeatureWindowQueryPortsV1.js';
import { publicProjectionFeatureWindowRequestSchema } from '@ariadne/protocol/public';
import { readProjectionFeatureWindow } from './SqliteProjectionFeatureWindow.js';
import {
  closeOwnedSqliteDatabase,
  type SqliteOwnerLease
} from './SqliteOwnerLease.js';

export interface PublicProjectionPersistenceClock {
  now(): Date;
}
export type PublicProjectionStartupStage = 'schema_open' | 'schema_validated'
  | 'history_audit' | 'history_audited' | 'preparation_reclaim' | 'preparation_reclaimed' | 'owner_ready' | PublicProjectionDatabaseOpenStage;

export interface PublicProjectionShutdownContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(reserveMs?: number): number;
  throwIfExpired(code?: string): void;
}

interface CommitRow {
  readonly cursor: number;
  readonly event_id: string;
  readonly source_id: string;
  readonly source_cursor: number;
  readonly contract_version: string;
  readonly occurred_at: string;
  readonly commit_json: string;
  readonly payload_digest: string;
  readonly history_digest: string;
}

interface VersionRow {
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

interface HeadRow extends VersionRow {}

interface CheckpointRow {
  readonly source_id: string;
  readonly source_cursor: number;
  readonly event_id: string;
  readonly updated_at: string;
}

const systemClock: PublicProjectionPersistenceClock = { now: () => new Date() };

export class SqlitePublicProjectionStore implements PublicProjectionPagedQueryStoreV1,
  PublicProjectionScopedQueryStoreV1, PublicProjectionViewQueryStoreV2, PublicProjectionCatalogQueryStoreV3,
  PublicProjectionFeatureWindowQueryStoreV1, PublicProjectionRunDocumentQueryStoreV1, PublicProjectionMessageMetadataQueryStoreV1,
  PublicProjectionFeatureReceiptQueryStoreV1, PublicConversationQueryStoreV1, PublicProjectionRunDocumentCommitSinkV1 {
  public readonly streamId: string;

  private readonly database: DatabaseSync;
  private readonly databasePath: string;
  private readonly ownerLease: SqliteOwnerLease;
  private readonly snapshotReader: SqliteProjectionSnapshotReader;
  private readonly catalogMetadata: SqliteProjectionCatalogMetadataCache;
  private readonly runDocumentReader: SqliteRunDocumentQueryReader;
  private readonly messageMetadataReader: SqliteMessageMetadataQueryReader;
  private accepting = true;
  private closed = false;
  private unhealthyCause: Error | null = null;
  private tail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;

  public constructor(
    dataRoot: string,
    private readonly clock: PublicProjectionPersistenceClock = systemClock,
    private readonly faultInjector: PublicProjectionPersistenceFaultInjector = {},
    onStartupStage?: (stage: PublicProjectionStartupStage) => void
  ) {
    onStartupStage?.('schema_open');
    const opened = openPublicProjectionDatabase(dataRoot, onStartupStage);
    this.database = opened.database;
    this.databasePath = opened.databasePath;
    this.ownerLease = opened.ownerLease;
    this.streamId = opened.streamId;
    this.catalogMetadata = new SqliteProjectionCatalogMetadataCache(this.database, storedVersionRowAsChange);
    this.snapshotReader = new SqliteProjectionSnapshotReader(this.database, this.streamId,
      () => this.clock.now(), () => readCurrentCursorState(this.database),
      cursor => readCursorDigest(this.database, cursor), versionRowAsChange);
    this.runDocumentReader = new SqliteRunDocumentQueryReader(this.database, this.snapshotReader, this.catalogMetadata, this.streamId);
    this.messageMetadataReader = new SqliteMessageMetadataQueryReader(this.database, this.snapshotReader, this.catalogMetadata, this.runDocumentReader, this.streamId);
    try {
      onStartupStage?.('schema_validated');
      const audit = (database: DatabaseSync): void => {
        onStartupStage?.('history_audit');
        auditStoredProjectionState(database, (header, change) => {
          this.catalogMetadata.rememberVerified(change, header);
        }, ['sessions', 'runs', 'decisions']);
        onStartupStage?.('history_audited');
      };
      if (this.database.prepare('PRAGMA user_version').get()?.user_version === 3) {
        upgradeRunDocumentSchema(this.database, audit);
      } else {
        audit(this.database);
      }
      onStartupStage?.('preparation_reclaim');
      this.catalogMetadata.assertStorageUnchanged();
      reclaimRunDocumentPreparationAtStartup(this.database);
      this.catalogMetadata.assertStorageUnchanged();
      onStartupStage?.('preparation_reclaimed');
      onStartupStage?.('owner_ready');
    } catch (error) {
      attributeSqliteOpeningFault('projection', error);
      try {
        closeOwnedSqliteDatabase(this.database, this.ownerLease);
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'public_projection_open_cleanup_failed');
      }
      this.closed = true;
      this.accepting = false;
      throw error;
    }
  }

  public append(commitValue: unknown): Promise<PublicProjectionAppendResult> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    try {
      const commit = assertPublicProjectionCommit(commitValue);
      return this.schedule(() => this.appendNow(commit));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  public appendRunDocument(commitValue: PublicRunDocumentCommit, plan: RunDocumentPlan): Promise<PublicProjectionAppendResult> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    try {
      const commit = assertPublicRunDocumentCommit(commitValue);
      return this.schedule(async () => {
        this.catalogMetadata.assertStorageUnchanged();
        if (Number(this.database.prepare('PRAGMA user_version').get()!.user_version) !== 4) {
          throw new Error('run_document_schema_activation_required');
        }
        const result = await new SqliteRunDocumentPublication(this.database, this.streamId, appendProjectionLedgerCommit, this.faultInjector).publish(commit, plan);
        if (!result.replayed) commit.changes.forEach((change, changeIndex) => {
          this.catalogMetadata.rememberVerified(change, {
            feature: change.feature, aggregate_id: change.aggregateId, aggregate_version: change.aggregateVersion,
            operation: change.operation, projected_at: change.projectedAt,
            payload_digest: digest(canonicalPublicProjectionJson(change)), commit_cursor: result.cursor, change_index: changeIndex
          });
        });
        return result;
      });
    } catch (error) { return Promise.reject(error); }
  }

  public snapshot(): Promise<PublicProjectionSnapshot> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    return this.schedule(() => this.snapshotNow());
  }

  /** Observer recovery reads only its bounded durable heads, never conversation bodies. */
  public readPublicAgentObservationHeads(): Promise<readonly import('@ariadne/protocol/public').PublicDiagnosticProjection[]> {
    return this.schedule(() => {
      const result: import('@ariadne/protocol/public').PublicDiagnosticProjection[] = [];
      const rows = this.database.prepare(`SELECT * FROM projection_heads
        WHERE feature='diagnostics' AND operation='upsert'
          AND aggregate_id GLOB 'agent-observation:*'
        ORDER BY aggregate_id LIMIT 513`).iterate();
      for (const value of rows) {
        const change = versionRowAsChange(value as unknown as VersionRow);
        if (change.feature !== 'diagnostics' || change.dto === null || change.aggregateVersion !== 1
          || !change.aggregateId.startsWith('agent-observation:')) throw storageCorruption('observer:head_identity_invalid');
        if (result.length >= 512) throw storageCorruption('observer:head_count_exceeded');
        result.push(change.dto);
      }
      return result;
    });
  }

  public beginSnapshot(value: unknown) {
    return this.schedule(() => this.snapshotReader.begin(value));
  }

  public readSnapshotPage(value: unknown) {
    return this.schedule(() => this.snapshotReader.page(value));
  }

  public beginViewSnapshot(value: unknown) {
    return this.schedule(() => this.snapshotReader.beginView(value));
  }

  public readViewSnapshotPage(value: unknown) {
    return this.schedule(() => this.snapshotReader.pageView(value));
  }

  public beginCatalogSnapshot(value: unknown) {
    return this.schedule(() => this.snapshotReader.beginCatalog(value));
  }

  public readRunDocument(value: unknown) { return this.schedule(() => this.runDocumentReader.root(value)); }
  public readRunDocumentMetadataPage(value: unknown) { return this.schedule(() => this.runDocumentReader.metadataPage(value)); }
  public readRunDocumentInboxInput(value: unknown) { return this.schedule(() => this.runDocumentReader.inbox(value)); }
  public readRunDocumentChunk(value: unknown) { return this.schedule(() => this.runDocumentReader.chunk(value)); }
  public readMessageMetadataWindow(value: unknown) { return this.schedule(() => this.messageMetadataReader.window(value)); }
  public readMessageBody(value: unknown) { return this.schedule(() => this.messageMetadataReader.body(value)); }

  public readCatalogPage(value: unknown) {
    return this.schedule(() => {
      const request = publicProjectionCatalogPageRequestSchema.parse(value);
      const manifest = this.snapshotReader.resolveCatalog(request.manifest);
      if ('status' in manifest) return manifest;
      return readProjectionCatalogPage(this.database, this.snapshotReader, manifest, request, this.catalogMetadata);
    });
  }

  public readCatalogDetail(value: unknown) {
    return this.schedule(() => {
      const request = publicProjectionCatalogDetailRequestSchema.parse(value);
      const manifest = this.snapshotReader.resolveCatalog(request.manifest);
      if ('status' in manifest) return manifest;
      return readProjectionCatalogDetail(this.database, this.snapshotReader, manifest, request, versionRowAsChange);
    });
  }

  public readCatalogCommits(value: unknown) {
    return this.schedule(() => {
      const request = publicProjectionCatalogReadRequestSchema.parse(value);
      const manifest = this.snapshotReader.resolveCatalog(request.manifest);
      if ('status' in manifest) return manifest;
      return readProjectionCatalogCommits(this.database, this.catalogMetadata, manifest, request,
        () => readCurrentCursorState(this.database).cursor, cursor => readCursorDigest(this.database, cursor));
    });
  }

  public readFeatureWindow(value: unknown) {
    return this.schedule(() => {
      const request = publicProjectionFeatureWindowRequestSchema.parse(value);
      this.catalogMetadata.assertStorageUnchanged();
      const manifest = this.snapshotReader.resolveView(request.manifest);
      const result = 'status' in manifest ? manifest
        : readProjectionFeatureWindow(this.database, this.snapshotReader, request, versionRowAsChange);
      this.catalogMetadata.assertStorageUnchanged(); return result;
    });
  }

  public readFeatureReceipts(value: unknown) {
    return this.schedule(() => {
      const request = publicProjectionFeatureReceiptRequestSchema.parse(value);
      this.catalogMetadata.assertStorageUnchanged();
      const manifest = this.snapshotReader.resolveView(request.manifest);
      if ('status' in manifest) {
        this.catalogMetadata.assertStorageUnchanged();
        return assertProjectionCatalogResult(publicProjectionFeatureReceiptResultSchema, { status: 'reset_required',
          reason: manifest.reason, queryVersion: '1.0', manifest: request.manifest,
          afterCursor: request.afterCursor, afterDigest: request.afterDigest });
      }
      return readProjectionFeatureReceipts(this.database, this.catalogMetadata, request,
        () => readCurrentCursorState(this.database).cursor, cursor => readCursorDigest(this.database, cursor));
    });
  }

  public readConversationReceipts(value: unknown) {
    return this.schedule(() => {
      const request = publicConversationReceiptRequestSchema.parse(value);
      this.catalogMetadata.assertStorageUnchanged();
      const manifest = this.snapshotReader.resolveCatalog(request.manifest);
      if ('status' in manifest) {
        this.catalogMetadata.assertStorageUnchanged();
        return assertProjectionCatalogResult(publicConversationReceiptResultSchema, { status: 'reset_required', reason: manifest.reason,
          queryVersion: '1.0', manifest: request.manifest, afterCursor: request.afterCursor, afterDigest: request.afterDigest });
      }
      return readConversationReceipts(this.database, this.catalogMetadata, request,
        () => readCurrentCursorState(this.database).cursor, cursor => readCursorDigest(this.database, cursor));
    });
  }
  public readConversationInferenceWindow(value: unknown) {
    return this.schedule(() => {
      const request = publicConversationInferenceRequestSchema.parse(value);
      this.catalogMetadata.assertStorageUnchanged();
      const manifest = this.snapshotReader.resolveCatalog(request.manifest);
      const result = 'status' in manifest
        ? assertProjectionCatalogResult(publicConversationInferenceResultSchema, { status: 'reset_required', reason: manifest.reason,
          queryVersion: '1.0', manifest: request.manifest, window: request.window })
        : readConversationInferenceWindow(this.database, this.snapshotReader, request, versionRowAsChange);
      this.catalogMetadata.assertStorageUnchanged(); return result;
    });
  }

  public readMessageWindow(value: unknown) {
    return this.schedule(() => {
      const request = publicProjectionMessageWindowRequestSchema.parse(value);
      const manifest = this.snapshotReader.resolveView(request.manifest);
      if ('status' in manifest) return manifest;
      this.catalogMetadata.assertStorageUnchanged();
      if (manifest.scope.kind === 'session' && this.database.prepare(`SELECT 1 FROM projection_versions v
        WHERE v.feature='runs' AND v.operation='upsert' AND json_extract(v.dto_json,'$.documentContractVersion')='1.0'
          AND json_extract(v.dto_json,'$.summary.sessionId')=? AND json_extract(v.dto_json,'$.collections.interactionMessages.itemCount')>0
          AND v.commit_cursor<=? AND NOT EXISTS (SELECT 1 FROM projection_versions newer
            WHERE newer.feature=v.feature AND newer.aggregate_id=v.aggregate_id
              AND newer.aggregate_version>v.aggregate_version AND newer.commit_cursor<=?) LIMIT 1`)
        .get(manifest.scope.sessionId, manifest.boundaryCursor, manifest.boundaryCursor) !== undefined) {
        this.catalogMetadata.assertStorageUnchanged();
        return { status: 'reset_required' as const, streamId: this.streamId, reason: 'contract_mismatch' as const };
      }
      const result = readProjectionMessageWindow(this.database, manifest, request.window, versionRowAsChange);
      this.catalogMetadata.assertStorageUnchanged(); return result;
    });
  }

  public readScope(value: PublicProjectionScopedReadRequest | unknown): Promise<PublicProjectionScopedReadBatch> {
    return this.schedule(() => {
      const request = publicProjectionScopedReadRequestSchema.parse(value);
      if (request.readContractVersion !== PUBLIC_PROJECTION_SCOPED_READ_VERSION) return {
        status: 'reset_required', readContractVersion: PUBLIC_PROJECTION_SCOPED_READ_VERSION,
        streamId: this.streamId, currentCursor: readCurrentCursorState(this.database).cursor,
        reason: 'contract_mismatch'
      };
      const scan = this.readNow({ contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        streamId: request.streamId, afterCursor: request.afterCursor,
        afterDigest: request.afterDigest, limit: request.limit });
      return filterScopedProjectionRead(this.database, request, scan, versionRowAsChange);
    });
  }

  public readModelProjectionHeads(): Promise<readonly ModelCatalogProjectionHead[]> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    return this.schedule(() => readModelProjectionHeads(this.database));
  }

  public readInferenceStreamProjectionHead(
    inferenceStreamIdValue: string
  ): Promise<InferenceStreamProjectionHead | null> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    let inferenceStreamId: string;
    try {
      inferenceStreamId = publicProjectionCanonicalIdSchema.parse(inferenceStreamIdValue);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.schedule(() => {
      const row = selectHead(this.database, 'inference_streams', inferenceStreamId);
      return row === undefined ? null : inferenceStreamHead(row);
    });
  }

  public readInferenceStreamProjectionHeads(): Promise<readonly InferenceStreamProjectionHead[]> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    return this.schedule(() => readInferenceStreamProjectionHeads(this.database));
  }

  public readPublicProjectionSourceCheckpoint(sourceIdValue: string): Promise<number> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    let sourceId: string;
    try {
      sourceId = publicProjectionCanonicalIdSchema.parse(sourceIdValue);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.schedule(() => readSourceCheckpoint(this.database, sourceId));
  }

  public read(
    requestValue: PublicProjectionReadRequest | unknown
  ): Promise<PublicProjectionReadBatch> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    try {
      const request = assertPublicProjectionReadRequest(requestValue);
      return this.schedule(() => this.readNow(request));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  public close(context?: PublicProjectionShutdownContext): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.accepting = false;
    this.closePromise = (async () => {
      if (context !== undefined) await waitForDrain(this.tail, context);
      else await this.tail;
      if (this.closed) return;
      closeOwnedSqliteDatabase(this.database, this.ownerLease);
      this.catalogMetadata.clear();
      this.closed = true;
    })();
    return this.closePromise;
  }

  /** Metadata only for local capacity diagnostics; not a public query or authority. */
  public catalogMetadataCacheStats() { return this.catalogMetadata.stats(); }

  private schedule<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.unhealthyCause !== null) {
      return Promise.reject(this.unhealthyError());
    }
    if (!this.accepting || this.closed) {
      return Promise.reject(new Error('public_projection_store_closed'));
    }
    const result = this.tail.then(async () => {
      // Work already admitted before close owns its place in the durable
      // queue. Closing only freezes new admissions and waits for this tail.
      if (this.closed) {
        throw new Error('public_projection_store_closed');
      }
      if (this.unhealthyCause !== null) throw this.unhealthyError();
      try {
        return await operation();
      } catch (error) {
        if (isProjectionStorageCorruption(error)) {
          this.unhealthyCause ??= error;
        }
        throw error;
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private unhealthyError(): Error {
    const error = new Error('public_projection_store_unhealthy', {
      cause: this.unhealthyCause ?? undefined
    });
    return classifySqliteAuthorityFault('projection', this.unhealthyCause) === 'integrity'
      ? markAuthorityIntegrityError('projection', error) : markAuthorityUnavailableError('projection', error);
  }

  private appendNow(commit: ProjectionCommit): PublicProjectionAppendResult {
    const result = appendProjectionLedgerCommit(this.database, this.streamId, commit, this.faultInjector);
    if (!result.replayed) {
      const cursor = result.cursor, changeDigests = result.changeDigests!;
      commit.changes.forEach((change, changeIndex) => {
        if (!['sessions', 'runs', 'decisions'].includes(change.feature)) return;
        this.catalogMetadata.rememberVerified(change, {
          feature: change.feature, aggregate_id: change.aggregateId, aggregate_version: change.aggregateVersion,
          operation: change.operation, projected_at: change.projectedAt,
          payload_digest: changeDigests[changeIndex]!, commit_cursor: cursor, change_index: changeIndex
        });
      });
    }
    return { cursor: result.cursor, streamId: result.streamId, replayed: result.replayed };
  }

  private snapshotNow(): PublicProjectionSnapshot {
    this.database.exec('BEGIN;');
    try {
      const current = readCurrentCursorState(this.database);
      const snapshot = buildSnapshot(
        this.database,
        this.streamId,
        current.cursor,
        current.cursorDigest,
        canonicalNow(this.clock)
      );
      this.database.exec('COMMIT;');
      return snapshot;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  private readNow(request: PublicProjectionReadRequest): PublicProjectionReadBatch {
    this.database.exec('BEGIN;');
    try {
      const current = readCurrentCursorState(this.database);
      if (request.contractVersion !== PUBLIC_PROJECTION_CONTRACT_VERSION) {
        const result = resetRequired(this.streamId, current.cursor, 'contract_mismatch');
        this.database.exec('COMMIT;');
        return result;
      }
      if (request.streamId !== this.streamId) {
        const result = resetRequired(this.streamId, current.cursor, 'stream_mismatch');
        this.database.exec('COMMIT;');
        return result;
      }
      if (request.afterCursor > current.cursor) {
        const result = resetRequired(this.streamId, current.cursor, 'cursor_gap');
        this.database.exec('COMMIT;');
        return result;
      }

      const storedAfterDigest = readCursorDigest(this.database, request.afterCursor);
      if (storedAfterDigest === undefined) {
        const result = resetRequired(this.streamId, current.cursor, 'cursor_gap');
        this.database.exec('COMMIT;');
        return result;
      }
      if (storedAfterDigest !== request.afterDigest) {
        const result = resetRequired(this.streamId, current.cursor, 'history_mismatch');
        this.database.exec('COMMIT;');
        return result;
      }

      const rows = this.database.prepare(
        `SELECT cursor, event_id, source_id, source_cursor, contract_version,
                occurred_at, commit_json, payload_digest, history_digest
         FROM projection_commits
         WHERE cursor > ? ORDER BY cursor LIMIT ?`
      ).iterate(
        request.afterCursor,
        request.limit + 1
      ) as unknown as Iterable<CommitRow>;
      const commits: Array<{
        readonly cursor: number;
        readonly cursorDigest: string;
        readonly commit: ProjectionCommit;
      }> = [];
      let expectedCursor = request.afterCursor + 1;
      let previousDigest = request.afterDigest;
      let hasMore = false;
      let commitEntriesByteLength = 0;
      for (const row of rows) {
        if (row.cursor !== expectedCursor) {
          const result = resetRequired(this.streamId, current.cursor, 'cursor_gap');
          this.database.exec('COMMIT;');
          return result;
        }
        if (commits.length >= request.limit) {
          hasMore = true;
          break;
        }
        const stored = parseStoredCommitRow(row);
        assertHistoryLink(row, previousDigest);
        if (stored.contractVersion !== PUBLIC_PROJECTION_CONTRACT_VERSION) {
          const result = resetRequired(this.streamId, current.cursor, 'contract_mismatch');
          this.database.exec('COMMIT;'); return result;
        }
        const commit = stored;
        const entry = {
          cursor: row.cursor,
          cursorDigest: row.history_digest,
          commit
        };
        const entryByteLength = canonicalJsonByteLength(entry);
        const candidateEnvelopeByteLength = canonicalJsonByteLength({
          status: 'ok' as const,
          contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
          streamId: this.streamId,
          afterCursor: request.afterCursor,
          afterDigest: request.afterDigest,
          nextCursor: entry.cursor,
          nextDigest: entry.cursorDigest,
          // `false` is one byte longer than `true`; reserve the larger final
          // envelope regardless of whether this page later finds a successor.
          hasMore: false,
          commits: []
        });
        const candidateCount = commits.length + 1;
        const candidateByteLength = candidateEnvelopeByteLength
          + commitEntriesByteLength
          + entryByteLength
          + Math.max(0, candidateCount - 1);
        if (candidateByteLength > MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES) {
          if (commits.length === 0) {
            throw storageCorruption('single_commit_exceeds_read_batch_capacity');
          }
          hasMore = true;
          break;
        }
        commits.push(entry);
        commitEntriesByteLength += entryByteLength;
        previousDigest = entry.cursorDigest;
        expectedCursor += 1;
      }
      const nextCursor = commits.at(-1)?.cursor ?? request.afterCursor;
      const nextDigest = commits.at(-1)?.cursorDigest ?? request.afterDigest;
      if (!hasMore && nextCursor !== current.cursor) {
        const result = resetRequired(this.streamId, current.cursor, 'cursor_gap');
        this.database.exec('COMMIT;');
        return result;
      }
      const result = assertPublicProjectionReadBatch({
        status: 'ok',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        streamId: this.streamId,
        afterCursor: request.afterCursor,
        afterDigest: request.afterDigest,
        nextCursor,
        nextDigest,
        hasMore,
        commits
      });
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK;');
      throw error;
    }
  }
}

function applyChange(
  database: DatabaseSync,
  commitCursor: number,
  changeIndex: number,
  change: StoredProjectionChange
): string {
  const changeJson = canonicalPublicProjectionJson(change);
  const changeDigest = digest(changeJson);
  const dtoJson = change.dto === null
    ? null
    : canonicalPublicProjectionJson(change.dto);
  const historical = database.prepare(
    `SELECT feature, aggregate_id, aggregate_version, operation,
            projected_at, dto_json, payload_digest, commit_cursor, change_index
     FROM projection_versions
     WHERE feature=? AND aggregate_id=? AND aggregate_version=?`
  ).get(
    change.feature,
    change.aggregateId,
    change.aggregateVersion
  ) as VersionRow | undefined;
  if (historical !== undefined) {
    const historicalChange = storedVersionRowAsChange(historical);
    if (canonicalPublicProjectionJson(historicalChange) !== changeJson) {
      throw storageCorruption(
        `version:${change.feature}:${change.aggregateId}:`
        + `${String(change.aggregateVersion)}:payload_drift`
      );
    }
    throw storageCorruption(
      `version:${change.feature}:${change.aggregateId}:`
      + `${String(change.aggregateVersion)}:different_event`
    );
  }

  const head = selectHead(database, change.feature, change.aggregateId);
  assertCurrentHead(database, change.feature, change.aggregateId, head);
  const expectedVersion = (head?.aggregate_version ?? 0) + 1;
  if (change.aggregateVersion !== expectedVersion) {
    throw storageCorruption(
      `version:${change.feature}:${change.aggregateId}:expected_`
      + `${String(expectedVersion)}:received_${String(change.aggregateVersion)}`
    );
  }

  database.prepare(
    `INSERT INTO projection_versions(
       feature, aggregate_id, aggregate_version, operation, projected_at,
       dto_json, payload_digest, commit_cursor, change_index
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    change.feature,
    change.aggregateId,
    change.aggregateVersion,
    change.operation,
    change.projectedAt,
    dtoJson,
    changeDigest,
    commitCursor,
    changeIndex
  );
  database.prepare(
    `INSERT INTO projection_heads(
       feature, aggregate_id, aggregate_version, operation, projected_at,
       dto_json, payload_digest, commit_cursor, change_index
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(feature, aggregate_id) DO UPDATE SET
       aggregate_version=excluded.aggregate_version,
       operation=excluded.operation,
       projected_at=excluded.projected_at,
       dto_json=excluded.dto_json,
       payload_digest=excluded.payload_digest,
       commit_cursor=excluded.commit_cursor,
       change_index=excluded.change_index`
  ).run(
    change.feature,
    change.aggregateId,
    change.aggregateVersion,
    change.operation,
    change.projectedAt,
    dtoJson,
    changeDigest,
    commitCursor,
    changeIndex
  );
  return changeDigest;
}

function assertNextSourceCursor(database: DatabaseSync, commit: StoredProjectionCommit): void {
  const checkpoint = database.prepare(
    `SELECT source_id, source_cursor, event_id, updated_at
     FROM projection_source_checkpoints WHERE source_id=?`
  ).get(commit.sourceId) as CheckpointRow | undefined;
  const expected = (checkpoint?.source_cursor ?? 0) + 1;
  if (commit.sourceCursor !== expected) {
    throw storageCorruption(
      `source:${commit.sourceId}:cursor_expected_${String(expected)}:`
      + `received_${String(commit.sourceCursor)}`
    );
  }
}

export function auditStoredProjectionState(database: DatabaseSync,
  onVerifiedHead?: (head: HeadRow, change: StoredProjectionChange) => void,
  observedFeatures?: readonly PublicProjectionFeature[]): void {
  const ownRead = !database.isTransaction;
  const storageVersion = ownRead ? database.prepare('PRAGMA data_version').get()!.data_version : undefined;
  if (ownRead) database.exec('BEGIN;');
  try {
    auditStoredProjectionSnapshot(database, onVerifiedHead, observedFeatures);
    if (ownRead) {
      database.exec('COMMIT;');
      if (database.prepare('PRAGMA data_version').get()!.data_version !== storageVersion) {
        throw storageCorruption('audit_external_write');
      }
    }
  } catch (error) {
    if (ownRead && database.isTransaction) {
      try { database.exec('ROLLBACK;'); }
      catch (rollbackError) { throw markAuthorityUnavailableError('projection',
        new AggregateError([error, rollbackError], 'public_projection_audit_rollback_failed')); }
    }
    throw error;
  }
}
function auditStoredProjectionSnapshot(database: DatabaseSync,
  onVerifiedHead?: (head: HeadRow, change: StoredProjectionChange) => void,
  observedFeatures?: readonly PublicProjectionFeature[]): void {
  const commits = database.prepare(
    `SELECT cursor, event_id, source_id, source_cursor, contract_version,
            occurred_at, commit_json, payload_digest, history_digest
     FROM projection_commits ORDER BY cursor`
  ).iterate() as unknown as Iterable<CommitRow>;
  const sourcePredecessor = database.prepare(`SELECT source_cursor, cursor FROM projection_commits
    WHERE source_id=? AND source_cursor<? ORDER BY source_cursor DESC LIMIT 1`);
  const commitVersions = database.prepare(`SELECT feature, aggregate_id, aggregate_version, operation,
    projected_at, dto_json, payload_digest, commit_cursor, change_index
    FROM projection_versions WHERE commit_cursor=? ORDER BY change_index`);
  const versionPredecessor = database.prepare(`SELECT aggregate_version, commit_cursor, change_index
    FROM projection_versions WHERE feature=? AND aggregate_id=? AND aggregate_version<?
    ORDER BY aggregate_version DESC LIMIT 1`);
  let expectedChangeCount = 0;
  let expectedDocumentCount = 0;
  let expectedCursor = 1;
  let previousHistoryDigest: string = PUBLIC_PROJECTION_GENESIS_DIGEST;
  for (const row of commits) {
    if (row.cursor !== expectedCursor) {
      throw storageCorruption(`commit_cursor_gap:${String(expectedCursor)}`);
    }
    const commit = parseStoredCommitRow(row);
    assertHistoryLink(row, previousHistoryDigest);
    const predecessor = sourcePredecessor.get(commit.sourceId, commit.sourceCursor) as
      { source_cursor: number; cursor: number } | undefined;
    const sourceExpected = (predecessor?.source_cursor ?? 0) + 1;
    if (commit.sourceCursor !== sourceExpected || (predecessor !== undefined && predecessor.cursor >= row.cursor)) {
      throw storageCorruption(`source:${commit.sourceId}:history_gap`);
    }
    // Only this bounded Commit and its versions are resident during audit.
    let index = 0;
    for (const value of commitVersions.iterate(row.cursor)) {
      const version = value as unknown as VersionRow;
      const change = commit.changes[index];
      if (change === undefined || version.change_index !== index) {
        throw storageCorruption('version_commit_reference_missing');
      }
      assertStoredVersionMatchesChange(version, change);
      if (isRunDocumentChange(change)) {
        verifyStoredRunDocument(database, change.dto, row.cursor); expectedDocumentCount++;
      }
      const previous = versionPredecessor.get(version.feature, version.aggregate_id,
        version.aggregate_version) as { aggregate_version: number; commit_cursor: number;
          change_index: number } | undefined;
      if (version.aggregate_version !== (previous?.aggregate_version ?? 0) + 1
        || (previous !== undefined && (previous.commit_cursor > row.cursor
          || (previous.commit_cursor === row.cursor && previous.change_index >= index)))) {
        throw storageCorruption(`version_history_gap:${identityKey(version.feature, version.aggregate_id)}`);
      }
      index += 1;
    }
    if (index !== commit.changes.length) throw storageCorruption('commit_change_artifacts_missing');
    expectedChangeCount += index;
    previousHistoryDigest = row.history_digest;
    expectedCursor += 1;
  }

  if (rowCount(database, 'projection_versions') !== expectedChangeCount) {
    throw storageCorruption('commit_change_artifacts_missing');
  }
  if (Number(database.prepare('PRAGMA user_version').get()!.user_version) >= 4) {
    const published = database.prepare('SELECT COUNT(*) AS total FROM projection_run_documents WHERE published_cursor IS NOT NULL').get()!;
    if (published.total !== expectedDocumentCount) throw storageCorruption('run_document_publication_count_mismatch');
  } else if (expectedDocumentCount !== 0) throw storageCorruption('run_document_schema_missing');

  const heads = database.prepare(
    `SELECT feature, aggregate_id, aggregate_version, operation,
            projected_at, dto_json, payload_digest, commit_cursor, change_index
     FROM projection_heads ORDER BY feature, aggregate_id`
  ).iterate() as unknown as Iterable<HeadRow>;
  const latestVersion = prepareLatestVersion(database);
  const latestCount = database.prepare(`SELECT count(*) AS total FROM
    (SELECT feature, aggregate_id FROM projection_versions GROUP BY feature, aggregate_id)`)
    .get() as { total: number };
  if (rowCount(database, 'projection_heads') !== latestCount.total) {
    throw storageCorruption('projection_heads_count_mismatch');
  }
  for (const head of heads) {
    // The complete Commit/version pass proved every latest version's Schema,
    // safety and digest in this same read transaction. Exact durable-field
    // equality transfers that proof to Head without reparsing all its bodies.
    assertHeadMatchesLatest(head.feature, head.aggregate_id, head, latestVersion);
    if (onVerifiedHead && (observedFeatures === undefined || observedFeatures.includes(head.feature))) {
      onVerifiedHead(head, storedVersionRowAsChange(head));
    }
  }

  const checkpoints = database.prepare(
    `SELECT source_id, source_cursor, event_id, updated_at
     FROM projection_source_checkpoints ORDER BY source_id`
  ).iterate() as unknown as Iterable<CheckpointRow>;
  const sourceCount = database.prepare('SELECT count(DISTINCT source_id) AS total FROM projection_commits')
    .get() as { total: number };
  if (rowCount(database, 'projection_source_checkpoints') !== sourceCount.total) {
    throw storageCorruption('source_checkpoint_count_mismatch');
  }
  const latestSourceCommit = database.prepare(`SELECT source_cursor, event_id, occurred_at FROM projection_commits
    WHERE source_id=? ORDER BY source_cursor DESC LIMIT 1`);
  for (const checkpoint of checkpoints) {
    const last = latestSourceCommit.get(checkpoint.source_id) as
      { source_cursor: number; event_id: string; occurred_at: string } | undefined;
    if (
      last === undefined
      || checkpoint.source_cursor !== last.source_cursor
      || checkpoint.event_id !== last.event_id
      || checkpoint.updated_at !== last.occurred_at
    ) {
      throw storageCorruption(`source_checkpoint_mismatch:${checkpoint.source_id}`);
    }
  }
}

function assertVersionRowMatchesChange(
  row: VersionRow,
  change: PublicProjectionChange
): void {
  assertStoredVersionMatchesChange(row, change);
}

function versionRowAsChange(row: VersionRow): PublicProjectionChange {
  const change = storedVersionRowAsChange(row);
  if (isRunDocumentChange(change)) throw new PublicProjectionRepresentationUpgradeRequired();
  return change;
}

function assertCurrentHead(database: DatabaseSync, feature: PublicProjectionFeature,
  aggregateId: string, head: HeadRow | undefined,
  latestVersion: StatementSync = prepareLatestVersion(database)): StoredProjectionChange | undefined {
  assertHeadMatchesLatest(feature, aggregateId, head, latestVersion);
  return head === undefined ? undefined : storedVersionRowAsChange(head);
}
function assertHeadMatchesLatest(feature: PublicProjectionFeature, aggregateId: string,
  head: HeadRow | undefined, latestVersion: StatementSync): void {
  const latest = latestVersion.get(feature, aggregateId) as VersionRow | undefined;
  if (latest === undefined && head === undefined) return;
  if (latest === undefined || head === undefined || !sameVersionRow(latest, head)) {
    throw storageCorruption(`projection_head_mismatch:${feature}:${aggregateId}`);
  }
}

function prepareLatestVersion(database: DatabaseSync): StatementSync {
  return database.prepare(`SELECT feature, aggregate_id, aggregate_version, operation,
    projected_at, dto_json, payload_digest, commit_cursor, change_index FROM projection_versions
    WHERE feature=? AND aggregate_id=? ORDER BY aggregate_version DESC LIMIT 1`);
}

function rowCount(database: DatabaseSync,
  table: 'projection_versions' | 'projection_heads' | 'projection_source_checkpoints'): number {
  return (database.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total;
}

function readFeatureDtos(
  database: DatabaseSync,
  feature: PublicProjectionFeature
): unknown[] {
  const rows = database.prepare(
    `SELECT feature, aggregate_id, aggregate_version, operation,
            projected_at, dto_json, payload_digest, commit_cursor, change_index
     FROM projection_heads
     WHERE feature=? AND operation='upsert'
     ORDER BY aggregate_id`
  ).all(feature) as unknown as HeadRow[];
  return rows.map((row) => {
    const dto = row.dto_json === null
      ? null
      : parseJson(row.dto_json, `snapshot:${feature}:${row.aggregate_id}`);
    assertVersionRowMatchesChange(row, versionRowAsChange(row));
    return dto;
  });
}

function readProjectionTombstones(
  database: DatabaseSync
): PublicProjectionTombstone[] {
  const rows = database.prepare(
    `SELECT feature, aggregate_id, aggregate_version, operation,
            projected_at, dto_json, payload_digest, commit_cursor, change_index
     FROM projection_heads
     WHERE operation='delete'
     ORDER BY feature, aggregate_id`
  ).all() as unknown as HeadRow[];
  return rows.map((row) => {
    const change = versionRowAsChange(row);
    assertVersionRowMatchesChange(row, change);
    if (change.operation !== 'delete' || change.dto !== null) {
      throw storageCorruption(
        `projection_tombstone_invalid:${row.feature}:${row.aggregate_id}`
      );
    }
    return {
      feature: row.feature,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      projectedAt: row.projected_at
    };
  });
}

function readModelProjectionHeads(
  database: DatabaseSync
): readonly ModelCatalogProjectionHead[] {
  const rows = database.prepare(
    `SELECT feature, aggregate_id, aggregate_version, operation,
            projected_at, dto_json, payload_digest, commit_cursor, change_index
     FROM projection_heads
     WHERE feature='models'
     ORDER BY aggregate_id`
  ).all() as unknown as HeadRow[];
  return rows.map((row) => {
    const change = versionRowAsChange(row);
    assertVersionRowMatchesChange(row, change);
    if (change.feature !== 'models') {
      throw storageCorruption(`model_projection_head_feature_invalid:${row.aggregate_id}`);
    }
    return {
      aggregateId: change.aggregateId,
      aggregateVersion: change.aggregateVersion,
      operation: change.operation,
      dto: change.dto
    };
  });
}

function readInferenceStreamProjectionHeads(
  database: DatabaseSync
): readonly InferenceStreamProjectionHead[] {
  const rows = database.prepare(
    `SELECT feature, aggregate_id, aggregate_version, operation,
            projected_at, dto_json, payload_digest, commit_cursor, change_index
     FROM projection_heads
     WHERE feature='inference_streams'
     ORDER BY aggregate_id`
  ).all() as unknown as HeadRow[];
  return rows.map(inferenceStreamHead);
}

function inferenceStreamHead(row: HeadRow): InferenceStreamProjectionHead {
  const change = versionRowAsChange(row);
  assertVersionRowMatchesChange(row, change);
  if (change.feature !== 'inference_streams') {
    throw storageCorruption(`inference_stream_head_feature_invalid:${row.aggregate_id}`);
  }
  return {
    aggregateId: change.aggregateId,
    aggregateVersion: change.aggregateVersion,
    operation: change.operation,
    dto: change.dto
  };
}

function readSourceCheckpoint(database: DatabaseSync, sourceId: string): number {
  const checkpoint = database.prepare(
    `SELECT source_id, source_cursor, event_id, updated_at
     FROM projection_source_checkpoints WHERE source_id=?`
  ).get(sourceId) as CheckpointRow | undefined;
  return checkpoint?.source_cursor ?? 0;
}

function buildSnapshot(
  database: DatabaseSync,
  streamId: string,
  cursor: number,
  cursorDigest: string,
  capturedAt: string
): PublicProjectionSnapshot {
  // Scalar ABI remains bounded. Refuse an oversized read before allocating
  // all DTO bodies; total history is served by the paged query boundary.
  const bodyBytes = database.prepare(`SELECT COALESCE(sum(length(CAST(dto_json AS BLOB))), 0) AS total
    FROM projection_heads WHERE operation='upsert'`).get() as { total: number };
  if (bodyBytes.total > MAX_PUBLIC_PROJECTION_SNAPSHOT_BYTES) {
    throw new Error('public_projection_snapshot_too_large');
  }
  return assertPublicProjectionSnapshot({
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    streamId,
    cursor,
    cursorDigest,
    capturedAt,
    sessions: readFeatureDtos(database, 'sessions'),
    messages: readFeatureDtos(database, 'messages'),
    runs: readFeatureDtos(database, 'runs'),
    decisions: readFeatureDtos(database, 'decisions'),
    models: readFeatureDtos(database, 'models'),
    diagnostics: readFeatureDtos(database, 'diagnostics'),
    inferenceStreams: readFeatureDtos(database, 'inference_streams'),
    tombstones: readProjectionTombstones(database)
  });
}

function selectCommitByEventId(
  database: DatabaseSync,
  eventId: string
): CommitRow | undefined {
  return database.prepare(
    `SELECT cursor, event_id, source_id, source_cursor, contract_version,
            occurred_at, commit_json, payload_digest, history_digest
     FROM projection_commits WHERE event_id=?`
  ).get(eventId) as CommitRow | undefined;
}

function selectHead(
  database: DatabaseSync,
  feature: PublicProjectionFeature,
  aggregateId: string
): HeadRow | undefined {
  return database.prepare(
    `SELECT feature, aggregate_id, aggregate_version, operation,
            projected_at, dto_json, payload_digest, commit_cursor, change_index
     FROM projection_heads WHERE feature=? AND aggregate_id=?`
  ).get(feature, aggregateId) as HeadRow | undefined;
}

function readCurrentCursorState(database: DatabaseSync): {
  readonly cursor: number;
  readonly cursorDigest: string;
} {
  const row = database.prepare(
    `SELECT cursor, history_digest
     FROM projection_commits ORDER BY cursor DESC LIMIT 1`
  ).get() as { cursor: number; history_digest: string } | undefined;
  if (row === undefined) {
    return { cursor: 0, cursorDigest: PUBLIC_PROJECTION_GENESIS_DIGEST };
  }
  const cursor = Number(row.cursor);
  if (
    !Number.isSafeInteger(cursor)
    || cursor <= 0
    || !isCanonicalProjectionDigest(row.history_digest)
  ) {
    throw storageCorruption('current_cursor_invalid');
  }
  return { cursor, cursorDigest: row.history_digest };
}

function readCursorDigest(
  database: DatabaseSync,
  cursor: number
): string | undefined {
  if (cursor === 0) return PUBLIC_PROJECTION_GENESIS_DIGEST;
  const row = database.prepare(
    'SELECT history_digest FROM projection_commits WHERE cursor=?'
  ).get(cursor) as { history_digest: string } | undefined;
  if (row === undefined) return undefined;
  if (!isCanonicalProjectionDigest(row.history_digest)) {
    throw storageCorruption(`cursor:${String(cursor)}:history_digest_invalid`);
  }
  return row.history_digest;
}

function resetRequired(
  streamId: string,
  currentCursor: number,
  reason: 'stream_mismatch' | 'contract_mismatch' | 'cursor_gap' | 'history_mismatch'
): PublicProjectionReadBatch {
  return assertPublicProjectionReadBatch({
    status: 'reset_required',
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    streamId,
    currentCursor,
    reason
  });
}

function canonicalNow(clock: PublicProjectionPersistenceClock): string {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('public_projection_clock_invalid');
  }
  return now.toISOString();
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function nextHistoryDigest(
  previousDigest: string,
  cursor: number,
  payloadDigest: string
): string {
  return digest(
    `${PUBLIC_PROJECTION_HISTORY_DOMAIN}\u0000${previousDigest}`
    + `\u0000${String(cursor)}\u0000${payloadDigest}`
  );
}

function assertHistoryLink(row: CommitRow, previousDigest: string): void {
  assertStoredCommitHistoryLink(row, previousDigest);
}

function assertCommitHistoryLink(database: DatabaseSync, row: CommitRow): void {
  const previousDigest = readCursorDigest(database, row.cursor - 1);
  if (previousDigest === undefined) {
    throw storageCorruption(`commit:${String(row.cursor)}:history_predecessor_missing`);
  }
  assertHistoryLink(row, previousDigest);
}

function canonicalJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalPublicProjectionJson(value)).byteLength;
}

function isCanonicalProjectionDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function parseJson(value: string, source: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw storageCorruption(`${source}:invalid_json`, error);
  }
}

function sameVersionRow(left: VersionRow, right: VersionRow): boolean {
  // Compare the nine durable fields exactly; serializing dto_json again only
  // escaped the already canonical body and allocated a second full copy.
  return left.feature === right.feature && left.aggregate_id === right.aggregate_id
    && left.aggregate_version === right.aggregate_version && left.operation === right.operation
    && left.projected_at === right.projected_at && left.dto_json === right.dto_json
    && left.payload_digest === right.payload_digest && left.commit_cursor === right.commit_cursor
    && left.change_index === right.change_index;
}

function identityKey(feature: PublicProjectionFeature, aggregateId: string): string {
  return `${feature}\u0000${aggregateId}`;
}

function toSafePositiveInteger(value: number | bigint, field: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw storageCorruption(`${field}_invalid`);
  }
  return numeric;
}

function normalizeConstraintError(error: unknown): unknown {
  if (
    error instanceof Error
    && (error as Error & { code?: unknown }).code === 'ERR_SQLITE_ERROR'
    && [1555, 2067].includes((error as Error & { errcode?: number }).errcode ?? -1)
  ) {
    return storageCorruption('sqlite_constraint_conflict', error);
  }
  return error;
}

function storageCorruption(message: string, cause?: unknown): Error {
  return markAuthorityIntegrityError('projection', new Error(`public_projection_storage_corruption:${message}`, { cause }));
}

function isProjectionStorageCorruption(error: unknown): error is Error {
  return error instanceof Error && classifySqliteAuthorityFault('projection', error) !== null;
}

async function waitForDrain(
  drain: Promise<void>,
  context: PublicProjectionShutdownContext
): Promise<void> {
  context.throwIfExpired('public_projection_shutdown_deadline_exceeded');
  const remaining = context.remainingMs();
  if (remaining <= 0) throw new Error('public_projection_shutdown_deadline_exceeded');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new Error('public_projection_shutdown_deadline_exceeded'));
    onAbort = fail;
    if (context.signal.aborted) {
      fail();
      return;
    }
    context.signal.addEventListener('abort', fail, { once: true });
    timer = setTimeout(fail, Math.min(remaining, 2_147_483_647));
    timer.unref?.();
  });
  try {
    await Promise.race([drain, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) context.signal.removeEventListener('abort', onAbort);
  }
}

/** Shared final transaction for the single Projection owner. Preparation and
 * public visibility hooks execute on its supplied connection, never a second
 * database or business authority. */
export function appendProjectionLedgerCommit(database: DatabaseSync, streamId: string,
  value: StoredProjectionCommit, faultInjector: PublicProjectionPersistenceFaultInjector = {},
  hooks: { beforeChanges?: () => void; afterChanges?: (cursor: number) => void;
    onReplay?: (commit: StoredProjectionCommit, cursor: number) => void } = {}):
  PublicProjectionAppendResult & { readonly changeDigests?: readonly string[] } {
  const commit = assertStoredProjectionCommit(value);
  if (commit.contractVersion === '6.0' && (!hooks.beforeChanges || !hooks.afterChanges || !hooks.onReplay)) {
    throw new Error('run_document_publication_owner_required');
  }
  const commitJson = canonicalPublicProjectionJson(commit);
  const commitDigest = digest(commitJson);
  database.exec('BEGIN IMMEDIATE;');
  try {
    hooks.beforeChanges?.();
    const existing = selectCommitByEventId(database, commit.eventId);
    if (existing !== undefined) {
      const identical = existing.commit_json === commitJson;
      const parsed = identical ? commit : parseStoredCommitRow(existing);
      if (identical) assertStoredCommitRowBinding(existing, commit, commitJson);
      assertCommitHistoryLink(database, existing);
      if (
        !identical && !storedCommitsEquivalent(parsed, commit)
      ) {
        throw storageCorruption(`event:${commit.eventId}:payload_drift`);
      }
      hooks.onReplay?.(parsed, existing.cursor);
      database.exec('COMMIT;');
      return { cursor: existing.cursor, streamId: streamId, replayed: true };
    }

    assertNextSourceCursor(database, commit);
    const current = readCurrentCursorState(database);
    const cursor = current.cursor + 1;
    if (!Number.isSafeInteger(cursor)) {
      throw storageCorruption('commit_cursor_exhausted');
    }
    const historyDigest = nextHistoryDigest(
      current.cursorDigest,
      cursor,
      commitDigest
    );
    const inserted = database.prepare(
      `INSERT INTO projection_commits(
         cursor, event_id, source_id, source_cursor, contract_version,
         occurred_at, commit_json, payload_digest, history_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      cursor,
      commit.eventId,
      commit.sourceId,
      commit.sourceCursor,
      commit.contractVersion,
      commit.occurredAt,
      commitJson,
      commitDigest,
      historyDigest
    );
    const insertedCursor = toSafePositiveInteger(
      inserted.lastInsertRowid,
      'commit_cursor'
    );
    if (insertedCursor !== cursor) {
      throw storageCorruption(
        `commit_cursor_expected_${String(cursor)}:received_${String(insertedCursor)}`
      );
    }

    const changeDigests = commit.changes.map((change, changeIndex) => applyChange(database, cursor, changeIndex, change));
    database.prepare(
      `INSERT INTO projection_source_checkpoints(
         source_id, source_cursor, event_id, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         source_cursor=excluded.source_cursor,
         event_id=excluded.event_id,
         updated_at=excluded.updated_at`
    ).run(commit.sourceId, commit.sourceCursor, commit.eventId, commit.occurredAt);

    // Each changed head is validated by applyChange. Bootstrap reads use
    // immutable pages at C; total history size is not a write constraint.
    hooks.afterChanges?.(cursor);
    faultInjector.beforeCommit?.();
    database.exec('COMMIT;');
    faultInjector.afterCommit?.();
    return { cursor, streamId: streamId, replayed: false, changeDigests };
  } catch (error) {
    if (database.isTransaction) {
      try { database.exec('ROLLBACK;'); }
      catch (rollbackError) { throw markAuthorityUnavailableError('projection',
        new AggregateError([error, rollbackError], 'public_projection_write_rollback_failed')); }
    }
    throw normalizeConstraintError(error);
  }
}
