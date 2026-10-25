import { auditStoredProjectionState as auditDocumentMigration } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicProjectionCommit, assertPublicRunDocumentCommit, canonicalPublicProjectionJson,
  PUBLIC_PROJECTION_CONTRACT_VERSION, PUBLIC_PROJECTION_GENESIS_DIGEST, RUN_DOCUMENT_COMMIT_VERSION, type ProjectionCommit, type PublicRunDocumentCommit } from '@ariadne/protocol/public';
import { RunDocumentPlan, type RunDocumentSource } from '../src/projection/RunDocumentPlan.js';
import { openPublicProjectionDatabase, resolvePublicProjectionDatabasePath } from '../src/adapters/persistence/PublicProjectionDbSchema.js';
import { upgradeRunDocumentSchema } from '../src/adapters/persistence/RunDocumentDbSchema.js';
import { SqliteRunDocumentPublication } from '../src/adapters/persistence/SqliteRunDocumentPublication.js';
import { appendProjectionLedgerCommit, auditStoredProjectionState, SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { closeOwnedSqliteDatabase } from '../src/adapters/persistence/SqliteOwnerLease.js';
import { verifyStoredRunDocument } from '../src/adapters/persistence/RunDocumentSqliteVerifier.js';

const at = '2032-01-01T00:00:00.000Z', roots: string[] = [], closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function open() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-document-publication-')); roots.push(root);
  const opened = openPublicProjectionDatabase(root); closes.push(() => closeOwnedSqliteDatabase(opened.database, opened.ownerLease));
  return opened;
}
function source(version = 1, large = true): RunDocumentSource {
  return { summary: { runId: 'document-run', sessionId: 'document-session', version,
    title: '模拟提交', status: 'running', label: '模拟提交', updatedAt: at,
    toolActivityCount: 0, queuedInputCount: 1, claimedInputCount: 0, interactionMessageCount: 1 },
    toolActivities: [], inbox: [{ inputId: 'input-0', messageId: 'message-0', version: 1, delivery: 'next_turn',
      content: '模拟输入', state: 'queued', queuedAt: at, updatedAt: at }],
    interactionMessages: [{ messageId: 'large-message', sessionId: 'document-session', runId: 'document-run', version: 1,
      role: 'assistant', content: large ? '正文🙂'.repeat(180_000) : '模拟短内容', status: 'completed', createdAt: at, updatedAt: at }] };
}
function decisionChange() {
  return { feature: 'decisions' as const, operation: 'upsert' as const, aggregateId: 'document-decision', aggregateVersion: 1,
    projectedAt: at, dto: { decisionId: 'document-decision', runId: 'document-run', sessionId: 'document-session', version: 1,
      kind: 'permission' as const, status: 'pending' as const, requestedAt: at,
      presentation: { contractVersion: '1.0' as const, kind: 'permission' as const, headline: '模拟授权', summary: '模拟资源授权',
        toolName: 'tool.safe_action', capabilityIds: ['capability.safe_action'], scopeIds: ['scope.workspace'], resourceSummary: '模拟资源' },
      action: { contractVersion: '1.0' as const, actionToken: `decision-action.v1:${'a'.repeat(64)}`, choices: ['allow_once', 'allow_run', 'deny'] } } };
}
function commit(plan: RunDocumentPlan, includeDecision = false): PublicRunDocumentCommit {
  return assertPublicRunDocumentCommit({ contractVersion: RUN_DOCUMENT_COMMIT_VERSION,
    eventId: `document-event-${plan.header.summary.version}`, sourceId: 'document-source', sourceCursor: plan.header.summary.version, occurredAt: at,
    changes: [{ feature: 'runs', operation: 'upsert', aggregateId: 'document-run', aggregateVersion: plan.header.summary.version,
      projectedAt: at, dto: plan.header }, ...(includeDecision ? [decisionChange()] : [])] });
}
function oldCommit(input: RunDocumentSource, includeDecision = false): ProjectionCommit {
  const { toolActivityCount: _tools, interactionMessageCount: _messages, queuedInputCount: _queued, claimedInputCount: _claimed, ...summary } = input.summary;
  return assertPublicProjectionCommit({ contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: `document-event-${input.summary.version}`, sourceId: 'document-source', sourceCursor: input.summary.version, occurredAt: at,
    changes: [{ feature: 'runs', operation: 'upsert', aggregateId: 'document-run', aggregateVersion: input.summary.version, projectedAt: at,
      dto: { ...summary, toolActivities: input.toolActivities, inbox: input.inbox, interactionMessages: input.interactionMessages } },
      ...(includeDecision ? [decisionChange()] : [])] });
}
function state(database: DatabaseSync) {
  return ['projection_commits', 'projection_versions', 'projection_heads', 'projection_source_checkpoints']
    .map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

describe('same-owner final Run document transaction', () => {
  it('publishes a multi-megabyte item with root/version/global C/source atomically and audits it after reopen', async () => {
    const opened = open(); upgradeRunDocumentSchema(opened.database, auditDocumentMigration);
    const plan = new RunDocumentPlan(source()), request = commit(plan);
    expect(Buffer.byteLength(canonicalPublicProjectionJson(source()))).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(canonicalPublicProjectionJson(request))).toBeLessThan(4096);
    expect(() => assertPublicProjectionCommit(request)).toThrow();
    const writer = new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger);
    expect(await writer.publish(request, plan)).toEqual({ cursor: 1, streamId: opened.streamId, replayed: false });
    const root = opened.database.prepare('SELECT published_cursor FROM projection_run_documents').get()!;
    expect(root.published_cursor).toBe(1);
    expect(opened.database.prepare('SELECT aggregate_version,commit_cursor FROM projection_heads').get()).toEqual({ aggregate_version: 1, commit_cursor: 1 });
    expect(opened.database.prepare('SELECT source_cursor,event_id FROM projection_source_checkpoints').get()).toEqual({ source_cursor: 1, event_id: 'document-event-1' });
    auditStoredProjectionState(opened.database);
    const before = state(opened.database);
    expect(await writer.publish(request, plan)).toEqual({ cursor: 1, streamId: opened.streamId, replayed: true });
    expect(state(opened.database)).toEqual(before);
    closeOwnedSqliteDatabase(opened.database, opened.ownerLease); closes.pop();
    const reopened = new DatabaseSync(opened.databasePath); closes.push(() => reopened.close());
    auditStoredProjectionState(reopened);
    expect(verifyStoredRunDocument(reopened, plan.header, 1)).toEqual(plan.header);
  });
  it('rolls every final artifact back before commit while retaining prepared chunks for retry', async () => {
    const opened = open(); upgradeRunDocumentSchema(opened.database, auditDocumentMigration); const plan = new RunDocumentPlan(source());
    const failed = new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger, { beforeCommit: () => { throw new Error('before_final_commit'); } });
    await expect(failed.publish(commit(plan, true), plan)).rejects.toThrow('before_final_commit');
    expect(state(opened.database)).toEqual([[], [], [], []]);
    expect(opened.database.prepare('SELECT preparation_state,published_cursor FROM projection_run_documents').get()).toEqual({ preparation_state: 'prepared', published_cursor: null });
    auditStoredProjectionState(opened.database);
    expect((await new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger).publish(commit(plan, true), plan)).cursor).toBe(1);
    expect(opened.database.prepare('SELECT COUNT(*) AS total FROM projection_versions').get()!.total).toBe(2);
    auditStoredProjectionState(opened.database);
  });
  it('preserves an unknown committed outcome and retries its original cursor without a second version', async () => {
    const opened = open(); upgradeRunDocumentSchema(opened.database, auditDocumentMigration); const plan = new RunDocumentPlan(source());
    await expect(new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger,
      { afterCommit: () => { throw new Error('lost_final_response'); } }).publish(commit(plan), plan)).rejects.toThrow('lost_final_response');
    expect(opened.database.prepare('SELECT published_cursor FROM projection_run_documents').get()!.published_cursor).toBe(1);
    const before = state(opened.database);
    const result = await new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger).publish(commit(plan), plan);
    expect(result).toEqual({ cursor: 1, streamId: opened.streamId, replayed: true }); expect(state(opened.database)).toEqual(before);
    auditStoredProjectionState(opened.database);
  });
  it('retains a published 5.0 receipt on equivalent 6.0 replay, then appends the next Run version to the same chain', async () => {
    const opened = open(), legacy = source(1, false); appendProjectionLedgerCommit(opened.database, opened.streamId, oldCommit(legacy, true));
    upgradeRunDocumentSchema(opened.database, auditDocumentMigration); const before = state(opened.database);
    const writer = new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger), oldPlan = new RunDocumentPlan(legacy);
    expect(await writer.publish(commit(oldPlan, true), oldPlan)).toEqual({ cursor: 1, streamId: opened.streamId, replayed: true });
    expect(state(opened.database)).toEqual(before);
    expect(opened.database.prepare('SELECT published_cursor FROM projection_run_documents WHERE run_version=1').get()!.published_cursor).toBeNull();
    const next = new RunDocumentPlan(source(2)); expect((await writer.publish(commit(next), next)).cursor).toBe(2);
    expect(opened.database.prepare('SELECT contract_version FROM projection_commits ORDER BY cursor').all()).toEqual([{ contract_version: '5.0' }, { contract_version: '6.0' }]);
    expect(opened.database.prepare('SELECT source_cursor FROM projection_source_checkpoints').get()!.source_cursor).toBe(2);
    auditStoredProjectionState(opened.database);
  });
  it('rejects replay body drift, version/source gaps and a raw document append outside the publication owner', async () => {
    const opened = open(), legacy = source(1, false); appendProjectionLedgerCommit(opened.database, opened.streamId, oldCommit(legacy));
    upgradeRunDocumentSchema(opened.database, auditDocumentMigration); const before = state(opened.database);
    const changed = source(1, false); (changed.inbox[0] as { content: string }).content = '漂移输入'; const drift = new RunDocumentPlan(changed);
    await expect(new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger).publish(commit(drift), drift)).rejects.toThrow('payload_drift');
    expect(state(opened.database)).toEqual(before);
    const gap = new RunDocumentPlan(source(3));
    await expect(new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger).publish(commit(gap), gap)).rejects.toThrow('cursor_expected_2');
    expect(state(opened.database)).toEqual(before);
    expect(() => appendProjectionLedgerCommit(opened.database, opened.streamId, commit(gap))).toThrow('publication_owner_required');
  });
  it('detects a body-only foreign commit between verification and final publication without advancing C', async () => {
    const opened = open(); upgradeRunDocumentSchema(opened.database, auditDocumentMigration); const plan = new RunDocumentPlan(source());
    const writer = new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger, { afterVerification: () => {
      const foreign = new DatabaseSync(opened.databasePath);
      try { foreign.exec("UPDATE projection_run_document_leaves SET chunk_bytes=zeroblob(length(chunk_bytes)) WHERE collection='interactionMessages' AND chunk_ordinal=0"); }
      finally { foreign.close(); }
    } });
    await expect(writer.publish(commit(plan), plan)).rejects.toThrow('publication_foreign_write');
    expect(state(opened.database)).toEqual([[], [], [], []]);
    expect(opened.database.prepare('SELECT published_cursor FROM projection_run_documents').get()!.published_cursor).toBeNull();
  });
  it('audits full stored chunk bodies, metadata, indexes and the publication link instead of trusting root-only hashes', async () => {
    const opened = open(); upgradeRunDocumentSchema(opened.database, auditDocumentMigration); const plan = new RunDocumentPlan(source());
    await new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger).publish(commit(plan), plan);
    opened.database.exec("UPDATE projection_run_document_leaves SET chunk_bytes=zeroblob(length(chunk_bytes)) WHERE collection='interactionMessages' AND chunk_ordinal=0");
    expect(() => auditStoredProjectionState(opened.database)).toThrow('chunk_digest_mismatch');
  });
  it('rejects a foreign commit to prior history before preparing or publishing the next version', async () => {
    const opened = open(); upgradeRunDocumentSchema(opened.database, auditDocumentMigration);
    const writer = new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger), first = new RunDocumentPlan(source());
    await writer.publish(commit(first), first); const before = state(opened.database);
    const foreign = new DatabaseSync(opened.databasePath);
    try { foreign.exec("UPDATE projection_run_document_leaves SET chunk_bytes=zeroblob(length(chunk_bytes)) WHERE run_version=1 AND collection='interactionMessages' AND chunk_ordinal=0"); }
    finally { foreign.close(); }
    const next = new RunDocumentPlan(source(2)); await expect(writer.publish(commit(next), next)).rejects.toThrow('publication_foreign_write');
    expect(state(opened.database)).toEqual(before);
    expect(opened.database.prepare('SELECT run_version FROM projection_run_documents').all()).toEqual([{ run_version: 1 }]);
  });
  it('returns an explicit legacy read reset and upgrade error without fabricating full arrays or poisoning unrelated reads', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-document-legacy-read-')); roots.push(root);
    const store = new SqlitePublicProjectionStore(root);
    try {
      // Candidate upgrade on this test owner's existing connection; no second
      // connection, fake user_version or production activation flag.
      const database = (store as unknown as { database: DatabaseSync }).database;
      upgradeRunDocumentSchema(database, auditDocumentMigration); const plan = new RunDocumentPlan(source());
      await new SqliteRunDocumentPublication(database, store.streamId, appendDocumentLedger).publish(commit(plan), plan);
      await expect(store.read({ contractVersion: '5.0', streamId: store.streamId, afterCursor: 0,
        afterDigest: PUBLIC_PROJECTION_GENESIS_DIGEST, limit: 16 })).resolves.toMatchObject({ status: 'reset_required', reason: 'contract_mismatch', currentCursor: 1 });
      await expect(store.snapshot()).rejects.toThrow('representation_upgrade_required');
      await expect(store.readModelProjectionHeads()).resolves.toEqual([]);
      await expect(store.readPublicProjectionSourceCheckpoint('document-source')).resolves.toBe(1);
      auditStoredProjectionState(database);
    } finally { await store.close(); }
  });
  it('keeps async document preparation, later fixed writes and close in the same owner queue', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-document-owner-queue-')); roots.push(root);
    const store = new SqlitePublicProjectionStore(root), database = (store as unknown as { database: DatabaseSync }).database;
    upgradeRunDocumentSchema(database, auditDocumentMigration);
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(done => { release = done; }), ready = new Promise<void>(done => { started = done; });
    const publish = SqliteRunDocumentPublication.prototype.publish;
    const spy = vi.spyOn(SqliteRunDocumentPublication.prototype, 'publish').mockImplementation(async function(this: SqliteRunDocumentPublication, value, plan) {
      started(); await wait; return publish.call(this, value, plan);
    });
    let closed = false;
    try {
      const plan = new RunDocumentPlan(source(1, false)), pending = store.appendRunDocument(commit(plan), plan);
      await ready;
      let queried = false;
      const checkpoint = store.readPublicProjectionSourceCheckpoint('document-source').then(value => { queried = true; return value; });
      const following = store.append({ contractVersion: '5.0', eventId: 'following-session', sourceId: 'sessions', sourceCursor: 1,
        occurredAt: at, changes: [{ feature: 'sessions', operation: 'upsert', aggregateId: 'document-session', aggregateVersion: 1,
          projectedAt: at, dto: { sessionId: 'document-session', workspaceId: 'workspace-a', version: 1, title: '模拟会话',
            status: 'active', pinned: false, createdAt: at, updatedAt: at } }] });
      const closing = store.close().then(() => { closed = true; });
      await Promise.resolve(); expect(queried).toBe(false); expect(closed).toBe(false);
      await expect(store.appendRunDocument(commit(plan), plan)).rejects.toThrow('store_closed');
      release(); expect(await pending).toMatchObject({ cursor: 1, replayed: false }); expect(await checkpoint).toBe(1);
      expect(await following).toMatchObject({ cursor: 2, replayed: false }); await closing;
      const reopened = new DatabaseSync(resolvePublicProjectionDatabasePath(root));
      try { auditStoredProjectionState(reopened); expect(reopened.prepare('SELECT published_cursor FROM projection_run_documents').get()!.published_cursor).toBe(1); }
      finally { reopened.close(); }
    } finally { release(); spy.mockRestore(); await store.close(); }
  });
  it('activates the normal owner before admitting document writes and audits the same document after reopening', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-document-owner-schema-')); roots.push(root);
    const store = new SqlitePublicProjectionStore(root);
    try {
      const plan = new RunDocumentPlan(source(1, false));
      expect(await store.appendRunDocument(commit(plan), plan)).toMatchObject({ cursor: 1, replayed: false });
      expect(await store.readModelProjectionHeads()).toEqual([]);
    } finally { await store.close(); }
    const reopened = new SqlitePublicProjectionStore(root);
    try {
      const database = (reopened as unknown as { database: DatabaseSync }).database;
      expect(database.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
      expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 3 }, { version: 4 }]);
      expect(await reopened.readPublicProjectionSourceCheckpoint('document-source')).toBe(1);
      expect(database.prepare('SELECT published_cursor FROM projection_run_documents').get()!.published_cursor).toBe(1);
    } finally { await reopened.close(); }
  });
  it('retains the original legacy receipt when the owner extension retries an equivalent document', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-document-owner-legacy-')); roots.push(root);
    const store = new SqlitePublicProjectionStore(root), database = (store as unknown as { database: DatabaseSync }).database;
    try {
      const input = source(1, false); await store.append(oldCommit(input)); const before = state(database);
      upgradeRunDocumentSchema(database, auditDocumentMigration); const plan = new RunDocumentPlan(input);
      expect(await store.appendRunDocument(commit(plan), plan)).toEqual({ cursor: 1, streamId: store.streamId, replayed: true });
      expect(state(database)).toEqual(before); expect(database.prepare('SELECT published_cursor FROM projection_run_documents').get()!.published_cursor).toBeNull();
      auditStoredProjectionState(database);
      expect(await store.readPublicProjectionSourceCheckpoint('document-source')).toBe(1);
    } finally { await store.close(); }
  });
  it('waits for async publication outcome and retries a committed unknown result at its original C', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-document-owner-unknown-')); roots.push(root);
    let fail = true;
    const store = new SqlitePublicProjectionStore(root, undefined, { afterCommit: () => { if (fail) throw new Error('unknown_document_commit'); } });
    const database = (store as unknown as { database: DatabaseSync }).database; upgradeRunDocumentSchema(database, auditDocumentMigration);
    try {
      const plan = new RunDocumentPlan(source(1, false));
      await expect(store.appendRunDocument(commit(plan, true), plan)).rejects.toThrow('unknown_document_commit'); fail = false;
      expect(await store.readPublicProjectionSourceCheckpoint('document-source')).toBe(1);
      expect(await store.appendRunDocument(commit(plan, true), plan)).toMatchObject({ cursor: 1, replayed: true });
      expect(database.prepare('SELECT COUNT(*) AS total FROM projection_versions').get()!.total).toBe(2); auditStoredProjectionState(database);
    } finally { await store.close(); }
  });
  it('latches an async document foreign-write rejection before any later read or write can claim health', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-document-owner-foreign-')); roots.push(root);
    const store = new SqlitePublicProjectionStore(root), database = (store as unknown as { database: DatabaseSync }).database;
    upgradeRunDocumentSchema(database, auditDocumentMigration);
    try {
      const plan = new RunDocumentPlan(source(1, false)); await store.appendRunDocument(commit(plan), plan);
      const foreign = new DatabaseSync(resolvePublicProjectionDatabasePath(root));
      try { foreign.exec("UPDATE projection_run_document_leaves SET chunk_bytes=zeroblob(length(chunk_bytes)) WHERE collection='inbox'"); }
      finally { foreign.close(); }
      const next = new RunDocumentPlan(source(2, false));
      await expect(store.appendRunDocument(commit(next), next)).rejects.toThrow('catalog:external_write');
      await expect(store.readPublicProjectionSourceCheckpoint('document-source')).rejects.toThrow('store_unhealthy');
      await expect(store.append(oldCommit(source(3, false)))).rejects.toThrow('store_unhealthy');
      expect(database.prepare('SELECT COUNT(*) AS total FROM projection_commits').get()!.total).toBe(1);
    } finally { await store.close(); }
  });
});
