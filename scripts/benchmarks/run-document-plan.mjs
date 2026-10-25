import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { canonicalPublicProjectionJson, RunDocumentItemAssembler, MAX_RUN_DOCUMENT_LEAF_BYTES,
  verifyRunDocumentHeader } from '@ariadne/protocol/public';
import { RunDocumentPlan } from '../../runtime/dist/projection/RunDocumentPlan.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'artifacts/todo-remediation');
const reportName = process.argv[2] ?? 't02-run-document-plan.json';
assert(/^[a-z0-9][a-z0-9_-]*\.json$/u.test(reportName), 'Report must be a basename.');
mkdirSync(output, { recursive: true });
const at = '2032-01-01T00:00:00.000Z';
const source = { summary: { runId: 'document-benchmark', sessionId: 'document-benchmark-session', version: 4,
  title: '模拟容量数据', status: 'running', label: '模拟容量数据', updatedAt: at,
  toolActivityCount: 0, queuedInputCount: 17, claimedInputCount: 0, interactionMessageCount: 1 },
  toolActivities: [], inbox: Array.from({ length: 17 }, (_, index) => ({ inputId: `input-${index}`,
    messageId: `message-${index}`, version: 1, delivery: 'next_turn', content: '汉字🙂'.repeat(20_000),
    state: 'queued', queuedAt: at, updatedAt: at })),
  interactionMessages: [{ messageId: 'large-message', sessionId: 'document-benchmark-session', runId: 'document-benchmark',
    version: 1, role: 'assistant', content: '长正文🙂'.repeat(200_000), status: 'completed', createdAt: at, updatedAt: at }] };
const serializedSourceBytes = Buffer.byteLength(canonicalPublicProjectionJson(source));
assert(serializedSourceBytes > 4 * 1024 * 1024);
const start = performance.now(); const plan = new RunDocumentPlan(source); const prepareMs = performance.now() - start;
await verifyRunDocumentHeader(plan.header);
let leafCount = 0, maximumLeafBytes = 0, maxHeapSample = 0, maxRssSample = 0, restoredItems = 0;
const readStart = performance.now();
for (const collection of ['inbox', 'interactionMessages']) for (let ordinal = 0; ordinal < source[collection].length; ordinal++) {
  const assembler = new RunDocumentItemAssembler(plan.header, collection, ordinal); let restored;
  for (const leaf of plan.itemLeaves(collection, ordinal)) {
    leafCount++; maximumLeafBytes = Math.max(maximumLeafBytes, Buffer.byteLength(canonicalPublicProjectionJson(leaf)));
    assert(maximumLeafBytes <= MAX_RUN_DOCUMENT_LEAF_BYTES);
    restored = await assembler.accept(leaf);
    const memory = process.memoryUsage(); maxHeapSample = Math.max(maxHeapSample, memory.heapUsed); maxRssSample = Math.max(maxRssSample, memory.rss);
  }
  assert.deepEqual(restored, { collection, value: source[collection][ordinal] }); restoredItems++;
}
const report = { format: 'ariadne-run-document-plan-benchmark.v1', acceptanceScope: 'node_read_model_only',
  fixture: '模拟容量数据; no authority write, model, SQLite, IPC or UI execution', serializedSourceBytes,
  headerBytes: Buffer.byteLength(canonicalPublicProjectionJson(plan.header)), collections: plan.header.collections,
  prepareMs, restoreAllItemsMs: performance.now() - readStart, leafCount, maximumLeafBytes, restoredItems,
  sampledHeapUsedBytes: maxHeapSample, sampledRssBytes: maxRssSample,
  productionDocumentPublication: false, notes: ['Samples are not continuous heap peaks.',
    'One explicitly requested item at a time; no complete reconstructed Run retained.'] };
writeFileSync(join(output, reportName), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
