import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { resolvePublicProjectionDatabasePath } from '../../runtime/src/adapters/persistence/PublicProjectionDbSchema.js';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries.js';
import { ProjectionRuntimeClient } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client.js';
import { ProjectionCatalogRepository, type ProjectionCatalogSelection } from '../../app/src/renderer/src/core/runtime/projection/projection-catalog-repository.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(project, 'artifacts/todo-remediation');
const [fixtureName = 't02-catalog-capacity.json', reportName = 't02-catalog-cache-capacity.json'] = process.argv.slice(2);
for (const name of [fixtureName, reportName]) assert(/^[a-z0-9][a-z0-9_-]*\.json$/u.test(name), 'Capacity paths must be JSON basenames.');
const fixture = JSON.parse(readFileSync(path.join(output, fixtureName), 'utf8'));
const dataRoot = realpathSync(fixture.dataRoot), temporary = realpathSync(tmpdir());
assert.equal(fixture.status, 'passed');
assert(dataRoot.toLowerCase().startsWith(`${temporary.toLowerCase()}${path.sep}`));
assert(/^ariadne-projection-catalog-capacity-[a-z0-9]+$/iu.test(path.basename(dataRoot)));
const database = new DatabaseSync(resolvePublicProjectionDatabasePath(dataRoot), { readOnly: true });
try {
  const rows = database.prepare("SELECT COUNT(*) AS count, SUM(length(CAST(dto_json AS BLOB))) AS bytes FROM projection_heads WHERE feature='runs'").get() as { count: number; bytes: number };
  assert.equal(rows.count, 512); assert(rows.bytes > 64 * 1024 * 1024);
  assert(database.prepare("SELECT 1 FROM projection_source_checkpoints WHERE source_id='catalog-capacity-fixture'").get());
} finally { database.close(); }

let opened = performance.now();
let store = new SqlitePublicProjectionStore(dataRoot);
const openMs = performance.now() - opened;
const repository = new ProjectionCatalogRepository(new ProjectionRuntimeClient({
  request: async command => ({ ok: true, value: await readAgentProjectionQuery(store, command) }),
  getStatus: async () => { throw new Error('unused_status'); }, onEvent: () => () => undefined, onStatus: () => () => undefined
}));
const tasks: ProjectionCatalogSelection = { scope: { kind: 'tasks' }, feature: 'runs', filter: 'all' };
const samples: { page: number; rows: number; bytes: number; ms: number }[] = [];
let peakCachedBytes = 0, peakHeapBytes = 0, peakRssBytes = 0;
const sample = (started: number) => {
  const current = repository.selected(); assert(current);
  assert.equal(current.page.totalRows, 512);
  assert(current.page.rows.length <= 128);
  assert(!JSON.stringify(current).includes('CATALOG_BODY_FIXTURE'));
  assert.equal(repository.usage().rows, current.page.rows.length);
  assert.equal(repository.usage().bytes, current.bytes);
  samples.push({ page: current.page.pageIndex, rows: current.page.rows.length, bytes: current.bytes, ms: performance.now() - started });
  peakCachedBytes = Math.max(peakCachedBytes, repository.usage().bytes);
  const memory = process.memoryUsage(); peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed); peakRssBytes = Math.max(peakRssBytes, memory.rss);
};
try {
  repository.select(tasks);
  let started = performance.now(); await repository.load(tasks); sample(started);
  for (let index = 1; index < 4; index += 1) {
    started = performance.now(); await repository.next(tasks); sample(started);
  }
  started = performance.now(); await repository.previous(tasks); sample(started);
  assert.equal(repository.selected()?.page.pageIndex, 2);
  started = performance.now(); await repository.next(tasks); sample(started);
  const visible = repository.selected();
  started = performance.now();
  const scan = await repository.scan(tasks);
  const noChangeScanMs = performance.now() - started;
  assert(scan.status === 'scanned' && !scan.dirty && !scan.hasMore);
  assert.equal(repository.selected(), visible);
  await store.close();
  opened = performance.now(); store = new SqlitePublicProjectionStore(dataRoot);
  const restartOpenMs = performance.now() - opened;
  await assert.rejects(repository.next({ ...tasks, filter: 'active' }), /window_required/u);
  // The old visible page stays trusted at its original C until an explicit
  // reset; a restarted owner must reject its expired generation.
  await assert.rejects(repository.scan(tasks), /snapshot_expired/u);
  assert.equal(repository.selected(), visible);
  repository.invalidate();
  started = performance.now(); await repository.load(tasks); const restartLoadMs = performance.now() - started;
  assert.equal(repository.selected()?.page.totalRows, 512);
  const report = { status: 'passed', scope: 'bounded Renderer catalog repository and production SQLite query owner in Node; actual Electron UI acceptance pending',
    createdAt: new Date().toISOString(), dataRoot, fixtureRunDtoBytes: fixture.serializedRunDtoBytes,
    openMs, samples, noChangeScanMs, peakCachedBytes, peakHeapBytes, peakRssBytes, restartOpenMs, restartLoadMs, finalUsage: repository.usage(),
    runtimeMetadataCache: store.catalogMetadataCacheStats() };
  writeFileSync(path.join(output, reportName), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await store.close(); }
