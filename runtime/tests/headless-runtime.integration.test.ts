import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
} from "@ariadne/protocol/host";
import { parseHeadlessOutput, type HeadlessOutput } from "@ariadne/protocol/headless";
import { createDefaultRuntimePolicySnapshot } from "@ariadne/protocol/settings";
import { verifyPublicProjectionScopedReadBatch, PublicProjectionViewPageChain, PublicProjectionCatalogPageChain, verifyCatalogBatch } from '@ariadne/protocol/public';
import { verifyConversationReceipts, verifyConversationInferenceWindow, verifyPublicProjectionFeatureReceipts, verifyRunDocumentRootResult, verifyRunDocumentMetadataResult,
  verifyRunDocumentInboxResult, verifyRunDocumentChunkResult, verifyMessageMetadataWindow, verifyMessageBody,
  canonicalPublicProjectionJson, type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("headless NDJSON Runtime", () => {
  it('routes all nine document and conversation commands through the real query owner', async () => {
    const fixture = await createFixture(), at = '2032-01-01T00:00:00.000Z';
    const seeded = new SqlitePublicProjectionStore(fixture.dataRoot);
    try {
      await seeded.append({ contractVersion: '5.0', sourceId: 'query-fixture', sourceCursor: 1, eventId: 'query-fixture-1', occurredAt: at,
        changes: [
          { feature: 'sessions', aggregateId: 'query-session', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
            dto: { sessionId: 'query-session', workspaceId: 'test', version: 1, title: '模拟查询会话', status: 'active', pinned: false, createdAt: at, updatedAt: at } },
          { feature: 'runs', aggregateId: 'query-run', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
            dto: { runId: 'query-run', sessionId: 'query-session', version: 1, title: '模拟查询任务', label: '模拟查询任务', status: 'completed', updatedAt: at,
              toolActivities: [], inbox: [{ inputId: 'query-input', messageId: 'query-input-message', version: 1, delivery: 'next_turn',
                content: 'PRIVATE_INBOX_QUERY_FIXTURE', state: 'queued', queuedAt: at, updatedAt: at }],
              interactionMessages: [{ messageId: 'query-interaction', sessionId: 'query-session', version: 1, role: 'assistant',
                content: 'PRIVATE_INTERACTION_QUERY_FIXTURE', status: 'completed', createdAt: at, updatedAt: at }] } },
          { feature: 'messages', aggregateId: 'query-message', aggregateVersion: 1, operation: 'upsert', projectedAt: at,
            dto: { messageId: 'query-message', sessionId: 'query-session', version: 1, role: 'user', content: 'PRIVATE_MESSAGE_QUERY_FIXTURE',
              status: 'completed', createdAt: at, updatedAt: at } }
        ] });
    } finally { await seeded.close(); }
    const child = startHeadless(); child.send(hello(fixture, 0)); await child.waitFor('ready');
    let sequence = 0;
    const query = async (command: RuntimeCommand): Promise<RuntimeResult> => {
      const id = `document-query-${++sequence}`;
      child.send({ type: 'command', requestId: id, commandId: id, deadlineAt: new Date(Date.now() + 15_000).toISOString(), command });
      const response = await child.waitForResponse(id);
      if (response.type !== 'response' || !response.outcome.ok) throw new Error(`query_failed:${command.kind}:${canonicalPublicProjectionJson(response)}`);
      return response.outcome.result;
    };
    const begun = await query({ kind: 'projection.catalog.begin', request: { pageContractVersion: '3.0',
      scope: { kind: 'session', sessionId: 'query-session', workspaceId: 'test' }, feature: 'runs', filter: 'all' } });
    if (begun.kind !== 'projection.catalog.manifest' || 'status' in begun.manifest) throw new Error('manifest_required');
    const manifest = begun.manifest;
    const rootRequest = { queryContractVersion: '1.0', manifest, runId: 'query-run' };
    const rooted = await query({ kind: 'projection.run_document.root', request: rootRequest });
    if (rooted.kind !== 'projection.run_document.root_result') throw new Error('root_result_required');
    const root = await verifyRunDocumentRootResult(rootRequest, rooted.document);
    if (root.status !== 'ok') throw new Error('root_required');
    const scoped = { queryContractVersion: '1.0', manifest, document: root.document };
    const metadataRequest = { ...scoped, collection: 'interactionMessages' as const, limit: 128 };
    const metadata = await query({ kind: 'projection.run_document.metadata', request: metadataRequest });
    if (metadata.kind !== 'projection.run_document.metadata_result') throw new Error('metadata_required');
    expect(await verifyRunDocumentMetadataResult(metadataRequest, metadata.page)).toMatchObject({ status: 'ok', hasMore: false, rows: [
      { metadata: { collection: 'interactionMessages', value: { messageId: 'query-interaction', runId: 'query-run' } } } ] });
    expect(canonicalPublicProjectionJson(metadata)).not.toContain('PRIVATE_INTERACTION_QUERY_FIXTURE');
    const inboxRequest = { ...scoped, inputId: 'query-input' };
    const inbox = await query({ kind: 'projection.run_document.inbox', request: inboxRequest });
    if (inbox.kind !== 'projection.run_document.inbox_result') throw new Error('inbox_required');
    expect(await verifyRunDocumentInboxResult(inboxRequest, inbox.input)).toMatchObject({ status: 'ok', proof: { metadata: {
      collection: 'inbox', value: { inputId: 'query-input', state: 'queued', delivery: 'next_turn' } } } });
    const chunkRequest = { ...scoped, collection: 'interactionMessages' as const, itemOrdinal: 0, chunkOrdinal: 0 };
    const chunk = await query({ kind: 'projection.run_document.chunk', request: chunkRequest });
    if (chunk.kind !== 'projection.run_document.chunk_result') throw new Error('chunk_required');
    const checkedChunk = await verifyRunDocumentChunkResult(chunkRequest, chunk.chunk);
    if (checkedChunk.status !== 'ok') throw new Error('chunk_ok_required');
    expect(Buffer.from(checkedChunk.leaf.contentBase64, 'base64').toString('utf8')).toContain('PRIVATE_INTERACTION_QUERY_FIXTURE');
    const windowRequest = { queryContractVersion: '1.0', manifest, window: { kind: 'latest' as const, limit: 128 } };
    const window = await query({ kind: 'projection.messages.metadata', request: windowRequest });
    if (window.kind !== 'projection.messages.metadata_result') throw new Error('window_required');
    const checkedWindow = await verifyMessageMetadataWindow(windowRequest, window.window);
    if (checkedWindow.status !== 'ok') throw new Error('window_ok_required');
    expect(checkedWindow.rows).toHaveLength(2);
    const message = checkedWindow.rows.find(row => row.kind === 'message');
    if (message?.kind !== 'message') throw new Error('standalone_message_required');
    const bodyRequest = { queryContractVersion: '1.0', manifest, body: message.body };
    const body = await query({ kind: 'projection.messages.body', request: bodyRequest });
    if (body.kind !== 'projection.messages.body_result') throw new Error('body_required');
    expect(await verifyMessageBody(bodyRequest, body.body)).toMatchObject({ status: 'ok', message: { content: 'PRIVATE_MESSAGE_QUERY_FIXTURE' } });
    const view = await query({ kind: 'projection.view.begin', request: { pageContractVersion: '2.0', scope: { kind: 'directory' }, features: ['models'] } });
    if (view.kind !== 'projection.view.manifest' || 'status' in view.manifest) throw new Error('view_required');
    const receiptRequest = { queryVersion: '1.0' as const, manifest: view.manifest, afterCursor: view.manifest.boundaryCursor,
      afterDigest: view.manifest.boundaryDigest, limit: 128 };
    const receipts = await query({ kind: 'projection.features.receipts', request: receiptRequest });
    if (receipts.kind !== 'projection.features.receipts_result') throw new Error('receipts_required');
    expect((await verifyPublicProjectionFeatureReceipts(receiptRequest, receipts.batch)).status).toBe('ok');
    const conversationRequest = { queryVersion: '1.0' as const, manifest, afterCursor: manifest.boundaryCursor,
      afterDigest: manifest.boundaryDigest, limit: 128 };
    const conversation = await query({ kind: 'projection.conversation.receipts', request: conversationRequest });
    if (conversation.kind !== 'projection.conversation.receipts_result') throw new Error('conversation_receipts_required');
    expect(await verifyConversationReceipts(conversationRequest, conversation.batch)).toMatchObject({ status: 'ok', entries: [] });
    const inferenceRequest = { queryVersion: '1.0' as const, manifest,
      window: { feature: 'inference_streams' as const, filter: 'all' as const, limit: 128 } };
    const inference = await query({ kind: 'projection.conversation.inference_window', request: inferenceRequest });
    if (inference.kind !== 'projection.conversation.inference_window_result') throw new Error('conversation_inference_required');
    expect(await verifyConversationInferenceWindow(inferenceRequest, inference.window)).toMatchObject({ status: 'ok', manifest, changes: [] });
    child.send({ type: 'shutdown', requestId: 'document-shutdown' }); await child.waitForResponse('document-shutdown');
    expect(await child.exit()).toBe(0);
  }, 30_000);
  it("uses hello/command/shutdown with persistent event cursors and clean stdout", async () => {
    const fixture = await createFixture();
    const first = startHeadless();
    first.send(hello(fixture, 0));
    const ready = await first.waitFor("ready");
    expect(ready).toMatchObject({ protocolVersion: "3.0" });
    first.send({
      type: "command",
      requestId: "status-1",
      commandId: "headless-status-1",
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      command: { kind: "runtime.status.get" },
    });
    const response = await first.waitForResponse("status-1");
    expect(response).toMatchObject({
      requestId: "status-1",
      outcome: { ok: true, result: { kind: "runtime.status" } },
    });
    first.send({
      type: "command",
      requestId: "status-1-replay",
      commandId: "headless-status-1",
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      command: { kind: "runtime.status.get" },
    });
    const replay = await first.waitForResponse("status-1-replay");
    expect(replay.type === "response" && response.type === "response"
      ? replay.outcome
      : undefined).toEqual(response.type === "response" ? response.outcome : undefined);
    first.send({ type: 'command', requestId: 'snapshot-begin', commandId: 'headless-snapshot-begin',
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      command: { kind: 'projection.snapshot.begin', request: { pageContractVersion: '1.0', scope: { kind: 'directory' } } } });
    const begun = await first.waitForResponse('snapshot-begin');
    if (begun.type !== 'response' || !begun.outcome.ok || begun.outcome.result.kind !== 'projection.snapshot.manifest'
      || 'status' in begun.outcome.result.manifest) throw new Error('headless_snapshot_manifest_missing');
    const manifest = begun.outcome.result.manifest;
    first.send({ type: 'command', requestId: 'snapshot-page', commandId: 'headless-snapshot-page',
      deadlineAt: new Date(Date.now() + 15_000).toISOString(), command: { kind: 'projection.snapshot.page', request: {
        pageContractVersion: '1.0', snapshotId: manifest.snapshotId, streamId: manifest.streamId,
        boundaryCursor: manifest.boundaryCursor, boundaryDigest: manifest.boundaryDigest,
        scope: manifest.scope, limit: 256
      } } });
    await expect(first.waitForResponse('snapshot-page')).resolves.toMatchObject({
      outcome: { ok: true, result: { kind: 'projection.snapshot.page_result',
        page: { status: 'ok', manifest, pageIndex: 0, hasMore: false } } }
    });
    const scopedRequest = { readContractVersion: '1.0', streamId: manifest.streamId,
      scope: manifest.scope, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit: 256 };
    first.send({ type: 'command', requestId: 'scope-read', commandId: 'headless-scope-read',
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      command: { kind: 'projection.scope.read', request: scopedRequest } });
    const scanned = await first.waitForResponse('scope-read');
    if (scanned.type !== 'response' || !scanned.outcome.ok || scanned.outcome.result.kind !== 'projection.scope.batch') {
      throw new Error('headless_scoped_read_missing');
    }
    await expect(verifyPublicProjectionScopedReadBatch(scopedRequest, scanned.outcome.result.batch))
      .resolves.toMatchObject({ status: 'ok', streamId: manifest.streamId, afterCursor: manifest.boundaryCursor });
    first.send({ type: 'command', requestId: 'view-begin', commandId: 'headless-view-begin',
      deadlineAt: new Date(Date.now() + 15_000).toISOString(), command: { kind: 'projection.view.begin',
        request: { pageContractVersion: '2.0', scope: { kind: 'directory' }, features: ['models'] } } });
    const selected = await first.waitForResponse('view-begin');
    if (selected.type !== 'response' || !selected.outcome.ok || selected.outcome.result.kind !== 'projection.view.manifest'
      || 'status' in selected.outcome.result.manifest) throw new Error('headless_view_manifest_missing');
    const view = selected.outcome.result.manifest;
    first.send({ type: 'command', requestId: 'view-page', commandId: 'headless-view-page',
      deadlineAt: new Date(Date.now() + 15_000).toISOString(), command: { kind: 'projection.view.page', request: {
        pageContractVersion: view.pageContractVersion, snapshotId: view.snapshotId, streamId: view.streamId,
        boundaryCursor: view.boundaryCursor, boundaryDigest: view.boundaryDigest, scope: view.scope,
        selectedFeatures: view.selectedFeatures, limit: 256
      } } });
    const viewPage = await first.waitForResponse('view-page');
    if (viewPage.type !== 'response' || !viewPage.outcome.ok || viewPage.outcome.result.kind !== 'projection.view.page_result') {
      throw new Error('headless_view_page_missing');
    }
    const validatedView = await new PublicProjectionViewPageChain(view).accept(viewPage.outcome.result.page);
    expect(validatedView.changes.every(change => change.feature === 'models')).toBe(true);
    first.send({ type: 'command', requestId: 'catalog-begin', commandId: 'headless-catalog-begin',
      deadlineAt: new Date(Date.now() + 15_000).toISOString(), command: { kind: 'projection.catalog.begin', request: {
        pageContractVersion: '3.0', scope: { kind: 'decisions' }, feature: 'decisions', filter: 'pending'
      } } });
    const catalogResponse = await first.waitForResponse('catalog-begin');
    if (catalogResponse.type !== 'response' || !catalogResponse.outcome.ok
      || catalogResponse.outcome.result.kind !== 'projection.catalog.manifest' || 'status' in catalogResponse.outcome.result.manifest) {
      throw new Error('headless_catalog_manifest_missing');
    }
    const catalog = catalogResponse.outcome.result.manifest;
    first.send({ type: 'command', requestId: 'catalog-page', commandId: 'headless-catalog-page',
      deadlineAt: new Date(Date.now() + 15_000).toISOString(), command: { kind: 'projection.catalog.page', request: { manifest: catalog, limit: 128 } } });
    const catalogPage = await first.waitForResponse('catalog-page');
    if (catalogPage.type !== 'response' || !catalogPage.outcome.ok || catalogPage.outcome.result.kind !== 'projection.catalog.page_result') {
      throw new Error('headless_catalog_page_missing');
    }
    expect((await new PublicProjectionCatalogPageChain(catalog).accept(catalogPage.outcome.result.page)).totalRows).toBe(0);
    const catalogRead = { manifest: catalog, afterCursor: catalog.boundaryCursor, afterDigest: catalog.boundaryDigest, limit: 128 };
    first.send({ type: 'command', requestId: 'catalog-read', commandId: 'headless-catalog-read',
      deadlineAt: new Date(Date.now() + 15_000).toISOString(), command: { kind: 'projection.catalog.read', request: catalogRead } });
    const catalogBatch = await first.waitForResponse('catalog-read');
    if (catalogBatch.type !== 'response' || !catalogBatch.outcome.ok || catalogBatch.outcome.result.kind !== 'projection.catalog.batch') {
      throw new Error('headless_catalog_batch_missing');
    }
    expect((await verifyCatalogBatch(catalogRead, catalogBatch.outcome.result.batch)).status).toBe('ok');
    first.send({
      type: "command",
      requestId: "expired-1",
      commandId: "headless-expired-1",
      // Keep this independent from host clock adjustments between test and child process.
      deadlineAt: "2000-01-01T00:00:00.000Z",
      command: { kind: "projection.snapshot.get", contractVersion: "5.0" },
    });
    await expect(first.waitForResponse("expired-1")).resolves.toMatchObject({
      outcome: {
        ok: false,
        error: { code: "deadline_exceeded", retryable: false },
      },
    });
    first.send({ type: "shutdown", requestId: "shutdown-1" });
    await first.waitForResponse("shutdown-1");
    expect(await first.exit()).toBe(0);

    const second = startHeadless();
    second.send(hello(fixture, 0));
    await second.waitFor("ready");
    second.send({
      type: "command",
      requestId: "snapshot-2",
      commandId: "headless-snapshot-2",
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      command: { kind: "projection.snapshot.get", contractVersion: "5.0" },
    });
    await expect(second.waitForResponse("snapshot-2")).resolves.toMatchObject({
      outcome: { ok: true, result: { kind: "projection.snapshot" } },
    });
    second.send({ type: "shutdown", requestId: "shutdown-2" });
    await second.waitForResponse("shutdown-2");
    expect(await second.exit()).toBe(0);
  }, 30_000);

  it("--once exits successfully after exactly one command", async () => {
    const fixture = await createFixture();
    const process = startHeadless(["--once"]);
    process.send(hello(fixture, 0));
    await process.waitFor("ready");
    process.send({
      type: "command",
      requestId: "once-status",
      commandId: "headless-once-status",
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      command: { kind: "runtime.status.get" },
    });
    await process.waitForResponse("once-status");
    expect(await process.exit()).toBe(0);
  }, 30_000);
});

async function createFixture(): Promise<{
  dataRoot: string;
  workspaceRoot: string;
  installRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-headless-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspace");
  await Promise.all([
    mkdir(dataRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);
  return {
    dataRoot,
    workspaceRoot,
    installRoot: path.resolve(process.cwd()),
  };
}

function hello(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  resumeCursor: number,
) {
  return {
    type: "hello",
    protocolVersion: "3.0",
    resumeCursor,
    bootstrap: {
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: randomUUID(),
      type: "bootstrap",
      appVersion: "test",
      runtimeVersion: "0.1.0",
      runtimeBuildFingerprint: "a".repeat(64),
      installRoot: fixture.installRoot,
      dataRoot: fixture.dataRoot,
      modelRoots: [path.join(fixture.dataRoot, "models")],
      modelProviders: [],
      modelSelection: { modelId: '', localFallbackModelId: '' },
      agentPermissions: {
        approvalPolicy: "request",
        proposalApproval: "manual",
        permissionPolicy: "confirmBeforeRun",
        sandboxMode: "workspace-write",
        allowedPermissions: ["read", "write", "shell", "network", "dangerous"],
      },
      agentAdmissionAuthoritySource: {
        sourceVersion: 1,
        status: "disabled",
        reason: "not_configured",
      },
      runtimePolicy: createDefaultRuntimePolicySnapshot(),
      profile: "local-only",
      workspaces: [{
        workspaceId: "test",
        label: "Test",
        rootPath: fixture.workspaceRoot,
        access: "write",
      }],
      production: false,
    },
  };
}

function startHeadless(args: string[] = []) {
  const child = spawn(
    process.execPath,
    [path.resolve(process.cwd(), "dist", "entry", "headless.js"), ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  const outputs: HeadlessOutput[] = [];
  let diagnostics = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    diagnostics += chunk.toString();
  });
  const waiters: Array<() => void> = [];
  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdout.on("line", (line) => {
    outputs.push(parseHeadlessOutput(JSON.parse(line)));
    for (const resolve of waiters.splice(0)) resolve();
  });
  const waitFor = async (type: HeadlessOutput["type"]): Promise<HeadlessOutput> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const index = outputs.findIndex((output) => output.type === type);
      if (index >= 0) return outputs.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw new Error(
      `headless output timeout:${type}:outputs=${JSON.stringify(outputs)}:stderr=${diagnostics.slice(-2_000)}`,
    );
  };
  return {
    send(value: unknown) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    waitFor,
    async waitForResponse(requestId: string) {
      while (true) {
        const output = await waitFor("response");
        if (output.type === "response" && output.requestId === requestId) return output;
      }
    },
    async exit(): Promise<number | null> {
      if (child.exitCode === null) await once(child, "exit");
      return child.exitCode;
    },
  };
}
