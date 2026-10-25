import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { assertPublicProjectionCommit, assertPublicRunDocumentCommit, type ProjectionCommit, type PublicProjectionChange,
  type PublicRunDocumentHeader, type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import { writeSessionTextExport } from '../src/main/data-management/session-text-export';
import { SessionExportService } from '../src/main/data-management/session-export-service';

// Use the original emitted SQLite owner and RunDocumentPlan. No second query
// implementation or Main raw-database reader is used to make export pass.
interface Store {
  append(value: ProjectionCommit): Promise<unknown>; appendRunDocument(value: unknown, plan: unknown): Promise<unknown>;
  close(): Promise<void>;
  beginCatalogSnapshot(input: unknown): Promise<Extract<RuntimeResult, { kind: 'projection.catalog.manifest' }>['manifest']>;
  readMessageMetadataWindow(input: unknown): Promise<Extract<RuntimeResult, { kind: 'projection.messages.metadata_result' }>['window']>;
  readMessageBody(input: unknown): Promise<Extract<RuntimeResult, { kind: 'projection.messages.body_result' }>['body']>;
  readRunDocumentChunk(input: unknown): Promise<Extract<RuntimeResult, { kind: 'projection.run_document.chunk_result' }>['chunk']>;
}
const resources: { root: string; store: Store }[] = [], at = '2032-01-01T00:00:00.000Z';
const selection = { sessionId: 'session-a', workspaceId: 'workspace-a', scope: 'public-message-text' as const, format: 'jsonl' as const };
afterEach(async () => { for (const { root, store } of resources.splice(0)) {
  await store.close();
  if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('AriadneTextExport-') || await realpath(root) !== root)
    throw new Error('Unsafe fixture cleanup.');
  await rm(root, { recursive: true, force: true });
} });
function commit(cursor: number, changes: PublicProjectionChange[]): ProjectionCommit {
  return assertPublicProjectionCommit({ contractVersion: '5.0', sourceId: 'export-fixture', sourceCursor: cursor,
    eventId: 'export-fixture-' + cursor, occurredAt: at, changes });
}
function session(id = 'a'): PublicProjectionChange { return { feature: 'sessions', operation: 'upsert', aggregateId: 'session-' + id,
  aggregateVersion: 1, projectedAt: at, dto: { sessionId: 'session-' + id, workspaceId: 'workspace-a', version: 1,
    title: 'Synthetic export fixture', pinned: false, status: 'active', createdAt: at, updatedAt: at } }; }
function message(index: number, owner = 'a', version = 1): PublicProjectionChange {
  const id = 'message-' + index.toString().padStart(4, '0');
  return { feature: 'messages', operation: 'upsert', aggregateId: id, aggregateVersion: version, projectedAt: at,
    dto: { messageId: id, sessionId: 'session-' + owner, version, role: 'assistant', content: 'PUBLIC_TEXT_' + index + '_' + version,
      status: 'completed', createdAt: at, updatedAt: at } };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'AriadneTextExport-'))), dataRoot = join(root, 'runtime');
  await mkdir(dataRoot);
  const module = await import(pathToFileURL(resolve('..', 'runtime', 'dist', 'adapters', 'persistence', 'SqlitePublicProjectionStore.js')).href) as {
    SqlitePublicProjectionStore: new(root: string) => Store };
  const store = new module.SqlitePublicProjectionStore(dataRoot); resources.push({ root, store });
  await store.append(commit(1, [session(), session('b')]));
  const request = async (command: RuntimeCommand): Promise<RuntimeResult> => {
    switch (command.kind) {
      case 'projection.catalog.begin': return { kind: 'projection.catalog.manifest', manifest: await store.beginCatalogSnapshot(command.request) };
      case 'projection.messages.metadata': return { kind: 'projection.messages.metadata_result', window: await store.readMessageMetadataWindow(command.request) };
      case 'projection.messages.body': return { kind: 'projection.messages.body_result', body: await store.readMessageBody(command.request) };
      case 'projection.run_document.chunk': return { kind: 'projection.run_document.chunk_result', chunk: await store.readRunDocumentChunk(command.request) };
      default: throw new Error('Unexpected export authority request.');
    }
  };
  return { root, dataRoot, store, request };
}
it('streams multiple original SQLite pages at one C while later edits and a foreign Session remain outside the export', async () => {
  const f = await fixture(); await f.store.append(commit(2, Array.from({ length: 200 }, (_, i) => message(i))));
  await f.store.append(commit(3, Array.from({ length: 60 }, (_, i) => message(i + 200))));
  await f.store.append(commit(4, [message(999, 'b')]));
  const lines: string[] = []; let changed = false;
  const result = await writeSessionTextExport(selection, async command => {
    const value = await f.request(command);
    if (command.kind === 'projection.messages.metadata' && !changed) {
      changed = true; await f.store.append(commit(5, [message(0, 'a', 2), message(260)]));
    }
    return value;
  }, async line => { lines.push(line); });
  expect(result.messages).toBe(260); expect(result.bytes).toBe(Buffer.byteLength(lines.join('')));
  const rows = lines.map(line => JSON.parse(line));
  expect(rows[0].order).toBe('newest-first'); expect(rows.at(-1).complete).toBe(true);
  expect(rows.slice(1, -1).map(row => row.messageId)).toEqual(Array.from({ length: 260 }, (_, i) => 'message-' + (259 - i).toString().padStart(4, '0')));
  expect(rows.at(-2).content).toBe('PUBLIC_TEXT_0_1'); expect(lines.join('')).not.toContain('PUBLIC_TEXT_999');
});
it('assembles one original oversized Run interaction through verified chunks without exporting Tool bodies', async () => {
  const f = await fixture();
  const module = await import(pathToFileURL(resolve('..', 'runtime', 'dist', 'projection', 'RunDocumentPlan.js')).href) as {
    RunDocumentPlan: new(source: unknown) => { header: PublicRunDocumentHeader } };
  const plan = new module.RunDocumentPlan({ summary: { runId: 'run-export', sessionId: 'session-a', version: 1, title: 'Synthetic export',
    label: 'Synthetic export', status: 'running', updatedAt: at, toolActivityCount: 0, queuedInputCount: 0,
    claimedInputCount: 0, interactionMessageCount: 1 }, toolActivities: [], inbox: [], interactionMessages: [{
      messageId: 'run-interaction', sessionId: 'session-a', runId: 'run-export', version: 1, role: 'assistant',
      content: '界'.repeat(400_000), status: 'completed', createdAt: at, updatedAt: at }] });
  await f.store.appendRunDocument(assertPublicRunDocumentCommit({ contractVersion: '6.0', sourceId: 'run-export-source', sourceCursor: 1,
    eventId: 'run-export-event', occurredAt: at, changes: [{ feature: 'runs', aggregateId: 'run-export', aggregateVersion: 1,
      operation: 'upsert', projectedAt: at, dto: plan.header }] }), plan);
  let chunks = 0; const lines: string[] = [];
  const result = await writeSessionTextExport(selection, command => { if (command.kind === 'projection.run_document.chunk') chunks++; return f.request(command); },
    async line => { lines.push(line); });
  expect(chunks).toBeGreaterThan(1); expect(result.messages).toBe(1); expect(JSON.parse(lines[1]!).content).toBe('界'.repeat(400_000));
  expect(JSON.parse(lines[0]!).excludes).toContain('tool-details');
});
it('publishes a new file exclusively and removes only its owned stage on digest failure or destination conflict', async () => {
  const f = await fixture(); await f.store.append(commit(2, [message(0)]));
  const destination = join(f.root, 'export.jsonl'), service = new SessionExportService(f.request, [f.dataRoot]);
  await service.create(selection, destination); const published = await readFile(destination);
  await expect(service.create(selection, destination)).rejects.toMatchObject({ code: 'EEXIST' }); expect(await readFile(destination)).toEqual(published);
  const damaged = new SessionExportService(async command => {
    const response = await f.request(command);
    if (response.kind === 'projection.messages.body_result' && response.body.status === 'ok') response.body.message.content = 'forged';
    return response;
  }, [f.dataRoot]);
  await expect(damaged.create(selection, join(f.root, 'failed.jsonl'))).rejects.toThrow('message_body_payload_digest_mismatch');
  expect((await readdir(f.root)).some(name => name.startsWith('.ariadne-session-export-') || name === 'failed.jsonl')).toBe(false);
  await expect(service.create(selection, join(f.dataRoot, 'unsafe.jsonl'))).rejects.toThrow('session_export_destination_inside_source');
  await writeFile(join(f.root, 'sentinel'), 'unrelated'); expect(await readFile(join(f.root, 'sentinel'), 'utf8')).toBe('unrelated');
});
it('rejects a granted snapshot for a different scope before writing export records', async () => {
  const f = await fixture(); let wrote = false;
  await expect(writeSessionTextExport(selection, command => command.kind === 'projection.catalog.begin'
    ? f.request({ ...command, request: { ...command.request, scope: { kind: 'session', workspaceId: 'workspace-a', sessionId: 'session-b' } } })
    : f.request(command), async () => { wrote = true; })).rejects.toThrow('session_export_scope_mismatch');
  expect(wrote).toBe(false);
});
