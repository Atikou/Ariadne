import { auditStoredProjectionState as auditDocumentMigration } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { assertPublicRunDocumentCommit, canonicalPublicProjectionJson, runtimeCommandSchema, runtimeResultSchema,
  type RuntimeResult } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { upgradeRunDocumentSchema } from '../../runtime/src/adapters/persistence/RunDocumentDbSchema.js';
import { SqliteRunDocumentPublication } from '../../runtime/src/adapters/persistence/SqliteRunDocumentPublication.js';
import { RunDocumentPlan } from '../../runtime/src/projection/RunDocumentPlan.js';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries.js';
import { ProjectionRuntimeClient, ProjectionProtocolIntegrityError } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client.js';
const at = '2032-01-01T00:00:00.000Z', resources: { root: string; store: SqlitePublicProjectionStore }[] = [];
afterEach(async () => { for (const { root, store } of resources.splice(0)) { await store.close(); rmSync(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-document-client-')), store = new SqlitePublicProjectionStore(root);
  resources.push({ root, store });
  await store.append({ contractVersion: '5.0', sourceId: 'fixture', sourceCursor: 1, eventId: 'fixture-1', occurredAt: at, changes: [
    { feature: 'sessions', aggregateId: 'session-a', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
      dto: { sessionId: 'session-a', workspaceId: 'workspace-a', version: 1, title: '模拟会话', status: 'active', pinned: false, createdAt: at, updatedAt: at } },
    { feature: 'messages', aggregateId: 'message-a', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
      dto: { messageId: 'message-a', sessionId: 'session-a', version: 1, role: 'user', content: 'PRIVATE_STANDALONE_FIXTURE', status: 'completed', createdAt: at, updatedAt: at } }
  ] });
  const database = (store as unknown as { database: DatabaseSync }).database; upgradeRunDocumentSchema(database, auditDocumentMigration);
  const plan = new RunDocumentPlan({ summary: { runId: 'run-a', sessionId: 'session-a', version: 1, title: '模拟文档', label: '模拟文档', status: 'running',
    updatedAt: at, toolActivityCount: 0, queuedInputCount: 1, claimedInputCount: 0, interactionMessageCount: 1 }, toolActivities: [],
    inbox: [{ inputId: 'input-a', messageId: 'input-message-a', version: 1, content: 'PRIVATE_INBOX_FIXTURE', delivery: 'next_turn', state: 'queued', queuedAt: at, updatedAt: at }],
    interactionMessages: [{ messageId: 'interaction-a', sessionId: 'session-a', runId: 'run-a', version: 1, role: 'assistant',
      content: 'PRIVATE_INTERACTION_FIXTURE🙂'.repeat(30_000), status: 'completed', createdAt: at, updatedAt: at }] });
  await new SqliteRunDocumentPublication(database, store.streamId, appendDocumentLedger).publish(assertPublicRunDocumentCommit({ contractVersion: '6.0', sourceId: 'document-fixture',
    sourceCursor: 1, eventId: 'document-fixture-1', occurredAt: at, changes: [{ feature: 'runs', aggregateId: 'run-a', aggregateVersion: 1,
      operation: 'upsert', projectedAt: at, dto: plan.header }] }), plan);
  const commands: string[] = []; let corrupt = false;
  const client = new ProjectionRuntimeClient({ request: async command => {
    commands.push(command.kind);
    let result = await readAgentProjectionQuery(store, runtimeCommandSchema.parse(command));
    if (corrupt) result = corrupted(result);
    return { ok: true, value: runtimeResultSchema.parse(result) };
  }, getStatus: async () => { throw new Error('unused_status'); }, onEvent: () => () => undefined, onStatus: () => () => undefined });
  const manifest = await client.beginCatalog({ scope: { kind: 'session', workspaceId: 'workspace-a', sessionId: 'session-a' }, feature: 'runs', filter: 'all' });
  const rootRequest = { queryContractVersion: '1.0', manifest, runId: 'run-a' }, document = await client.readRunDocument(rootRequest);
  if (document.status !== 'ok') throw new Error('document_required');
  const scoped = { queryContractVersion: '1.0', manifest, document: document.document };
  const windowRequest = { queryContractVersion: '1.0', manifest, window: { kind: 'latest' as const, limit: 128 } };
  const window = await client.readMessageMetadataWindow(windowRequest);
  if (window.status !== 'ok') throw new Error('window_required');
  const message = window.rows.find(row => row.kind === 'message'); if (message?.kind !== 'message') throw new Error('message_required');
  const view = await client.beginViewSnapshot({ kind: 'directory' }, ['diagnostics']);
  return { client, commands, document, window, rootRequest, windowRequest, scoped,
    bodyRequest: { queryContractVersion: '1.0', manifest, body: message.body },
    metadataRequest: { ...scoped, collection: 'interactionMessages' as const, limit: 128 },
    inboxRequest: { ...scoped, inputId: 'input-a' },
    chunkRequest: { ...scoped, collection: 'interactionMessages' as const, itemOrdinal: 0, chunkOrdinal: 0 },
    receiptRequest: { queryVersion: '1.0' as const, manifest: view, afterCursor: view.boundaryCursor, afterDigest: view.boundaryDigest, limit: 128 },
    conversationReceiptRequest: { queryVersion: '1.0' as const, manifest, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit: 128 },
    inferenceRequest: { queryVersion: '1.0' as const, manifest, window: { feature: 'inference_streams' as const, filter: 'all' as const, limit: 128 } },
    corrupt: () => { corrupt = true; } };
}
function corrupted(result: RuntimeResult): RuntimeResult {
  const bad = `sha256:${'0'.repeat(64)}`;
  switch (result.kind) {
    case 'projection.run_document.root_result': return result.document.status === 'ok' ? { ...result, document: { ...result.document, rootDigest: bad } } : result;
    case 'projection.run_document.metadata_result': return result.page.status === 'ok' ? { ...result, page: { ...result.page, pageDigest: bad } } : result;
    case 'projection.run_document.inbox_result': return result.input.status === 'ok' ? { ...result, input: { ...result.input, resultDigest: bad } } : result;
    case 'projection.run_document.chunk_result': return result.chunk.status === 'ok' ? { ...result, chunk: { ...result.chunk, resultDigest: bad } } : result;
    case 'projection.messages.metadata_result': return result.window.status === 'ok' ? { ...result, window: { ...result.window, windowDigest: bad } } : result;
    case 'projection.messages.body_result': return result.body.status === 'ok' ? { ...result, body: { ...result.body, bodyDigest: bad } } : result;
    case 'projection.features.receipts_result': return result.batch.status === 'ok' ? { ...result, batch: { ...result.batch, batchDigest: bad } } : result;
    case 'projection.conversation.receipts_result': return result.batch.status === 'ok' ? { ...result, batch: { ...result.batch, batchDigest: bad } } : result;
    case 'projection.conversation.inference_window_result': return result.window.status === 'ok' ? { ...result, window: { ...result.window, windowDigest: bad } } : result;
    default: return result;
  }
}
it('uses public command/result schemas, the actual SQLite query owner and client verification for all nine queries', async () => {
  const f = await fixture();
  expect(f.window.rows).toHaveLength(2); expect(canonicalPublicProjectionJson(f.window)).not.toMatch(/PRIVATE_/u);
  expect(await f.client.readRunDocumentMetadata(f.metadataRequest)).toMatchObject({ status: 'ok', hasMore: false });
  expect(await f.client.readRunDocumentInbox(f.inboxRequest)).toMatchObject({ status: 'ok', proof: { metadata: { collection: 'inbox', value: { state: 'queued' } } } });
  expect(await f.client.readRunDocumentChunk(f.chunkRequest)).toMatchObject({ status: 'ok', leaf: { descriptor: { chunkOrdinal: 0, chunkCount: 4 } } });
  expect(await f.client.readMessageBody(f.bodyRequest)).toMatchObject({ status: 'ok', message: { content: 'PRIVATE_STANDALONE_FIXTURE' } });
  expect(await f.client.readFeatureReceipts(f.receiptRequest)).toMatchObject({ status: 'ok', entries: [] });
  expect(await f.client.readConversationReceipts(f.conversationReceiptRequest)).toMatchObject({ status: 'ok', entries: [] });
  expect(await f.client.readConversationInferenceWindow(f.inferenceRequest)).toMatchObject({ status: 'ok', manifest: f.window.manifest, changes: [] });
  expect(f.commands).toContain('projection.run_document.root'); expect(f.commands).toContain('projection.messages.metadata');
  expect(f.commands).not.toContain('projection.snapshot.get');
});
it('rejects changed envelopes in every new client method before returning verified data to consumers', async () => {
  const f = await fixture(); f.corrupt();
  for (const operation of [
    () => f.client.readRunDocument(f.rootRequest), () => f.client.readRunDocumentMetadata(f.metadataRequest),
    () => f.client.readRunDocumentInbox(f.inboxRequest), () => f.client.readRunDocumentChunk(f.chunkRequest),
    () => f.client.readMessageMetadataWindow(f.windowRequest), () => f.client.readMessageBody(f.bodyRequest),
    () => f.client.readFeatureReceipts(f.receiptRequest), () => f.client.readConversationReceipts(f.conversationReceiptRequest),
    () => f.client.readConversationInferenceWindow(f.inferenceRequest)
  ]) await expect(operation()).rejects.toBeInstanceOf(ProjectionProtocolIntegrityError);
});
