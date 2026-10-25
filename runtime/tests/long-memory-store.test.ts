import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeCommandSchema, runtimeResultSchema, type LongMemoryCommand, type LongMemoryContent } from '@ariadne/protocol/public';
import { SqliteLongMemoryStore } from '../src/adapters/persistence/SqliteLongMemoryStore.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { seedReleasedMemoryVector,releasedMemoryVectors } from './long-memory-schema1-fixture.js';
const scope = { contractVersion: '5.0', workspaceId: 'workspace-a', sessionId: 'session-a' } as const;
const clock = new Date('2026-10-04T00:00:00Z');
const content: LongMemoryContent = { scope: 'workspace', memoryType: 'fact', title: '真实长期记忆', content: '项目使用 TypeScript 和 SQLite 持久化',
  importance: 0.8, confidence: 1, sensitivity: 'workspace', retentionUntil: null };
const roots: string[] = []; const stores: SqliteLongMemoryStore[] = [];
function open(root?: string) {
  const directory = root ?? mkdtempSync(path.join(tmpdir(), 'ariadne-long-memory-')); if (!root) roots.push(directory);
  const store = new SqliteLongMemoryStore(directory); stores.push(store); return { root: directory, store };
}
async function close(store: SqliteLongMemoryStore) { const shutdown = createShutdownContext(Date.now() + 5_000); try { await store.close(shutdown); } finally { shutdown.dispose(); } }
afterEach(async () => { for (const store of stores.splice(0)) await close(store); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const put = (memoryId = 'memory-1', fields: Partial<LongMemoryContent> = {}) => ({ ...scope, ...content, ...fields, kind: 'memory.put', memoryId, expectedVersion: null } as const);
const query = { ...scope, kind: 'memory.query', scope: null, status: 'all', before: null, limit: 50 } as const;

describe('long-memory persistent authority', () => {
  it('separates global, workspace and session scopes without trusting a supplied scope ID', async () => {
    const { store } = open();
    await store.execute('workspace', put('workspace-memory'), clock);
    await store.execute('session', put('session-memory', { scope: 'session' }), clock);
    await store.execute('global', put('global-memory', { scope: 'global' }), clock);
    expect((await store.query(query, clock)).memories).toHaveLength(3);
    expect((await store.query({ ...query, sessionId: 'session-b' }, clock)).memories.map(memory => memory.memoryId)).toEqual(['workspace-memory','global-memory']);
    expect((await store.query({ ...query, workspaceId: 'workspace-b', sessionId: 'session-b' }, clock)).memories.map(memory => memory.memoryId)).toEqual(['global-memory']);
    expect(await store.get('session-memory', { workspaceId: 'workspace-b', sessionId: scope.sessionId }, clock)).toBeNull();
    await expect(store.execute('foreign-edit', { ...put('workspace-memory'), workspaceId: 'workspace-b', expectedVersion: 1 }, clock)).rejects.toThrow('long_memory_scope_conflict');
    await expect(store.execute('move-scope', { ...put('workspace-memory'), scope: 'global', expectedVersion: 1 }, clock)).rejects.toThrow('long_memory_scope_conflict');
    expect(runtimeResultSchema.parse(await store.query(query, clock))).toEqual(await store.query(query, clock));
  });
  it('owns exact receipts and CAS while concurrent edits cannot both advance one version', async () => {
    const { store } = open(); const command = put(); const receipt = await store.execute('create', command, clock);
    expect(receipt).toEqual({ kind: 'memory.updated', memoryId: 'memory-1', version: 1 });
    expect(await store.execute('create', command, clock)).toEqual(receipt);
    await expect(store.execute('create', { ...command, content: 'changed payload' }, clock)).rejects.toThrow('long_memory_command_conflict');
    const attempts = await Promise.allSettled([store.execute('update-a', { ...command, expectedVersion: 1, content: 'winner A' }, clock),
      store.execute('update-b', { ...command, expectedVersion: 1, content: 'winner B' }, clock)]);
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1);
    expect(await store.reconcile('create', command)).toEqual(receipt);
    expect((await store.get('memory-1', scope, clock))!.version).toBe(2);
  });
  it('uses literal FTS terms and recalls Chinese fragments from actual persisted content', async () => {
    const { store } = open(); await store.execute('create', put(), clock);
    expect((await store.lexicalSearch(scope, '持久化', 20, clock))[0]!.memory.content).toBe(content.content);
    expect((await store.lexicalSearch(scope, 'SQLite', 20, clock))[0]!.memory.memoryId).toBe('memory-1');
    expect(await store.lexicalSearch(scope, '" OR * ) NEAR(', 20, clock)).toEqual([]);
    expect(await store.lexicalSearch({ workspaceId: 'foreign', sessionId: 'other' }, 'SQLite', 20, clock)).toEqual([]);
  });
  it('keeps model candidates out of recall until user activation and denies model global writes', async () => {
    const { store } = open(); const candidate = { ...scope, ...content, memoryId: 'candidate', runId: 'run-1' };
    await store.stageCandidate('stage', candidate, clock);
    expect((await store.get('candidate', scope, clock))!).toMatchObject({ status: 'candidate', reviewedAt: null, provenance: { kind: 'agent', runId: 'run-1' } });
    expect(await store.lexicalSearch(scope, 'SQLite', 20, clock)).toEqual([]); expect(await store.indexSource('candidate',1,clock)).toBeNull();
    await expect(store.stageCandidate('global-stage', { ...candidate, scope: 'global', memoryId: 'denied' }, clock)).rejects.toThrow('long_memory_agent_global_write_denied');
    await store.execute('activate', { ...scope, kind: 'memory.transition', memoryId: 'candidate', expectedVersion: 1, action: 'activate' }, clock);
    expect((await store.lexicalSearch(scope, 'SQLite', 20, clock))[0]!.memory).toMatchObject({ status: 'active', version: 2, reviewedAt: clock.toISOString() });
  });
  it('preserves inactive state when edited and requires explicit reactivation', async () => {
    const { store } = open(); await store.execute('create', put(), clock);
    await store.execute('deactivate', { ...scope, kind: 'memory.transition', memoryId: 'memory-1', expectedVersion: 1, action: 'deactivate' }, clock);
    await store.execute('edit', { ...put(), expectedVersion: 2, content: 'INACTIVE SQLite CONTENT' }, clock);
    expect((await store.get('memory-1', scope, clock))!.status).toBe('inactive');
    expect(await store.lexicalSearch(scope, 'SQLite', 20, clock)).toEqual([]);
    await store.execute('reactivate', { ...scope, kind: 'memory.transition', memoryId: 'memory-1', expectedVersion: 3, action: 'activate' }, clock);
    expect((await store.indexSource('memory-1',4,clock))!.version).toBe(4);
  });
  it('excludes expired records from both lexical and vector candidate pages while leaving them editable', async () => {
    const { store } = open(); await store.execute('expired', put('expired', { retentionUntil: clock.toISOString() }), clock);
    expect((await store.get('expired', scope, clock))!.expired).toBe(true);
    expect((await store.query(query, clock)).memories).toHaveLength(1);
    expect(await store.lexicalSearch(scope, 'SQLite', 20, clock)).toEqual([]); expect(await store.indexSource('expired',1,clock)).toBeNull();
  });
  it('forgets content, FTS and vectors atomically and old receipts cannot resurrect deleted memory', async () => {
    const { store, root } = open(); const command = put(); const receipt = await store.execute('create', command, clock);
    seedReleasedMemoryVector(root,'memory-1'); expect(releasedMemoryVectors(root)).toHaveLength(1);
    await store.execute('delete', { ...scope, kind: 'memory.delete', memoryId: 'memory-1', expectedVersion: 1 }, clock);
    expect(await store.get('memory-1', scope, clock)).toBeNull(); expect((await store.query(query, clock)).memories).toEqual([]);
    expect(await store.lexicalSearch(scope, 'SQLite', 20, clock)).toEqual([]); expect(releasedMemoryVectors(root)).toHaveLength(0);
    expect(await store.execute('create', command, clock)).toEqual(receipt);
    await expect(store.execute('resurrect', command, clock)).rejects.toThrow('long_memory_scope_conflict');
    await close(store);
    const database = new DatabaseSync(path.join(root, 'data/long-memory/long-memory.db'), { readOnly: true });
    try { expect(database.prepare('SELECT status,payload_json FROM long_memories').get()).toMatchObject({ status: 'deleted', payload_json: null });
      expect(JSON.stringify(database.prepare('SELECT * FROM long_memory_commands').all())).not.toContain(content.content);
      expect(database.prepare('SELECT count(*) AS n FROM long_memory_fts').get()).toMatchObject({ n: 0 });
      expect(database.prepare('SELECT count(*) AS n FROM long_memory_vectors').get()).toMatchObject({ n: 0 }); }
    finally { database.close(); }
  });
  it('preserves the released Schema 1 vector format on reopening and invalidates it on source edits', async () => {
    const first = open(); await first.store.execute('create', put(), clock);
    seedReleasedMemoryVector(first.root,'memory-1'); await close(first.store); const store = open(first.root).store;
    expect(releasedMemoryVectors(first.root)).toEqual([expect.objectContaining({memory_id:'memory-1',memory_version:1,space_id:'space-a',dimension:2,vector_json:'[1,0]'})]);
    await store.execute('edit', { ...put(), expectedVersion: 1, content: 'NEW CONTENT' }, clock);
    expect(releasedMemoryVectors(first.root)).toHaveLength(0); expect(await store.indexSource('memory-1',1,clock)).toBeNull();
  });
  it('paginates exact timestamps without duplicates and keeps cancelled commands out of the journal', async () => {
    const { store } = open(); for (const id of ['memory-a','memory-b','memory-c']) await store.execute(id, put(id), clock);
    const first = await store.query({ ...query, limit: 2 }, clock); expect(first.memories.map(memory => memory.memoryId)).toEqual(['memory-c','memory-b']);
    expect((await store.query({ ...query, limit: 2, before: first.nextCursor }, clock)).memories.map(memory => memory.memoryId)).toEqual(['memory-a']);
    const controller = new AbortController(); controller.abort(new Error('REQUEST_ABORTED'));
    await expect(store.execute('aborted', put('absent'), clock, controller.signal)).rejects.toThrow('REQUEST_ABORTED');
    expect(await store.reconcile('aborted', put('absent'))).toBeNull(); expect(await store.get('absent', scope, clock)).toBeNull();
  });
  it('fences another owner, clock regression and a newer database version', async () => {
    const first = open(); expect(() => new SqliteLongMemoryStore(first.root)).toThrow('sqlite_owner_lease_unavailable');
    await first.store.execute('create', put(), clock);
    await expect(first.store.execute('old-clock', { ...put(), expectedVersion: 1 }, new Date(clock.getTime() - 1))).rejects.toThrow('long_memory_clock_regressed');
    await close(first.store); const file = path.join(first.root, 'data/long-memory/long-memory.db'); const database = new DatabaseSync(file);
    try { database.exec('PRAGMA user_version=2; PRAGMA wal_checkpoint(TRUNCATE);'); } finally { database.close(); }
    const bytes = readFileSync(file); expect(() => new SqliteLongMemoryStore(first.root)).toThrow('long_memory_schema_unsupported:2'); expect(readFileSync(file)).toEqual(bytes);
  });
  it('rejects public provenance forgery and protected vector data', () => {
    expect(runtimeCommandSchema.parse(put())).toEqual(put());
    for (const extra of [{ scopeId: 'foreign' }, { provenance: { kind: 'user' } }, { vector: [1] }, { reviewedAt: clock.toISOString() }]) {
      expect(runtimeCommandSchema.safeParse({ ...put(), ...extra }).success).toBe(false);
    }
    expect(runtimeResultSchema.safeParse({ kind: 'memory.updated', memoryId: 'memory-1', version: 1, content: 'private cached payload' }).success).toBe(false);
  });
});
