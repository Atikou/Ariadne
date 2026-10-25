import { auditStoredProjectionState as auditDocumentMigration } from '../../runtime/dist/adapters/persistence/SqlitePublicProjectionStore.js';
import assert from 'node:assert/strict';
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { canonicalPublicProjectionJson, RunDocumentItemAssembler, MAX_RUN_DOCUMENT_LEAF_BYTES } from '@ariadne/protocol/public';
import { RunDocumentPlan } from '../../runtime/dist/projection/RunDocumentPlan.js';
import { openPublicProjectionDatabase } from '../../runtime/dist/adapters/persistence/PublicProjectionDbSchema.js';
import { upgradeRunDocumentSchema } from '../../runtime/dist/adapters/persistence/RunDocumentDbSchema.js';
import { SqliteRunDocumentPreparation } from '../../runtime/dist/adapters/persistence/SqliteRunDocumentPreparation.js';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase } from '../../runtime/dist/adapters/persistence/SqliteOwnerLease.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'artifacts/todo-remediation');
const reportName = process.argv[2] ?? 't02-run-document-sqlite.json';
assert(/^[a-z0-9][a-z0-9_-]*\.json$/u.test(reportName)); mkdirSync(output, { recursive: true });
const fixtureRoot = mkdtempSync(join(os.tmpdir(), 'AriadneRunDocumentCandidate-'));
const opened = openPublicProjectionDatabase(fixtureRoot), backup = join(fixtureRoot, 'before-run-document.sqlite');
const at = '2032-01-01T00:00:00.000Z';
const source = { summary: { runId: 'document-benchmark', sessionId: 'document-benchmark-session', version: 4,
  title: '模拟容量数据', status: 'running', label: '模拟容量数据', updatedAt: at,
  toolActivityCount: 0, queuedInputCount: 17, claimedInputCount: 0, interactionMessageCount: 1 },
  toolActivities: [], inbox: Array.from({ length: 17 }, (_, index) => ({ inputId: `input-${index}`,
    messageId: `message-${index}`, version: 1, delivery: 'next_turn', content: '汉字🙂'.repeat(20_000),
    state: 'queued', queuedAt: at, updatedAt: at })),
  interactionMessages: [{ messageId: 'large-message', sessionId: 'document-benchmark-session', runId: 'document-benchmark',
    version: 1, role: 'assistant', content: '长正文🙂'.repeat(200_000), status: 'completed', createdAt: at, updatedAt: at }] };
const prepareStart = performance.now(), plan = new RunDocumentPlan(source), planMs = performance.now() - prepareStart;
try {
  opened.database.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}';`);
  const descriptor = openSync(backup, 'r+'); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  upgradeRunDocumentSchema(opened.database, auditDocumentMigration);
  await assert.rejects(new SqliteRunDocumentPreparation(opened.database).prepare(plan,
    () => { throw new Error('benchmark_preparation_interruption'); }), /benchmark_preparation_interruption/u);
  assert.equal(await new SqliteRunDocumentPreparation(opened.database).readPreparedHeader(plan.header.summary.runId, 4), null);
} finally { closeOwnedSqliteDatabase(opened.database, opened.ownerLease); }
const lease = acquireSqliteOwnerLease(opened.databasePath, 'run_document_candidate_benchmark');
let database;
try { database = new DatabaseSync(opened.databasePath); } catch (error) { lease.close(); throw error; }
let report;
try {
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;');
  const preparation = new SqliteRunDocumentPreparation(database), start = performance.now();
  await preparation.prepare(plan); const persistMs = performance.now() - start;
  assert.deepEqual(await preparation.readPreparedHeader(plan.header.summary.runId, 4), plan.header);
  const readStart = performance.now(); let restoredItems = 0, leafCount = 0, maximumLeafBytes = 0, heap = 0, rss = 0;
  for (const collection of ['inbox', 'interactionMessages']) for (let ordinal = 0; ordinal < source[collection].length; ordinal++) {
    const metadata = await preparation.readItemMetadata(plan.header, collection, ordinal); assert(metadata);
    assert(!('content' in metadata.metadata.value));
    const assembler = new RunDocumentItemAssembler(plan.header, collection, ordinal); let item;
    for (let chunk = 0; chunk < metadata.descriptor.chunkCount; chunk++) {
      const leaf = await preparation.readItemLeaf(plan.header, collection, ordinal, chunk); assert(leaf);
      maximumLeafBytes = Math.max(maximumLeafBytes, Buffer.byteLength(canonicalPublicProjectionJson(leaf)));
      assert(maximumLeafBytes <= MAX_RUN_DOCUMENT_LEAF_BYTES); leafCount++;
      item = await assembler.accept(leaf);
      const memory = process.memoryUsage(); heap = Math.max(heap, memory.heapUsed); rss = Math.max(rss, memory.rss);
    }
    assert.deepEqual(item, { collection, value: source[collection][ordinal] }); restoredItems++;
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM projection_commits').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM projection_source_checkpoints').get().count, 0);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  report = { format: 'ariadne-run-document-sqlite-benchmark.v1', acceptanceScope: 'independent_sqlite_candidate_only',
    fixture: '模拟数据; candidate schema is not enabled in production', fixtureRoot, recoveryCopy: backup,
    serializedSourceBytes: Buffer.byteLength(canonicalPublicProjectionJson(source)), headerBytes: Buffer.byteLength(canonicalPublicProjectionJson(plan.header)),
    planMs, persistAndVerifyMs: persistMs, readAndRestoreMs: performance.now() - readStart, leafCount, maximumLeafBytes, restoredItems,
    maximumStoredChunkBytes: database.prepare('SELECT MAX(length(chunk_bytes)) AS max FROM projection_run_document_leaves').get().max,
    sampledHeapUsedBytes: heap, sampledRssBytes: rss, interruptedPreparationHidden: true, reopenRetryComplete: true,
    authorityWrite: false, publicCommits: 0, productionDocumentPublication: false,
    notes: ['No Runtime IPC, model, Renderer, final publication, source ACK or process hard kill is covered.',
      'Memory values are stage samples, not continuous peaks; current-Run preparation indexes grow with item count.'] };
} finally { closeOwnedSqliteDatabase(database, lease); }
writeFileSync(join(output, reportName), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
