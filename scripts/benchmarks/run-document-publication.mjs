import { auditStoredProjectionState as auditDocumentMigration } from '../../runtime/dist/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../../runtime/dist/adapters/persistence/SqlitePublicProjectionStore.js';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { canonicalPublicProjectionJson, assertPublicRunDocumentCommit, RunDocumentItemAssembler } from '@ariadne/protocol/public';
import { RunDocumentPlan } from '../../runtime/dist/projection/RunDocumentPlan.js';
import { openPublicProjectionDatabase, resolvePublicProjectionDatabasePath, readMetadata } from '../../runtime/dist/adapters/persistence/PublicProjectionDbSchema.js';
import { upgradeRunDocumentSchema } from '../../runtime/dist/adapters/persistence/RunDocumentDbSchema.js';
import { SqliteRunDocumentPublication } from '../../runtime/dist/adapters/persistence/SqliteRunDocumentPublication.js';
import { SqliteRunDocumentPreparation } from '../../runtime/dist/adapters/persistence/SqliteRunDocumentPreparation.js';
import { auditStoredProjectionState } from '../../runtime/dist/adapters/persistence/SqlitePublicProjectionStore.js';
import { verifyStoredRunDocument } from '../../runtime/dist/adapters/persistence/RunDocumentSqliteVerifier.js';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase } from '../../runtime/dist/adapters/persistence/SqliteOwnerLease.js';

const file = fileURLToPath(import.meta.url), at = '2032-01-01T00:00:00.000Z';
function source(version = 1) {
  return { summary: { runId: 'document-benchmark', sessionId: 'document-benchmark-session', version,
    title: '模拟提交与强杀', status: 'running', label: '模拟提交与强杀', updatedAt: at,
    toolActivityCount: 0, queuedInputCount: 17, claimedInputCount: 0, interactionMessageCount: 1 },
    toolActivities: [], inbox: Array.from({ length: 17 }, (_, index) => ({ inputId: `input-${index}`,
      messageId: `message-${index}`, version: 1, delivery: 'next_turn', content: '汉字🙂'.repeat(20_000),
      state: 'queued', queuedAt: at, updatedAt: at })),
    interactionMessages: [{ messageId: 'large-message', sessionId: 'document-benchmark-session', runId: 'document-benchmark',
      version: 1, role: 'assistant', content: '长正文🙂'.repeat(200_000), status: 'completed', createdAt: at, updatedAt: at }] };
}
function request(plan) {
  return assertPublicRunDocumentCommit({ contractVersion: '6.0', eventId: `document-benchmark-${plan.header.summary.version}`,
    sourceId: 'document-benchmark-source', sourceCursor: plan.header.summary.version, occurredAt: at,
    changes: [{ feature: 'runs', operation: 'upsert', aggregateId: 'document-benchmark', aggregateVersion: plan.header.summary.version,
      projectedAt: at, dto: plan.header }] });
}
function assertCandidateRoot(dataRoot) {
  const parent = dirname(dataRoot);
  assert(/^AriadneRunDocumentPublication-[A-Za-z0-9_-]+$/u.test(basename(parent)));
  assert(['before', 'after'].includes(basename(dataRoot)));
  assert.equal(realpathSync.native(dirname(parent)), realpathSync.native(os.tmpdir()));
  assert(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink());
  assert(lstatSync(dataRoot).isDirectory() && !lstatSync(dataRoot).isSymbolicLink());
}
function openCandidate(dataRoot) {
  assertCandidateRoot(dataRoot);
  const path = resolvePublicProjectionDatabasePath(dataRoot), lease = acquireSqliteOwnerLease(path, 'run_document_publication_candidate');
  let database;
  try {
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 4);
    auditStoredProjectionState(database);
    return { database, streamId: readMetadata(database).streamId, close: () => closeOwnedSqliteDatabase(database, lease) };
  } catch (error) { if (database) closeOwnedSqliteDatabase(database, lease); else lease.close(); throw error; }
}
function counts(database) {
  return database.prepare(`SELECT (SELECT COUNT(*) FROM projection_commits) AS commits,
    (SELECT COUNT(*) FROM projection_versions) AS versions,
    (SELECT COUNT(*) FROM projection_heads) AS heads,
    (SELECT COUNT(*) FROM projection_source_checkpoints) AS sources,
    (SELECT COUNT(*) FROM projection_run_documents WHERE published_cursor IS NOT NULL) AS published`).get();
}
async function worker(phase, dataRoot) {
  assert(['before', 'after'].includes(phase)); assert.equal(basename(dataRoot), phase);
  const opened = openCandidate(dataRoot), plan = new RunDocumentPlan(source());
  const stop = () => {
    assert(process.send); process.send({ checkpoint: phase, pid: process.pid });
    const cell = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(cell, 0, 0);
  };
  try {
    await new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger,
      phase === 'before' ? { beforeCommit: stop } : { afterCommit: stop }).publish(request(plan), plan);
    throw new Error('candidate_worker_checkpoint_not_reached');
  } finally { opened.close(); }
}
async function killAtCheckpoint(phase, dataRoot) {
  const child = fork(file, ['--worker', phase, dataRoot], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2048); });
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`candidate_worker_checkpoint_timeout:${phase}:${stderr}`)), 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`candidate_worker_early_exit:${phase}:${code}:${signal}:${stderr}`)); });
      child.on('message', value => {
        if (value?.checkpoint !== phase || value.pid !== child.pid) return;
        clearTimeout(timer); assert.equal(child.exitCode, null); assert.equal(child.killed, false); resolveReady();
      });
    });
    assert(child.kill('SIGKILL'));
    const exit = await exited;
    return { checkpoint: phase, actualProcessKill: true, exit };
  } finally { if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGKILL'); }
}

if (process.argv[2] === '--worker') await worker(process.argv[3], process.argv[4]);
else {
  const reportName = process.argv[2] ?? 't02-run-document-publication.json';
  assert(/^[a-z0-9][a-z0-9_-]*\.json$/u.test(reportName));
  const taskRoot = mkdtempSync(join(os.tmpdir(), 'AriadneRunDocumentPublication-'));
  const results = [];
  for (const phase of ['before', 'after']) {
    const dataRoot = join(taskRoot, phase); mkdirSync(dataRoot);
    const initial = openPublicProjectionDatabase(dataRoot);
    try { upgradeRunDocumentSchema(initial.database, auditDocumentMigration); } finally { closeOwnedSqliteDatabase(initial.database, initial.ownerLease); }
    const killed = await killAtCheckpoint(phase, dataRoot), opened = openCandidate(dataRoot);
    try {
      const recoveredCounts = { ...counts(opened.database) };
      assert.deepEqual(recoveredCounts, phase === 'before'
        ? { commits: 0, versions: 0, heads: 0, sources: 0, published: 0 }
        : { commits: 1, versions: 1, heads: 1, sources: 1, published: 1 });
      const plan = new RunDocumentPlan(source()), writer = new SqliteRunDocumentPublication(opened.database, opened.streamId, appendDocumentLedger);
      const retried = await writer.publish(request(plan), plan);
      assert.equal(retried.cursor, 1); assert.equal(retried.replayed, phase === 'after');
      assert.deepEqual({ ...counts(opened.database) }, { commits: 1, versions: 1, heads: 1, sources: 1, published: 1 });
      const next = new RunDocumentPlan(source(2)); assert.equal((await writer.publish(request(next), next)).cursor, 2);
      verifyStoredRunDocument(opened.database, plan.header, 1); auditStoredProjectionState(opened.database);
      const preparation = new SqliteRunDocumentPreparation(opened.database);
      const metadata = await preparation.readItemMetadata(plan.header, 'interactionMessages', 0);
      const assembler = new RunDocumentItemAssembler(plan.header, 'interactionMessages', 0); let restored, maximumLeafBytes = 0;
      for (let chunk = 0; chunk < metadata.descriptor.chunkCount; chunk++) {
        const leaf = await preparation.readItemLeaf(plan.header, 'interactionMessages', 0, chunk);
        maximumLeafBytes = Math.max(maximumLeafBytes, Buffer.byteLength(canonicalPublicProjectionJson(leaf)));
        restored = await assembler.accept(leaf);
      }
      assert.deepEqual(restored.value, source().interactionMessages[0]);
      assert.equal(opened.database.prepare('SELECT source_cursor FROM projection_source_checkpoints').get().source_cursor, 2);
      assert.equal(opened.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(opened.database.prepare('PRAGMA foreign_key_check').all().length, 0);
      results.push({ ...killed, recoveredCounts, retry: retried, finalCounts: { ...counts(opened.database) },
        maximumLeafBytes, priorPublishedVersionRestoredAfterNextHead: true });
    } finally { opened.close(); }
  }
  const report = { format: 'ariadne-run-document-publication-benchmark.v1', acceptanceScope: 'independent_sqlite_publication_candidate_only',
    fixture: '模拟数据; candidate schema and Publisher are not enabled in production', taskRoot,
    serializedSourceBytes: Buffer.byteLength(canonicalPublicProjectionJson(source())), results,
    authorityWrite: false, runtimeIpc: false, renderer: false, model: false, outboxAck: false,
    productionDocumentPublication: false, notes: ['Actual Node worker hard kills bracket SQLite COMMIT; not Runtime/Main/UI recovery.',
      'Prior immutable version verification is not a public fixed-C manifest/query acceptance.'] };
  const output = resolve(dirname(file), '../../artifacts/todo-remediation'); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, reportName), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
