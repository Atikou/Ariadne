import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, MAX_PUBLIC_PROJECTION_PAGE_BYTES,
  PublicProjectionCatalogPageChain, canonicalPublicProjectionJson, verifyCatalogBatch } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../../runtime/dist/adapters/persistence/SqlitePublicProjectionStore.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'artifacts/todo-remediation');
const reportName = process.argv[2] ?? 't02-catalog-capacity.json';
assert(/^[a-z0-9][a-z0-9_-]*\.json$/u.test(reportName), 'Report must be a JSON basename.');
mkdirSync(output, { recursive: true });
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ariadne-projection-catalog-capacity-'));
console.log(JSON.stringify({ status: 'running', dataRoot }));
const now = '2032-01-01T00:00:00.000Z';
const content = 'CATALOG_BODY_FIXTURE '.repeat(3500);
const sessionId = index => `catalog-session-${String(index).padStart(3, '0')}`;
const runId = index => `catalog-run-${String(index).padStart(4, '0')}`;
let sourceCursor = 0;
let serializedRunDtoBytes = 0;
let store = new SqlitePublicProjectionStore(dataRoot);
const commit = changes => ({ contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, eventId: `catalog-event-${++sourceCursor}`,
  sourceId: 'catalog-capacity-fixture', sourceCursor, occurredAt: now, changes });
const run = (index, version = 1, status = 'running') => ({ feature: 'runs', aggregateId: runId(index),
  aggregateVersion: version, operation: 'upsert', projectedAt: now, dto: { runId: runId(index),
    sessionId: sessionId(index % 100), version, title: `Run ${index}`, status, label: 'Fixture working',
    toolActivities: [], inbox: [], interactionMessages: Array.from({ length: 2 }, (_, message) => ({
      messageId: `catalog-message-${index}-${message}`, sessionId: sessionId(index % 100), version: 1,
      role: 'assistant', content, status: 'completed', createdAt: now, updatedAt: now
    })), updatedAt: now } });
const latencies = [];
const samples = [];
let maxPageBytes = 0;
let peakHeapBytes = 0;
let peakRssBytes = 0;
const memory = () => { const state = process.memoryUsage();
  peakHeapBytes = Math.max(peakHeapBytes, state.heapUsed); peakRssBytes = Math.max(peakRssBytes, state.rss); };
try {
  await store.append(commit(Array.from({ length: 100 }, (_, index) => ({ feature: 'sessions', aggregateId: sessionId(index),
    aggregateVersion: 1, operation: 'upsert', projectedAt: now, dto: { sessionId: sessionId(index), workspaceId: 'catalog-workspace',
      version: 1, title: `Session ${index}`, pinned: false, status: 'active', createdAt: now, updatedAt: now } }))));
  for (let offset = 0; offset < 512; offset += 4) {
    const changes = Array.from({ length: 4 }, (_, index) => run(offset + index));
    serializedRunDtoBytes += changes.reduce((sum, change) => sum + Buffer.byteLength(canonicalPublicProjectionJson(change.dto)), 0);
    const started = performance.now();
    await store.append(commit(changes)); latencies.push(performance.now() - started); memory();
  }
  assert(serializedRunDtoBytes > 64 * 1024 * 1024);
  await assert.rejects(store.snapshot(), /public_projection_snapshot_too_large/u);
  const manifest = await store.beginCatalogSnapshot({ pageContractVersion: '3.0', scope: { kind: 'tasks' }, feature: 'runs', filter: 'active' });
  assert(!('status' in manifest));
  const chain = new PublicProjectionCatalogPageChain(manifest);
  let pageCursor;
  let total = 0;
  let mutate = true;
  const metadataBeforePages = store.catalogMetadataCacheStats();
  do {
    const started = performance.now();
    const page = await chain.accept(await store.readCatalogPage({ manifest, limit: 128, ...(pageCursor ? { pageCursor } : {}) }));
    assert.equal(page.totalRows, 512);
    assert.deepEqual(page.statusCounts, { running: 512 });
    assert(!JSON.stringify(page).includes('CATALOG_BODY_FIXTURE'));
    const bytes = Buffer.byteLength(canonicalPublicProjectionJson(page));
    assert(bytes <= MAX_PUBLIC_PROJECTION_PAGE_BYTES);
    maxPageBytes = Math.max(maxPageBytes, bytes);
    samples.push({ pageIndex: page.pageIndex, rows: page.rows.length, bytes, ms: performance.now() - started });
    total += page.rows.length; pageCursor = page.nextPageCursor;
    if (mutate) { mutate = false; await store.append(commit([run(0, 2, 'completed')])); }
    memory();
  } while (pageCursor !== undefined);
  assert.equal(total, 512);
  const metadataAfterPages = store.catalogMetadataCacheStats();
  assert.equal(metadataAfterPages.misses, metadataBeforePages.misses, 'Hot catalog pages must not reread full Run DTOs.');
  const detailAt = performance.now();
  const detail = await store.readCatalogDetail({ manifest, aggregateId: runId(0) });
  assert.equal(detail.status, 'ok');
  assert.equal(detail.change?.dto?.status, 'running');
  const detailMs = performance.now() - detailAt;
  const request = { manifest, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit: 128 };
  const batch = await verifyCatalogBatch(request, await store.readCatalogCommits(request));
  assert.equal(batch.status, 'ok');
  assert.equal(batch.entries[0]?.changes[0]?.operation, 'remove');
  assert(!JSON.stringify(batch).includes('CATALOG_BODY_FIXTURE'));
  await store.close();
  const restartAt = performance.now();
  store = new SqlitePublicProjectionStore(dataRoot);
  const restartOpenMs = performance.now() - restartAt;
  assert.equal((await store.readCatalogPage({ manifest, limit: 128 })).status, 'reset_required');
  const fresh = await store.beginCatalogSnapshot({ pageContractVersion: '3.0', scope: { kind: 'tasks' }, feature: 'runs', filter: 'active' });
  assert(!('status' in fresh));
  const freshPage = await store.readCatalogPage({ manifest: fresh, limit: 128 });
  assert.equal(freshPage.status, 'ok'); assert.equal(freshPage.totalRows, 511);
  memory();
  const sorted = [...latencies].sort((a, b) => a - b);
  const report = { status: 'passed', scope: 'minimal catalog storage/query, explicit details and restart; actual Renderer/Electron acceptance pending',
    createdAt: new Date().toISOString(), dataRoot, sessions: 100, originalRuns: 512, serializedRunDtoBytes,
    appendFourRunMedianMs: sorted[Math.floor(sorted.length / 2)], pages: samples, maxPageBytes, totalSnapshotRows: total,
    detailBytes: Buffer.byteLength(canonicalPublicProjectionJson(detail)), detailMs,
    minimalSettlementBytes: Buffer.byteLength(canonicalPublicProjectionJson(batch)), restartOpenMs,
    restartActiveRows: freshPage.totalRows, peakHeapBytes, peakRssBytes,
    metadataBeforePages, metadataAfterPages, restartMetadataCache: store.catalogMetadataCacheStats() };
  writeFileSync(path.join(output, reportName), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await store.close(); }
