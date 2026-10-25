import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteLongMemoryStore } from '../src/adapters/persistence/SqliteLongMemoryStore.js';
import { classifySqliteAuthorityFault } from '../src/adapters/persistence/SqliteAuthorityHealth.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { seedReleasedMemoryVector } from './long-memory-schema1-fixture.js';

const roots: string[] = []; const stores: SqliteLongMemoryStore[] = [];
const scope = { contractVersion: '5.0', workspaceId: 'workspace', sessionId: 'session' } as const;
const command = { ...scope, kind: 'memory.put', memoryId: 'memory', expectedVersion: null,
  scope: 'workspace', memoryType: 'fact', title: 'Original', content: 'Private original SQLite content', importance: 0.8,
  confidence: 1, sensitivity: 'workspace', retentionUntil: null } as const;
const now = new Date('2026-10-06T00:00:00Z');
function root() { const value = mkdtempSync(path.join(tmpdir(), 'ariadne-memory-health-')); roots.push(value); return value; }
function open(directory: string) { const store = new SqliteLongMemoryStore(directory); stores.push(store); return store; }
function dbfile(directory: string) { return path.join(directory, 'data/long-memory/long-memory.db'); }
async function close(store: SqliteLongMemoryStore) {
  const shutdown = createShutdownContext(Date.now() + 5_000); try { await store.close(shutdown); } finally { shutdown.dispose(); }
}
function modify(directory: string, sql: string) {
  const database = new DatabaseSync(dbfile(directory));
  try { database.exec(sql); database.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } finally { database.close(); }
}
afterEach(async () => { for (const store of stores.splice(0)) await close(store);
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('long-memory source integrity ownership', () => {
  it.each([
    ["UPDATE long_memories SET payload_json='{}'", 'payload'],
    ["UPDATE long_memories SET scope_id='foreign'", 'binding'],
    ["UPDATE long_memories SET payload_json=json_set(payload_json,'$.scope','global')", 'scope'],
    ["UPDATE long_memories SET payload_json=json_set(payload_json,'$.memoryId','forged')", 'protected fields'],
    ["UPDATE long_memory_commands SET result_json='{}'", 'receipt'],
    ["UPDATE long_memory_commands SET result_json=json_set(result_json,'$.memoryId','absent')", 'receipt identity'],
    ["UPDATE long_memory_vectors SET vector_json='[1]'", 'vector'],
    ["UPDATE long_memory_vectors SET memory_version=2", 'vector version'],
    ["UPDATE long_memory_fts SET content='rewritten'", 'FTS'],
    ['CREATE TABLE unexpected(value TEXT)', 'layout']
  ])('rejects source %s on reopening without modifying original bytes (%s)', async (sql) => {
    const directory = root(); const store = open(directory);
    await store.execute('create', command, now); seedReleasedMemoryVector(directory,'memory'); await close(store);
    modify(directory, sql); const bytes = readFileSync(dbfile(directory));
    let failure: unknown;
    try { open(directory); } catch (error) { failure = error; }
    expect(classifySqliteAuthorityFault('memory', failure)).toBe('integrity');
    expect(readFileSync(dbfile(directory))).toEqual(bytes);
    // A second attempt proves the failed opener released its lease.
    expect(() => open(directory)).not.toThrow('sqlite_owner_lease_unavailable');
  });
  it('latches an actual own decoder failure before an already queued overwrite executes', async () => {
    const directory = root(); const store = open(directory); await store.execute('create', command, now);
    modify(directory, "UPDATE long_memories SET payload_json='{}'");
    const observations = await Promise.allSettled([
      store.get('memory', scope, now), store.execute('overwrite', { ...command, expectedVersion: 1, content: 'Overwritten' }, now)
    ]);
    expect(observations.every(item => item.status === 'rejected')).toBe(true);
    expect(() => store.assertHealthy()).toThrow('memory_authority_integrity');
    const database = new DatabaseSync(dbfile(directory), { readOnly: true });
    try { expect(database.prepare('SELECT payload_json,version FROM long_memories').get()).toMatchObject({ payload_json: '{}', version: 1 });
      expect(database.prepare("SELECT 1 FROM long_memory_commands WHERE command_id='overwrite'").get()).toBeUndefined(); }
    finally { database.close(); }
  });
  it('does not latch legitimate CAS/input errors, preserves original receipts and tombstones across restart', async () => {
    const directory = root(); const store = open(directory); const receipt = await store.execute('create', command, now);
    await expect(store.execute('conflict', command, now)).rejects.toThrow('long_memory_version_conflict');
    expect(() => store.assertHealthy()).not.toThrow();
    await store.execute('delete', { ...scope, kind: 'memory.delete', memoryId: 'memory', expectedVersion: 1 }, now); await close(store);
    const reopened = open(directory); expect(await reopened.reconcile('create', command)).toEqual(receipt);
    expect(await reopened.get('memory', scope, now)).toBeNull();
  });
  it('refuses an unversioned occupied database without creating any memory tables', async () => {
    const directory = root(); const store = open(directory); await close(store);
    modify(directory, 'PRAGMA user_version=0'); const bytes = readFileSync(dbfile(directory));
    let failure: unknown; try { open(directory); } catch (error) { failure = error; }
    expect(classifySqliteAuthorityFault('memory', failure)).toBe('unavailable'); expect(readFileSync(dbfile(directory))).toEqual(bytes);
  });
});
