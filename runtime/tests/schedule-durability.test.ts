import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { migrateProductivityV1ToV2 } from '../src/adapters/persistence/ProductivityV1ToV2Migration.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const scope = { contractVersion: '5.0', workspaceId: 'workspace-1', sessionId: 'session-1' } as const;
const clock = new Date('2098-01-01T00:00:00Z');
const roots: string[] = []; const stores: SqliteProductivityStore[] = [];
const query = { ...scope, kind: 'schedule.occurrences.query', before: null, limit: 50 } as const;
function open(root?: string) {
  const directory = root ?? mkdtempSync(path.join(os.tmpdir(), 'ariadne-schedule-durability-'));
  if (root === undefined) roots.push(directory);
  const store = new SqliteProductivityStore(directory); stores.push(store); return { store, root: directory };
}
async function close(store: SqliteProductivityStore) {
  const shutdown = createShutdownContext(Date.now() + 5_000); try { await store.close(shutdown); } finally { shutdown.dispose(); }
}
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await close(store); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function due(store: SqliteProductivityStore) {
  await store.execute('schedule', { ...scope, kind: 'schedule.create', scheduleId: 'schedule-1', prompt: 'Actual scheduled task',
    timing: { kind: 'once', at: clock.toISOString(), missPolicy: 'run_once' } }, clock);
  await store.materializeDue(clock); return (await store.pendingOccurrences(16, clock))[0]!;
}

describe('durable submission lease, backoff and offline upgrade', () => {
  it('charges before I/O, refuses a second claim and preserves the exact retry boundary after reopening', async () => {
    const { store, root } = open(); const item = await due(store);
    expect(await store.claimOccurrence(item.occurrenceId, clock, 10_000)).toBe(true);
    expect((await store.queryOccurrences(query)).occurrences[0]).toMatchObject({ attempts: 1, nextAttemptAt: null,
      attemptDeadlineAt: new Date(clock.getTime() + 10_000).toISOString() });
    expect(await store.claimOccurrence(item.occurrenceId, clock)).toBe(false);
    await store.settleOccurrence(item.occurrenceId, false, 'schedule_submission_uncertain', true, clock); await close(store);
    const recovered = open(root).store;
    expect(await recovered.pendingOccurrences(16, new Date(clock.getTime() + 999))).toEqual([]);
    expect(await recovered.claimOccurrence(item.occurrenceId, new Date(clock.getTime() + 999))).toBe(false);
    expect((await recovered.pendingOccurrences(16, new Date(clock.getTime() + 1_000)))[0]).toEqual({ ...item, attempts: 1 });
    expect(await recovered.claimOccurrence(item.occurrenceId, new Date(clock.getTime() + 1_000))).toBe(true);
    await recovered.settleOccurrence(item.occurrenceId, true, undefined, true, new Date(clock.getTime() + 1_000));
    expect((await recovered.queryOccurrences(query)).occurrences[0]).toMatchObject({ status: 'submitted', attempts: 2, nextAttemptAt: null, attemptDeadlineAt: null });
  });

  it('bounds repeated crashes by charged attempts and waits for each abandoned lease plus backoff', async () => {
    const first = open(); let store = first.store; const item = await due(store); let time = clock.getTime();
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect(await store.claimOccurrence(item.occurrenceId, new Date(time), 100)).toBe(true);
      await close(store); store = open(first.root).store;
      await store.materializeDue(new Date(time + 99));
      expect(await store.pendingOccurrences(16, new Date(time + 99))).toEqual([]);
      await store.materializeDue(new Date(time + 100));
      const snapshot = (await store.queryOccurrences(query)).occurrences[0]!;
      expect(snapshot.attempts).toBe(attempt); expect(snapshot.attemptDeadlineAt).toBeNull();
      if (attempt < 8) {
        time = Date.parse(snapshot.nextAttemptAt!);
        expect(await store.pendingOccurrences(16, new Date(time - 1))).toEqual([]);
      } else expect(snapshot).toMatchObject({ status: 'failed', attempts: 8, canRetry: true, nextAttemptAt: null });
    }
    expect(await store.claimOccurrence(item.occurrenceId, new Date(time + 60_000))).toBe(false);
    await store.execute('manual-retry', { ...scope, kind: 'schedule.occurrence.retry', occurrenceId: item.occurrenceId, expectedAttempts: 8 }, new Date(time));
    expect(await store.claimOccurrence(item.occurrenceId, new Date(time))).toBe(true);
    await store.settleOccurrence(item.occurrenceId, false, 'schedule_submission_uncertain', true, new Date(time));
    expect((await store.queryOccurrences(query)).occurrences[0]).toMatchObject({ status: 'failed', attempts: 9, nextAttemptAt: null });
  });

  it('keeps the claim active when a settlement clock regresses and rejects invalid submission deadlines', async () => {
    const { store } = open(); const item = await due(store);
    await expect(store.claimOccurrence(item.occurrenceId, clock, 120_001)).rejects.toThrow('schedule_submission_timeout_invalid');
    await store.claimOccurrence(item.occurrenceId, clock);
    await expect(store.settleOccurrence(item.occurrenceId, true, undefined, true, new Date(clock.getTime() - 1))).rejects.toThrow('schedule_occurrence_clock_regressed');
    expect((await store.claimedOccurrences())[0]).toMatchObject({ attempts: 1 });
  });

  it('fails closed on schema 1 at startup, migrates only offline, backs up and preserves byte-exact receipts and business rows', async () => {
    const { store, root } = open(); const item = await due(store);
    await store.execute('goal', { ...scope, kind: 'goal.put', goalId: 'goal-1', expectedVersion: null,
      title: 'Existing Goal', phase: 'implementation', status: 'active', roundCap: 2 }, clock);
    await store.claimOccurrence(item.occurrenceId, clock); await store.settleOccurrence(item.occurrenceId, false, 'schedule_submission_uncertain', true, clock);
    await close(store);
    const databasePath = path.join(root, 'data/productivity/productivity.db'); const database = new DatabaseSync(databasePath);
    let receipts: unknown; let goals: unknown;
    try {
      database.exec('DROP TABLE productivity_task_faults; DROP INDEX productivity_occurrence_ready; ALTER TABLE productivity_schedule_occurrences DROP COLUMN next_attempt_at; ALTER TABLE productivity_schedule_occurrences DROP COLUMN attempt_started_at; PRAGMA user_version=1;');
      receipts = database.prepare('SELECT * FROM productivity_commands ORDER BY command_id').all();
      goals = database.prepare('SELECT * FROM productivity_goals').all();
    } finally { database.close(); }
    expect(() => new SqliteProductivityStore(root)).toThrow('productivity_offline_migration_required:1:3');
    const result = migrateProductivityV1ToV2(root, clock); expect(result).toMatchObject({ migrated: true, fromVersion: 1, toVersion: 2 });
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    try { expect(backup.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 }); expect(backup.prepare('SELECT * FROM productivity_commands ORDER BY command_id').all()).toEqual(receipts); }
    finally { backup.close(); }
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try { expect(migrated.prepare('SELECT * FROM productivity_commands ORDER BY command_id').all()).toEqual(receipts);
      expect(migrated.prepare('SELECT * FROM productivity_goals').all()).toEqual(goals); }
    finally { migrated.close(); }
    expect(migrateProductivityV1ToV2(root, clock)).toMatchObject({ migrated: false, fromVersion: 2, toVersion: 2 });
    const current = open(root).store;
    expect(await current.pendingOccurrences(16, clock)).toEqual([]);
    expect((await current.pendingOccurrences(16, new Date(clock.getTime() + 1_000)))[0]).toMatchObject({ attempts: 1 });
    expect(() => migrateProductivityV1ToV2(root)).toThrow('sqlite_owner_lease_unavailable');
  });

  it('rolls back schema and business rows when the post-DDL integrity check fails', async () => {
    const { store, root } = open(); await due(store); await close(store);
    const databasePath = path.join(root, 'data/productivity/productivity.db');
    const source = new DatabaseSync(databasePath);
    let rows: unknown;
    try {
      source.exec('DROP TABLE productivity_task_faults; DROP INDEX productivity_occurrence_ready; ALTER TABLE productivity_schedule_occurrences DROP COLUMN next_attempt_at; ALTER TABLE productivity_schedule_occurrences DROP COLUMN attempt_started_at; PRAGMA user_version=1;');
      rows = source.prepare('SELECT * FROM productivity_commands ORDER BY command_id').all();
    } finally { source.close(); }
    const originalPrepare = DatabaseSync.prototype.prepare;
    let checks = 0;
    const fault = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'PRAGMA quick_check' && ++checks === 2) throw new Error('injected_post_ddl_integrity_failure');
      return originalPrepare.call(this, sql);
    });
    try { expect(() => migrateProductivityV1ToV2(root, clock)).toThrow('injected_post_ddl_integrity_failure'); }
    finally { fault.mockRestore(); }
    const recovered = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(recovered.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 });
      expect(recovered.prepare('SELECT * FROM productivity_commands ORDER BY command_id').all()).toEqual(rows);
      expect(recovered.prepare('PRAGMA table_info(productivity_schedule_occurrences)').all()).toHaveLength(11);
    } finally { recovered.close(); }
    expect(migrateProductivityV1ToV2(root, new Date(clock.getTime() + 1))).toMatchObject({ migrated: true });
  });

  it('rejects a newer database without changing it or creating a migration backup', async () => {
    const { store, root } = open(); await close(store);
    const databasePath = path.join(root, 'data/productivity/productivity.db'); const database = new DatabaseSync(databasePath);
    try { database.exec('PRAGMA user_version=4; PRAGMA wal_checkpoint(TRUNCATE);'); } finally { database.close(); }
    const bytes = readFileSync(databasePath);
    expect(() => migrateProductivityV1ToV2(root)).toThrow('productivity_migration_version_unsupported:4');
    expect(readFileSync(databasePath)).toEqual(bytes);
    expect(() => new SqliteProductivityStore(root)).toThrow('productivity_offline_migration_required:4:3');
    expect(readFileSync(databasePath)).toEqual(bytes);
  });
});
