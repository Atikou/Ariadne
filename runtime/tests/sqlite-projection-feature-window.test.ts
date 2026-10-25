import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, verifyPublicProjectionFeatureWindow,
  type PublicProjectionChange, type PublicProjectionViewManifest } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { resolvePublicProjectionDatabasePath } from '../src/adapters/persistence/PublicProjectionDbSchema.js';

const NOW = '2026-10-05T00:00:00.000Z';
const roots: string[] = [], stores: SqlitePublicProjectionStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function create() { const root = mkdtempSync(path.join(tmpdir(), 'ariadne-feature-window-')); roots.push(root); const store = new SqlitePublicProjectionStore(root); stores.push(store); return store; }
function commit(index: number, changes: PublicProjectionChange[]) { return { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, eventId: `event-${index}`, sourceId: 'source', sourceCursor: index, occurredAt: NOW, changes }; }
function diagnostic(index: number): PublicProjectionChange { return { feature: 'diagnostics', aggregateId: `diagnostic-${index}`, aggregateVersion: 1, operation: 'upsert', projectedAt: NOW,
  dto: { diagnosticId: `diagnostic-${index}`, version: 1, severity: 'info', code: 'FIXTURE', message: `Diagnostic ${index}`, observedAt: NOW } }; }
function session(id: string): PublicProjectionChange { return { feature: 'sessions', aggregateId: id, aggregateVersion: 1, operation: 'upsert', projectedAt: NOW,
  dto: { sessionId: id, workspaceId: 'workspace', version: 1, title: id, pinned: false, status: 'active', createdAt: NOW, updatedAt: NOW } }; }
function stream(index: number, owner = 'session', status: 'streaming' | 'committed' = 'streaming', length = 10): PublicProjectionChange {
  const text = 'x'.repeat(length), chunks = Array.from({ length: Math.ceil(length / 32768) }, (_, part) => ({ sequence: part + 1, channel: 'reasoning' as const,
    text: text.slice(part * 32768, (part + 1) * 32768), observedAt: NOW }));
  return { feature: 'inference_streams', aggregateId: `stream-${index}`, aggregateVersion: 1, operation: 'upsert', projectedAt: NOW,
    dto: { inferenceStreamId: `stream-${index}`, sessionId: owner, runId: `run-${index}`, turnId: `turn-${index}`, attemptId: `attempt-${index}`,
      version: 1, status, retainedFromSequence: 1, finalSequence: chunks.length, chunks, updatedAt: NOW } };
}
async function view(store: SqlitePublicProjectionStore, sessionId?: string): Promise<PublicProjectionViewManifest> {
  const manifest = await store.beginViewSnapshot({ pageContractVersion: '2.0', scope: sessionId === undefined ? { kind: 'directory' }
    : { kind: 'session', workspaceId: 'workspace', sessionId }, features: [sessionId === undefined ? 'diagnostics' : 'inference_streams'] });
  if ('status' in manifest) throw new Error(manifest.reason); return manifest;
}

it('reads bounded diagnostics with binary ties and before windows at the same C during updates and deletes', async () => {
  const store = create(); await store.append(commit(1, [0, 1, 2, 3].map(diagnostic)));
  const manifest = await view(store);
  const request = { windowContractVersion: '1.0' as const, manifest, window: { feature: 'diagnostics' as const, filter: 'all' as const, limit: 2 } };
  const first = await verifyPublicProjectionFeatureWindow(request, await store.readFeatureWindow(request));
  expect(first).toMatchObject({ status: 'ok', hasEarlier: true });
  if (first.status !== 'ok') throw new Error('window_required');
  expect(first.changes.map(change => change.aggregateId)).toEqual(['diagnostic-0', 'diagnostic-1']);
  await store.append(commit(2, [{ ...diagnostic(1), aggregateVersion: 2, operation: 'delete', dto: null }, diagnostic(4)]));
  const older = { ...request, window: { ...request.window, beforeAggregateId: 'diagnostic-1' } };
  expect(await verifyPublicProjectionFeatureWindow(older, await store.readFeatureWindow(older))).toMatchObject({ status: 'ok', hasEarlier: false,
    changes: [{ aggregateId: 'diagnostic-2' }, { aggregateId: 'diagnostic-3' }] });
  const fresh = { ...older, manifest: await view(store) };
  expect(await verifyPublicProjectionFeatureWindow(fresh, await store.readFeatureWindow(fresh))).toEqual({ status: 'anchor_unavailable', snapshotId: fresh.manifest.snapshotId });
  await expect(verifyPublicProjectionFeatureWindow(request, { status: 'anchor_unavailable', snapshotId: manifest.snapshotId })).rejects.toThrow('anchor_request_mismatch');
});

it('limits inference bodies to the exact Session, current status and explicit Run identity set', async () => {
  const store = create(); await store.append(commit(1, [session('session'), session('foreign'), stream(0), stream(1, 'session', 'committed'), stream(2, 'foreign')]));
  const manifest = await view(store, 'session');
  const request = { windowContractVersion: '1.0' as const, manifest, window: { feature: 'inference_streams' as const, filter: 'streaming' as const, limit: 128 } };
  expect(await store.readFeatureWindow(request)).toMatchObject({ status: 'ok', changes: [{ aggregateId: 'stream-0' }] });
  const exact = { ...request, window: { ...request.window, filter: 'all' as const, runIds: ['run-1', 'run-2'] } };
  const result = await verifyPublicProjectionFeatureWindow(exact, await store.readFeatureWindow(exact));
  expect(result).toMatchObject({ status: 'ok', changes: [{ aggregateId: 'stream-1' }] });
  if (result.status !== 'ok') throw new Error('window_required'); expect(result.changes).toHaveLength(1);
  await expect(store.readFeatureWindow({ ...request, window: { feature: 'diagnostics', filter: 'all', limit: 128 } })).rejects.toThrow();
  await expect(verifyPublicProjectionFeatureWindow(exact, { ...result, window: { ...exact.window, limit: 127 } })).rejects.toThrow('request_mismatch');
});

it('enforces the complete envelope byte bound and continues from the last actual row without skipping large streams', async () => {
  const store = create(); await store.append(commit(1, [session('session')]));
  for (let index = 0; index < 10; index += 1) await store.append(commit(index + 2, [stream(index, 'session', 'committed', 262144)]));
  const request = { windowContractVersion: '1.0' as const, manifest: await view(store, 'session'), window: { feature: 'inference_streams' as const, filter: 'all' as const, limit: 128 } };
  let next = request, rows = 0, calls = 0;
  do {
    const result = await verifyPublicProjectionFeatureWindow(next, await store.readFeatureWindow(next));
    if (result.status !== 'ok') throw new Error('window_required');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2 * 1024 * 1024);
    rows += result.changes.length; calls += 1;
    if (!result.hasEarlier) break;
    next = { ...request, window: { ...request.window, beforeAggregateId: result.changes.at(-1)!.aggregateId } } as typeof request;
  } while (calls < 10);
  expect(rows).toBe(10); expect(calls).toBe(2);
});

it('rejects expired and restarted generations and corrupt stored row digests', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-feature-restart-')); roots.push(root);
  let instant = new Date(NOW);
  const store = new SqlitePublicProjectionStore(root, { now: () => instant }); stores.push(store);
  await store.append(commit(1, [diagnostic(0)]));
  const request = { windowContractVersion: '1.0' as const, manifest: await view(store), window: { feature: 'diagnostics' as const, filter: 'all' as const, limit: 1 } };
  instant = new Date(instant.getTime() + 300001);
  expect(await store.readFeatureWindow(request)).toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
  await store.close(); stores.splice(stores.indexOf(store), 1);
  const restarted = new SqlitePublicProjectionStore(root); stores.push(restarted);
  expect(await restarted.readFeatureWindow(request)).toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
  const fresh = { ...request, manifest: await view(restarted) };
  const database = new DatabaseSync(resolvePublicProjectionDatabasePath(root));
  try { database.prepare("UPDATE projection_versions SET payload_digest=? WHERE feature='diagnostics'").run(`sha256:${'0'.repeat(64)}`); }
  finally { database.close(); }
  await expect(restarted.readFeatureWindow(fresh)).rejects.toThrow('public_projection_storage_corrupt');
  await expect(restarted.readFeatureWindow(fresh)).rejects.toThrow('public_projection_store_unhealthy');
});
