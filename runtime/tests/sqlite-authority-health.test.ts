import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteTransactionOwner } from '../src/adapters/persistence/SqliteTransactionOwner.js';
import { acquireSqliteOwnerLease } from '../src/adapters/persistence/SqliteOwnerLease.js';
import { SqliteAuthorityHealth, markAuthorityIntegrityError, readPersistedAuthorityJson } from '../src/adapters/persistence/SqliteAuthorityHealth.js';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { DATABASE_PATHS } from '../src/adapters/persistence/DatabasePaths.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';

const roots: string[] = [];
const closers: { close(context: ReturnType<typeof createShutdownContext>): Promise<void> }[] = [];
function root(): string { const value = mkdtempSync(path.join(tmpdir(), 'AriadneAuthorityHealth-')); roots.push(value); return value; }
function owner(options: Partial<{ beforeWriteCommit: () => void; afterWriteCommit: () => void }> = {}) {
  const directory = root(), file = path.join(directory, 'authority.db');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE receipts(id TEXT PRIMARY KEY);');
  const instance = new SqliteTransactionOwner(database, file, acquireSqliteOwnerLease(file, 'test'), {
    source: 'execution', shutdownRequestedCode: 'shutdown', closedCode: 'closed', shutdownConflictCode: 'conflict',
    transactionActiveCode: 'active', shutdownDeadlineCode: 'deadline', ...options
  });
  closers.push(instance); return { instance, database, directory };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const instance of closers.splice(0)) {
    const context = createShutdownContext(Date.now() + 5_000);
    try { await instance.close(context); } finally { context.dispose(); }
  }
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('source-owned SQLite authority health', () => {
  it('does not classify message prefixes, callback syntax errors, other sources or ordinary SQLite conflicts', async () => {
    const { instance, database } = owner();
    for (const error of [new Error('agent_storage_corruption:untrusted'), new SyntaxError('callback'),
      markAuthorityIntegrityError('productivity', new Error('private productivity body'))]) {
      await expect(instance.schedule(async () => { throw error; })).rejects.toBe(error);
      expect(() => instance.assertHealthy()).not.toThrow();
    }
    await instance.schedule(signal => instance.transaction('write', () => { database.exec("INSERT INTO receipts VALUES ('one')"); }, signal));
    await expect(instance.schedule(signal => instance.transaction('write', () => {
      database.exec("INSERT INTO receipts VALUES ('one')");
    }, signal))).rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 1555 });
    expect(() => instance.assertHealthy()).not.toThrow();
    expect(database.isTransaction).toBe(false);
  });

  it('latches actual NOTADB evidence, preserves the first error and refuses already-queued operations', async () => {
    const { instance, database, directory } = owner();
    const broken = path.join(directory, 'broken.db'); writeFileSync(broken, Buffer.alloc(1024, 0x7f));
    const first = instance.schedule(async () => { database.prepare('ATTACH DATABASE ? AS broken').run(broken); });
    const execute = vi.fn(async () => 'must not run');
    const queued = instance.schedule(execute);
    await expect(first).rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 26 });
    await expect(queued).rejects.toMatchObject({ source: 'execution', faultKind: 'integrity', message: 'execution_authority_integrity' });
    expect(execute).not.toHaveBeenCalled();
    expect(() => instance.assertHealthy()).toThrow('execution_authority_integrity');
  });

  it('keeps unknown post-COMMIT outcome recoverable through the original durable receipt', async () => {
    const privateFailure = new Error('after COMMIT lost reply');
    const { instance, database } = owner({ afterWriteCommit: () => { throw privateFailure; } });
    await expect(instance.schedule(signal => instance.transaction('write', () => {
      database.exec("INSERT INTO receipts VALUES ('stable-command')");
    }, signal))).rejects.toBe(privateFailure);
    expect(() => instance.assertHealthy()).not.toThrow();
    expect(await instance.schedule(signal => instance.transaction('read', () => database.prepare('SELECT id FROM receipts').all(), signal)))
      .toEqual([{ id: 'stable-command' }]);
  });

  it('fences a failed rollback while retaining both errors and the close barrier', async () => {
    const { instance, database } = owner();
    const original = new Error('original transaction failure'), rollback = new Error('rollback outcome unknown');
    const exec = database.exec.bind(database);
    const spy = vi.spyOn(database, 'exec').mockImplementation(sql => {
      if (sql === 'ROLLBACK;') throw rollback;
      return exec(sql);
    });
    const failure = await instance.schedule(signal => instance.transaction('write', () => { throw original; }, signal)).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toEqual([original, rollback]);
    expect(() => instance.assertHealthy()).toThrow('execution_authority_unavailable');
    spy.mockRestore(); database.exec('ROLLBACK;');
  });

  it('rejects corrupted actual Productivity data and subsequent writes while another authority remains usable', async () => {
    const directory = root(), productivity = new SqliteProductivityStore(directory);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(directory); closers.push(productivity, conversation);
    const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-health', sessionId: 'session-health' } as const;
    await productivity.execute('goal-health', { ...scope, kind: 'goal.put', goalId: 'goal-health', expectedVersion: null,
      title: 'Health', phase: 'implementation', status: 'active', roundCap: 8 });
    const external = new DatabaseSync(path.join(directory, DATABASE_PATHS.productivity));
    try { external.prepare('UPDATE productivity_goals SET goal_json=?').run('{invalid private body'); }
    finally { external.close(); }
    await expect(productivity.query(scope.workspaceId, scope.sessionId)).rejects.toThrow('productivity_persisted_record_invalid');
    expect(() => productivity.assertHealthy()).toThrow('productivity_authority_integrity');
    await expect(productivity.execute('no-second-write', { ...scope, kind: 'goal.put', goalId: 'goal-health', expectedVersion: 1,
      title: 'Overwrite would hide corruption', phase: 'implementation', status: 'active', roundCap: 8 }))
      .rejects.toThrow('productivity_authority_integrity');
    expect(await conversation.readSession('unrelated-session')).toBeNull();
    expect(() => conversation.assertHealthy()).not.toThrow();
  });

  it('requires owned persisted decoding evidence and treats actual IOERR as unavailable', () => {
    const health = new SqliteAuthorityHealth('productivity');
    try { readPersistedAuthorityJson('productivity', '{}', () => { throw new Error('invalid durable shape'); }); }
    catch (error) { health.observe(error); }
    expect(() => health.assertHealthy()).toThrow('productivity_authority_integrity');
    const io = new SqliteAuthorityHealth('memory');
    io.observe(Object.assign(new Error('private filesystem path'), { code: 'ERR_SQLITE_ERROR', errcode: 522 }));
    expect(() => io.assertHealthy()).toThrow('memory_authority_unavailable');
    const busy = new SqliteAuthorityHealth('memory');
    busy.observe(Object.assign(new Error('busy'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }));
    expect(() => busy.assertHealthy()).not.toThrow();
  });
});
