import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST,
  publicProjectionCanonicalIdSchema,
  type ProjectionCommitV3,
  type PublicProjectionChangeV3,
  type PublicProjectionFeatureV3,
  type PublicProjectionReadBatchV3,
  type PublicProjectionReadRequestV3,
  type PublicProjectionSnapshotV3,
  type PublicProjectionTombstoneV3
} from '@ariadne/protocol/public';

import {
  assertValidProjectionCommitV3 as assertPublicProjectionCommitV3,
  assertValidPublicProjectionReadBatchV3 as assertPublicProjectionReadBatchV3,
  assertValidPublicProjectionReadRequestV3 as assertPublicProjectionReadRequestV3,
  assertValidPublicProjectionSnapshotV3 as assertPublicProjectionSnapshotV3,
  canonicalPublicProjectionJson as canonicalPublicProjectionJsonV3
} from '../../projection/PublicProjectionContractV3.js';
import type {
  ModelCatalogProjectionHead
} from '../../projection/ModelCatalogProjectionPorts.js';
import { openPublicProjectionDatabase } from './PublicProjectionDbSchema.js';
import {
  closeOwnedSqliteDatabase,
  type SqliteOwnerLease
} from './SqliteOwnerLease.js';

export interface PublicProjectionPersistenceClock {
  now(): Date;
}

export interface PublicProjectionPersistenceFaultInjector {
  beforeCommit?(): void;
  afterCommit?(): void;
}

export interface PublicProjectionShutdownContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(reserveMs?: number): number;
  throwIfExpired(code?: string): void;
}

export interface PublicProjectionAppendResult {
  readonly cursor: number;
  readonly streamId: string;
  readonly replayed: boolean;
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
  readonly feature: PublicProjectionFeatureV3;
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

export class SqlitePublicProjectionStore {
  public readonly streamId: string;

  private readonly database: DatabaseSync;
  private readonly databasePath: string;
  private readonly ownerLease: SqliteOwnerLease;
  private accepting = true;
  private closed = false;
  private unhealthyCause: Error | null = null;
  private tail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;

  public constructor(
    dataRoot: string,
    private readonly clock: PublicProjectionPersistenceClock = systemClock,
    private readonly faultInjector: PublicProjectionPersistenceFaultInjector = {}
  ) {
    const opened = openPublicProjectionDatabase(dataRoot);
    this.database = opened.database;
    this.databasePath = opened.databasePath;
    this.ownerLease = opened.ownerLease;
    this.streamId = opened.streamId;
    try {
      auditStoredProjectionState(this.database);
    } catch (error) {
      try {
        closeOwnedSqliteDatabase(this.database, this.ownerLease);
      } catch {
        // Preserve the corruption evidence and keep uncertain close state fenced.
      }
      this.closed = true;
      this.accepting = false;
      throw error;
    }
  }

  public append(commitValue: unknown): Promise<PublicProjectionAppendResult> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    try {
      const commit = assertPublicProjectionCommitV3(commitValue);
      return this.schedule(() => this.appendNow(commit));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  public snapshot(): Promise<PublicProjectionSnapshotV3> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    return this.schedule(() => this.snapshotNow());
  }

  public readModelProjectionHeads(): Promise<readonly ModelCatalogProjectionHead[]> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    return this.schedule(() => readModelProjectionHeads(this.database));
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
    requestValue: PublicProjectionReadRequestV3 | unknown
  ): Promise<PublicProjectionReadBatchV3> {
    if (this.unhealthyCause !== null) return Promise.reject(this.unhealthyError());
    try {
      const request = assertPublicProjectionReadRequestV3(requestValue);
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
      this.closed = true;
    })();
    return this.closePromise;
  }

  private schedule<T>(operation: () => T): Promise<T> {
    if (this.unhealthyCause !== null) {
      return Promise.reject(this.unhealthyError());
    }
    if (!this.accepting || this.closed) {
      return Promise.reject(new Error('public_projection_store_closed'));
    }
    const result = this.tail.then(() => {
      // Work already admitted before close owns its place in the durable
      // queue. Closing only freezes new admissions and waits for this tail.
      if (this.closed) {
        throw new Error('public_projection_store_closed');
      }
      if (this.unhealthyCause !== null) throw this.unhealthyError();
      try {
        return operation();
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
    return new Error('public_projection_store_unhealthy', {
      cause: this.unhealthyCause ?? undefined
    });
  }

  private appendNow(commit: ProjectionCommitV3): PublicProjectionAppendResult {
    const commitJson = canonicalPublicProjectionJsonV3(commit);
    const commitDigest = digest(commitJson);
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const existing = selectCommitByEventId(this.database, commit.eventId);
      if (existing !== undefined) {
        const parsed = parseCommitRow(existing);
        assertCommitHistoryLink(this.database, existing);
        if (
          existing.payload_digest !== commitDigest
          || canonicalPublicProjectionJsonV3(parsed) !== commitJson
        ) {
          throw storageCorruption(`event:${commit.eventId}:payload_drift`);
        }
        this.database.exec('COMMIT;');
        return { cursor: existing.cursor, streamId: this.streamId, replayed: true };
      }

      assertNextSourceCursor(this.database, commit);
      const current = readCurrentCursorState(this.database);
      const cursor = current.cursor + 1;
      if (!Number.isSafeInteger(cursor)) {
        throw storageCorruption('commit_cursor_exhausted');
      }
      const historyDigest = nextHistoryDigest(
        current.cursorDigest,
        cursor,
        commitDigest
      );
      const inserted = this.database.prepare(
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

      commit.changes.forEach((change, changeIndex) => {
        applyChange(this.database, cursor, changeIndex, change);
      });
      this.database.prepare(
        `INSERT INTO projection_source_checkpoints(
           source_id, source_cursor, event_id, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           source_cursor=excluded.source_cursor,
           event_id=excluded.event_id,
           updated_at=excluded.updated_at`
      ).run(commit.sourceId, commit.sourceCursor, commit.eventId, commit.occurredAt);

      // The full snapshot is the only reset/bootstrap authority. Never make a
      // commit durable if it would leave that authority unreadable.
      buildSnapshot(
        this.database,
        this.streamId,
        cursor,
        historyDigest,
        canonicalNow(this.clock)
      );

      this.faultInjector.beforeCommit?.();
      this.database.exec('COMMIT;');
      this.faultInjector.afterCommit?.();
      return { cursor, streamId: this.streamId, replayed: false };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK;');
      throw normalizeConstraintError(error);
    }
  }

  private snapshotNow(): PublicProjectionSnapshotV3 {
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

  private readNow(request: PublicProjectionReadRequestV3): PublicProjectionReadBatchV3 {
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
        readonly commit: ProjectionCommitV3;
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
        const commit = parseCommitRow(row);
        assertHistoryLink(row, previousDigest);
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
      const result = assertPublicProjectionReadBatchV3({
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
  change: PublicProjectionChangeV3
): void {
  const changeJson = canonicalPublicProjectionJsonV3(change);
  const changeDigest = digest(changeJson);
  const dtoJson = change.dto === null
    ? null
    : canonicalPublicProjectionJsonV3(change.dto);
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
    const historicalChange = versionRowAsChange(historical);
    if (canonicalPublicProjectionJsonV3(historicalChange) !== changeJson) {
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
}

function assertNextSourceCursor(database: DatabaseSync, commit: ProjectionCommitV3): void {
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

function auditStoredProjectionState(database: DatabaseSync): void {
  const commits = database.prepare(
    `SELECT cursor, event_id, source_id, source_cursor, contract_version,
            occurred_at, commit_json, payload_digest, history_digest
     FROM projection_commits ORDER BY cursor`
  ).all() as unknown as CommitRow[];
  const commitByCursor = new Map<number, ProjectionCommitV3>();
  const expectedSourceCursor = new Map<string, number>();
  let expectedCursor = 1;
  let previousHistoryDigest: string = PUBLIC_PROJECTION_GENESIS_DIGEST;
  for (const row of commits) {
    if (row.cursor !== expectedCursor) {
      throw storageCorruption(`commit_cursor_gap:${String(expectedCursor)}`);
    }
    const commit = parseCommitRow(row);
    assertHistoryLink(row, previousHistoryDigest);
    const sourceExpected = (expectedSourceCursor.get(commit.sourceId) ?? 0) + 1;
    if (commit.sourceCursor !== sourceExpected) {
      throw storageCorruption(`source:${commit.sourceId}:history_gap`);
    }
    expectedSourceCursor.set(commit.sourceId, commit.sourceCursor);
    commitByCursor.set(row.cursor, commit);
    previousHistoryDigest = row.history_digest;
    expectedCursor += 1;
  }

  const versions = database.prepare(
    `SELECT feature, aggregate_id, aggregate_version, operation,
            projected_at, dto_json, payload_digest, commit_cursor, change_index
     FROM projection_versions ORDER BY commit_cursor, change_index`
  ).all() as unknown as VersionRow[];
  const latestByAggregate = new Map<string, VersionRow>();
  const seenCommitChanges = new Set<string>();
  for (const row of versions) {
    const commit = commitByCursor.get(row.commit_cursor);
    const change = commit?.changes[row.change_index];
    if (commit === undefined || change === undefined) {
      throw storageCorruption('version_commit_reference_missing');
    }
    assertVersionRowMatchesChange(row, change);
    const changeKey = `${String(row.commit_cursor)}:${String(row.change_index)}`;
    if (seenCommitChanges.has(changeKey)) {
      throw storageCorruption(`version_change_duplicate:${changeKey}`);
    }
    seenCommitChanges.add(changeKey);
    const aggregateKey = identityKey(row.feature, row.aggregate_id);
    const previous = latestByAggregate.get(aggregateKey);
    if (row.aggregate_version !== (previous?.aggregate_version ?? 0) + 1) {
      throw storageCorruption(`version_history_gap:${aggregateKey}`);
    }
    latestByAggregate.set(aggregateKey, row);
  }
  const expectedChangeCount = commits.reduce(
    (total, row) => total + parseCommitRow(row).changes.length,
    0
  );
  if (seenCommitChanges.size !== expectedChangeCount) {
    throw storageCorruption('commit_change_artifacts_missing');
  }

  const heads = database.prepare(
    `SELECT feature, aggregate_id, aggregate_version, operation,
            projected_at, dto_json, payload_digest, commit_cursor, change_index
     FROM projection_heads ORDER BY feature, aggregate_id`
  ).all() as unknown as HeadRow[];
  if (heads.length !== latestByAggregate.size) {
    throw storageCorruption('projection_heads_count_mismatch');
  }
  for (const head of heads) {
    const latest = latestByAggregate.get(identityKey(head.feature, head.aggregate_id));
    if (latest === undefined || canonicalRow(latest) !== canonicalRow(head)) {
      throw storageCorruption(
        `projection_head_mismatch:${head.feature}:${head.aggregate_id}`
      );
    }
  }

  const checkpoints = database.prepare(
    `SELECT source_id, source_cursor, event_id, updated_at
     FROM projection_source_checkpoints ORDER BY source_id`
  ).all() as unknown as CheckpointRow[];
  if (checkpoints.length !== expectedSourceCursor.size) {
    throw storageCorruption('source_checkpoint_count_mismatch');
  }
  for (const checkpoint of checkpoints) {
    const last = [...commits].reverse().find((row) => row.source_id === checkpoint.source_id);
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

function parseCommitRow(row: CommitRow): ProjectionCommitV3 {
  const parsed = parseJson(row.commit_json, `commit:${String(row.cursor)}`);
  const commit = assertPublicProjectionCommitV3(parsed);
  const canonical = canonicalPublicProjectionJsonV3(commit);
  if (
    !Number.isSafeInteger(row.cursor)
    || row.cursor <= 0
    || row.event_id !== commit.eventId
    || row.source_id !== commit.sourceId
    || row.source_cursor !== commit.sourceCursor
    || row.contract_version !== commit.contractVersion
    || row.occurred_at !== commit.occurredAt
    || row.commit_json !== canonical
    || row.payload_digest !== digest(canonical)
    || !isCanonicalProjectionDigest(row.history_digest)
  ) {
    throw storageCorruption(`commit:${String(row.cursor)}:row_mismatch`);
  }
  return commit;
}

function assertVersionRowMatchesChange(
  row: VersionRow,
  change: PublicProjectionChangeV3
): void {
  const dtoJson = change.dto === null ? null : canonicalPublicProjectionJsonV3(change.dto);
  const canonical = canonicalPublicProjectionJsonV3(change);
  if (
    row.feature !== change.feature
    || row.aggregate_id !== change.aggregateId
    || row.aggregate_version !== change.aggregateVersion
    || row.operation !== change.operation
    || row.projected_at !== change.projectedAt
    || row.dto_json !== dtoJson
    || row.payload_digest !== digest(canonical)
  ) {
    throw storageCorruption(
      `version:${row.feature}:${row.aggregate_id}:${String(row.aggregate_version)}:row_mismatch`
    );
  }
}

function versionRowAsChange(row: VersionRow): PublicProjectionChangeV3 {
  return assertPublicProjectionCommitV3({
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: 'stored-version-check',
    sourceId: 'stored-version-check',
    sourceCursor: 1,
    occurredAt: row.projected_at,
    changes: [{
      feature: row.feature,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      operation: row.operation,
      projectedAt: row.projected_at,
      dto: row.dto_json === null
        ? null
        : parseJson(row.dto_json, 'stored_version_dto')
    }]
  }).changes[0]!;
}

function readFeatureDtos(
  database: DatabaseSync,
  feature: PublicProjectionFeatureV3
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
): PublicProjectionTombstoneV3[] {
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
): PublicProjectionSnapshotV3 {
  return assertPublicProjectionSnapshotV3({
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
  feature: PublicProjectionFeatureV3,
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
): PublicProjectionReadBatchV3 {
  return assertPublicProjectionReadBatchV3({
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
    `ariadne-public-projection-v3\u0000${previousDigest}`
    + `\u0000${String(cursor)}\u0000${payloadDigest}`
  );
}

function assertHistoryLink(row: CommitRow, previousDigest: string): void {
  const expected = nextHistoryDigest(
    previousDigest,
    row.cursor,
    row.payload_digest
  );
  if (row.history_digest !== expected) {
    throw storageCorruption(`commit:${String(row.cursor)}:history_digest_mismatch`);
  }
}

function assertCommitHistoryLink(database: DatabaseSync, row: CommitRow): void {
  const previousDigest = readCursorDigest(database, row.cursor - 1);
  if (previousDigest === undefined) {
    throw storageCorruption(`commit:${String(row.cursor)}:history_predecessor_missing`);
  }
  assertHistoryLink(row, previousDigest);
}

function canonicalJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalPublicProjectionJsonV3(value)).byteLength;
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

function canonicalRow(row: VersionRow): string {
  return canonicalPublicProjectionJsonV3({
    feature: row.feature,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    operation: row.operation,
    projectedAt: row.projected_at,
    dtoJson: row.dto_json,
    payloadDigest: row.payload_digest,
    commitCursor: row.commit_cursor,
    changeIndex: row.change_index
  });
}

function identityKey(feature: PublicProjectionFeatureV3, aggregateId: string): string {
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
    && (error.message.includes('constraint failed') || error.message.includes('UNIQUE constraint'))
  ) {
    return storageCorruption('sqlite_constraint_conflict', error);
  }
  return error;
}

function storageCorruption(message: string, cause?: unknown): Error {
  return new Error(`public_projection_storage_corruption:${message}`, { cause });
}

function isProjectionStorageCorruption(error: unknown): error is Error {
  return error instanceof Error
    && error.message.startsWith('public_projection_storage_corruption:');
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
