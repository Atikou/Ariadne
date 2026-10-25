import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { taskNotificationReferenceSchema, type TaskNotificationReference } from '@shared/task-notification';
import { unrestrictedMainWrites, type MainPersistenceAdmission } from '../data-management/main-maintenance-gate';
import { snapshotSqliteMetadata } from '../data-management/snapshot-file';
import { open } from 'node:fs/promises';
import { z } from 'zod';

const TABLES = [
  'CREATE TABLE notification_preferences (state TEXT PRIMARY KEY, enabled INTEGER NOT NULL, enabled_since TEXT NOT NULL) STRICT',
  'CREATE TABLE notification_delivery (run_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, source_status TEXT NOT NULL, shown_at TEXT, retry_after INTEGER NOT NULL, PRIMARY KEY (run_id, workspace_id, session_id, version, state, source_status)) STRICT'
];
export type TaskNotificationPreferences = { completed: boolean; failed: boolean };
const timestamp = z.iso.datetime();
const preferenceRow = z.object({ state: z.enum(['completed', 'failed']), enabled: z.union([z.literal(0), z.literal(1)]), enabled_since: timestamp }).strict();

function assertCurrentReceiptSchema(database: DatabaseSync): void {
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  const objects = database.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if (version !== 1 || objects.length !== TABLES.length || !TABLES.every(sql => objects.some(row => row.sql === sql)))
    throw new Error('notification_delivery_format_unknown');
  if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('notification_delivery_integrity_failed');
}

/** Validate an authenticated isolated file without creating, migrating or
 * changing a live notification consumer or its delivery history. */
export function validateTaskNotificationBackup(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON'); assertCurrentReceiptSchema(database);
    for (const row of database.prepare('SELECT * FROM notification_preferences').iterate()) preferenceRow.parse(row);
    for (const row of database.prepare('SELECT * FROM notification_delivery').iterate()) {
      taskNotificationReferenceSchema.parse({ runId: row.run_id, workspaceId: row.workspace_id, sessionId: row.session_id,
        version: row.version, state: row.state, sourceStatus: row.source_status });
      if (row.shown_at !== null) timestamp.parse(row.shown_at);
      z.number().int().nonnegative().safe().parse(row.retry_after);
    }
  } finally { database.close(); }
}

/** A disk index of observed native delivery, owned by the existing Main notification
 * consumer. No task state/body is copied and no age/count eviction can replay history. */
export class TaskNotificationReceipts {
  private database: DatabaseSync | null = null;
  private unavailable = false;
  constructor(private readonly path: string, private readonly now: () => number = Date.now,
    private readonly writes: MainPersistenceAdmission = unrestrictedMainWrites) {}
  async initialize(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const database = new DatabaseSync(this.path); this.database = database;
      database.exec('PRAGMA busy_timeout=1000');
      const version = database.prepare('PRAGMA user_version').get()?.user_version;
      const objects = database.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      if (version === 0 && objects.length === 0) {
        database.exec('BEGIN IMMEDIATE');
        try { for (const sql of TABLES) database.exec(sql); database.exec('PRAGMA user_version=1; COMMIT'); }
        catch (error) { database.exec('ROLLBACK'); throw error; }
      }
      assertCurrentReceiptSchema(database);
    } catch { this.disable(); }
  }
  configure(preferences: TaskNotificationPreferences): Partial<Record<'completed' | 'failed', string>> {
    return this.writes.writeSync(() => this.access({}, database => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const windows: Partial<Record<'completed' | 'failed', string>> = {};
        for (const state of ['completed', 'failed'] as const) {
          const previous = database.prepare('SELECT enabled, enabled_since FROM notification_preferences WHERE state=?').get(state);
          const enabled = preferences[state];
          const since = enabled && previous?.enabled === 1 ? String(previous.enabled_since) : new Date(this.now()).toISOString();
          database.prepare('INSERT INTO notification_preferences VALUES (?,?,?) ON CONFLICT(state) DO UPDATE SET enabled=excluded.enabled, enabled_since=excluded.enabled_since')
            .run(state, enabled ? 1 : 0, since);
          if (enabled) windows[state] = since;
        }
        database.exec('COMMIT'); return windows;
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    }));
  }
  eligible(reference: TaskNotificationReference): boolean {
    const ref = taskNotificationReferenceSchema.parse(reference);
    return this.access(false, database => {
      const row = database.prepare('SELECT shown_at, retry_after FROM notification_delivery WHERE run_id=? AND workspace_id=? AND session_id=? AND version=? AND state=? AND source_status=?')
        .get(...this.identity(ref));
      return !row || (row.shown_at === null && Number(row.retry_after) <= this.now());
    });
  }
  requested(reference: TaskNotificationReference, delay = 30_000): void { this.write(reference, null, this.now() + delay); }
  shown(reference: TaskNotificationReference): void { this.write(reference, new Date(this.now()).toISOString(), 0); }
  failed(reference: TaskNotificationReference): void { this.requested(reference, 60_000); }
  close(): void { this.database?.close(); this.database = null; }
  /** Capture through the original connection after its write admission closes.
   * Failure never disables this business-independent delivery owner. */
  async captureSnapshot(destination: string): Promise<{ userVersion: number; schemaDigest: string }> {
    if (!this.database || this.unavailable) throw new Error('notification_snapshot_unavailable');
    const metadata = snapshotSqliteMetadata(this.database);
    this.database.exec("VACUUM INTO '" + destination.replaceAll("'", "''") + "';");
    const copy = new DatabaseSync(destination, { readOnly: true });
    try { if (JSON.stringify(snapshotSqliteMetadata(copy)) !== JSON.stringify(metadata)) throw new Error('notification_snapshot_metadata_changed'); }
    finally { copy.close(); }
    const file = await open(destination, 'r+'); try { await file.sync(); } finally { await file.close(); }
    return metadata;
  }
  private identity(ref: TaskNotificationReference): [string, string, string, number, string, string] {
    return [ref.runId, ref.workspaceId, ref.sessionId, ref.version, ref.state, ref.sourceStatus];
  }
  private write(reference: TaskNotificationReference, shownAt: string | null, retryAfter: number): void {
    const ref = taskNotificationReferenceSchema.parse(reference);
    this.writes.writeSync(() => this.access(undefined, database => {
      database.prepare('INSERT INTO notification_delivery VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id,workspace_id,session_id,version,state,source_status) DO UPDATE SET shown_at=coalesce(notification_delivery.shown_at,excluded.shown_at), retry_after=excluded.retry_after')
        .run(...this.identity(ref), shownAt, retryAfter);
    }));
  }
  private access<T>(fallback: T, operation: (database: DatabaseSync) => T): T {
    if (!this.database || this.unavailable) return fallback;
    try { return operation(this.database); } catch { this.disable(); return fallback; }
  }
  private disable(): void {
    this.unavailable = true;
    try { this.close(); } catch { this.database = null; }
    console.warn('Task notification delivery storage is unavailable; existing data is retained and terminal reminders are paused.');
  }
}
