import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openConversationDatabase } from '../src/adapters/persistence/ConversationDbSchema.js';
import { openAgentControlDatabase } from '../src/adapters/persistence/agentControlDbSchema.js';
import { openPublicProjectionDatabase } from '../src/adapters/persistence/PublicProjectionDbSchema.js';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { closeOwnedSqliteDatabase } from '../src/adapters/persistence/SqliteOwnerLease.js';
import { readOwnedAuthorityFault } from '../src/adapters/persistence/SqliteAuthorityHealth.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const owners = [['conversation', openConversationDatabase], ['execution', openAgentControlDatabase],
  ['projection', openPublicProjectionDatabase]] as const;
function root(): string { const value = mkdtempSync(path.join(tmpdir(), 'AriadneCriticalOpening-')); roots.push(value); return value; }
function caught(operation: () => unknown): unknown { try { operation(); } catch (error) { return error; } throw new Error('expected_failure'); }

describe('critical authority initialization evidence', () => {
  for (const [source, open] of owners) {
    it(`${source} proves altered schema at its own validator, releases the lease and preserves original bytes`, () => {
      const directory = root(), opened = open(directory), file = opened.databasePath;
      closeOwnedSqliteDatabase(opened.database, opened.ownerLease);
      const external = new DatabaseSync(file);
      try { external.exec('CREATE VIEW foreign_private_schema AS SELECT 1; PRAGMA wal_checkpoint(TRUNCATE);'); }
      finally { external.close(); }
      const before = readFileSync(file);
      expect(readOwnedAuthorityFault(caught(() => open(directory)))).toEqual({ source, kind: 'integrity' });
      expect(readFileSync(file)).toEqual(before);
      // Reopen fails on the same persisted source, rather than a leaked owner lease.
      expect(readOwnedAuthorityFault(caught(() => open(directory)))).toEqual({ source, kind: 'integrity' });
      expect(readFileSync(file)).toEqual(before);
    });
    it(`${source} reports newer stores as unavailable without rewriting them`, () => {
      const directory = root(), opened = open(directory), file = opened.databasePath;
      closeOwnedSqliteDatabase(opened.database, opened.ownerLease);
      const external = new DatabaseSync(file);
      try { external.exec('PRAGMA user_version=999; PRAGMA wal_checkpoint(TRUNCATE);'); } finally { external.close(); }
      const before = readFileSync(file);
      expect(readOwnedAuthorityFault(caught(() => open(directory)))).toEqual({ source, kind: 'unavailable' });
      expect(readFileSync(file)).toEqual(before);
    });
  }
  it('does not turn a diagnostic callback or caller argument into source corruption', () => {
    const directory = root(), original = new Error('public_projection_storage_corruption:callback');
    const error = caught(() => new SqlitePublicProjectionStore(directory, undefined, undefined,
      stage => { if (stage === 'history_audit') throw original; }));
    expect(error).toBe(original); expect(readOwnedAuthorityFault(error)).toBeNull();
    for (const [, open] of owners) expect(readOwnedAuthorityFault(caught(() => open('')))).toBeNull();
    const reopened = openPublicProjectionDatabase(directory);
    closeOwnedSqliteDatabase(reopened.database, reopened.ownerLease);
  });
  it('attributes invalid persisted commit payload before startup can reclaim anything', async () => {
    const directory = root(), store = new SqlitePublicProjectionStore(directory);
    const time = '2032-01-01T00:00:00.000Z';
    try { await store.append({ contractVersion: '5.0', eventId: 'original-event', sourceId: 'original-source', sourceCursor: 1,
      occurredAt: time, changes: [{ feature: 'sessions', aggregateId: 'original-session', aggregateVersion: 1,
        operation: 'upsert', projectedAt: time, dto: { sessionId: 'original-session', workspaceId: 'workspace-health',
          title: 'Original', pinned: false, status: 'active', createdAt: time, updatedAt: time, version: 1 } }] }); }
    finally { await store.close(); }
    const opened = openPublicProjectionDatabase(directory), file = opened.databasePath;
    try { opened.database.prepare('UPDATE projection_commits SET commit_json=?').run(JSON.stringify({ private: 'invalid commit shape' })); }
    finally { closeOwnedSqliteDatabase(opened.database, opened.ownerLease); }
    const before = readFileSync(file), error = caught(() => new SqlitePublicProjectionStore(directory));
    expect(readOwnedAuthorityFault(error)).toEqual({ source: 'projection', kind: 'integrity' });
    expect(readFileSync(file)).toEqual(before);
  });
});
