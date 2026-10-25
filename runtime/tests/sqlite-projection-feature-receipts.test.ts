import { auditStoredProjectionState as auditDocumentMigration } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { assertPublicProjectionCommit, assertPublicRunDocumentCommit, canonicalPublicProjectionJson,
  publicProjectionFeatureReceiptRequestSchema, verifyPublicProjectionFeatureReceipts,
  type PublicProjectionChange, type PublicProjectionFeatureReceiptRequest, type PublicProjectionViewManifest } from '@ariadne/protocol/public';
import { RunDocumentPlan } from '../src/projection/RunDocumentPlan.js';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteRunDocumentPublication } from '../src/adapters/persistence/SqliteRunDocumentPublication.js';
import { upgradeRunDocumentSchema } from '../src/adapters/persistence/RunDocumentDbSchema.js';
import { resolvePublicProjectionDatabasePath } from '../src/adapters/persistence/PublicProjectionDbSchema.js';
const at = '2032-01-01T00:00:00.000Z';
const resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const { root, store } of resources.splice(0)) {
  await store.close(); rmSync(root, { recursive: true, force: true });
} });
function create() {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-feature-receipts-'));
  let clock = at; const store = new SqlitePublicProjectionStore(root, { now: () => new Date(clock) });
  resources.push({ root, store });
  return { root, store, advance: () => { clock = '2032-01-01T00:06:00.000Z'; },
    database: (store as unknown as { database: DatabaseSync }).database };
}
function session(id = 'a', version = 1, workspace = 'a'): PublicProjectionChange {
  return { feature: 'sessions', aggregateId: `session-${id}`, aggregateVersion: version, operation: 'upsert', projectedAt: at,
    dto: { sessionId: `session-${id}`, workspaceId: `workspace-${workspace}`, version, title: '模拟会话',
      status: 'active', pinned: false, createdAt: at, updatedAt: at } };
}
function diagnostic(id = 'a', version = 1): PublicProjectionChange {
  return { feature: 'diagnostics', aggregateId: `diagnostic-${id}`, aggregateVersion: version, operation: 'upsert', projectedAt: at,
    dto: { diagnosticId: `diagnostic-${id}`, version, severity: 'info', code: 'FIXTURE', message: 'PRIVATE_DIAGNOSTIC_BODY', observedAt: at } };
}
function stream(version = 1, owner = 'a'): PublicProjectionChange {
  return { feature: 'inference_streams', aggregateId: 'stream-a', aggregateVersion: version, operation: 'upsert', projectedAt: at,
    dto: { inferenceStreamId: 'stream-a', sessionId: `session-${owner}`, runId: 'run-a', turnId: 'turn-a', attemptId: 'attempt-a',
      version, status: 'streaming', retainedFromSequence: 1, finalSequence: 1,
      chunks: [{ sequence: 1, channel: 'reasoning', text: 'PRIVATE_STREAM_BODY', observedAt: at }], updatedAt: at } };
}
function ordinary(cursor: number, changes: PublicProjectionChange[], sourceId = 'fixture') {
  return assertPublicProjectionCommit({ contractVersion: '5.0', sourceId, sourceCursor: cursor, eventId: `${sourceId}-${cursor}`, occurredAt: at, changes });
}
async function view(store: SqlitePublicProjectionStore, id?: string): Promise<PublicProjectionViewManifest> {
  const value = await store.beginViewSnapshot({ pageContractVersion: '2.0', scope: id === undefined ? { kind: 'directory' }
    : { kind: 'session', sessionId: `session-${id}`, workspaceId: 'workspace-a' }, features: [id === undefined ? 'diagnostics' : 'inference_streams'] });
  if ('status' in value) throw new Error(value.reason); return value;
}
function request(manifest: PublicProjectionViewManifest, limit = 128): PublicProjectionFeatureReceiptRequest {
  return { queryVersion: '1.0', manifest, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit };
}
async function publish(f: ReturnType<typeof create>) {
  upgradeRunDocumentSchema(f.database, auditDocumentMigration);
  const plan = new RunDocumentPlan({ summary: { runId: 'run-a', sessionId: 'session-a', version: 1, title: '模拟文档', label: '模拟文档',
    status: 'running', updatedAt: at, toolActivityCount: 0, queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: 1 },
    toolActivities: [], inbox: [], interactionMessages: [{ messageId: 'message-a', sessionId: 'session-a', runId: 'run-a', version: 1,
      role: 'assistant', status: 'completed', content: 'PRIVATE_DOCUMENT_BODY🙂'.repeat(40_000), createdAt: at, updatedAt: at }] });
  const commit = assertPublicRunDocumentCommit({ contractVersion: '6.0', sourceId: 'run-source', sourceCursor: 1,
    eventId: 'run-source-1', occurredAt: at, changes: [{ feature: 'runs', aggregateId: 'run-a', aggregateVersion: 1,
      projectedAt: at, operation: 'upsert', dto: plan.header }] });
  await new SqliteRunDocumentPublication(f.database, f.store.streamId, appendDocumentLedger).publish(commit, plan);
}

it('scans original mixed 5.0/6.0 cursors without document chunks or unrelated DTO bodies', async () => {
  const f = create(); await f.store.append(ordinary(1, [session()]));
  const manifest = await view(f.store); await publish(f);
  await f.store.append(ordinary(2, [diagnostic()])); await f.store.append(ordinary(3, [stream()]));
  await f.store.append(ordinary(4, [{ ...diagnostic('a', 2), operation: 'delete', dto: null }]));
  const prepare = vi.spyOn(f.database, 'prepare');
  let next = request(manifest, 1), cursors: number[] = [], receipts: string[] = [];
  do {
    const result = await verifyPublicProjectionFeatureReceipts(next, await f.store.readFeatureReceipts(next));
    expect(result.status).toBe('ok'); if (result.status !== 'ok') throw new Error('receipt_required');
    cursors.push(...result.entries.map(item => item.cursor)); receipts.push(...result.entries.flatMap(item => item.receipts.map(row => row.operation)));
    for (const item of result.entries) {
      const original = f.database.prepare('SELECT payload_digest,history_digest FROM projection_commits WHERE cursor=?').get(item.cursor);
      expect(item.payloadDigest).toBe(original?.payload_digest); expect(item.cursorDigest).toBe(original?.history_digest);
    }
    expect(canonicalPublicProjectionJson(result)).not.toMatch(/PRIVATE_|dto|chunk_bytes/u);
    next = { ...next, afterCursor: result.nextCursor, afterDigest: result.nextDigest };
    if (!result.hasMore) break;
  } while (cursors.length < 10);
  expect(cursors).toEqual([2, 3, 4, 5]); expect(receipts).toEqual(['upsert', 'remove']);
  expect(prepare.mock.calls.map(call => String(call[0])).join('\n')).not.toMatch(/run_document_(items|leaves)/u);
  expect(await f.store.readScope({ readContractVersion: '1.0', streamId: manifest.streamId, scope: manifest.scope,
    afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit: 128 })).toMatchObject({ status: 'reset_required', reason: 'contract_mismatch' });
  expect(await f.store.readFeatureWindow({ windowContractVersion: '1.0', manifest, window: { feature: 'diagnostics', filter: 'all', limit: 128 } }))
    .toMatchObject({ status: 'ok', changes: [] });
});

it('returns exact Session invalidations for stream transfers and tombstones without foreign bodies', async () => {
  const f = create(); await f.store.append(ordinary(1, [session(), session('b'), stream()]));
  const a = request(await view(f.store, 'a')), b = request(await view(f.store, 'b'));
  await f.store.append(ordinary(2, [stream(2, 'b')])); await f.store.append(ordinary(3, [{ ...stream(3, 'b'), operation: 'delete', dto: null }]));
  const left = await verifyPublicProjectionFeatureReceipts(a, await f.store.readFeatureReceipts(a));
  const right = await verifyPublicProjectionFeatureReceipts(b, await f.store.readFeatureReceipts(b));
  if (left.status !== 'ok' || right.status !== 'ok') throw new Error('receipt_required');
  expect(left.entries.map(item => item.receipts.map(row => row.operation))).toEqual([['remove'], []]);
  expect(right.entries.map(item => item.receipts.map(row => row.operation))).toEqual([['upsert'], ['remove']]);
  expect(canonicalPublicProjectionJson(left)).not.toContain('PRIVATE_STREAM_BODY');
});

it('invalidates only the exact model/diagnostic selection and keeps original empty ledger positions', async () => {
  const f = create(); await f.store.append(ordinary(1, [session()]));
  const manifest = await f.store.beginViewSnapshot({ pageContractVersion: '2.0', scope: { kind: 'directory' }, features: ['models'] });
  if ('status' in manifest) throw new Error(manifest.reason);
  const input = request(manifest);
  const model: PublicProjectionChange = { feature: 'models', aggregateId: 'model-a', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
    dto: { modelId: 'model-a', version: 1, label: '模拟模型', location: 'local', availability: 'ready', supportsTextChat: true,
      supportsAgent: true, supportsPlan: false, supportsVision: false, qualificationState: 'unknown', updatedAt: at } };
  await f.store.append(ordinary(2, [diagnostic()])); await f.store.append(ordinary(3, [model]));
  await f.store.append(ordinary(4, [{ ...model, aggregateVersion: 2, operation: 'delete', dto: null }]));
  const value = await verifyPublicProjectionFeatureReceipts(input, await f.store.readFeatureReceipts(input));
  if (value.status !== 'ok') throw new Error('receipt_required');
  expect(value.entries.map(item => item.receipts.map(row => row.operation))).toEqual([[], ['upsert'], ['remove']]);
  expect(canonicalPublicProjectionJson(value)).not.toMatch(/PRIVATE_DIAGNOSTIC_BODY|模拟模型/u);
});

it('fences foreign owner writes in bounded feature windows even when they yield no selected rows', async () => {
  const f = create(); await f.store.append(ordinary(1, [session()])); const manifest = await view(f.store);
  const foreign = new DatabaseSync(resolvePublicProjectionDatabasePath(f.root));
  foreign.exec("UPDATE projection_versions SET dto_json=replace(dto_json,'模拟会话','外部更改') WHERE feature='sessions'"); foreign.close();
  await expect(f.store.readFeatureWindow({ windowContractVersion: '1.0', manifest,
    window: { feature: 'diagnostics', filter: 'all', limit: 128 } })).rejects.toThrow('public_projection_storage_corruption');
  await expect(f.store.readModelProjectionHeads()).rejects.toThrow();
});

it('resets on Session moves and delete/restore even when the final workspace returns to its original value', async () => {
  const f = create(); await f.store.append(ordinary(1, [session(), stream()])); const input = request(await view(f.store, 'a'));
  await f.store.append(ordinary(2, [{ ...session('a', 2), operation: 'delete', dto: null }]));
  await f.store.append(ordinary(3, [session('a', 3)]));
  expect(await verifyPublicProjectionFeatureReceipts(input, await f.store.readFeatureReceipts(input))).toMatchObject({ status: 'reset_required', reason: 'scope_mismatch' });
  const fresh = request(await view(f.store, 'a'));
  await f.store.append(ordinary(4, [session('a', 4, 'b')]));
  expect(await f.store.readFeatureReceipts(fresh)).toMatchObject({ status: 'reset_required', reason: 'scope_mismatch' });
});

it('binds lease, selection, expiry, scan boundary, digest and negative results', async () => {
  const f = create(); await f.store.append(ordinary(1, [session()])); const input = request(await view(f.store));
  for (const [change, reason] of [
    [{ afterCursor: 0 }, 'boundary_mismatch'], [{ afterCursor: 100 }, 'cursor_gap'],
    [{ afterDigest: `sha256:${'a'.repeat(64)}` }, 'history_mismatch'],
    [{ manifest: { ...input.manifest, snapshotId: 'missing-lease' } }, 'snapshot_expired'],
    [{ manifest: { ...input.manifest, selectedFeatures: ['models'] } }, 'scope_mismatch']
  ] as const) expect(await f.store.readFeatureReceipts({ ...input, ...change })).toMatchObject({ status: 'reset_required', reason });
  const invalidSelection = { ...input, manifest: { ...input.manifest, selectedFeatures: ['sessions'] } };
  expect(publicProjectionFeatureReceiptRequestSchema.safeParse(invalidSelection).success).toBe(false);
  f.advance(); const expired = await f.store.readFeatureReceipts(input);
  expect(await verifyPublicProjectionFeatureReceipts(input, expired)).toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
  await expect(verifyPublicProjectionFeatureReceipts(input, { ...expired, afterCursor: input.afterCursor + 1 })).rejects.toThrow('request_mismatch');
});

it('keeps schema-3 data and immutable history unchanged and invalidates leases after reopen', async () => {
  const f = create(); await f.store.append(ordinary(1, [diagnostic()])); const input = request(await view(f.store));
  const before = f.database.prepare('SELECT * FROM projection_commits').all();
  expect(await f.store.readFeatureReceipts(input)).toMatchObject({ status: 'ok', entries: [], hasMore: false });
  expect(f.database.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
  expect(f.database.prepare('SELECT * FROM projection_commits').all()).toEqual(before);
  await f.store.close(); const reopened = new SqlitePublicProjectionStore(f.root, { now: () => new Date(at) });
  resources.find(item => item.root === f.root)!.store = reopened;
  expect(await reopened.readFeatureReceipts(input)).toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
});

it('fences foreign commits even for an empty selection and latches corrupted original history', async () => {
  const f = create(); await f.store.append(ordinary(1, [session()])); const input = request(await view(f.store));
  const foreign = new DatabaseSync(resolvePublicProjectionDatabasePath(f.root));
  foreign.exec("UPDATE projection_versions SET dto_json=replace(dto_json,'模拟会话','外部更改') WHERE feature='sessions'"); foreign.close();
  await expect(f.store.readFeatureReceipts(input)).rejects.toThrow('public_projection_storage_corruption');
  await expect(f.store.readModelProjectionHeads()).rejects.toThrow();
  const clean = create(); await clean.store.append(ordinary(1, [session()])); const cleanInput = request(await view(clean.store));
  await clean.store.append(ordinary(2, [diagnostic()]));
  clean.database.prepare('UPDATE projection_commits SET history_digest=? WHERE cursor=2').run(`sha256:${'b'.repeat(64)}`);
  await expect(clean.store.readFeatureReceipts(cleanInput)).rejects.toThrow('feature_receipts:commit_invalid');
  await expect(clean.store.readModelProjectionHeads()).rejects.toThrow();
});
