import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { PublicProjectionScope } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { resolvePublicProjectionDatabasePath } from '../../runtime/src/adapters/persistence/PublicProjectionDbSchema.js';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries.js';
import { ProjectionRuntimeClient } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client.js';
import { ProjectionScopeRepository } from '../../app/src/renderer/src/core/runtime/projection/projection-scope-repository.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(project, 'artifacts/todo-remediation/t02-scope-cache-capacity.json');
const fixture = JSON.parse(readFileSync(path.join(project, 'artifacts/todo-remediation/t02-projection-capacity.json'), 'utf8'));
// Reuse only the previously generated, independently identified TEMP fixture.
const dataRoot = realpathSync(fixture.dataRoot);
const temporary = realpathSync(tmpdir());
assert(dataRoot.toLowerCase().startsWith(`${temporary.toLowerCase()}${path.sep}`));
assert(/^ariadne-projection-capacity-[a-z0-9]+$/iu.test(path.basename(dataRoot)));
assert.equal(fixture.status, 'passed');
const database = new DatabaseSync(resolvePublicProjectionDatabasePath(dataRoot), { readOnly: true });
try {
  const rows = database.prepare(`SELECT COUNT(*) AS count, SUM(length(CAST(dto_json AS BLOB))) AS bytes
    FROM projection_heads WHERE feature='messages' AND operation='upsert'`).get() as { count: number; bytes: number };
  assert(rows.count >= 10_000);
  assert(rows.bytes > 64 * 1024 * 1024);
  assert(database.prepare("SELECT 1 FROM projection_source_checkpoints WHERE source_id='capacity-fixture'").get());
} finally { database.close(); }

const opened = performance.now();
let store = new SqlitePublicProjectionStore(dataRoot);
const openMs = performance.now() - opened;
const client = new ProjectionRuntimeClient({
  request: async command => ({ ok: true, value: await readAgentProjectionQuery(store, command) }),
  getStatus: async () => { throw new Error('status_not_used'); },
  onEvent: () => () => undefined, onStatus: () => () => undefined
});
const repository = new ProjectionScopeRepository(client);
const features = ['decisions', 'inference_streams', 'runs'] as const;
const scope = (index: number): Extract<PublicProjectionScope, { kind: 'session' }> => ({ kind: 'session',
  workspaceId: 'capacity-workspace', sessionId: `capacity-session-${String(index).padStart(3, '0')}` });
let peakHeapBytes = 0;
let peakRssBytes = 0;
let peakCachedBytes = 0;
const selections: { session: number; ms: number; rows: number; entries: number; cachedBytes: number }[] = [];
const memory = () => {
  const current = process.memoryUsage();
  peakHeapBytes = Math.max(peakHeapBytes, current.heapUsed);
  peakRssBytes = Math.max(peakRssBytes, current.rss);
  peakCachedBytes = Math.max(peakCachedBytes, repository.usage().bytes);
};
try {
  for (let index = 0; index < 24; index += 1) {
    repository.select(scope(index), features);
    const started = performance.now();
    const result = await repository.load(scope(index), features, { kind: 'latest', limit: 16 });
    assert.equal(result.status, 'published');
    const view = repository.selected();
    assert(view);
    assert.equal(view.messageWindow?.changes.length, 16);
    assert(repository.usage().sessions <= 3);
    assert(repository.usage().bytes <= 24 * 1024 * 1024);
    assert(view.changes.every(change => change.feature !== 'messages'
      || (change.dto !== null && change.dto.sessionId === scope(index).sessionId)));
    selections.push({ session: index, ms: performance.now() - started, rows: view.changes.length,
      entries: repository.usage().entries, cachedBytes: repository.usage().bytes });
    memory();
  }
  assert.equal(repository.read(scope(0), features), null);
  const visible = repository.selected();
  assert(visible);
  const before = performance.now();
  const scanned = await repository.scan(scope(23), features);
  assert.equal(scanned.status, 'scanned');
  if (scanned.status === 'scanned') assert.equal(scanned.dirty, false);
  const noChangeScanMs = performance.now() - before;
  assert.equal(repository.selected(), visible);
  const reloadAt = performance.now();
  repository.select(scope(0), features);
  await repository.load(scope(0), features, { kind: 'around', anchorMessageId: 'capacity-message-00050', limit: 9 });
  const evictedSessionReloadMs = performance.now() - reloadAt;
  assert.equal(repository.selected()?.messageWindow?.changes.length, 9);
  assert(repository.selected()?.changes.some(change => change.aggregateId === 'capacity-message-00050'));
  memory();
  repository.invalidate();
  assert.equal(repository.usage().bytes, 0);
  await store.close();
  const restartAt = performance.now();
  store = new SqlitePublicProjectionStore(dataRoot);
  const restartOpenMs = performance.now() - restartAt;
  const restoredAt = performance.now();
  await repository.load(scope(0), features, { kind: 'latest', limit: 16 });
  const restartScopeLoadMs = performance.now() - restoredAt;
  assert.equal(repository.selected()?.messageWindow?.changes.length, 16);
  memory();
  const sorted = selections.map(item => item.ms).sort((left, right) => left - right);
  const report = { status: 'passed', scope: 'Renderer repository and production query owner in Node; actual Electron UI acceptance pending',
    createdAt: new Date().toISOString(), dataRoot, fixtureSessions: fixture.sessions,
    fixtureMessages: fixture.originalMessages, fixtureSerializedDtoBytes: fixture.serializedDtoBytes,
    selections, selectionMedianMs: sorted[Math.floor(sorted.length / 2)],
    selectionP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], openMs, noChangeScanMs,
    evictedSessionReloadMs, restartOpenMs, restartScopeLoadMs,
    peakHeapBytes, peakRssBytes, peakCachedBytes, finalUsage: repository.usage() };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await store.close(); }
