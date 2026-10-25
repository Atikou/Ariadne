import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_PROJECTION_GENESIS_DIGEST, PUBLIC_PROJECTION_HISTORY_DOMAIN, canonicalPublicProjectionJson, runtimeCommandSchema } from '@ariadne/protocol/public';
import { migrateCommunicationContract, assertCommunicationContractReady } from '../src/adapters/persistence/CommunicationContractMigration.js';
import { appendProjectionLedgerCommit, SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { openPublicProjectionDatabase } from '../src/adapters/persistence/PublicProjectionDbSchema.js';
import { closeOwnedSqliteDatabase } from '../src/adapters/persistence/SqliteOwnerLease.js';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { SqliteLongMemoryStore } from '../src/adapters/persistence/SqliteLongMemoryStore.js';
import { SqliteRuntimeCommandJournal } from '../src/adapters/persistence/SqliteRuntimeCommandJournal.js';
import { DATABASE_PATHS } from '../src/adapters/persistence/DatabasePaths.js';
import { runtimeCommandIdentity } from '../src/ingress/RuntimeCommandIdentity.js';
import { commandReceiptIdentity } from '../src/adapters/persistence/CommandReceiptIdentity.js';
import { boundedCanonicalJson } from '../src/ingress/BoundedCanonicalJson.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots: string[] = [];
const scope = { contractVersion: '5.0', workspaceId: 'workspace', sessionId: 'session' } as const;
const clock = new Date('2026-10-04T00:00:00.000Z');
const goal = { ...scope, kind: 'goal.put', goalId: 'goal', expectedVersion: null, title: 'Retain this goal', phase: 'implementation', status: 'active', roundCap: 8 } as const;
const memory = { ...scope, kind: 'memory.put', memoryId: 'memory', expectedVersion: null, scope: 'workspace', memoryType: 'fact',
  title: 'Retain this memory', content: 'Stored user content .v3 must remain exact', importance: 0.8, confidence: 1, sensitivity: 'workspace', retentionUntil: null } as const;
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const directory = mkdtempSync(path.join(os.tmpdir(), 'ariadne-communication-')); roots.push(directory); return directory; }
function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function digest(text: string): string { return `sha256:${hash(text)}`; }
async function close(store: SqliteProductivityStore | SqliteLongMemoryStore) {
  const context = createShutdownContext(Date.now() + 5_000); try { await store.close(context); } finally { context.dispose(); }
}
function modify(directory: string, owner: keyof typeof DATABASE_PATHS, run: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(path.join(directory, DATABASE_PATHS[owner])); try { run(database); } finally { database.close(); }
}
function historical(command: typeof goal | typeof memory) { return { ...command, kind: `${command.kind}.v3`, contractVersion: '4.0' }; }
function oldReceipt(directory: string, owner: 'productivity' | 'longMemory', command: typeof goal | typeof memory) {
  modify(directory, owner, database => {
    const table = owner === 'productivity' ? 'productivity_commands' : 'long_memory_commands';
    const row = database.prepare(`SELECT result_json FROM ${table} WHERE command_id='create'`).get()!;
    const result = JSON.parse(String(row.result_json)); result.kind += '.v3';
    database.prepare(`UPDATE ${table} SET fingerprint=?,result_json=? WHERE command_id='create'`)
      .run(digest(JSON.stringify(historical(command))), JSON.stringify(result));
    if (owner === 'productivity') database.prepare('UPDATE productivity_events SET kind=?,event_json=? WHERE command_id=?')
      .run('goal.put.v3', JSON.stringify(result), 'create');
  });
}
async function fixture() {
  const directory = root();
  const productivity = new SqliteProductivityStore(directory); try { await productivity.execute('create', goal, clock); } finally { await close(productivity); }
  const longMemory = new SqliteLongMemoryStore(directory); try { await longMemory.execute('create', memory, clock); } finally { await close(longMemory); }
  oldReceipt(directory, 'productivity', goal); oldReceipt(directory, 'longMemory', memory);
  const projection = openPublicProjectionDatabase(directory);
  try {
    for (const index of [1, 2]) appendProjectionLedgerCommit(projection.database, projection.streamId, { contractVersion: '5.0', eventId: `event-${index}`, sourceId: 'source', sourceCursor: index,
      occurredAt: clock.toISOString(), changes: [{ feature: 'sessions', aggregateId: 'session', aggregateVersion: index,
        operation: 'upsert', projectedAt: clock.toISOString(), dto: { sessionId: 'session', workspaceId: 'workspace', version: index,
          title: 'Retain user text .v3', pinned: false, status: 'active', createdAt: clock.toISOString(), updatedAt: clock.toISOString() } }] });
  } finally { closeOwnedSqliteDatabase(projection.database, projection.ownerLease); }
  modify(directory, 'publicProjection', database => {
    let previous: string = PUBLIC_PROJECTION_GENESIS_DIGEST;
    for (const row of database.prepare('SELECT cursor,commit_json FROM projection_commits ORDER BY cursor').all()) {
      const json = canonicalPublicProjectionJson({ ...JSON.parse(String(row.commit_json)), contractVersion: '4.0' });
      const payload = digest(json); const history = digest(`${PUBLIC_PROJECTION_HISTORY_DOMAIN}\u0000${previous}\u0000${String(row.cursor)}\u0000${payload}`);
      database.prepare('UPDATE projection_commits SET contract_version=?,commit_json=?,payload_digest=?,history_digest=? WHERE cursor=?')
        .run('4.0', json, payload, history, row.cursor!); previous = history;
    }
    const row = database.prepare('SELECT * FROM projection_metadata').get()!;
    database.prepare('UPDATE projection_metadata SET contract_version=?,metadata_digest=?').run('4.0', digest(`4.0\u0000${String(row.stream_id)}\u0000${String(row.genesis_digest)}\u0000${String(row.created_at)}`));
    database.exec("UPDATE schema_migrations SET name='public_projection_v4_store_v3'");
  });
  return directory;
}
function values(directory: string, owner: keyof typeof DATABASE_PATHS, sql: string) {
  const database = new DatabaseSync(path.join(directory, DATABASE_PATHS[owner]), { readOnly: true });
  try { return database.prepare(sql).all(); } finally { database.close(); }
}

describe('fixed communication contract and persisted identity', () => {
  it('rejects numbered live commands, keeps stable identity across transport versions and preserves payload differences', () => {
    expect(runtimeCommandSchema.safeParse(historical(goal)).success).toBe(false);
    expect(runtimeCommandIdentity(goal).digest).toBe(runtimeCommandIdentity(historical(goal)).digest);
    expect(commandReceiptIdentity(goal).fingerprint).toBe(commandReceiptIdentity({ ...goal, contractVersion: '6.0' }).fingerprint);
    expect(commandReceiptIdentity(goal).previousFingerprints).toContain(digest(JSON.stringify(historical(goal))));
    expect(runtimeCommandIdentity({ ...goal, title: 'Different input' }).previousDigests).not.toContain(hash(boundedCanonicalJson(historical(goal))));
  });
  it('replays only the exact historical journal input and promotes its digest without duplicating execution', () => {
    const directory = root(); const journal = new SqliteRuntimeCommandJournal(); journal.open(directory);
    try {
      const oldDigest = hash(boundedCanonicalJson(historical(goal)));
      expect(journal.begin('create', oldDigest)).toEqual({ kind: 'started' });
      const outcome = { ok: true, result: { kind: 'acknowledged' } } as const;
      journal.complete('create', oldDigest, outcome);
      const altered = runtimeCommandIdentity({ ...goal, title: 'Different input' });
      expect(journal.begin('create', altered.digest, altered.previousDigests)).toEqual({ kind: 'conflict' });
      const identity = runtimeCommandIdentity(goal);
      expect(journal.begin('create', identity.digest, identity.previousDigests)).toEqual({ kind: 'replay', outcome });
      expect(journal.begin('create', identity.digest)).toEqual({ kind: 'replay', outcome });
    } finally { journal.close(); }
  });
  it('replays old domain receipts while conflicting input stays rejected and business versions do not advance', async () => {
    const directory = await fixture();
    const productivity = new SqliteProductivityStore(directory); const longMemory = new SqliteLongMemoryStore(directory);
    try {
      expect(await productivity.execute('create', goal, clock)).toMatchObject({ kind: 'goal.updated' });
      expect(await longMemory.execute('create', memory, clock)).toEqual({ kind: 'memory.updated', memoryId: 'memory', version: 1 });
      await expect(productivity.execute('create', { ...goal, title: 'different' }, clock)).rejects.toThrow('productivity_command_conflict');
      await expect(longMemory.execute('create', { ...memory, content: 'different' }, clock)).rejects.toThrow('long_memory_command_conflict');
      expect((await productivity.query('workspace', 'session')).goal?.version).toBe(1);
      expect((await longMemory.get('memory', scope, clock))!.version).toBe(1);
    } finally { await close(productivity); await close(longMemory); }
  });
  it('upgrades old history and receipts with frozen physical schemas, retained records and usable backups', async () => {
    const directory = await fixture();
    const heads = values(directory, 'publicProjection', 'SELECT * FROM projection_heads');
    const memories = values(directory, 'longMemory', 'SELECT * FROM long_memories');
    const goals = values(directory, 'productivity', 'SELECT * FROM productivity_goals');
    expect(() => assertCommunicationContractReady(directory)).toThrow('communication_contract_offline_migration_required');
    const result = migrateCommunicationContract(directory);
    expect(result.migrated).toBe(true); expect(result.backups).toHaveLength(3);
    expect(() => assertCommunicationContractReady(directory)).not.toThrow();
    expect(values(directory, 'publicProjection', 'SELECT * FROM projection_heads')).toEqual(heads);
    expect(values(directory, 'longMemory', 'SELECT * FROM long_memories')).toEqual(memories);
    expect(values(directory, 'productivity', 'SELECT * FROM productivity_goals')).toEqual(goals);
    const projection = new SqlitePublicProjectionStore(directory);
    try { expect(await projection.snapshot()).toMatchObject({ contractVersion: '5.0', cursor: 2, sessions: [{ title: 'Retain user text .v3', version: 2 }] }); }
    finally { await projection.close(); }
    expect(migrateCommunicationContract(directory)).toMatchObject({ migrated: false, backups: [] });
    const backup = new DatabaseSync(result.backups.find(entry => entry.owner === 'publicProjection')!.path, { readOnly: true });
    try { expect(backup.prepare('SELECT contract_version FROM projection_metadata').get()!.contract_version).toBe('4.0'); }
    finally { backup.close(); }
  });
  it.each(['history', 'future', 'layout'] as const)('rejects %s corruption before modifying business files', async fault => {
    const directory = await fixture();
    modify(directory, 'publicProjection', database => {
      if (fault === 'history') database.exec(`UPDATE projection_commits SET history_digest='sha256:${'f'.repeat(64)}' WHERE cursor=1`);
      if (fault === 'future') database.exec("UPDATE projection_metadata SET contract_version='6.0'");
      if (fault === 'layout') database.exec('CREATE TABLE unknown_extension(value TEXT)');
    });
    const file = path.join(directory, DATABASE_PATHS.publicProjection); const before = readFileSync(file);
    expect(() => migrateCommunicationContract(directory)).toThrow(/communication_migration/);
    expect(readFileSync(file)).toEqual(before);
    expect(values(directory, 'productivity', 'SELECT kind FROM productivity_events')).toEqual([{ kind: 'goal.put.v3' }]);
  });
  it('rolls back every pending owner before commit on validation failure and safely retries', async () => {
    const directory = await fixture(); const original = DatabaseSync.prototype.prepare;
    const fault = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('UPDATE projection_metadata SET contract_version=')) throw new Error('injected_projection_failure');
      return original.call(this, sql);
    });
    expect(() => migrateCommunicationContract(directory)).toThrow('injected_projection_failure'); fault.mockRestore();
    expect(values(directory, 'productivity', 'SELECT kind FROM productivity_events')).toEqual([{ kind: 'goal.put.v3' }]);
    expect(() => assertCommunicationContractReady(directory)).toThrow();
    expect(migrateCommunicationContract(directory).migrated).toBe(true);
  });
  it('keeps projection fenced after a domain commit failure and resumes already translated receipts', async () => {
    const directory = await fixture(); const original = DatabaseSync.prototype.exec; let commits = 0;
    const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT;' && ++commits === 2) throw new Error('injected_partial_commit');
      return original.call(this, sql);
    });
    expect(() => migrateCommunicationContract(directory)).toThrow('injected_partial_commit'); fault.mockRestore();
    expect(values(directory, 'productivity', 'SELECT kind FROM productivity_events')).toEqual([{ kind: 'goal.put' }]);
    expect(() => assertCommunicationContractReady(directory)).toThrow();
    expect(migrateCommunicationContract(directory).migrated).toBe(true);
  });
});
