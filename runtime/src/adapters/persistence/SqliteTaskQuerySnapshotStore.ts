import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TASK_CENTER_QUERY_VERSION, MAX_TASK_CENTER_PAGE_BYTES, taskCenterFilterSchema,
  taskCenterPageSchema, taskDirectoryRowSchema, taskReferenceKey,
  type TaskCenterFilter, type TaskCenterPage, type TaskDirectoryRow, type TaskReference } from '@ariadne/protocol/public';
import { TaskQueryCurrentIndex } from './TaskQueryCurrentIndex.js';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase, type SqliteOwnerLease } from './SqliteOwnerLease.js';
import { initializeTaskQuerySnapshotSchema } from './TaskQuerySnapshotSchema.js';
import { decodeTaskSnapshotCursor, encodeTaskSnapshotCursor, matchesTaskCenterFilter,
  MAX_TASK_QUERY_SNAPSHOTS, TASK_QUERY_SNAPSHOT_LIFETIME_MS, TASK_QUERY_SNAPSHOT_RELATIVE_PATH,
  taskSnapshotCoverageSchema, TaskQuerySnapshotReset, type TaskSnapshotCoverage } from './TaskQuerySnapshotRecords.js';

interface SnapshotHeader {
  snapshot_id: string; scope_key: string; filter_json: string; captured_at: string;
  expires_at: number; coverage_json: string | null; ready: number;
}
/** Immutable, leased, disposable query snapshots. No business command or body is stored. */
export class SqliteTaskQuerySnapshotStore {
  private database: DatabaseSync | null = null;
  private lease: SqliteOwnerLease | null = null;
  private failed = false;
  private readonly secret = randomBytes(32);
  get available(): boolean { return this.database !== null && !this.failed; }
  constructor(dataRoot: string, private readonly now: () => number = Date.now) {
    const file = path.resolve(dataRoot, TASK_QUERY_SNAPSHOT_RELATIVE_PATH);
    let database: DatabaseSync | null = null, lease: SqliteOwnerLease | null = null;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      lease = acquireSqliteOwnerLease(file, 'task-query-snapshots');
      database = new DatabaseSync(file);
      database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
      initializeTaskQuerySnapshotSchema(database);
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      // Process-local cursor signatures cannot authorize an earlier process's snapshots.
      database.exec('DELETE FROM task_query_snapshots; DELETE FROM task_query_current; DELETE FROM task_query_decisions;');
      this.database = database; this.lease = lease;
    } catch {
      if (database && lease) closeOwnedSqliteDatabase(database, lease);
      else lease?.close();
    }
  }
  begin(scopeKey: string, input: TaskCenterFilter): string {
    if (!scopeKey || scopeKey.length > 128) throw new TaskQuerySnapshotReset('scope_changed');
    const filter = taskCenterFilterSchema.parse(input), id = randomUUID(), now = this.now();
    this.transaction(database => {
      database.prepare('DELETE FROM task_query_snapshots WHERE expires_at<=?').run(now);
      database.prepare(`DELETE FROM task_query_snapshots WHERE snapshot_id IN
        (SELECT snapshot_id FROM task_query_snapshots ORDER BY captured_at DESC,snapshot_id DESC LIMIT -1 OFFSET ?)`)
        .run(MAX_TASK_QUERY_SNAPSHOTS - 1);
      database.prepare('INSERT INTO task_query_snapshots VALUES (?,?,?,?,?,NULL,0)')
        .run(id, scopeKey, JSON.stringify(filter), new Date(now).toISOString(), now + TASK_QUERY_SNAPSHOT_LIFETIME_MS);
    });
    return id;
  }
  append(snapshotId: string, scopeKey: string, rows: readonly TaskDirectoryRow[]): void {
    if (rows.length > 128) throw new Error('task_query_snapshot_batch_overflow');
    // Validate every row before BEGIN so no schema failure publishes a partial batch.
    const validated = rows.map(row => taskDirectoryRowSchema.parse(row));
    this.transaction(database => {
      const header = this.header(snapshotId, scopeKey);
      if (header.ready !== 0) throw new Error('task_query_snapshot_already_sealed');
      const filter = taskCenterFilterSchema.parse(JSON.parse(header.filter_json));
      const insert = database.prepare('INSERT INTO task_query_rows VALUES (?,?,?,?)');
      for (const row of validated) {
        if (matchesTaskCenterFilter(row, filter)) insert.run(snapshotId, taskReferenceKey(row.metadata.reference),
          row.metadata.updatedAt ?? '', JSON.stringify(row));
      }
    });
  }
  seal(snapshotId: string, scopeKey: string, coverage: TaskSnapshotCoverage): void {
    const validated = taskSnapshotCoverageSchema.parse(coverage);
    if (new Set(validated.map(item => item.source)).size !== 3) throw new Error('task_query_coverage_duplicate');
    this.transaction(database => {
      if (this.header(snapshotId, scopeKey).ready !== 0) throw new Error('task_query_snapshot_already_sealed');
      database.prepare('UPDATE task_query_snapshots SET coverage_json=?,ready=1 WHERE snapshot_id=?')
        .run(JSON.stringify(validated), snapshotId);
    });
  }
  discard(snapshotId: string, scopeKey: string): void {
    this.transaction(database => database.prepare('DELETE FROM task_query_snapshots WHERE snapshot_id=? AND scope_key=?')
      .run(snapshotId, scopeKey));
  }
  mergeCurrent(source: TaskReference['source'], tag: string, rows: readonly TaskDirectoryRow[]): void {
    this.transaction(database => new TaskQueryCurrentIndex(database).merge(source, tag, rows));
  }
  finishCurrent(source: TaskReference['source'], tag: string): void {
    this.transaction(database => new TaskQueryCurrentIndex(database).finish(source, tag));
  }
  currentItem(reference: TaskReference): TaskDirectoryRow | null {
    try { return new TaskQueryCurrentIndex(this.requireDatabase()).item(reference); }
    catch (error) { this.failed = true; throw new TaskQuerySnapshotReset('unavailable'); }
  }
  mergeDecisions(tag: string, decisions: readonly TaskDirectoryRow['decisions'][number][]): void {
    this.transaction(database => new TaskQueryCurrentIndex(database).mergeDecisions(tag, decisions));
  }
  finishDecisions(tag: string): void {
    this.transaction(database => new TaskQueryCurrentIndex(database).finishDecisions(tag));
  }
  currentDecisions(workspaceId: string, sessionId: string, runId: string): TaskDirectoryRow['decisions'] {
    return new TaskQueryCurrentIndex(this.requireDatabase()).decisions(workspaceId, sessionId, runId);
  }
  captureCurrent(scopeKey: string, filter: TaskCenterFilter, coverage: TaskSnapshotCoverage,
    authorizedWorkspaces: readonly string[] | null): string {
    const id = this.begin(scopeKey, filter);
    try {
      this.transaction(database => new TaskQueryCurrentIndex(database).capture(id, filter, authorizedWorkspaces));
      this.seal(id, scopeKey, coverage); return id;
    } catch (error) { this.discard(id, scopeKey); throw error; }
  }
  page(scopeKey: string, filter: TaskCenterFilter, snapshotId: string | null,
    encodedCursor: string | null, limit: number): TaskCenterPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('task_query_page_limit_invalid');
    const requested = taskCenterFilterSchema.parse(filter);
    const filterKey = createHash('sha256').update(JSON.stringify(requested)).digest('hex');
    const cursor = encodedCursor === null ? null : decodeTaskSnapshotCursor(encodedCursor, this.secret);
    if (cursor && (cursor.scopeKey !== scopeKey || cursor.filterKey !== filterKey))
      throw new TaskQuerySnapshotReset('scope_changed');
    if (cursor && snapshotId !== null && cursor.snapshotId !== snapshotId) throw new TaskQuerySnapshotReset('invalid_cursor');
    const id = cursor?.snapshotId ?? snapshotId;
    if (id === null) throw new TaskQuerySnapshotReset('invalid_cursor');
    const header = this.header(id, scopeKey);
    if (header.ready !== 1 || header.coverage_json === null) throw new TaskQuerySnapshotReset('unavailable');
    if (header.filter_json !== JSON.stringify(requested)) throw new TaskQuerySnapshotReset('scope_changed');
    const database = this.requireDatabase(), coverage = taskSnapshotCoverageSchema.parse(JSON.parse(header.coverage_json));
    const selected = cursor === null || cursor.start
      ? database.prepare('SELECT task_key,sort_time,row_json FROM task_query_rows WHERE snapshot_id=? ORDER BY sort_time DESC,task_key LIMIT ?').all(id, limit + 1)
      : database.prepare(`SELECT task_key,sort_time,row_json FROM task_query_rows WHERE snapshot_id=?
          AND (sort_time<? OR (sort_time=? AND task_key>?)) ORDER BY sort_time DESC,task_key LIMIT ?`)
        .all(id, cursor.time, cursor.time, cursor.key, limit + 1);
    const total = Number(database.prepare('SELECT COUNT(*) AS total FROM task_query_rows WHERE snapshot_id=?').get(id)?.total);
    const page: TaskCenterPage = { kind: 'tasks.query_result', contractVersion: TASK_CENTER_QUERY_VERSION,
      snapshotId: id, capturedAt: header.captured_at, expiresAt: new Date(header.expires_at).toISOString(),
      consistency: 'eventual', filter: requested, complete: coverage.every(item => item.status === 'ready'),
      watermarks: coverage, indexedTotal: total, rows: [],
      pageCursor: encodedCursor ?? encodeTaskSnapshotCursor({ snapshotId: id, scopeKey,
        filterKey, time: '', key: 'first', start: true }, this.secret), nextCursor: null };
    for (let index = 0; index < Math.min(limit, selected.length); index++) {
      const record = selected[index]!;
      const row = taskDirectoryRowSchema.parse(JSON.parse(String(record.row_json)));
      const next = index + 1 < selected.length ? encodeTaskSnapshotCursor({ snapshotId: id, scopeKey,
        filterKey, time: String(record.sort_time), key: String(record.task_key), start: false }, this.secret) : null;
      const candidate = { ...page, rows: [...page.rows, row], nextCursor: next };
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_TASK_CENTER_PAGE_BYTES) {
        if (page.rows.length === 0) throw new TaskQuerySnapshotReset('unavailable');
        break;
      }
      page.rows = candidate.rows; page.nextCursor = next;
    }
    return taskCenterPageSchema.parse(page);
  }
  close(): void {
    const database = this.database, lease = this.lease;
    this.database = null; this.lease = null;
    if (database && lease) closeOwnedSqliteDatabase(database, lease);
    else lease?.close();
  }
  private header(snapshotId: string, scopeKey: string): SnapshotHeader {
    const row = this.requireDatabase().prepare('SELECT * FROM task_query_snapshots WHERE snapshot_id=?').get(snapshotId);
    if (!row || Number(row.expires_at) <= this.now()) throw new TaskQuerySnapshotReset('expired');
    if (row.scope_key !== scopeKey) throw new TaskQuerySnapshotReset('scope_changed');
    return row as unknown as SnapshotHeader;
  }
  private requireDatabase(): DatabaseSync {
    if (this.database === null || this.failed) throw new TaskQuerySnapshotReset('unavailable');
    return this.database;
  }
  private transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.requireDatabase(); database.exec('BEGIN IMMEDIATE;');
    try { const result = operation(database); database.exec('COMMIT;'); return result; }
    catch (error) {
      try { if (database.isTransaction) database.exec('ROLLBACK;'); }
      catch { this.failed = true; }
      const sqlite = error as { code?: unknown; errcode?: unknown };
      // A rolled-back UNIQUE/precondition rejection is not damaged storage.
      if (sqlite?.code === 'ERR_SQLITE_ERROR' && typeof sqlite.errcode === 'number'
        && [8, 10, 11, 13, 14, 26].includes(sqlite.errcode & 255)) this.failed = true;
      throw error;
    }
  }
}
