import { auditStoredProjectionState as auditDocumentMigration } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicProjectionCommit, assertPublicRunDocumentCommit, canonicalPublicProjectionJson, verifyCatalogBatch,
  PUBLIC_PROJECTION_GENESIS_DIGEST, MAX_PUBLIC_PROJECTION_PAGE_BYTES, type PublicProjectionChange,
  type PublicProjectionCatalogBeginRequest, type PublicProjectionCatalogManifest } from '@ariadne/protocol/public';
import { RunDocumentPlan, type RunDocumentSource } from '../src/projection/RunDocumentPlan.js';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteRunDocumentPublication } from '../src/adapters/persistence/SqliteRunDocumentPublication.js';
import { upgradeRunDocumentSchema } from '../src/adapters/persistence/RunDocumentDbSchema.js';
const at = '2032-01-01T00:00:00.000Z', resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const { root, store } of resources.splice(0)) {
  await store.close(); rmSync(root, { recursive: true, force: true });
} });
function create() {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-document-catalog-')), store = new SqlitePublicProjectionStore(root);
  resources.push({ root, store }); return { store, database: (store as unknown as { database: DatabaseSync }).database };
}
function session(id = 'a', version = 1, workspace = 'a'): PublicProjectionChange {
  return { feature: 'sessions', aggregateId: `session-${id}`, aggregateVersion: version, operation: 'upsert', projectedAt: at,
    dto: { sessionId: `session-${id}`, workspaceId: `workspace-${workspace}`, version, title: '模拟会话',
      status: 'active', pinned: false, createdAt: at, updatedAt: at } };
}
function ordinary(cursor: number, changes: PublicProjectionChange[], sourceId = 'session-source') {
  return assertPublicProjectionCommit({ contractVersion: '5.0', sourceId, sourceCursor: cursor, eventId: `${sourceId}-${cursor}`, occurredAt: at, changes });
}
function source(version = 1, owner = 'a', completed = false, large = false): RunDocumentSource {
  return { summary: { runId: 'run-a', sessionId: `session-${owner}`, version, title: '模拟目录', label: '模拟目录',
    status: completed ? 'completed' : 'running', updatedAt: at, toolActivityCount: 0, queuedInputCount: 1, claimedInputCount: 0, interactionMessageCount: 1 },
    toolActivities: [], inbox: [{ inputId: 'input-a', messageId: 'input-message-a', version: 1, delivery: 'next_turn',
      content: 'PRIVATE_INBOX_FIXTURE', state: 'queued', queuedAt: at, updatedAt: at }],
    interactionMessages: [{ messageId: 'message-a', sessionId: `session-${owner}`, runId: 'run-a', version, role: 'assistant',
      content: large ? 'PRIVATE_MESSAGE_FIXTURE🙂'.repeat(40_000) : 'PRIVATE_MESSAGE_FIXTURE', status: 'completed', createdAt: at, updatedAt: at }] };
}
function legacy(input: RunDocumentSource) {
  const { toolActivityCount: _t, queuedInputCount: _q, claimedInputCount: _c, interactionMessageCount: _m, ...dto } = input.summary;
  return ordinary(input.summary.version, [{ feature: 'runs', aggregateId: 'run-a', aggregateVersion: input.summary.version,
    operation: 'upsert', projectedAt: at, dto: { ...dto, toolActivities: [], inbox: [...input.inbox], interactionMessages: [...input.interactionMessages] } }], 'run-source');
}
function decision(version = 1, owner = 'a'): PublicProjectionChange {
  return { feature: 'decisions', aggregateId: 'decision-a', aggregateVersion: version, operation: 'upsert', projectedAt: at,
    dto: { decisionId: 'decision-a', runId: 'run-a', sessionId: `session-${owner}`, version, status: 'pending', kind: 'user_question', requestedAt: at,
      presentation: { contractVersion: '1.0', kind: 'user_question', headline: '模拟问题', question: 'PRIVATE_QUESTION_FIXTURE', allowsFreeText: true },
      action: { contractVersion: '1.0', actionToken: `decision-action.v1:${'a'.repeat(64)}`, choices: ['answer'] } } };
}
function documentCommit(plan: RunDocumentPlan, decisions: PublicProjectionChange[] = []) {
  return assertPublicRunDocumentCommit({ contractVersion: '6.0', sourceId: 'run-source', sourceCursor: plan.header.summary.version,
    eventId: `run-source-${plan.header.summary.version}`, occurredAt: at, changes: [{ feature: 'runs', aggregateId: 'run-a',
      aggregateVersion: plan.header.summary.version, operation: 'upsert', projectedAt: at, dto: plan.header }, ...decisions] });
}
async function begin(store: SqlitePublicProjectionStore, options: Partial<PublicProjectionCatalogBeginRequest> = {}): Promise<PublicProjectionCatalogManifest> {
  const result = await store.beginCatalogSnapshot({ pageContractVersion: '3.0', feature: 'runs', filter: 'all',
    scope: { kind: 'session', sessionId: 'session-a', workspaceId: 'workspace-a' }, ...options });
  if ('status' in result) throw new Error(`fixture_manifest:${result.reason}`); return result;
}
function input(manifest: PublicProjectionCatalogManifest, limit = 128) {
  return { manifest, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit };
}
async function fixture() {
  const f = create(); await f.store.append(ordinary(1, [session(), session('b')])); upgradeRunDocumentSchema(f.database, auditDocumentMigration);
  return { ...f, writer: new SqliteRunDocumentPublication(f.database, f.store.streamId, appendDocumentLedger) };
}
describe('version-aware metadata-only catalog commit scan', () => {
  it('replays mixed 5.0/6.0 receipts with original history, unrelated positions, pagination and filtered removals', async () => {
    const f = await fixture(); await f.store.append(legacy(source()));
    const manifest = await begin(f.store, { filter: 'active' });
    const decisions = await begin(f.store, { feature: 'decisions', filter: 'pending', scope: { kind: 'decisions', workspaceId: 'workspace-a' } });
    const second = new RunDocumentPlan(source(2, 'a', false, true)); await f.writer.publish(documentCommit(second), second);
    await f.store.append(ordinary(2, [session('a', 2)]));
    const third = new RunDocumentPlan(source(3, 'a', true, true)); await f.writer.publish(documentCommit(third, [decision()]), third);
    const sql: string[] = [], prepare = f.database.prepare.bind(f.database);
    vi.spyOn(f.database, 'prepare').mockImplementation(statement => { sql.push(statement); return prepare(statement); });
    let request = input(manifest, 1); const received = [];
    for (let index = 0; index < 3; index++) {
      const batch = await verifyCatalogBatch(request, await f.store.readCatalogCommits(request));
      if (batch.status !== 'ok') throw new Error('fixture_batch'); received.push(batch);
      request = { ...request, afterCursor: batch.nextCursor, afterDigest: batch.nextDigest };
    }
    expect(received.map(batch => batch.entries[0]!.changes.length)).toEqual([1, 0, 1]);
    expect(received.map(batch => batch.hasMore)).toEqual([true, true, false]);
    expect(received[0]!.entries[0]!.changes[0]).toMatchObject({ operation: 'upsert', aggregateVersion: 2, row: { dto: second.header.summary } });
    expect(received[2]!.entries[0]!.changes[0]).toMatchObject({ operation: 'remove', aggregateVersion: 3, row: null });
    for (const batch of received) {
      const entry = batch.entries[0]!, stored = prepare('SELECT payload_digest,history_digest FROM projection_commits WHERE cursor=?').get(entry.cursor)!;
      expect(entry.payloadDigest).toBe(stored.payload_digest); expect(entry.cursorDigest).toBe(stored.history_digest);
    }
    const decisionRequest = input(decisions), decisionBatch = await verifyCatalogBatch(decisionRequest, await f.store.readCatalogCommits(decisionRequest));
    expect(decisionBatch).toMatchObject({ status: 'ok', nextCursor: 5, entries: [{ changes: [] }, { changes: [] }, { changes: [{ row: { dto: { decisionId: 'decision-a' } } }] }] });
    expect(JSON.stringify({ received, decisionBatch })).not.toMatch(/PRIVATE_|decision-action|contentBase64/u);
    expect(sql.some(statement => /projection_run_document_(leaves|items)/u.test(statement))).toBe(false);
    expect(prepare('SELECT SUM(length(chunk_bytes)) AS bytes FROM projection_run_document_leaves').get()!.bytes).toBeGreaterThan(2 * 1024 * 1024);
    await expect(f.store.read({ contractVersion: '5.0', streamId: f.store.streamId, afterCursor: 2, afterDigest: manifest.boundaryDigest, limit: 128 }))
      .resolves.toMatchObject({ status: 'reset_required', reason: 'contract_mismatch' });
  });
  it('emits removals to former Session owners for Run and Decision moves without leaking the new summary', async () => {
    const f = await fixture(), first = new RunDocumentPlan(source()); await f.writer.publish(documentCommit(first, [decision()]), first);
    const oldRuns = await begin(f.store), oldDecisions = await begin(f.store, { feature: 'decisions', filter: 'pending' });
    const incomingRuns = await begin(f.store, { scope: { kind: 'session', sessionId: 'session-b', workspaceId: 'workspace-a' } });
    const next = new RunDocumentPlan(source(2, 'b')); await f.writer.publish(documentCommit(next, [decision(2, 'b')]), next);
    for (const manifest of [oldRuns, oldDecisions]) {
      const request = input(manifest), batch = await verifyCatalogBatch(request, await f.store.readCatalogCommits(request));
      expect(batch).toMatchObject({ status: 'ok', entries: [{ changes: [{ operation: 'remove', aggregateVersion: 2, row: null }] }] });
      expect(JSON.stringify(batch)).not.toContain('session-b');
    }
    const request = input(incomingRuns);
    expect(await verifyCatalogBatch(request, await f.store.readCatalogCommits(request)))
      .toMatchObject({ entries: [{ changes: [{ operation: 'upsert', row: { dto: { sessionId: 'session-b' } } }] }] });
    const oldRoot = await f.store.readRunDocument({ queryContractVersion: '1.0', manifest: oldRuns, runId: 'run-a' });
    expect(oldRoot).toMatchObject({ status: 'ok', header: { summary: { sessionId: 'session-a', version: 1 } } });
  });
  it('requires fresh dependent catalogs when Session workspace ownership changes, and removes directory membership', async () => {
    const f = await fixture(), plan = new RunDocumentPlan(source()); await f.writer.publish(documentCommit(plan, [decision()]), plan);
    const selected = await begin(f.store), tasks = await begin(f.store, { scope: { kind: 'tasks', workspaceId: 'workspace-a' } }),
      decisions = await begin(f.store, { feature: 'decisions', filter: 'pending', scope: { kind: 'decisions', workspaceId: 'workspace-a' } }),
      global = await begin(f.store, { scope: { kind: 'tasks' } }),
      directory = await begin(f.store, { feature: 'sessions', scope: { kind: 'directory', workspaceId: 'workspace-a' } });
    await f.store.append(ordinary(2, [session('a', 2, 'b')]));
    for (const manifest of [selected, tasks, decisions]) {
      expect(await f.store.readCatalogCommits(input(manifest))).toMatchObject({ status: 'reset_required', reason: 'scope_mismatch' });
    }
    const globalRequest = input(global);
    expect(await verifyCatalogBatch(globalRequest, await f.store.readCatalogCommits(globalRequest)))
      .toMatchObject({ status: 'ok', entries: [{ changes: [] }] });
    const directoryRequest = input(directory);
    expect(await verifyCatalogBatch(directoryRequest, await f.store.readCatalogCommits(directoryRequest)))
      .toMatchObject({ status: 'ok', entries: [{ changes: [{ aggregateId: 'session-a', operation: 'remove', row: null }] }] });
    expect(await f.store.beginCatalogSnapshot({ pageContractVersion: '3.0', feature: 'runs', filter: 'all', scope: selected.scope }))
      .toMatchObject({ status: 'reset_required', reason: 'scope_mismatch' });
  });
  it('keeps all positions through a document tombstone and unrelated commits, with bounded output', async () => {
    const f = await fixture(), plan = new RunDocumentPlan(source()); await f.writer.publish(documentCommit(plan), plan);
    const manifest = await begin(f.store);
    await f.store.append(ordinary(2, [{ feature: 'runs', aggregateId: 'run-a', aggregateVersion: 2, operation: 'delete', projectedAt: at, dto: null }], 'run-source'));
    await f.store.append(ordinary(2, [session('b', 2)]));
    const request = input(manifest), batch = await verifyCatalogBatch(request, await f.store.readCatalogCommits(request));
    expect(batch).toMatchObject({ status: 'ok', nextCursor: 4, entries: [{ changes: [{ operation: 'remove', aggregateVersion: 2 }] }, { changes: [] }] });
    expect(Buffer.byteLength(canonicalPublicProjectionJson(batch))).toBeLessThanOrEqual(MAX_PUBLIC_PROJECTION_PAGE_BYTES);
    expect(await f.store.readCatalogCommits({ ...request, afterCursor: 5 })).toMatchObject({ status: 'reset_required', reason: 'cursor_gap' });
    expect(await f.store.readCatalogCommits({ ...request, afterDigest: PUBLIC_PROJECTION_GENESIS_DIGEST }))
      .toMatchObject({ status: 'reset_required', reason: 'history_mismatch' });
  });
  it('resets workspace catalogs when a deleted Session is restored into the same workspace', async () => {
    const f = await fixture(), plan = new RunDocumentPlan(source()); await f.writer.publish(documentCommit(plan), plan);
    await f.store.append(ordinary(2, [{ feature: 'sessions', aggregateId: 'session-a', aggregateVersion: 2,
      operation: 'delete', projectedAt: at, dto: null }]));
    const manifest = await begin(f.store, { scope: { kind: 'tasks', workspaceId: 'workspace-a' } });
    expect(await f.store.readCatalogPage({ manifest, limit: 128 })).toMatchObject({ totalRows: 0 });
    await f.store.append(ordinary(3, [session('a', 3)]));
    expect(await f.store.readCatalogCommits(input(manifest))).toMatchObject({ status: 'reset_required', reason: 'scope_mismatch' });
    const fresh = await begin(f.store, { scope: { kind: 'tasks', workspaceId: 'workspace-a' } });
    expect(await f.store.readCatalogPage({ manifest: fresh, limit: 128 })).toMatchObject({ totalRows: 1 });
  });
  it('rejects body-only external writes before advancing an otherwise unrelated catalog', async () => {
    const f = await fixture(), plan = new RunDocumentPlan(source()); await f.writer.publish(documentCommit(plan), plan);
    const manifest = await begin(f.store), databasePath = (f.store as unknown as { databasePath: string }).databasePath;
    const external = new DatabaseSync(databasePath);
    try { external.exec('UPDATE projection_run_document_leaves SET chunk_bytes=zeroblob(length(chunk_bytes))'); } finally { external.close(); }
    await expect(f.store.readCatalogCommits(input(manifest))).rejects.toThrow('external_write');
    await expect(f.store.readModelProjectionHeads()).rejects.toThrow('store_unhealthy');
  });
  it('uses the same history-link validation as scalar reads and latches actual chain corruption', async () => {
    const f = await fixture(), first = new RunDocumentPlan(source()); await f.writer.publish(documentCommit(first), first);
    const manifest = await begin(f.store), next = new RunDocumentPlan(source(2)); await f.writer.publish(documentCommit(next), next);
    f.database.prepare('UPDATE projection_commits SET history_digest=? WHERE cursor=3').run(`sha256:${'f'.repeat(64)}`);
    await expect(f.store.readCatalogCommits(input(manifest))).rejects.toThrow('history_digest_mismatch');
    await expect(f.store.readPublicProjectionSourceCheckpoint('run-source')).rejects.toThrow('store_unhealthy');
  });
});
