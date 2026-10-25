import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { SqliteConversationRunHandoffUnitOfWork } from '../../runtime/dist/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { SqlitePublicProjectionStore } from '../../runtime/dist/adapters/persistence/SqlitePublicProjectionStore.js';
import { resolvePublicProjectionDatabasePath } from '../../runtime/dist/adapters/persistence/PublicProjectionDbSchema.js';
import { ConversationPublicProjectionPublisher } from '../../runtime/dist/projection/ConversationPublicProjectionPublisher.js';
import { createShutdownContext } from '../../runtime/dist/ingress/ShutdownContext.js';

const [manifestPath, reportPath] = process.argv.slice(2);
assert(manifestPath && reportPath, 'Fixture manifest and fresh report path required.');
const fixture = JSON.parse(readFileSync(resolve(manifestPath), 'utf8').replace(/^\uFEFF/u, ''));
assert(fixture.format === 'ariadne-projection-electron-capacity.v1' && fixture.messageCount === 10000
  && fixture.sessionCount === 150 && fixture.pendingHandoffCount === 0);
const root = realpathSync.native(fixture.root);
assert(dirname(root).toLowerCase() === realpathSync.native(tmpdir()).toLowerCase()
  && basename(root).startsWith('AriadneCapacity-'), 'Only named isolated capacity data is permitted.');
const dataRoot = join(root, 'runtime');
let conversation, projection, inspection;
try {
  const started = performance.now();
  conversation = new SqliteConversationRunHandoffUnitOfWork(dataRoot);
  const conversationOpenMs = performance.now() - started;
  const projectionStarted = performance.now();
  projection = new SqlitePublicProjectionStore(dataRoot);
  const projectionOpenMs = performance.now() - projectionStarted;
  inspection = new DatabaseSync(resolvePublicProjectionDatabasePath(dataRoot), { readOnly: true });
  const head = () => inspection.prepare('SELECT count(*) AS count, max(cursor) AS cursor FROM projection_commits').get();
  const before = head(), publisher = new ConversationPublicProjectionPublisher(conversation, projection);
  const replayStarted = performance.now();
  let records = 0, batches = 0, cursor = 0;
  for (;;) {
    const result = await publisher.publishPending();
    records += result.readRecords; batches++; cursor = result.afterCursor;
    if (result.readRecords === 0) break;
  }
  const replayMs = performance.now() - replayStarted, after = head();
  assert.deepEqual(after, before, 'An exact replay must preserve all Commit positions.');
  assert(records > 10000 && records < 20000 && cursor >= records);
  const report = { format: 'ariadne-conversation-projection-replay.v1', root, records, batches, cursor,
    conversationOpenMs, projectionOpenMs, replayMs, totalMs: performance.now() - started,
    commitsBefore: before, commitsAfter: after, memory: process.memoryUsage(),
    notes: ['Existing isolated fixture; OS cache state uncontrolled.', 'Full startup audit and authority replay retained.',
      'Node owner benchmark, not Runtime/Main/Renderer/Provider or cold-start acceptance.', 'Memory point is not a continuous peak.'] };
  writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ records, batches, conversationOpenMs, projectionOpenMs, replayMs, totalMs: report.totalMs }));
} finally {
  inspection?.close();
  await projection?.close();
  if (conversation) await conversation.close(createShutdownContext(Date.now() + 5000));
}
