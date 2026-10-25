import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION, PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION,
  MAX_PUBLIC_PROJECTION_PAGE_BYTES, PublicProjectionViewPageChain,
  verifyPublicProjectionMessageWindow,
  type ProjectionCommit, type PublicProjectionChange, type PublicProjectionViewManifest,
  type PublicProjectionMessageWindow, type PublicMessageProjection
} from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { resolvePublicProjectionDatabasePath } from '../src/adapters/persistence/PublicProjectionDbSchema.js';

const resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
const NOW = '2032-01-01T00:00:00.000Z';
afterEach(async () => {
  for (const { root, store } of resources.splice(0)) { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

describe('selected Projection snapshots and Message windows', () => {
  it('windows immutable Agent interaction messages together with Message heads without loading all Run details', async () => {
    const store = createStore();
    const embedded = (index: number, runId = 'run-a'): PublicMessageProjection => ({ messageId: id(index), sessionId: 'session-a', runId,
      version: 1, role: index % 2 === 0 ? 'assistant' : 'user', content: `Interaction ${index}`,
      status: 'completed', createdAt: NOW, updatedAt: NOW });
    const parent = (version: number, messages: PublicMessageProjection[]): PublicProjectionChange => ({ feature: 'runs', operation: 'upsert',
      aggregateId: 'run-a', aggregateVersion: version, projectedAt: NOW, dto: { runId: 'run-a', sessionId: 'session-a', version,
        title: 'Inbox conversation', status: 'running', label: 'Running', toolActivities: [], inbox: [], interactionMessages: messages, updatedAt: NOW } });
    await store.append(commit(1, [session('a'), session('b'), message(10), parent(1, [embedded(0), embedded(1), embedded(2)])]));
    const manifest = await begin(store, undefined, ['inference_streams']);
    await store.append(commit(2, [parent(2, [embedded(0), embedded(1), embedded(2), embedded(3)])]));
    const first = await window(store, manifest, { kind: 'latest', limit: 2 });
    expect(first.changes.map(change => change.aggregateId)).toEqual([id(2), id(10)]);
    const before = await window(store, manifest, { kind: 'before', anchorMessageId: id(2), limit: 2 });
    expect(before.changes.map(change => change.aggregateId)).toEqual([id(1), id(0)]);
    expect(before.hasEarlier).toBe(false);
    expect((await window(store, manifest, { kind: 'around', anchorMessageId: id(1), limit: 3 })).changes).toHaveLength(3);
    expect((await window(store, await begin(store, undefined, ['inference_streams']), { kind: 'latest', limit: 10 })).changes).toHaveLength(5);

    // A dedicated Message authority owns its identity, including deletion.
    await store.append(commit(3, [message(0)]));
    const owning = await window(store, await begin(store, undefined, ['inference_streams']), { kind: 'around', anchorMessageId: id(0), limit: 1 });
    expect(owning.changes[0]?.dto).toMatchObject({ content: 'Message 0' });
    await store.append(commit(4, [{ feature: 'messages', operation: 'delete', aggregateId: id(0), aggregateVersion: 2, projectedAt: NOW, dto: null }]));
    const fresh = await begin(store, undefined, ['inference_streams']);
    expect(await store.readMessageWindow({ manifest: fresh, window: { kind: 'around', anchorMessageId: id(0), limit: 1 } }))
      .toEqual({ status: 'anchor_unavailable', snapshotId: fresh.snapshotId });
  });

  it('validates the original Run row digest before exposing a nested interaction window', async () => {
    const store = createStore();
    await store.append(commit(1, [session('a'), { feature: 'runs', operation: 'upsert', aggregateId: 'run-a', aggregateVersion: 1, projectedAt: NOW,
      dto: { runId: 'run-a', sessionId: 'session-a', version: 1, title: 'Run', status: 'running', label: 'Running',
        toolActivities: [], inbox: [], interactionMessages: [{ messageId: 'interaction', sessionId: 'session-a', runId: 'run-a', version: 1,
          role: 'user', content: 'Nested history', status: 'completed', createdAt: NOW, updatedAt: NOW }], updatedAt: NOW } }]));
    const manifest = await begin(store, undefined, ['inference_streams']);
    const root = resources.at(-1)!.root;
    const database = new DatabaseSync(resolvePublicProjectionDatabasePath(root));
    try { database.prepare("UPDATE projection_versions SET payload_digest=? WHERE feature='runs'").run(`sha256:${'0'.repeat(64)}`); }
    finally { database.close(); }
    await expect(store.readMessageWindow({ manifest, window: { kind: 'latest', limit: 1 } })).rejects.toThrow('public_projection_storage_corrupt');
    await expect(store.readMessageWindow({ manifest, window: { kind: 'latest', limit: 1 } })).rejects.toThrow('public_projection_store_unhealthy');
  });
  it('shares deterministic time/role/binary-ID ordering with the public client', async () => {
    const store = createStore();
    const a = message(1), b = message(2), c = message(3), d = message(4);
    if (a.feature !== 'messages' || a.dto === null || b.feature !== 'messages' || b.dto === null
      || c.feature !== 'messages' || c.dto === null || d.feature !== 'messages' || d.dto === null) throw new Error('fixture_message_missing');
    await store.append(commit(1, [session('a'),
      { ...a, aggregateId: 'message-Z', dto: { ...a.dto, messageId: 'message-Z', role: 'user' } },
      { ...b, aggregateId: 'message-a', dto: { ...b.dto, messageId: 'message-a', role: 'user' } },
      { ...c, aggregateId: 'message-A', dto: { ...c.dto, messageId: 'message-A', role: 'assistant' } },
      { ...d, aggregateId: 'message-0', dto: { ...d.dto, messageId: 'message-0', role: 'system' } }
    ]));
    const result = await window(store, await begin(store), { kind: 'latest', limit: 10 });
    expect(result.changes.map(change => change.aggregateId)).toEqual(['message-Z', 'message-a', 'message-A', 'message-0']);
  });

  it('starts a fresh generation after restart and rejects window row corruption', async () => {
    let store = createStore();
    const resource = resources.at(-1)!;
    await store.append(commit(1, [session('a'), message(1)]));
    const old = await begin(store);
    await store.close();
    store = new SqlitePublicProjectionStore(resource.root);
    resource.store = store;
    expect(await store.readMessageWindow({ manifest: old, window: { kind: 'latest', limit: 10 } }))
      .toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
    const fresh = await begin(store);
    const database = new DatabaseSync(resolvePublicProjectionDatabasePath(resource.root));
    try { database.exec("UPDATE projection_versions SET dto_json=json_set(dto_json, '$.content', 'corrupt') WHERE feature='messages';"); }
    finally { database.close(); }
    await expect(store.readMessageWindow({ manifest: fresh, window: { kind: 'latest', limit: 10 } }))
      .rejects.toThrow('row_mismatch');
    await expect(store.beginViewSnapshot({ pageContractVersion: '2.0', scope: fresh.scope, features: ['runs'] }))
      .rejects.toThrow('public_projection_store_unhealthy');
  });

  it('loads metadata without all Message bodies and uses the same immutable C for later windows', async () => {
    const store = createStore();
    await store.append(commit(1, [session('a'), session('b')]));
    await store.append(commit(2, Array.from({ length: 100 }, (_, index) => message(index))));
    await store.append(commit(3, [message(900, 'b')]));
    const manifest = await begin(store);
    const page = await new PublicProjectionViewPageChain(manifest).accept(await store.readViewSnapshotPage(pageRequest(manifest)));
    expect(page.changes).toEqual([]);
    expect(page.hasMore).toBe(false);
    await store.append(commit(4, [message(99, 'a', 2, 'Updated after C.'), message(100),
      { feature: 'messages', operation: 'delete', aggregateId: id(98), aggregateVersion: 2, projectedAt: NOW, dto: null }]));
    const latest = await window(store, manifest, { kind: 'latest', limit: 10 });
    expect(latest.changes.map(change => change.aggregateId)).toEqual(Array.from({ length: 10 }, (_, index) => id(index + 90)));
    expect(latest.changes.every(change => change.aggregateVersion === 1)).toBe(true);
    expect(latest.hasEarlier).toBe(true);
    expect(latest.hasLater).toBe(false);
    const previous = await window(store, manifest, { kind: 'before', anchorMessageId: id(90), limit: 10 });
    expect(previous.changes.map(change => change.aggregateId)).toEqual(Array.from({ length: 10 }, (_, index) => id(index + 80)));
    expect(previous.hasEarlier).toBe(true);
    expect(previous.hasLater).toBe(true);
    const around = await window(store, manifest, { kind: 'around', anchorMessageId: id(10), limit: 5 });
    expect(around.changes.map(change => change.aggregateId)).toEqual([8, 9, 10, 11, 12].map(id));
    const fresh = await window(store, await begin(store), { kind: 'latest', limit: 5 });
    expect(fresh.changes.map(change => change.aggregateId)).toEqual([95, 96, 97, 99, 100].map(id));
    expect(fresh.changes.find(change => change.aggregateId === id(99))?.aggregateVersion).toBe(2);
  });

  it('cuts large windows by bytes while preserving the anchor and adjacent message order', async () => {
    const store = createStore();
    await store.append(commit(1, [session('a')]));
    for (let index = 0; index < 20; index += 1) await store.append(commit(index + 2, [message(index, 'a', 1, '文'.repeat(100_000))]));
    const manifest = await begin(store);
    const latest = await window(store, manifest, { kind: 'latest', limit: 128 });
    expect(latest.changes).toHaveLength(6);
    expect(latest.changes.map(change => change.aggregateId)).toEqual([14, 15, 16, 17, 18, 19].map(id));
    expect(Buffer.byteLength(JSON.stringify(latest))).toBeLessThanOrEqual(MAX_PUBLIC_PROJECTION_PAGE_BYTES);
    const around = await window(store, manifest, { kind: 'around', anchorMessageId: id(10), limit: 128 });
    expect(around.changes).toHaveLength(6);
    expect(around.changes.some(change => change.aggregateId === id(10))).toBe(true);
    const ordered = around.changes.map(change => Number(change.aggregateId.slice(-3)));
    expect(ordered.every((value, index) => index === 0 || value === ordered[index - 1]! + 1)).toBe(true);
    expect(around.hasEarlier).toBe(true);
    expect(around.hasLater).toBe(true);
  });

  it('returns explicit unavailable anchors for missing, deleted and foreign Session messages', async () => {
    const store = createStore();
    await store.append(commit(1, [session('a'), session('b'), message(1), message(2, 'b')]));
    await store.append(commit(2, [{ feature: 'messages', aggregateId: id(1), aggregateVersion: 2,
      operation: 'delete', projectedAt: NOW, dto: null }]));
    const manifest = await begin(store);
    for (const anchorMessageId of [id(0), id(1), id(2)]) expect(await store.readMessageWindow({ manifest,
      window: { kind: 'around', anchorMessageId, limit: 10 } })).toEqual({ status: 'anchor_unavailable', snapshotId: manifest.snapshotId });
  });

  it('verifies selected features and page order without widening the released V1 page contract', async () => {
    const store = createStore();
    await store.append(commit(1, Array.from({ length: 10 }, (_, index) => session(String(index)))));
    const manifest = await begin(store, { kind: 'directory' }, ['sessions']);
    const first = await store.readViewSnapshotPage(pageRequest(manifest, 4));
    if (first.status !== 'ok') throw new Error('unexpected_page_reset');
    const second = await store.readViewSnapshotPage({ ...pageRequest(manifest, 4), pageCursor: first.nextPageCursor });
    const chain = new PublicProjectionViewPageChain(manifest);
    await expect(chain.accept(second)).rejects.toThrow('page_chain_mismatch');
    await chain.accept(first);
    await expect(chain.accept(first)).rejects.toThrow('page_chain_mismatch');
    await chain.accept(second);
    expect(await store.readViewSnapshotPage({ ...pageRequest(manifest), selectedFeatures: ['models'] }))
      .toMatchObject({ status: 'reset_required', reason: 'scope_mismatch' });
    const { selectedFeatures: _features, ...releasedRequest } = pageRequest(manifest);
    expect(await store.readSnapshotPage({ ...releasedRequest, pageContractVersion: '1.0' }))
      .toMatchObject({ status: 'reset_required', reason: 'contract_mismatch' });
  });

  it('rejects forged manifests, expired generations and corrupted window body/order/digests', async () => {
    let now = new Date(NOW);
    const store = createStore({ now: () => now });
    await store.append(commit(1, [session('a'), message(1), message(2)]));
    const manifest = await begin(store);
    const request = { manifest, window: { kind: 'latest' as const, limit: 10 } };
    const result = await store.readMessageWindow(request);
    if (result.status !== 'ok') throw new Error('unexpected_window_reset');
    await expect(verifyPublicProjectionMessageWindow(request, { ...result, changes: [...result.changes].reverse() }))
      .rejects.toThrow('order_mismatch');
    const changed = structuredClone(result);
    const first = changed.changes[0]!;
    if (first.feature !== 'messages' || first.dto === null) throw new Error('message_missing');
    first.dto.content = 'Forged body.';
    await expect(verifyPublicProjectionMessageWindow(request, changed)).rejects.toThrow('digest_mismatch');
    expect(await store.readMessageWindow({ ...request, manifest: { ...manifest, selectedFeatures: ['messages'] } }))
      .toMatchObject({ status: 'reset_required', reason: 'scope_mismatch' });
    now = new Date(now.getTime() + 5 * 60_000);
    expect(await store.readMessageWindow(request)).toMatchObject({ status: 'reset_required', reason: 'snapshot_expired' });
  });
});

function createStore(clock?: { now(): Date }) {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-message-window-'));
  const store = new SqlitePublicProjectionStore(root, clock);
  resources.push({ root, store });
  return store;
}
async function begin(store: SqlitePublicProjectionStore,
  scope: PublicProjectionViewManifest['scope'] = { kind: 'session', workspaceId: 'workspace-a', sessionId: 'session-a' },
  features: PublicProjectionViewManifest['selectedFeatures'] = ['decisions', 'inference_streams', 'runs']) {
  const manifest = await store.beginViewSnapshot({ pageContractVersion: PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION, scope, features });
  if ('status' in manifest) throw new Error('unexpected_view_reset');
  return manifest;
}
function pageRequest(manifest: PublicProjectionViewManifest, limit = 128) {
  return { pageContractVersion: manifest.pageContractVersion, snapshotId: manifest.snapshotId,
    streamId: manifest.streamId, boundaryCursor: manifest.boundaryCursor, boundaryDigest: manifest.boundaryDigest,
    scope: manifest.scope, selectedFeatures: manifest.selectedFeatures, limit };
}
async function window(store: SqlitePublicProjectionStore, manifest: PublicProjectionViewManifest,
  descriptor: PublicProjectionMessageWindow) {
  const request = { manifest, window: descriptor };
  const result = await verifyPublicProjectionMessageWindow(request, await store.readMessageWindow(request));
  if (result.status !== 'ok') throw new Error('unexpected_window_unavailable');
  return result;
}
function id(index: number) { return `message-${String(index).padStart(3, '0')}`; }
function commit(sourceCursor: number, changes: PublicProjectionChange[]): ProjectionCommit {
  return { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, sourceId: 'window-fixture', sourceCursor,
    eventId: `window-event-${sourceCursor}`, occurredAt: NOW, changes };
}
function session(owner: string): PublicProjectionChange {
  return { feature: 'sessions', operation: 'upsert', aggregateId: `session-${owner}`, aggregateVersion: 1,
    projectedAt: NOW, dto: { sessionId: `session-${owner}`, workspaceId: `workspace-${owner}`, version: 1,
      title: `Session ${owner}`, pinned: false, status: 'active', createdAt: NOW, updatedAt: NOW } };
}
function message(index: number, owner = 'a', version = 1, content = `Message ${index}`): PublicProjectionChange {
  return { feature: 'messages', operation: 'upsert', aggregateId: id(index), aggregateVersion: version,
    projectedAt: NOW, dto: { messageId: id(index), sessionId: `session-${owner}`, role: 'assistant',
      content, version, status: 'completed', createdAt: NOW, updatedAt: NOW } };
}
