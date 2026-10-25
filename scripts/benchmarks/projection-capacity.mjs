import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import {
  MAX_PUBLIC_PROJECTION_PAGE_BYTES, PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION, PUBLIC_PROJECTION_SCOPED_READ_VERSION,
  PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION, PublicProjectionViewPageChain,
  PublicProjectionPageChain, verifyPublicProjectionScopedReadBatch, verifyPublicProjectionMessageWindow
} from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../../runtime/dist/adapters/persistence/SqlitePublicProjectionStore.js';
import { resolvePublicProjectionDatabasePath } from '../../runtime/dist/adapters/persistence/PublicProjectionDbSchema.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(project, 'artifacts/todo-remediation');
mkdirSync(output, { recursive: true });
// Fresh independent data. Keep it for inspection; never touch the desktop data root.
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ariadne-projection-capacity-'));
const timestamp = '2032-01-01T00:00:00.000Z';
const content = 'Capacity fixture text. '.repeat(330); // 7,590 ASCII bytes per Message
const sessionId = index => `capacity-session-${String(index).padStart(3, '0')}`;
const messageId = index => `capacity-message-${String(index).padStart(5, '0')}`;
let sourceCursor = 0;
let serializedBytes = 0;
let peakHeap = 0;
let peakRss = 0;
let trace = null;
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  if (trace !== null) trace.sql.set(sql, (trace.sql.get(sql) ?? 0) + 1);
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (key === 'get' || key === 'all') return (...args) => {
      const result = value.apply(target, args);
      if (trace !== null) trace.returnedRows += key === 'get' ? Number(result !== undefined) : result.length;
      return result;
    };
    if (key === 'iterate') return function*(...args) {
      for (const row of value.apply(target, args)) {
        if (trace !== null) trace.returnedRows += 1;
        yield row;
      }
    };
    return value.bind(target);
  } });
};
const memory = () => {
  const sample = process.memoryUsage();
  peakHeap = Math.max(peakHeap, sample.heapUsed);
  peakRss = Math.max(peakRss, sample.rss);
};
const commit = changes => ({ contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
  eventId: `capacity-event-${++sourceCursor}`, sourceId: 'capacity-fixture', sourceCursor,
  occurredAt: timestamp, changes });
const message = (index, version = 1, body = content) => ({ feature: 'messages', operation: 'upsert',
  aggregateId: messageId(index), aggregateVersion: version, projectedAt: timestamp, dto: {
    messageId: messageId(index), sessionId: sessionId(Math.floor(index / 100)), version,
    role: 'assistant', content: body, status: 'completed', createdAt: timestamp, updatedAt: timestamp
  } });
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] };
};
let store;
try {
  const started = performance.now();
  store = new SqlitePublicProjectionStore(dataRoot);
  const emptyOpenMs = performance.now() - started;
  await store.append(commit(Array.from({ length: 100 }, (_, index) => ({
    feature: 'sessions', operation: 'upsert', aggregateId: sessionId(index), aggregateVersion: 1,
    projectedAt: timestamp, dto: { sessionId: sessionId(index), workspaceId: 'capacity-workspace',
      version: 1, title: `Capacity Session ${index}`, pinned: false, status: 'active',
      createdAt: timestamp, updatedAt: timestamp }
  }))));
  const early = [], late = [];
  let appendRows = 0;
  const appendSql = new Map();
  for (let batch = 0; batch < 100; batch += 1) {
    const changes = Array.from({ length: 100 }, (_, offset) => message(batch * 100 + offset));
    serializedBytes += changes.reduce((total, change) => total + Buffer.byteLength(JSON.stringify(change.dto)), 0);
    trace = { sql: new Map(), returnedRows: 0 };
    const start = performance.now();
    await store.append(commit(changes));
    const elapsed = performance.now() - start;
    if (batch < 10) early.push(elapsed);
    if (batch >= 90) late.push(elapsed);
    appendRows = Math.max(appendRows, trace.returnedRows);
    for (const [sql, count] of trace.sql) appendSql.set(sql, (appendSql.get(sql) ?? 0) + count);
    trace = null;
    memory();
    if ((batch + 1) % 20 === 0) console.log(`Persisted ${(batch + 1) * 100} Messages.`);
  }
  assert(serializedBytes > 64 * 1024 * 1024);
  assert(![...appendSql.keys()].some(sql => /FROM projection_heads\s+(?:WHERE feature=\? AND operation='upsert'|ORDER BY)/u.test(sql)),
    'Append must not enumerate the global heads.');
  assert(appendRows < 1_000, 'A fixed-size append read grew with global history.');

  // Pin C, then update/delete/create while subsequent pages still read C.
  const manifest = await store.beginSnapshot({ pageContractVersion: PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION,
    scope: { kind: 'session', workspaceId: 'capacity-workspace', sessionId: sessionId(99) } });
  assert(!('status' in manifest));
  const chain = new PublicProjectionPageChain(manifest);
  let pageCursor, pages = 0, observed = 0, maxPageBytes = 0;
  const pageStart = performance.now();
  do {
    const page = await chain.accept(await store.readSnapshotPage({
      pageContractVersion: manifest.pageContractVersion, snapshotId: manifest.snapshotId,
      streamId: manifest.streamId, boundaryCursor: manifest.boundaryCursor,
      boundaryDigest: manifest.boundaryDigest, scope: manifest.scope, limit: 16,
      ...(pageCursor === undefined ? {} : { pageCursor })
    }));
    maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page)));
    for (const change of page.changes) {
      assert.equal(change.feature, 'messages');
      assert.equal(change.dto.content, content);
      assert.equal(change.aggregateVersion, 1);
      observed += 1;
    }
    pages += 1;
    if (pages === 1) await store.append(commit([
      message(9900, 2, 'Updated after C.'),
      { feature: 'messages', operation: 'delete', aggregateId: messageId(9901),
        aggregateVersion: 2, projectedAt: timestamp, dto: null },
      { ...message(10000), dto: { ...message(10000).dto, sessionId: sessionId(99) } }
    ]));
    pageCursor = page.nextPageCursor;
    memory();
  } while (!chain.isComplete());
  assert.equal(observed, 100);
  assert(maxPageBytes <= MAX_PUBLIC_PROJECTION_PAGE_BYTES);
  const fixedBoundaryReadMs = performance.now() - pageStart;
  const viewStart = performance.now();
  const selected = await store.beginViewSnapshot({ pageContractVersion: PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION,
    scope: manifest.scope, features: ['decisions', 'inference_streams', 'runs'] });
  assert(!('status' in selected));
  const metadataPage = await new PublicProjectionViewPageChain(selected).accept(await store.readViewSnapshotPage({
    pageContractVersion: selected.pageContractVersion, snapshotId: selected.snapshotId, streamId: selected.streamId,
    boundaryCursor: selected.boundaryCursor, boundaryDigest: selected.boundaryDigest, scope: selected.scope,
    selectedFeatures: selected.selectedFeatures, limit: 128
  }));
  assert.equal(metadataPage.changes.length, 0);
  const selectedMetadataMs = performance.now() - viewStart;
  const latestRequest = { manifest: selected, window: { kind: 'latest', limit: 16 } };
  const latestStart = performance.now();
  const latestWindow = await verifyPublicProjectionMessageWindow(latestRequest, await store.readMessageWindow(latestRequest));
  const latestWindowMs = performance.now() - latestStart;
  assert.equal(latestWindow.status, 'ok');
  assert.equal(latestWindow.changes.length, 16);
  assert.equal(latestWindow.hasEarlier, true);
  const aroundRequest = { manifest: selected, window: { kind: 'around', anchorMessageId: messageId(9950), limit: 9 } };
  const aroundStart = performance.now();
  const aroundWindow = await verifyPublicProjectionMessageWindow(aroundRequest, await store.readMessageWindow(aroundRequest));
  const aroundWindowMs = performance.now() - aroundStart;
  assert.equal(aroundWindow.status, 'ok');
  assert.equal(aroundWindow.changes.length, 9);
  assert(aroundWindow.changes.some(change => change.aggregateId === messageId(9950)));
  memory();
  const replayRequest = { readContractVersion: PUBLIC_PROJECTION_SCOPED_READ_VERSION, scope: manifest.scope,
    streamId: manifest.streamId, afterCursor: manifest.boundaryCursor,
    afterDigest: manifest.boundaryDigest, limit: 10 };
  const replay = await verifyPublicProjectionScopedReadBatch(replayRequest, await store.readScope(replayRequest));
  assert.equal(replay.status, 'ok');
  assert.equal(replay.entries.length, 1);
  assert.equal(replay.entries[0].changes.length, 3);

  await store.close();
  const reopenStart = performance.now();
  store = new SqlitePublicProjectionStore(dataRoot);
  const populatedOpenMs = performance.now() - reopenStart;
  memory();
  // Restart expires an in-memory generation explicitly; start a fresh one.
  assert.equal((await store.readSnapshotPage({ pageContractVersion: manifest.pageContractVersion,
    snapshotId: manifest.snapshotId, streamId: manifest.streamId, boundaryCursor: manifest.boundaryCursor,
    boundaryDigest: manifest.boundaryDigest, scope: manifest.scope, limit: 16 })).status, 'reset_required');
  const latest = await store.beginSnapshot({ pageContractVersion: PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION,
    scope: manifest.scope });
  assert(!('status' in latest));
  assert.equal(latest.boundaryCursor, manifest.boundaryCursor + 1);
  const latestChain = new PublicProjectionPageChain(latest);
  pageCursor = undefined;
  let tombstones = 0, latestCount = 0;
  do {
    const page = await latestChain.accept(await store.readSnapshotPage({
      pageContractVersion: latest.pageContractVersion, snapshotId: latest.snapshotId,
      streamId: latest.streamId, boundaryCursor: latest.boundaryCursor, boundaryDigest: latest.boundaryDigest,
      scope: latest.scope, limit: 128, ...(pageCursor === undefined ? {} : { pageCursor })
    }));
    tombstones += page.changes.filter(change => change.operation === 'delete').length;
    latestCount += page.changes.length;
    pageCursor = page.nextPageCursor;
  } while (!latestChain.isComplete());
  assert.equal(latestCount, 101);
  assert.equal(tombstones, 1);
  const evidence = { status: 'passed', scope: 'SQLite store and current paged query; Renderer/UI acceptance pending',
    createdAt: new Date().toISOString(), dataRoot, databasePath: resolvePublicProjectionDatabasePath(dataRoot),
    sessions: 100, originalMessages: 10_000, serializedDtoBytes: serializedBytes,
    emptyOpenMs, populatedOpenMs, appendEarly: distribution(early), appendLate: distribution(late),
    appendMaxReturnedRowsPer100Messages: appendRows,
    appendSql: [...appendSql].map(([sql, count]) => ({ sql, count })),
    fixedBoundaryReadMs, pages, maxPageBytes, peakHeapBytes: peakHeap, peakRssBytes: peakRss,
    selectedMetadataMs, latestWindowMs, aroundWindowMs,
    latestWindowRows: latestWindow.changes.length, latestWindowBytes: Buffer.byteLength(JSON.stringify(latestWindow)),
    aroundWindowRows: aroundWindow.changes.length, aroundWindowBytes: Buffer.byteLength(JSON.stringify(aroundWindow)),
    fixedBoundaryMessages: observed, postBoundaryCommits: replay.entries.length,
    restartLatestRows: latestCount, restartTombstones: tombstones };
  writeFileSync(path.join(output, 't02-projection-capacity.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ...evidence, appendSql: `${appendSql.size} query shapes in evidence` }, null, 2));
} finally {
  trace = null;
  DatabaseSync.prototype.prepare = prepare;
  await store?.close();
}
