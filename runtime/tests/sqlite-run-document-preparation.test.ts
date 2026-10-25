import { auditStoredProjectionState as auditDocumentMigration } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, RunDocumentItemAssembler, type ProjectionCommit } from '@ariadne/protocol/public';
import { RunDocumentPlan, type RunDocumentSource } from '../src/projection/RunDocumentPlan.js';
import { openPublicProjectionDatabase, resolvePublicProjectionDatabasePath } from '../src/adapters/persistence/PublicProjectionDbSchema.js';
import { upgradeRunDocumentSchema } from '../src/adapters/persistence/RunDocumentDbSchema.js';
import { SqliteRunDocumentPreparation } from '../src/adapters/persistence/SqliteRunDocumentPreparation.js';
import { appendProjectionLedgerCommit, auditStoredProjectionState, SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { closeOwnedSqliteDatabase } from '../src/adapters/persistence/SqliteOwnerLease.js';

const roots: string[] = [], closes: (() => void)[] = [];
const at = '2032-01-01T00:00:00.000Z';
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function open() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-run-document-')); roots.push(root);
  const opened = openPublicProjectionDatabase(root); closes.push(() => closeOwnedSqliteDatabase(opened.database, opened.ownerLease));
  return { ...opened, root };
}
function source(): RunDocumentSource {
  return { summary: { runId: 'document-run', sessionId: 'document-session', version: 4,
    title: '模拟容量', status: 'running', label: '模拟容量', updatedAt: at,
    toolActivityCount: 0, queuedInputCount: 2, claimedInputCount: 0, interactionMessageCount: 1 },
    toolActivities: [], inbox: [0, 1].map(index => ({ inputId: `input-${index}`, messageId: `message-${index}`, version: 1,
      delivery: 'next_turn' as const, content: '模拟🙂'.repeat(18_000), state: 'queued' as const, queuedAt: at, updatedAt: at })),
    interactionMessages: [{ messageId: 'large-message', sessionId: 'document-session', runId: 'document-run', version: 1,
      role: 'assistant', content: '正文🙂'.repeat(120_000), status: 'completed', createdAt: at, updatedAt: at }] };
}
const preservedTables = ['projection_metadata', 'projection_commits', 'projection_versions', 'projection_heads', 'projection_source_checkpoints'];
function history(database: DatabaseSync) { return preservedTables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }

describe('SQLite Run document preparation candidate', () => {
  it('upgrades a current-format copy without altering history, watermarks, tombstones or Stream; restores the original copy', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-document-restore-')); roots.push(root);
    const originalOwner = openPublicProjectionDatabase(root);
    try {
      for (let version = 1; version <= 3; version++) {
        const commit: ProjectionCommit = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
          eventId: `document-event-${version}`, sourceId: 'document-source', sourceCursor: version, occurredAt: at,
          changes: [{ feature: 'sessions', aggregateId: 'document-session', aggregateVersion: version, projectedAt: at,
            ...(version === 3 ? { operation: 'delete' as const, dto: null } : { operation: 'upsert' as const,
              dto: { sessionId: 'document-session', workspaceId: 'document-workspace', version, title: '模拟历史',
                status: 'active' as const, pinned: false, createdAt: at, updatedAt: at } }) }] };
        appendProjectionLedgerCommit(originalOwner.database, originalOwner.streamId, commit);
      }
    } finally { closeOwnedSqliteDatabase(originalOwner.database, originalOwner.ownerLease); }
    const file = resolvePublicProjectionDatabasePath(root), backup = path.join(root, 'before-document.sqlite');
    copyFileSync(file, backup);
    const database = new DatabaseSync(file); database.exec('PRAGMA foreign_keys=ON;');
    try {
      const before = history(database), ledger = database.prepare('SELECT * FROM schema_migrations').all();
      upgradeRunDocumentSchema(database, auditDocumentMigration);
      expect(history(database)).toEqual(before);
      expect(database.prepare('SELECT * FROM schema_migrations WHERE version=3').all()).toEqual(ledger);
      expect(database.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
      auditStoredProjectionState(database);
      await new SqliteRunDocumentPreparation(database).prepare(new RunDocumentPlan(source()));
      expect(history(database)).toEqual(before);
      expect(database.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { database.close(); }
    copyFileSync(backup, file);
    const restored = new SqlitePublicProjectionStore(root);
    try {
      const restoredDatabase = (restored as unknown as { database: DatabaseSync }).database;
      expect(restoredDatabase.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
      const originalDatabase = new DatabaseSync(backup);
      try { expect(history(restoredDatabase)).toEqual(history(originalDatabase)); }
      finally { originalDatabase.close(); }
      const snapshot = await restored.snapshot();
      expect(snapshot.cursor).toBe(3); expect(snapshot.sessions).toHaveLength(0);
      expect(snapshot.tombstones).toEqual([expect.objectContaining({ feature: 'sessions', aggregateVersion: 3 })]);
    } finally { await restored.close(); }
  });
  it('rolls DDL, migration ledger and user_version back together; refuses corruption before creating objects', () => {
    const { database } = open(); const before = database.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
    expect(() => upgradeRunDocumentSchema(database, auditDocumentMigration, () => { throw new Error('injected_migration_interruption'); })).toThrow('injected_migration_interruption');
    expect(database.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);
    expect(database.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()!.count).toBe(1);
    database.exec("UPDATE projection_metadata SET metadata_digest='sha256:'||printf('%064d',0)");
    expect(() => upgradeRunDocumentSchema(database, auditDocumentMigration)).toThrow('metadata_invalid');
    expect(database.prepare('SELECT name FROM sqlite_master WHERE name LIKE \'projection_run_%\'').all()).toEqual([]);
  });
  it('keeps interrupted preparation invisible and retries exact immutable items after reopening', async () => {
    const opened = open(), database = opened.database; upgradeRunDocumentSchema(database, auditDocumentMigration);
    const plan = new RunDocumentPlan(source()), preparation = new SqliteRunDocumentPreparation(database);
    const before = history(database);
    await expect(preparation.prepare(plan, () => { throw new Error('injected_after_complete_item'); })).rejects.toThrow('injected_after_complete_item');
    expect(await preparation.readPreparedHeader('document-run', 4)).toBeNull();
    expect(database.prepare('SELECT COUNT(*) AS count FROM projection_run_document_items').get()!.count).toBe(1);
    closeOwnedSqliteDatabase(database, opened.ownerLease); closes.pop();
    const reopened = new DatabaseSync(opened.databasePath); reopened.exec('PRAGMA foreign_keys=ON;'); closes.push(() => reopened.close());
    const recovered = new SqliteRunDocumentPreparation(reopened);
    expect(await recovered.readPreparedHeader('document-run', 4)).toBeNull();
    await recovered.prepare(plan);
    expect(await recovered.readPreparedHeader('document-run', 4)).toEqual(plan.header);
    const counts = reopened.prepare('SELECT COUNT(*) AS count FROM projection_run_document_leaves').get();
    await recovered.prepare(plan);
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM projection_run_document_leaves').get()).toEqual(counts);
    expect(history(reopened)).toEqual(before);
    const assembler = new RunDocumentItemAssembler(plan.header, 'interactionMessages', 0); let item = null;
    const proof = await recovered.readItemMetadata(plan.header, 'interactionMessages', 0);
    for (let chunk = 0; chunk < proof!.descriptor.chunkCount; chunk++) item = await assembler.accept(await recovered.readItemLeaf(plan.header, 'interactionMessages', 0, chunk));
    expect(item).toEqual({ collection: 'interactionMessages', value: source().interactionMessages[0] });
    expect(reopened.prepare('SELECT MAX(length(chunk_bytes)) AS max FROM projection_run_document_leaves').get()!.max).toBeLessThanOrEqual(262_144);
  });
  it('reads proven Inbox metadata without selecting chunk bytes and refuses body or metadata drift', async () => {
    const { database } = open(); upgradeRunDocumentSchema(database, auditDocumentMigration);
    const plan = new RunDocumentPlan(source()), preparation = new SqliteRunDocumentPreparation(database); await preparation.prepare(plan);
    const prepare = vi.spyOn(database, 'prepare');
    const proof = await preparation.readItemMetadata(plan.header, 'inbox', 0);
    expect(proof!.metadata.value).not.toHaveProperty('content');
    expect(prepare.mock.calls.some(call => /SELECT[^;]*chunk_bytes/iu.test(String(call[0])))).toBe(false); prepare.mockRestore();
    database.exec("UPDATE projection_run_document_items SET metadata_json=json_set(metadata_json,'$.value.delivery','next_step') WHERE collection='inbox' AND item_ordinal=0");
    await expect(preparation.readItemMetadata(plan.header, 'inbox', 0)).rejects.toThrow('metadata_digest_mismatch');
    await expect(preparation.prepare(plan)).rejects.toThrow('item_conflict');
    database.exec("UPDATE projection_run_document_leaves SET chunk_bytes=zeroblob(length(chunk_bytes)) WHERE collection='interactionMessages' AND chunk_ordinal=0");
    await expect(preparation.readItemLeaf(plan.header, 'interactionMessages', 0, 0)).rejects.toThrow('chunk_digest_mismatch');
  });
  it('rejects same-version different-root preparation and leaves the completed root unchanged', async () => {
    const { database } = open(); upgradeRunDocumentSchema(database, auditDocumentMigration);
    const plan = new RunDocumentPlan(source()), preparation = new SqliteRunDocumentPreparation(database); await preparation.prepare(plan);
    const changed = source(); (changed.inbox[0] as { content: string }).content = 'changed body';
    await expect(preparation.prepare(new RunDocumentPlan(changed))).rejects.toThrow('identity_conflict');
    expect(await preparation.readPreparedHeader('document-run', 4)).toEqual(plan.header);
    expect(await preparation.readItemMetadata(plan.header, 'inbox', 100)).toBeNull();
  });
  it('distinguishes out-of-range requests from missing coverage of a prepared document', async () => {
    const { database } = open(); upgradeRunDocumentSchema(database, auditDocumentMigration);
    const plan = new RunDocumentPlan(source()), preparation = new SqliteRunDocumentPreparation(database); await preparation.prepare(plan);
    expect(await preparation.readItemLeaf(plan.header, 'interactionMessages', 0, 32)).toBeNull();
    database.exec("DELETE FROM projection_run_document_leaves WHERE collection='interactionMessages' AND chunk_ordinal=1");
    await expect(preparation.readItemLeaf(plan.header, 'interactionMessages', 0, 1)).rejects.toThrow('stored_leaf_missing');
    database.exec("DELETE FROM projection_run_document_leaves WHERE collection='inbox' AND item_ordinal=1; DELETE FROM projection_run_document_items WHERE collection='inbox' AND item_ordinal=1");
    await expect(preparation.readItemMetadata(plan.header, 'inbox', 1)).rejects.toThrow('stored_item_missing');
    await expect(preparation.readItemMetadata(plan.header, 'inbox', -1)).rejects.toThrow('position_invalid');
  });
  it('validates item and leaf indexes against the proof before interpreting query coverage', async () => {
    const { database } = open(); upgradeRunDocumentSchema(database, auditDocumentMigration);
    const plan = new RunDocumentPlan(source()), preparation = new SqliteRunDocumentPreparation(database); await preparation.prepare(plan);
    database.exec("UPDATE projection_run_document_items SET chunk_count=1 WHERE collection='interactionMessages'");
    await expect(preparation.readItemLeaf(plan.header, 'interactionMessages', 0, 1)).rejects.toThrow('stored_item_mismatch');
    database.prepare("UPDATE projection_run_document_items SET chunk_count=? WHERE collection='interactionMessages'")
      .run(plan.header.collections.interactionMessages.leafCount);
    database.exec("UPDATE projection_run_document_leaves SET leaf_index=99 WHERE collection='interactionMessages' AND chunk_ordinal=1");
    await expect(preparation.readItemLeaf(plan.header, 'interactionMessages', 0, 1)).rejects.toThrow('stored_leaf_identity_mismatch');
    database.exec("UPDATE projection_run_document_items SET item_id='substituted-id' WHERE collection='inbox' AND item_ordinal=0");
    await expect(preparation.readItemMetadata(plan.header, 'inbox', 0)).rejects.toThrow('stored_item_mismatch');
  });
  it('rejects a foreign SQLite body-only commit between short item transactions', async () => {
    const { database, databasePath } = open(); upgradeRunDocumentSchema(database, auditDocumentMigration);
    const plan = new RunDocumentPlan(source()), preparation = new SqliteRunDocumentPreparation(database);
    let injected = false;
    await expect(preparation.prepare(plan, () => {
      if (injected) return; injected = true;
      const foreign = new DatabaseSync(databasePath);
      try { foreign.exec("UPDATE projection_run_document_leaves SET chunk_bytes=zeroblob(length(chunk_bytes)) WHERE collection='inbox' AND item_ordinal=0"); }
      finally { foreign.close(); }
    })).rejects.toThrow('preparation_foreign_write');
    expect(await preparation.readPreparedHeader('document-run', 4)).toBeNull();
    expect(database.prepare('SELECT COUNT(*) AS count FROM projection_commits').get()!.count).toBe(0);
  });
});
