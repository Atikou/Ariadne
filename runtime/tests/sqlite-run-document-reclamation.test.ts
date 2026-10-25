import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RunDocumentItemAssembler, assertPublicRunDocumentCommit,
  verifyRunDocumentRootResult, verifyRunDocumentChunkResult } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteRunDocumentPreparation } from '../src/adapters/persistence/SqliteRunDocumentPreparation.js';
import { reclaimRunDocumentPreparationAtStartup } from '../src/adapters/persistence/RunDocumentStartupReclamation.js';
import { RunDocumentPlan, type RunDocumentSource } from '../src/projection/RunDocumentPlan.js';

const roots: string[] = [], owners = new Set<SqlitePublicProjectionStore>();
afterEach(async () => {
  for (const owner of owners) await owner.close(); owners.clear();
  for (const root of roots.splice(0)) {
    const scoped = relative(tmpdir(), root);
    if (!scoped.startsWith('AriadneReclamation-') || scoped.includes(sep) || isAbsolute(scoped)) throw new Error('unsafe_reclamation_fixture');
    rmSync(root, { recursive: true, force: true });
  }
});
const at = '2032-01-01T00:00:00.000Z';
function open(root?: string) {
  if (root === undefined) { root = mkdtempSync(join(tmpdir(), 'AriadneReclamation-')); roots.push(root); }
  const owner = new SqlitePublicProjectionStore(root); owners.add(owner);
  return { root, owner, database: (owner as unknown as { database: DatabaseSync }).database };
}
async function close(owner: SqlitePublicProjectionStore) { await owner.close(); owners.delete(owner); }
function plan(version: number, count: number, large = false) {
  const source: RunDocumentSource = { summary: { runId: 'reclaim-run', sessionId: 'reclaim-session', version,
    title: '模拟准备回收', status: 'running', label: '模拟准备回收', updatedAt: at,
    toolActivityCount: 0, queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: count }, toolActivities: [], inbox: [],
    interactionMessages: Array.from({ length: count }, (_, index) => ({ messageId: `reclaim-message-${index}`,
      sessionId: 'reclaim-session', runId: 'reclaim-run', version: 1, role: 'assistant' as const,
      content: large ? '汉字'.repeat(60_000) : '完整原正文', status: 'completed' as const, createdAt: at, updatedAt: at })) };
  return new RunDocumentPlan(source);
}
function commit(source: RunDocumentPlan) {
  const version = source.header.summary.version;
  return assertPublicRunDocumentCommit({ contractVersion: '6.0', eventId: `reclaim-run-${version}`,
    sourceId: 'reclaim-source', sourceCursor: version, occurredAt: at,
    changes: [{ feature: 'runs', operation: 'upsert', aggregateId: 'reclaim-run', aggregateVersion: version, projectedAt: at, dto: source.header }] });
}
async function range(owner: SqlitePublicProjectionStore) {
  const manifest = await owner.beginCatalogSnapshot({ pageContractVersion: '3.0', feature: 'runs', filter: 'all',
    scope: { kind: 'session', sessionId: 'reclaim-session', workspaceId: 'reclaim-workspace' } });
  if ('status' in manifest) throw new Error('reclamation_manifest');
  const request = { queryContractVersion: '1.0', manifest, runId: 'reclaim-run' };
  const root = await verifyRunDocumentRootResult(request, await owner.readRunDocument(request));
  if (root.status !== 'ok') throw new Error('reclamation_root');
  return { manifest, root };
}
async function body(owner: SqlitePublicProjectionStore, selected: Awaited<ReturnType<typeof range>>) {
  const assembler = new RunDocumentItemAssembler(selected.root.header, 'interactionMessages', 0);
  for (let chunkOrdinal = 0; chunkOrdinal < 32; chunkOrdinal++) {
    const request = { queryContractVersion: '1.0', manifest: selected.manifest, document: selected.root.document,
      collection: 'interactionMessages' as const, itemOrdinal: 0, chunkOrdinal };
    const result = await verifyRunDocumentChunkResult(request, await owner.readRunDocumentChunk(request));
    if (result.status !== 'ok') throw new Error('reclamation_chunk');
    const item = await assembler.accept(result.leaf); if (item !== null) return item.value;
  }
  throw new Error('reclamation_body_incomplete');
}
async function seedPublished() {
  const f = open();
  await f.owner.append({ contractVersion: '5.0', eventId: 'reclaim-session-event', sourceId: 'reclaim-session-source', sourceCursor: 1,
    occurredAt: at, changes: [{ feature: 'sessions', operation: 'upsert', aggregateId: 'reclaim-session', aggregateVersion: 1,
      projectedAt: at, dto: { sessionId: 'reclaim-session', workspaceId: 'reclaim-workspace', version: 1,
        title: '模拟回收', pinned: false, status: 'active', createdAt: at, updatedAt: at } }] });
  const original = plan(1, 1); await f.owner.appendRunDocument(commit(original), original); return f;
}

describe('new-owner bounded unpublished preparation reclamation', () => {
  it('reclaims only eight leaves at startup and rebuilds the exact pending version while old C remains readable', async () => {
    const f = await seedPublished(), candidate = plan(2, 5, true);
    await new SqliteRunDocumentPreparation(f.database).prepare(candidate);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM projection_run_document_leaves WHERE run_version=2').get()!.count).toBe(10);
    await close(f.owner); const reopened = open(f.root);
    expect(reopened.database.prepare('SELECT COUNT(*) AS count FROM projection_run_document_leaves WHERE run_version=2').get()!.count).toBe(2);
    expect(reopened.database.prepare('SELECT preparation_state,published_cursor FROM projection_run_documents WHERE run_version=2').get())
      .toEqual({ preparation_state: 'preparing', published_cursor: null });
    const original = await range(reopened.owner);
    expect((await body(reopened.owner, original)).content).toBe('完整原正文');
    expect(await reopened.owner.appendRunDocument(commit(candidate), candidate)).toMatchObject({ cursor: 3, replayed: false });
    expect((await body(reopened.owner, original)).content).toBe('完整原正文');
    expect((await body(reopened.owner, await range(reopened.owner))).content).toBe('汉字'.repeat(60_000));
    await close(reopened.owner); const final = open(f.root);
    expect(final.database.prepare('SELECT COUNT(*) AS count FROM projection_run_documents').get()!.count).toBe(2);
    expect(final.database.prepare('SELECT COUNT(*) AS count FROM projection_commits').get()!.count).toBe(3);
  });
  it('rolls a collection interruption back, removes an empty abandoned root, and never removes a published root', async () => {
    const f = await seedPublished(), candidate = plan(2, 1, true), preparation = new SqliteRunDocumentPreparation(f.database);
    await preparation.prepare(candidate);
    const before = f.database.prepare('SELECT run_version,preparation_state,published_cursor FROM projection_run_documents ORDER BY run_version').all();
    expect(() => reclaimRunDocumentPreparationAtStartup(f.database, () => { throw new Error('interrupted_reclamation'); })).toThrow('interrupted_reclamation');
    expect(f.database.prepare('SELECT run_version,preparation_state,published_cursor FROM projection_run_documents ORDER BY run_version').all()).toEqual(before);
    expect(await preparation.readPreparedHeader('reclaim-run', 2)).toEqual(candidate.header);
    expect(reclaimRunDocumentPreparationAtStartup(f.database)).toMatchObject({ rootsRemoved: 1, itemsRemoved: 1, leavesRemoved: 2 });
    const empty = plan(2, 0); await preparation.prepare(empty);
    expect(reclaimRunDocumentPreparationAtStartup(f.database)).toEqual({ rootsRemoved: 1, itemsRemoved: 0, leavesRemoved: 0, bodyBytesRemoved: 0 });
    expect(reclaimRunDocumentPreparationAtStartup(f.database)).toEqual({ rootsRemoved: 0, itemsRemoved: 0, leavesRemoved: 0, bodyBytesRemoved: 0 });
    expect((await body(f.owner, await range(f.owner))).content).toBe('完整原正文');
  });
  it('does not hide a corrupted publication marker before the new-owner audit', async () => {
    const f = await seedPublished(); await close(f.owner);
    const { DatabaseSync } = await import('node:sqlite');
    const { resolvePublicProjectionDatabasePath } = await import('../src/adapters/persistence/PublicProjectionDbSchema.js');
    const database = new DatabaseSync(resolvePublicProjectionDatabasePath(f.root));
    try { database.exec('UPDATE projection_run_documents SET published_cursor=NULL'); } finally { database.close(); }
    expect(() => open(f.root)).toThrow();
    const inspect = new DatabaseSync(resolvePublicProjectionDatabasePath(f.root), { readOnly: true });
    try { expect(inspect.prepare('SELECT COUNT(*) AS count FROM projection_run_document_leaves').get()!.count).toBe(1); }
    finally { inspect.close(); }
  });
  it('rejects a foreign body commit between the audit and reclamation without deleting the candidate', async () => {
    const f = await seedPublished(), candidate = plan(2, 1, true);
    await new SqliteRunDocumentPreparation(f.database).prepare(candidate); await close(f.owner);
    const { DatabaseSync } = await import('node:sqlite');
    const { resolvePublicProjectionDatabasePath } = await import('../src/adapters/persistence/PublicProjectionDbSchema.js');
    const file = resolvePublicProjectionDatabasePath(f.root);
    expect(() => new SqlitePublicProjectionStore(f.root, undefined, undefined, stage => {
      if (stage !== 'preparation_reclaim') return;
      const foreign = new DatabaseSync(file);
      try { foreign.exec('UPDATE projection_run_document_leaves SET chunk_bytes=zeroblob(length(chunk_bytes)) WHERE run_version=1'); }
      finally { foreign.close(); }
    })).toThrow('catalog:external_write');
    const inspect = new DatabaseSync(file, { readOnly: true });
    try { expect(inspect.prepare('SELECT COUNT(*) AS count FROM projection_run_document_leaves WHERE run_version=2').get()!.count).toBe(2); }
    finally { inspect.close(); }
  });
});
