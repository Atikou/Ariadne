import { auditStoredProjectionState as auditDocumentMigration } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalPublicProjectionJson, verifyConversationReceipts, verifyConversationInferenceWindow,
  type PublicProjectionChange, type PublicProjectionCatalogManifest, type PublicConversationReceiptRequest } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteRunDocumentPublication } from '../src/adapters/persistence/SqliteRunDocumentPublication.js';
import { RunDocumentPlan } from '../src/projection/RunDocumentPlan.js';
import { upgradeRunDocumentSchema } from '../src/adapters/persistence/RunDocumentDbSchema.js';
import { resolvePublicProjectionDatabasePath } from '../src/adapters/persistence/PublicProjectionDbSchema.js';
const at = '2032-01-01T00:00:00.000Z', resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const { root, store } of resources.splice(0)) { await store.close(); rmSync(root, { recursive: true, force: true }); } });
function create() {
  let now = new Date(at), cursor = 0;
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-conversation-query-')), store = new SqlitePublicProjectionStore(root, { now: () => now });
  resources.push({ root, store }); const database = (store as unknown as { database: DatabaseSync }).database;
  return { root, store, database, expire: () => { now = new Date(now.getTime() + 300_001); },
    append: (changes: PublicProjectionChange[]) => { cursor++; return store.append({ contractVersion: '5.0', sourceId: 'fixture', sourceCursor: cursor,
      eventId: `fixture-${cursor}`, occurredAt: at, changes }); } };
}
function session(id = 'a', version = 1, workspace = 'a'): PublicProjectionChange {
  return { feature: 'sessions', aggregateId: `session-${id}`, aggregateVersion: version, operation: 'upsert', projectedAt: at,
    dto: { sessionId: `session-${id}`, workspaceId: `workspace-${workspace}`, version, title: '模拟会话', status: 'active', pinned: false, createdAt: at, updatedAt: at } };
}
function message(id = 'a', version = 1, owner = 'a'): PublicProjectionChange {
  return { feature: 'messages', aggregateId: `message-${id}`, aggregateVersion: version, operation: 'upsert', projectedAt: at,
    dto: { messageId: `message-${id}`, sessionId: `session-${owner}`, version, role: 'user', content: 'PRIVATE_MESSAGE_BODY', status: 'completed', createdAt: at, updatedAt: at } };
}
function stream(id = 'a', version = 1, owner = 'a', status: 'streaming' | 'committed' = 'streaming', length = 20): PublicProjectionChange {
  const text = 'x'.repeat(length), chunks = Array.from({ length: Math.ceil(length / 32768) }, (_, part) => ({ sequence: part + 1, channel: 'reasoning' as const,
    text: text.slice(part * 32768, (part + 1) * 32768), observedAt: at }));
  return { feature: 'inference_streams', aggregateId: `stream-${id}`, aggregateVersion: version, operation: 'upsert', projectedAt: at,
    dto: { inferenceStreamId: `stream-${id}`, sessionId: `session-${owner}`, runId: `run-${id}`, turnId: `turn-${id}`, attemptId: `attempt-${id}`,
      version, status, retainedFromSequence: 1, finalSequence: chunks.length, chunks, updatedAt: at } };
}
async function begin(f: ReturnType<typeof create>, owner = 'a'): Promise<PublicProjectionCatalogManifest> {
  const result = await f.store.beginCatalogSnapshot({ pageContractVersion: '3.0', scope: { kind: 'session', sessionId: `session-${owner}`, workspaceId: 'workspace-a' }, feature: 'runs', filter: 'all' });
  if ('status' in result) throw new Error(result.reason); return result;
}
function scan(manifest: PublicProjectionCatalogManifest, limit = 128): PublicConversationReceiptRequest {
  return { queryVersion: '1.0', manifest, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit };
}
async function publish(f: ReturnType<typeof create>, version = 1, owner = 'a') {
  if (f.database.prepare('PRAGMA user_version').get()?.user_version === 3) upgradeRunDocumentSchema(f.database, auditDocumentMigration);
  const plan = new RunDocumentPlan({ summary: { runId: 'run-a', sessionId: `session-${owner}`, version, title: '模拟文档', label: '模拟文档', status: 'completed',
    updatedAt: at, toolActivityCount: 0, queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: 1 }, toolActivities: [], inbox: [],
    interactionMessages: [{ messageId: 'interaction-a', sessionId: `session-${owner}`, runId: 'run-a', version, role: 'assistant',
      content: 'BODY🙂'.repeat(150_000), status: 'completed', createdAt: at, updatedAt: at }] });
  await new SqliteRunDocumentPublication(f.database, f.store.streamId, appendDocumentLedger).publish({ contractVersion: '6.0', sourceId: 'document', sourceCursor: version,
    eventId: `document-${version}`, occurredAt: at, changes: [{ feature: 'runs', aggregateId: 'run-a', aggregateVersion: version,
      operation: 'upsert', projectedAt: at, dto: plan.header }] }, plan);
}
it('keeps mixed original 5.0/6.0 positions and includes all three conversation dependencies without reading document parts', async () => {
  const f = create(); await f.append([session(), session('b')]); const manifest = await begin(f);
  await publish(f); await f.append([message()]); await f.append([message('foreign', 1, 'b')]); await f.append([stream()]);
  await f.append([{ feature: 'diagnostics', aggregateId: 'diagnostic-a', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
    dto: { diagnosticId: 'diagnostic-a', version: 1, severity: 'info', code: 'FIXTURE', message: 'PRIVATE_DIAGNOSTIC_BODY', observedAt: at } }]);
  const prepare = vi.spyOn(f.database, 'prepare'); let request = scan(manifest, 2); const cursors: number[] = [], features: string[] = [];
  do {
    const result = await verifyConversationReceipts(request, await f.store.readConversationReceipts(request));
    if (result.status !== 'ok') throw new Error('receipts_required');
    cursors.push(...result.entries.map(item => item.cursor)); features.push(...result.entries.flatMap(item => item.receipts.map(row => row.feature)));
    for (const entry of result.entries) {
      const original = f.database.prepare('SELECT payload_digest,history_digest FROM projection_commits WHERE cursor=?').get(entry.cursor);
      expect(entry.payloadDigest).toBe(original?.payload_digest); expect(entry.cursorDigest).toBe(original?.history_digest);
    }
    expect(canonicalPublicProjectionJson(result)).not.toMatch(/PRIVATE_|BODY|dto|contentBase64/u);
    request = { ...request, afterCursor: result.nextCursor, afterDigest: result.nextDigest }; if (!result.hasMore) break;
  } while (cursors.length < 10);
  expect(cursors).toEqual([2, 3, 4, 5, 6]); expect(features).toEqual(['runs', 'messages', 'inference_streams']);
  expect(prepare.mock.calls.map(call => String(call[0])).join('\n')).not.toMatch(/run_document_(items|leaves)/u);
});
it('emits removals to previous Session owners for Message, document Run and stream transfers and subsequent tombstones', async () => {
  const f = create(); await f.append([session(), session('b'), message(), stream()]); await publish(f);
  const left = scan(await begin(f)), right = scan(await begin(f, 'b'));
  await f.append([message('a', 2, 'b'), stream('a', 2, 'b')]); await publish(f, 2, 'b');
  await f.append([{ ...message('a', 3, 'b'), operation: 'delete', dto: null }, { ...stream('a', 3, 'b'), operation: 'delete', dto: null },
    { feature: 'runs', aggregateId: 'run-a', aggregateVersion: 3, operation: 'delete', projectedAt: at, dto: null }]);
  const a = await verifyConversationReceipts(left, await f.store.readConversationReceipts(left)), b = await verifyConversationReceipts(right, await f.store.readConversationReceipts(right));
  if (a.status !== 'ok' || b.status !== 'ok') throw new Error('receipts_required');
  expect(a.entries.flatMap(entry => entry.receipts.map(row => `${row.feature}:${row.operation}`))).toEqual(['messages:remove', 'inference_streams:remove', 'runs:remove']);
  expect(b.entries.flatMap(entry => entry.receipts.map(row => row.operation))).toEqual(['upsert', 'upsert', 'upsert', 'remove', 'remove', 'remove']);
});
it('resets Session membership after deletion and restoration even when the final workspace matches', async () => {
  const f = create(); await f.append([session(), message()]); const request = scan(await begin(f));
  await f.append([{ ...session('a', 2), operation: 'delete', dto: null }]); await f.append([session('a', 3)]);
  expect(await verifyConversationReceipts(request, await f.store.readConversationReceipts(request))).toMatchObject({ status: 'reset_required', reason: 'scope_mismatch' });
});
it('reads inference prefixes and message metadata at the exact Catalog C during later updates and Session moves', async () => {
  const f = create(); await f.append([session(), session('b'), message(), stream('a'), stream('b', 1, 'a', 'committed'), stream('foreign', 1, 'b')]);
  const manifest = await begin(f), request = { queryVersion: '1.0' as const, manifest, window: { feature: 'inference_streams' as const, filter: 'streaming' as const, limit: 128 } };
  await f.append([stream('a', 2, 'a', 'committed'), session('a', 2, 'b')]);
  const result = await verifyConversationInferenceWindow(request, await f.store.readConversationInferenceWindow(request));
  expect(result).toMatchObject({ status: 'ok', manifest, changes: [{ aggregateId: 'stream-a', aggregateVersion: 1 }] });
  const window = await f.store.readMessageMetadataWindow({ queryContractVersion: '1.0', manifest, window: { kind: 'latest', limit: 128 } });
  expect(window).toMatchObject({ status: 'ok', manifest, rows: [{ kind: 'message', metadata: { messageId: 'message-a' } }] });
  const selected = { ...request, window: { ...request.window, filter: 'all' as const, runIds: ['run-b', 'run-foreign'] } };
  expect(await verifyConversationInferenceWindow(selected, await f.store.readConversationInferenceWindow(selected)))
    .toMatchObject({ status: 'ok', changes: [{ aggregateId: 'stream-b' }] });
  expect(await f.store.readConversationInferenceWindow({ ...request, window: { ...request.window, beforeAggregateId: 'stream-foreign' } }))
    .toMatchObject({ status: 'anchor_unavailable', manifest });
});
it('honors row and total envelope byte bounds and continues prefixes without skipped large bodies', async () => {
  const f = create(); await f.append([session()]);
  for (let index = 0; index < 10; index++) await f.append([stream(String(index), 1, 'a', 'committed', 262_144)]);
  const manifest = await begin(f), window = { feature: 'inference_streams' as const, filter: 'all' as const, limit: 128 };
  let next = window, rows = 0, calls = 0;
  do {
    const request = { queryVersion: '1.0' as const, manifest, window: next };
    const result = await verifyConversationInferenceWindow(request, await f.store.readConversationInferenceWindow(request));
    if (result.status !== 'ok') throw new Error('window_required'); expect(Buffer.byteLength(canonicalPublicProjectionJson(result))).toBeLessThanOrEqual(2 * 1024 * 1024);
    rows += result.changes.length; calls++; if (!result.hasEarlier) break;
    next = { ...window, beforeAggregateId: result.changes.at(-1)!.aggregateId } as typeof window;
  } while (calls < 10);
  expect(rows).toBe(10); expect(calls).toBe(2);
});
it('binds lease, negative results, boundary and history without changing the activated schema or history', async () => {
  const f = create(); await f.append([session()]); const manifest = await begin(f), request = scan(manifest);
  const rows = f.database.prepare('SELECT * FROM projection_commits').all();
  expect(await f.store.readConversationReceipts(request)).toMatchObject({ status: 'ok', entries: [] });
  expect(f.database.prepare('SELECT * FROM projection_commits').all()).toEqual(rows); expect(f.database.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
  for (const [change, reason] of [[{ afterCursor: 0 }, 'boundary_mismatch'], [{ afterCursor: 100 }, 'cursor_gap'],
    [{ afterDigest: `sha256:${'a'.repeat(64)}` }, 'history_mismatch'], [{ manifest: { ...manifest, snapshotId: 'missing' } }, 'snapshot_expired']] as const) {
    expect(await f.store.readConversationReceipts({ ...request, ...change })).toMatchObject({ status: 'reset_required', reason });
  }
  f.expire(); const expired = await f.store.readConversationReceipts(request);
  expect(await verifyConversationReceipts(request, expired)).toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
  await expect(verifyConversationReceipts(request, { ...expired, afterCursor: 0 })).rejects.toThrow('request_mismatch');
  const inference = { queryVersion: '1.0' as const, manifest, window: { feature: 'inference_streams' as const, filter: 'all' as const, limit: 128 } };
  expect(await verifyConversationInferenceWindow(inference, await f.store.readConversationInferenceWindow(inference)))
    .toMatchObject({ status: 'reset_required', reason: 'snapshot_expired', manifest });
});
it('fences external writes on empty receipt/window reads and latches corrupted original history', async () => {
  for (const window of [false, true]) {
    const f = create(); await f.append([session()]); const manifest = await begin(f);
    const foreign = new DatabaseSync(resolvePublicProjectionDatabasePath(f.root)); foreign.exec("UPDATE projection_versions SET dto_json=replace(dto_json,'模拟会话','外部修改') WHERE feature='sessions'"); foreign.close();
    await expect(window ? f.store.readConversationInferenceWindow({ queryVersion: '1.0', manifest, window: { feature: 'inference_streams', filter: 'all', limit: 128 } })
      : f.store.readConversationReceipts(scan(manifest))).rejects.toThrow('public_projection_storage_corruption');
    await expect(f.store.readModelProjectionHeads()).rejects.toThrow();
  }
  const clean = create(); await clean.append([session()]); const request = scan(await begin(clean)); await clean.append([message()]);
  clean.database.prepare('UPDATE projection_commits SET history_digest=? WHERE cursor=2').run(`sha256:${'b'.repeat(64)}`);
  await expect(clean.store.readConversationReceipts(request)).rejects.toThrow('conversation_receipts:commit_invalid');
  await expect(clean.store.readModelProjectionHeads()).rejects.toThrow();
});
