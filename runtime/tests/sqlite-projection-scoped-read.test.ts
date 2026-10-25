import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION, PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION,
  PUBLIC_PROJECTION_SCOPED_READ_VERSION, MAX_PUBLIC_PROJECTION_SCOPED_READ_BYTES,
  verifyPublicProjectionScopedReadBatch,
  type PublicProjectionChange, type PublicProjectionScopedReadRequest, type ProjectionCommit
} from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';

const resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
const NOW = '2032-01-01T00:00:00.000Z';
afterEach(async () => {
  for (const { root, store } of resources.splice(0)) {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('scoped Projection scans', () => {
  it('advances across unrelated Commits without returning their bodies and retains own updates/deletes', async () => {
    const store = createStore();
    await store.append(commit(1, [session('a'), session('b')]));
    let request = await readRequest(store);
    await store.append(commit(2, [message('b', 'other', 1, 'Other Session content is not subscribed.')]));
    await store.append(commit(3, [message('a', 'own', 1, 'First own content.')]));
    await store.append(commit(4, [{ feature: 'messages', aggregateId: 'other', aggregateVersion: 2,
      operation: 'delete', projectedAt: NOW, dto: null }]));
    await store.append(commit(5, [message('a', 'own', 2, 'Second own content.')]));
    await store.append(commit(6, [{ feature: 'messages', aggregateId: 'own', aggregateVersion: 3,
      operation: 'delete', projectedAt: NOW, dto: null }]));
    const changes: PublicProjectionChange[] = [];
    const cursors: number[] = [];
    let hasMore = true;
    while (hasMore) {
      const batch = await verifyPublicProjectionScopedReadBatch(request, await store.readScope(request));
      if (batch.status !== 'ok') throw new Error('unexpected_read_reset');
      expect(JSON.stringify(batch)).not.toContain('Other Session content');
      cursors.push(...batch.entries.map(entry => entry.cursor));
      changes.push(...batch.entries.flatMap(entry => entry.changes));
      request = { ...request, afterCursor: batch.nextCursor, afterDigest: batch.nextDigest };
      hasMore = batch.hasMore;
    }
    expect(cursors).toEqual([2, 3, 4, 5, 6]);
    expect(changes.map(change => [change.aggregateId, change.aggregateVersion, change.operation]))
      .toEqual([['own', 1, 'upsert'], ['own', 2, 'upsert'], ['own', 3, 'delete']]);
  });

  it('preserves progress and complete replay when a byte-bound cuts the original scan', async () => {
    const store = createStore();
    await store.append(commit(1, [session('a')]));
    let request = { ...await readRequest(store), limit: 256 };
    for (let index = 0; index < 10; index += 1) await store.append(commit(index + 2,
      [message('a', `large-${index}`, 1, '文'.repeat(100_000))]));
    const ids: string[] = [];
    let batches = 0;
    let hasMore = true;
    while (hasMore) {
      const batch = await verifyPublicProjectionScopedReadBatch(request, await store.readScope(request));
      if (batch.status !== 'ok') throw new Error('unexpected_read_reset');
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(MAX_PUBLIC_PROJECTION_SCOPED_READ_BYTES);
      expect(batch.nextCursor).toBeGreaterThan(request.afterCursor);
      ids.push(...batch.entries.flatMap(entry => entry.changes.map(change => change.aggregateId)));
      request = { ...request, afterCursor: batch.nextCursor, afterDigest: batch.nextDigest };
      batches += 1;
      hasMore = batch.hasMore;
    }
    expect(batches).toBe(2);
    expect(ids).toEqual(Array.from({ length: 10 }, (_, index) => `large-${index}`));
    expect(request.afterCursor).toBe(11);
  });

  it('rejects payload, global history, missing cursor, and wrong subscription drift before applying', async () => {
    const store = createStore();
    await store.append(commit(1, [session('a')]));
    const request = await readRequest(store);
    await store.append(commit(2, [message('a', 'own', 1, 'Own content.')]));
    const batch = await store.readScope(request);
    if (batch.status !== 'ok') throw new Error('unexpected_read_reset');
    const changed = structuredClone(batch);
    const change = changed.entries[0]!.changes[0]!;
    if (change.feature !== 'messages' || change.dto === null) throw new Error('message_missing');
    change.dto.content = 'Altered content.';
    await expect(verifyPublicProjectionScopedReadBatch(request, changed)).rejects.toThrow('payload_mismatch');
    await expect(verifyPublicProjectionScopedReadBatch(request, { ...batch, entries: [
      { ...batch.entries[0]!, payloadDigest: `sha256:${'f'.repeat(64)}` }
    ] })).rejects.toThrow('history_mismatch');
    await expect(verifyPublicProjectionScopedReadBatch(request, { ...batch, entries: [] }))
      .rejects.toThrow('Scan boundary');
    await expect(verifyPublicProjectionScopedReadBatch({ ...request,
      scope: { kind: 'session', workspaceId: 'workspace-b', sessionId: 'session-b' } }, batch))
      .rejects.toThrow('request_mismatch');
  });

  it('returns explicit resets for an invalid owner or obsolete stream, history, cursor and contract', async () => {
    const store = createStore();
    await store.append(commit(1, [session('a')]));
    const request = await readRequest(store);
    for (const [override, reason] of [
      [{ streamId: 'different-stream' }, 'stream_mismatch'],
      [{ afterDigest: `sha256:${'f'.repeat(64)}` }, 'history_mismatch'],
      [{ afterCursor: 100 }, 'cursor_gap'],
      [{ readContractVersion: '0.0' }, 'contract_mismatch'],
      [{ scope: { kind: 'session', workspaceId: 'workspace-b', sessionId: 'session-a' } }, 'scope_mismatch']
    ] as const) expect(await store.readScope({ ...request, ...override })).toMatchObject({ status: 'reset_required', reason });
    expect((await store.readScope(request)).status).toBe('ok');
  });

  it('restricts workspace directory bodies and still scans commits with no relevant directory changes', async () => {
    const store = createStore();
    await store.append(commit(1, [session('a'), session('b')]));
    const base = await readRequest(store);
    const request = { ...base, scope: { kind: 'directory' as const, workspaceId: 'workspace-a' }, limit: 256 };
    await store.append(commit(2, [session('a', 2), session('b', 2)]));
    await store.append(commit(3, [message('a', 'own', 1, 'Message bodies do not belong to the directory.')]));
    const batch = await verifyPublicProjectionScopedReadBatch(request, await store.readScope(request));
    if (batch.status !== 'ok') throw new Error('unexpected_read_reset');
    expect(batch.entries.map(entry => entry.changes.map(change => change.aggregateId)))
      .toEqual([['session-a'], []]);
    expect(batch.nextCursor).toBe(3);
  });
});

function createStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-scoped-read-'));
  const store = new SqlitePublicProjectionStore(root);
  resources.push({ root, store });
  return store;
}
async function readRequest(store: SqlitePublicProjectionStore): Promise<PublicProjectionScopedReadRequest> {
  const manifest = await store.beginSnapshot({ pageContractVersion: PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION,
    scope: { kind: 'session', workspaceId: 'workspace-a', sessionId: 'session-a' } });
  if ('status' in manifest) throw new Error('unexpected_snapshot_reset');
  return { readContractVersion: PUBLIC_PROJECTION_SCOPED_READ_VERSION, scope: manifest.scope,
    streamId: manifest.streamId, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit: 2 };
}
function commit(sourceCursor: number, changes: PublicProjectionChange[]): ProjectionCommit {
  return { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, sourceId: 'scoped-test', sourceCursor,
    eventId: `scoped-event-${sourceCursor}`, occurredAt: NOW, changes };
}
function session(owner: string, version = 1): PublicProjectionChange {
  return { feature: 'sessions', operation: 'upsert', aggregateId: `session-${owner}`, aggregateVersion: version,
    projectedAt: NOW, dto: { sessionId: `session-${owner}`, workspaceId: `workspace-${owner}`, version,
      title: `Session ${owner}`, status: 'active', pinned: false, createdAt: NOW, updatedAt: NOW } };
}
function message(owner: string, id: string, version: number, content: string): PublicProjectionChange {
  return { feature: 'messages', operation: 'upsert', aggregateId: id, aggregateVersion: version,
    projectedAt: NOW, dto: { messageId: id, sessionId: `session-${owner}`, version,
      role: 'assistant', status: 'completed', content, createdAt: NOW, updatedAt: NOW } };
}
