import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AgentRunCommandService, sha256AgentControlData } from '@ariadne/agent-core';
import { assertPublicProjectionCommit, canonicalPublicProjectionJson, RunDocumentItemAssembler,
  verifyRunDocumentRootResult, verifyRunDocumentChunkResult } from '@ariadne/protocol/public';
import { SqliteAgentRunUnitOfWork } from '../../runtime/dist/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { resolveAgentControlDatabasePath } from '../../runtime/dist/adapters/persistence/agentControlDbSchema.js';
import { resolvePublicProjectionDatabasePath } from '../../runtime/dist/adapters/persistence/PublicProjectionDbSchema.js';
import { SqlitePublicProjectionStore } from '../../runtime/dist/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../../runtime/dist/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ConversationAuthorityService } from '../../runtime/dist/control/conversation/ConversationAuthorityService.js';
import { ConversationPublicProjectionPublisher } from '../../runtime/dist/projection/ConversationPublicProjectionPublisher.js';
import { AgentRunPublicProjectionPublisher, agentRunProjectionSourceId, projectAgentRunV3 } from '../../runtime/dist/projection/AgentRunPublicProjectionPublisher.js';
import { createAgentRunVersionReader } from '../../runtime/dist/composition/AgentControlRuntimeCompositionSupport.js';
import { ProtectedAgentRunInteractionMessageResolver } from '../../runtime/dist/composition/ProtectedAgentRunInteractionMessageResolver.js';
import { createShutdownContext } from '../../runtime/dist/ingress/ShutdownContext.js';

const file = fileURLToPath(import.meta.url), runId = 'oversized-core-run', sessionId = 'oversized-core-session', workspaceId = 'oversized-core-workspace';
const phases = ['before-commit', 'after-commit-before-ack', 'after-ack'];
const content = '【模拟超大权威输入】汉字'.repeat(8_000);
assert(content.length <= 100_000);
const at = index => new Date(Date.UTC(2030, 0, 1) + index * 1000).toISOString();
const noPayloadArtifacts = { turnInputPayloads: [], effectPayloads: [] };
function guard(root) {
  assert(phases.includes(basename(root)));
  assert(basename(dirname(root)).startsWith('AriadneCoreDocumentAck-'));
  assert.equal(realpathSync.native(dirname(dirname(root))), realpathSync.native(tmpdir()));
  assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
  assert(lstatSync(dirname(root)).isDirectory() && !lstatSync(dirname(root)).isSymbolicLink());
}
async function closeUnit(unit) {
  const context = createShutdownContext(Date.now() + 30_000);
  try { await unit.close(context); } finally { context.dispose(); }
}
function publisher(unit, sink, outbox = unit) {
  return new AgentRunPublicProjectionPublisher(outbox, createAgentRunVersionReader(unit), sink,
    { interactionResolver: new ProtectedAgentRunInteractionMessageResolver(unit) });
}
async function enqueueCommand(index) {
  return { kind: 'run.enqueue_inbox_input', commandId: `oversized-enqueue-${index}`, runId,
    expectedVersion: index + 1, occurredAt: at(index + 1), input: {
      inputId: `oversized-input-${index}`, messageId: `oversized-message-${index}`, delivery: 'next_turn',
      content, contentDigest: await sha256AgentControlData(content) } };
}
async function seed(root) {
  guard(root);
  const unit = new SqliteAgentRunUnitOfWork(root), conversation = new SqliteConversationRunHandoffUnitOfWork(root), projection = new SqlitePublicProjectionStore(root);
  try {
    await new ConversationAuthorityService(conversation).createSession({ kind: 'conversation.create_session',
      commandId: 'oversized-create-session', eventId: 'oversized-create-session-event', sessionId, workspaceId,
      expectedVersion: null, title: '【模拟】超大 Core Run 强杀验收', occurredAt: at(0) });
    assert.equal((await new ConversationPublicProjectionPublisher(conversation, projection).publishPending()).projectedRecords, 1);
    const service = new AgentRunCommandService(unit);
    await service.execute({ kind: 'run.start', commandId: 'oversized-start', runId, occurredAt: at(0), binding: {
      bindingVersion: 3, sessionId,
      objectiveRef: { kind: 'conversation_message', messageId: 'oversized-objective', messageVersion: 1, contentDigest: `sha256:${'a'.repeat(64)}` },
      workspace: { workspaceId, revision: 1, grantDigest: `sha256:${'b'.repeat(64)}`, access: 'write', scopeIds: ['workspace'] },
      model: { providerId: 'oversized-fixture-provider', modelId: 'oversized-fixture-model', settingsRevision: 1 },
      policy: { policyId: 'oversized-fixture-policy', revision: 1, permissionMode: 'ask' }, capabilities: [],
      toolCatalog: { catalogId: 'oversized-fixture-catalog', revision: 1, digest: `sha256:${'e'.repeat(64)}`, allowedToolNames: [] },
      budget: { grantId: 'oversized-fixture-grant', runId, vector: { modelTurns: 12, toolCalls: 8, readCalls: 0,
        writeCalls: 0, shellCalls: 0, costMicrousd: 1_000_000 }, deadlineAt: '2031-01-01T00:00:00.000Z', source: { kind: 'root' } }
    } }, { turnInputPayloads: [], effectPayloads: [] });
    for (let index = 0; index < 5; index++) await service.execute(await enqueueCommand(index), noPayloadArtifacts);
    const run = await unit.loadRunVersion(runId, 6); assert(run); assert.equal(run.inbox.length, 5);
    const dto = projectAgentRunV3(run), serializedDtoBytes = Buffer.byteLength(canonicalPublicProjectionJson(dto));
    assert(serializedDtoBytes > 1024 * 1024);
    assert.throws(() => assertPublicProjectionCommit({ contractVersion: '5.0', eventId: 'oversized-old-commit',
      sourceId: 'oversized-old-source', sourceCursor: 1, occurredAt: run.updatedAt, changes: [{ feature: 'runs',
        operation: 'upsert', aggregateId: runId, aggregateVersion: 6, projectedAt: run.updatedAt, dto }] }));
    return { serializedDtoBytes, inboxItems: 5, perItemUtf16Length: content.length, noProviderExecution: true };
  } finally { await projection.close(); await closeUnit(conversation); await closeUnit(unit); }
}
function counts(root) {
  const authority = new DatabaseSync(resolveAgentControlDatabasePath(root), { readOnly: true });
  const projection = new DatabaseSync(resolvePublicProjectionDatabasePath(root), { readOnly: true });
  try {
    return { authority: { ...authority.prepare(`SELECT
      (SELECT version FROM agent_runs WHERE run_id=?) AS runVersion,
      (SELECT COUNT(*) FROM agent_commands) AS commands,
      (SELECT COUNT(*) FROM agent_outbox WHERE published_at IS NOT NULL) AS acknowledged,
      (SELECT COUNT(*) FROM agent_outbox WHERE published_at IS NULL) AS pending`).get(runId) },
    projection: { ...projection.prepare(`SELECT
      (SELECT MAX(cursor) FROM projection_commits) AS globalCursor,
      (SELECT COUNT(*) FROM projection_commits WHERE source_id=?) AS runCommits,
      (SELECT aggregate_version FROM projection_heads WHERE feature='runs' AND aggregate_id=?) AS headVersion,
      (SELECT COUNT(*) FROM projection_run_documents WHERE published_cursor IS NOT NULL) AS publishedDocuments,
      (SELECT source_cursor FROM projection_source_checkpoints WHERE source_id=?) AS sourceCursor`).get(agentRunProjectionSourceId(runId), runId, agentRunProjectionSourceId(runId)) } };
  } finally { projection.close(); authority.close(); }
}
async function worker(phase, root) {
  guard(root); assert.equal(basename(root), phase); let currentVersion = 0;
  const stop = () => {
    assert(process.send); process.send({ checkpoint: phase, pid: process.pid });
    const cell = new Int32Array(new SharedArrayBuffer(4)); for (;;) Atomics.wait(cell, 0, 0);
  };
  const unit = new SqliteAgentRunUnitOfWork(root), projection = new SqlitePublicProjectionStore(root, undefined, {
    beforeCommit: () => { if (phase === 'before-commit' && currentVersion === 6) stop(); },
    afterCommit: () => { if (phase === 'after-commit-before-ack' && currentVersion === 6) stop(); }
  });
  try {
    const outbox = { claimPending: request => unit.claimPending(request), markPublished: async request => {
      await unit.markPublished(request); if (phase === 'after-ack' && currentVersion === 6) stop();
    } };
    await publisher(unit, { appendRunDocument: (commit, plan) => {
      currentVersion = commit.changes[0].aggregateVersion; return projection.appendRunDocument(commit, plan);
    } }, outbox).publishPending();
    throw new Error('core_ack_checkpoint_not_reached');
  } finally { await projection.close(); await closeUnit(unit); }
}
async function killAtCheckpoint(phase, root) {
  const child = fork(file, ['--worker', phase, root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  try {
    await new Promise((ready, reject) => {
      const timer = setTimeout(() => reject(new Error(`core_ack_checkpoint_timeout:${phase}:${stderr}`)), 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`core_ack_worker_exited:${code}:${signal}:${stderr}`)); });
      child.on('message', message => { if (message?.checkpoint !== phase || message.pid !== child.pid) return;
        clearTimeout(timer); ready(); });
    });
    assert(child.kill('SIGKILL')); return { actualProcessKill: true, pid: child.pid, exit: await exited };
  } finally { if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGKILL'); }
}
async function begin(projection) {
  const manifest = await projection.beginCatalogSnapshot({ pageContractVersion: '3.0', feature: 'runs', filter: 'all',
    scope: { kind: 'session', sessionId, workspaceId } }); assert(!('status' in manifest));
  const request = { queryContractVersion: '1.0', manifest, runId }, root = await verifyRunDocumentRootResult(request, await projection.readRunDocument(request));
  assert.equal(root.status, 'ok'); return { manifest, root };
}
async function readBody(projection, range) {
  const assembler = new RunDocumentItemAssembler(range.root.header, 'inbox', 0); let maxChunkBytes = 0;
  for (let chunkOrdinal = 0; chunkOrdinal < 32; chunkOrdinal++) {
    const request = { queryContractVersion: '1.0', manifest: range.manifest, document: range.root.document, collection: 'inbox', itemOrdinal: 0, chunkOrdinal };
    const result = await verifyRunDocumentChunkResult(request, await projection.readRunDocumentChunk(request)); assert.equal(result.status, 'ok');
    maxChunkBytes = Math.max(maxChunkBytes, Buffer.byteLength(canonicalPublicProjectionJson(result)));
    assert(maxChunkBytes <= 512 * 1024);
    const item = await assembler.accept(result.leaf); if (item !== null) return { value: item.value, chunks: chunkOrdinal + 1, maxChunkBytes };
  }
  throw new Error('core_ack_body_incomplete');
}
async function recover(phase, root) {
  const recovered = counts(root), before = phase === 'before-commit', acked = phase === 'after-ack';
  assert.deepEqual(recovered.authority, { runVersion: 6, commands: 6, acknowledged: acked ? 12 : 10, pending: acked ? 0 : 2 });
  assert.deepEqual(recovered.projection, { globalCursor: before ? 6 : 7, runCommits: before ? 5 : 6,
    headVersion: before ? 5 : 6, publishedDocuments: before ? 5 : 6, sourceCursor: before ? 5 : 6 });
  const unit = new SqliteAgentRunUnitOfWork(root), projection = new SqlitePublicProjectionStore(root);
  try {
    const active = publisher(unit, projection), retried = await active.publishPending();
    assert.equal(retried.acknowledgedMessages, acked ? 0 : 2);
    assert.deepEqual(counts(root).authority, { runVersion: 6, commands: 6, acknowledged: 12, pending: 0 });
    assert.equal(counts(root).projection.globalCursor, 7); assert.equal(counts(root).projection.runCommits, 6);
    const receipt = await unit.loadCommittedCommandReceipt('oversized-enqueue-4'); assert(receipt);
    await new AgentRunCommandService(unit).execute(await enqueueCommand(4), noPayloadArtifacts);
    assert.deepEqual(await unit.loadCommittedCommandReceipt('oversized-enqueue-4'), receipt);
    assert.equal(counts(root).authority.commands, 6); assert.equal(counts(root).authority.pending, 0);
    const original = await begin(projection); assert.equal(original.root.header.summary.version, 6);
    const oldBody = await readBody(projection, original); assert.equal(oldBody.value.content, content); assert(oldBody.chunks > 1);
    const replacement = '【模拟后续修订】更新'.repeat(6_000);
    await new AgentRunCommandService(unit).execute({ kind: 'run.replace_inbox_input', commandId: 'oversized-replace', runId,
      expectedVersion: 6, inputId: 'oversized-input-0', expectedInputVersion: 1, content: replacement,
      contentDigest: await sha256AgentControlData(replacement), occurredAt: at(7) }, noPayloadArtifacts);
    assert.equal((await active.publishPending()).acknowledgedMessages, 2);
    const current = await begin(projection); assert.equal(current.root.header.summary.version, 7);
    assert.equal((await readBody(projection, original)).value.content, content);
    assert.equal((await readBody(projection, current)).value.content, replacement);
    assert.equal(counts(root).projection.globalCursor, 8);
    return { phase, recovered, retry: retried, final: counts(root), sameCommandReceipt: true,
      oldCBoundary: original.manifest.boundaryCursor, newCBoundary: current.manifest.boundaryCursor,
      oldBodyRestoredAfterNextVersion: true, chunks: oldBody.chunks, maximumChunkResponseBytes: oldBody.maxChunkBytes };
  } finally { await projection.close(); await closeUnit(unit); }
}
if (process.argv[2] === '--worker') await worker(process.argv[3], process.argv[4]);
else {
  const reportName = process.argv[2] ?? 't02-run-document-core-ack.json'; assert(/^[a-z0-9][a-z0-9_-]*\.json$/u.test(reportName));
  const taskRoot = mkdtempSync(join(tmpdir(), 'AriadneCoreDocumentAck-')), results = []; let fixture;
  for (const phase of phases) {
    const root = join(taskRoot, phase); mkdirSync(root); fixture = await seed(root);
    const killed = await killAtCheckpoint(phase, root); results.push({ ...killed, ...await recover(phase, root) });
  }
  const report = { format: 'ariadne-run-document-core-ack.v1', passed: true, taskRoot, fixture, results,
    scope: 'Actual durable Core commands, SQLite authority/receipts/outbox and production document Publisher/owner; actual Node process hard kills.',
    runtimeIngress: false, electron: false, provider: false, codec: 'StrictJson fixture only; no user credentials or production keyring acceptance.' };
  const output = resolve(dirname(file), '../../artifacts/todo-remediation');
  writeFileSync(join(output, reportName), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
