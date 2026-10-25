import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { SqliteConversationRunHandoffUnitOfWork } from '../../runtime/dist/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ConversationAuthorityService } from '../../runtime/dist/control/conversation/ConversationAuthorityService.js';
import { ConversationRunHandoffSagaService } from '../../runtime/dist/control/conversation/ConversationRunHandoffSagaService.js';
import { ConversationAgentStartFailureProjectionService } from '../../runtime/dist/control/conversation/ConversationAgentStartFailureProjectionService.js';
import { ConversationPublicProjectionPublisher, projectConversationAuthorityRecordV3 } from '../../runtime/dist/projection/ConversationPublicProjectionPublisher.js';
import { SqlitePublicProjectionStore } from '../../runtime/dist/adapters/persistence/SqlitePublicProjectionStore.js';
import { createShutdownContext } from '../../runtime/dist/ingress/ShutdownContext.js';

const [rootInput, workspaceId, outputInput] = process.argv.slice(2);
if (!rootInput || !workspaceId || !outputInput) throw new Error('usage: projection-electron-fixture <fresh-temp-root> <workspace-id> <output>');
const root = path.resolve(rootInput), output = path.resolve(outputInput), temporary = path.resolve(tmpdir());
const relative = path.relative(temporary, root);
assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(root).startsWith('AriadneCapacity-'), 'Fixture root must be a fresh named TEMP directory.');
assert(!existsSync(path.join(root, 'runtime')), 'Fixture refuses to alter an existing Runtime data root.');
mkdirSync(root, { recursive: true }); mkdirSync(output, { recursive: true });
assert(readdirSync(root).every(name => name === 'workspace'), 'Fixture root contains unrelated data.');
const runtimeRoot = path.join(root, 'runtime'), unit = new SqliteConversationRunHandoffUnitOfWork(runtimeRoot);
const projection = new SqlitePublicProjectionStore(runtimeRoot), authority = new ConversationAuthorityService(unit);
const handoff = new ConversationRunHandoffSagaService(unit), failure = new ConversationAgentStartFailureProjectionService(unit);
const publisher = new ConversationPublicProjectionPublisher(unit, projection, { readLimit: 1000 });
const started = performance.now(); let serializedBytes = 0, pairIndex = 0;
const sessionId = index => `capacity-session-${String(index).padStart(3, '0')}`;
const at = (eventIndex, sessionIndex) => new Date(Date.UTC(2000, 0, 1) + (150 - sessionIndex) * 1000 + eventIndex).toISOString();
const publish = async () => { let result; do { result = await publisher.publishPending(); } while (result.readRecords === 1000); };
try {
  for (let index = 0; index < 150; index++) {
    const id = sessionId(index);
    await authority.createSession({ kind: 'conversation.create_session', commandId: `capacity-create-${index}`,
      eventId: `capacity-create-event-${index}`, sessionId: id, workspaceId, expectedVersion: null,
      title: `【模拟容量数据】Session ${String(index).padStart(3, '0')}`, occurredAt: at(0, index) });
    if (index >= 50) for (let pair = 0; pair < 50; pair++) {
      const identity = `${index}-${String(pair).padStart(2, '0')}`, sagaId = `capacity-saga-${identity}`;
      const body = `【模拟容量数据，无模型执行】 ${pair === 0 ? `CAPACITY_ANCHOR_${index}` : ''} ` + 'Capacity fixture text. '.repeat(340);
      const accepted = await authority.acceptUserMessage({ kind: 'conversation.accept_user_message', commandId: `capacity-accept-${identity}`,
        eventId: `capacity-user-event-${identity}`, sessionId: id, workspaceId, occurredAt: at(pair * 2 + 1, index),
        expectedSessionVersion: pair * 2 + 1, messageId: `capacity-user-${identity}`, expectedMessageVersion: null,
        content: body, sagaId, handoffCommandId: `capacity-handoff-accept-${identity}`,
        handoffOutboxMessageId: `capacity-accepted-outbox-${identity}` });
      const runRequestId = `capacity-request-${identity}`, agentCommandId = `capacity-agent-command-${identity}`;
      await handoff.execute({ kind: 'handoff.request_agent_run', sagaId, commandId: `capacity-handoff-request-${identity}`,
        expectedVersion: 1, inboxEventId: `capacity-request-inbox-${identity}`, outboxMessageId: `capacity-request-outbox-${identity}`,
        occurredAt: at(pair * 2 + 1, index), sessionId: id, workspaceId, messageId: accepted.messageVersion.messageId,
        messageVersion: 1, objectiveDigest: accepted.messageVersion.contentDigest, runRequestId, agentCommandId });
      await failure.project({ kind: 'conversation.project_agent_start_failure', commandId: `capacity-settle-${identity}`,
        eventId: `capacity-assistant-event-${identity}`, sessionId: id, workspaceId, messageId: `capacity-assistant-${identity}`,
        assistantContent: '【模拟容量数据，夹具 handoff 已结算】 ' + 'Capacity fixture text. '.repeat(340), sagaId, expectedSagaVersion: 2,
        handoffCommandId: `capacity-handoff-settle-${identity}`, handoffInboxEventId: `capacity-settle-inbox-${identity}`,
        handoffOutboxMessageId: `capacity-settle-outbox-${identity}`, objectiveMessageId: accepted.messageVersion.messageId,
        objectiveMessageVersion: 1, objectiveDigest: accepted.messageVersion.contentDigest, runRequestId, agentCommandId,
        failureCode: 'capacity_fixture_no_execution', occurredAt: at(pair * 2 + 2, index) });
      pairIndex++;
    }
    // Consume only the independent fixture's delivery records. Terminal Saga
    // facts and receipts remain intact; no Agent/provider effect is requested.
    for (let batch = 0; ; batch++) {
      const claimId = `capacity-fixture-sink-${index}-${batch}`;
      const claimed = await unit.claimPending({ claimId, limit: 100, leaseMs: 30000 });
      if (claimed.length === 0) break;
      await unit.acknowledgePublished({ claimId, messages: claimed.map(entry => ({ cursor: entry.cursor, messageId: entry.message.messageId })) });
    }
    await publish();
    if ((index + 1) % 25 === 0) console.log(`Capacity fixture: ${index + 1} Sessions, ${pairIndex * 2} Messages.`);
  }
  assert.equal(await unit.countPendingHandoffOutbox(), 0);
  const manifest = await projection.beginCatalogSnapshot({ pageContractVersion: '3.0', scope: { kind: 'directory' }, feature: 'sessions', filter: 'all' });
  assert(!('status' in manifest));
  const page = await projection.readCatalogPage({ manifest, limit: 128 }); assert.equal(page.status, 'ok'); assert.equal(page.totalRows, 150);
  let cursor = 0;
  for (;;) {
    const records = await unit.readProjectionRecords({ afterCursor: cursor, limit: 100 });
    if (records.length === 0) break;
    for (const record of records) {
      for (const change of projectConversationAuthorityRecordV3(record).changes) if (change.feature === 'messages') serializedBytes += Buffer.byteLength(JSON.stringify(change.dto));
      cursor = record.cursor;
    }
  }
  assert(serializedBytes > 64 * 1024 * 1024);
  const metadata = { format: 'ariadne-projection-electron-capacity.v1', root, workspaceId, sessionCount: 150,
    messageSessionCount: 100, messageCount: pairIndex * 2, serializedMessageBytes: serializedBytes,
    seedMs: performance.now() - started, pendingHandoffCount: 0, noModelExecution: true,
    marker: 'CAPACITY_ANCHOR_149', anchorSessionId: sessionId(149), anchorMessageId: 'capacity-user-149-00',
    completedAt: new Date().toISOString() };
  writeFileSync(path.join(output, 'fixture.json'), JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata));
} finally {
  await projection.close();
  const shutdown = createShutdownContext(Date.now() + 30000);
  try { await unit.close(shutdown); } finally { shutdown.dispose(); }
}
