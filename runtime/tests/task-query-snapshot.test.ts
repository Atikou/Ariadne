import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { taskReferenceKey, type TaskCenterFilter, type TaskDirectoryRow } from '@ariadne/protocol/public';
import { SqliteTaskQuerySnapshotStore } from '../src/adapters/persistence/SqliteTaskQuerySnapshotStore.js';
import { TASK_QUERY_SNAPSHOT_LIFETIME_MS, TASK_QUERY_SNAPSHOT_RELATIVE_PATH,
  type TaskSnapshotCoverage } from '../src/adapters/persistence/TaskQuerySnapshotRecords.js';

const filter: TaskCenterFilter = { reference: null, workspaceId: 'workspace-a', sessionId: null, includeArchived: false,
  sources: ['run', 'goal', 'workflow', 'schedule', 'occurrence'], states: [], updatedFrom: null, updatedThrough: null };
const timestamp = '2026-10-06T00:00:00.000Z';
const coverage: TaskSnapshotCoverage = ['projection', 'productivity', 'conversation'].map(source => ({
  source: source as TaskSnapshotCoverage[number]['source'], status: 'ready', revision: 12, capturedAt: timestamp, diagnosticCode: null }));
const fixtures: { root: string; stores: SqliteTaskQuerySnapshotStore[] }[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) {
  for (const store of fixture.stores) store.close(); rmSync(fixture.root, { recursive: true, force: true });
} });
function open() {
  const root = mkdtempSync(join(tmpdir(), 'ariadne-task-snapshots-'));
  let now = Date.parse(timestamp);
  const store = new SqliteTaskQuerySnapshotStore(root, () => now);
  const fixture = { root, stores: [store] }; fixtures.push(fixture);
  return { ...fixture, store, advance: (delta: number) => { now += delta; } };
}
function row(index: number, workspace = 'workspace-a'): TaskDirectoryRow {
  return { metadata: { reference: { source: 'run', sourceId: 'run-' + String(index).padStart(4, '0') },
    workspaceId: workspace, sessionId: 'session-a', title: '任务 ' + index,
    sourceStatus: 'running', state: 'running', version: 1, attempts: null, updatedAt: timestamp, dueAt: null,
    relations: [], relationTotal: 0, runReferences: [], runReferenceTotal: 0 }, archived: false, decisions: [], result: 'none' };
}
function seal(store: SqliteTaskQuerySnapshotStore, rows: TaskDirectoryRow[], marks = coverage) {
  const id = store.begin('authorized-a', filter);
  for (let start = 0; start < rows.length; start += 128) store.append(id, 'authorized-a', rows.slice(start, start + 128));
  store.seal(id, 'authorized-a', marks); return id;
}

describe('immutable SQLite task query snapshots', () => {
  it('pages 130 fixed revisions while a separate refresh includes updates and low-key insertions', () => {
    const { store } = open(); const originals = Array.from({ length: 130 }, (_, index) => row(index + 1));
    const id = seal(store, originals), first = store.page('authorized-a', filter, id, null, 17);
    const updated = originals.map(item => ({ ...item, metadata: { ...item.metadata, version: 2, state: 'completed' as const } }));
    seal(store, [row(0), ...updated]);
    const revisited = store.page('authorized-a', filter, null, first.pageCursor, 17);
    expect(revisited.snapshotId).toBe(first.snapshotId);
    expect(revisited.rows).toEqual(first.rows);
    expect(revisited.pageCursor).toBe(first.pageCursor);
    const seen = [...first.rows]; let cursor = first.nextCursor;
    while (cursor !== null) { const page = store.page('authorized-a', filter, null, cursor, 17);
      seen.push(...page.rows); cursor = page.nextCursor; }
    expect(seen).toHaveLength(130); expect(new Set(seen.map(item => taskReferenceKey(item.metadata.reference))).size).toBe(130);
    expect(seen.every(item => item.metadata.version === 1)).toBe(true);
    const fresh = seal(store, [row(0), ...updated]);
    expect(store.page('authorized-a', filter, fresh, null, 1).rows[0]?.metadata.reference.sourceId).toBe('run-0000');
    expect(() => store.append(id, 'authorized-a', [row(999)])).toThrow('already_sealed');
  });
  it('keeps exact-reference cursors bounded even with maximum owner and reference IDs', () => {
    const { store } = open();
    const item = row(1, 'w'.repeat(256));
    item.metadata.sessionId = 's'.repeat(256);
    item.metadata.reference.sourceId = 'r'.repeat(256);
    const exact: TaskCenterFilter = { ...filter, workspaceId: item.metadata.workspaceId, sessionId: item.metadata.sessionId,
      reference: item.metadata.reference, updatedFrom: timestamp, updatedThrough: timestamp, states: ['running'] };
    const id = store.begin('authorized-a', exact);
    store.append(id, 'authorized-a', [item, { ...item, metadata: { ...item.metadata, reference: { source: 'run', sourceId: 'other' } } }]);
    store.seal(id, 'authorized-a', coverage);
    const page = store.page('authorized-a', exact, id, null, 1);
    expect(page.rows).toEqual([item]);
    expect(page.indexedTotal).toBe(1);
    expect(page.pageCursor.length).toBeLessThanOrEqual(2048);
    expect(store.page('authorized-a', exact, null, page.pageCursor, 1).rows).toEqual([item]);
  });
  it('applies all filters and rejects authorization or filter changes, forged cursors and duplicate identities', () => {
    const { store } = open(), rows = [row(1), row(2), row(3, 'workspace-b'), { ...row(4), archived: true }];
    const id = seal(store, rows), first = store.page('authorized-a', filter, id, null, 1);
    expect(first.indexedTotal).toBe(2);
    expect(() => store.page('authorized-b', filter, null, first.nextCursor, 1)).toThrow('scope_changed');
    expect(() => store.page('authorized-a', { ...filter, states: ['completed'] }, null, first.nextCursor, 1)).toThrow('scope_changed');
    expect(() => store.page('authorized-a', filter, null, first.nextCursor!.slice(0, -1) + '!', 1)).toThrow('invalid_cursor');
    const duplicate = store.begin('authorized-a', filter);
    expect(() => store.append(duplicate, 'authorized-a', [row(1), row(1)])).toThrow();
    store.seal(duplicate, 'authorized-a', coverage);
    expect(store.page('authorized-a', filter, duplicate, null, 5).indexedTotal).toBe(0);
    const scoped = { ...filter, sessionId: 'session-a', states: ['running' as const], updatedFrom: timestamp, updatedThrough: timestamp };
    const exact = store.begin('authorized-a', scoped);
    store.append(exact, 'authorized-a', [row(1), { ...row(2), metadata: { ...row(2).metadata, updatedAt: null } },
      { ...row(3), metadata: { ...row(3).metadata, sessionId: 'session-b' } }]);
    store.seal(exact, 'authorized-a', coverage);
    expect(store.page('authorized-a', scoped, exact, null, 5).indexedTotal).toBe(1);
  });
  it('keeps partial source watermarks explicit and forbids reading a mutable building snapshot', () => {
    const { store } = open(), id = store.begin('authorized-a', filter);
    store.append(id, 'authorized-a', [row(1)]);
    expect(() => store.page('authorized-a', filter, id, null, 5)).toThrow('unavailable');
    store.seal(id, 'authorized-a', coverage.map(mark => mark.source === 'productivity'
      ? { ...mark, status: 'unavailable', revision: null, diagnosticCode: 'source_unavailable' } : mark));
    expect(store.page('authorized-a', filter, id, null, 5)).toMatchObject({ complete: false, consistency: 'eventual' });
  });
  it('expires, evicts and resets process-local cursors without creating authority state', () => {
    const fixture = open(), { store } = fixture;
    const id = seal(store, [row(1), row(2)]), cursor = store.page('authorized-a', filter, id, null, 1).nextCursor;
    fixture.advance(TASK_QUERY_SNAPSHOT_LIFETIME_MS);
    expect(() => store.page('authorized-a', filter, null, cursor, 1)).toThrow('expired');
    const evicted = seal(store, [row(1)]);
    for (let index = 0; index < 16; index++) { fixture.advance(1); seal(store, [row(index)]); }
    expect(() => store.page('authorized-a', filter, evicted, null, 1)).toThrow('expired');
    store.close(); const reopened = new SqliteTaskQuerySnapshotStore(fixture.root);
    fixture.stores.push(reopened);
    expect(() => reopened.page('authorized-a', filter, null, cursor, 1)).toThrow('invalid_cursor');
    expect(() => reopened.page('authorized-a', filter, id, null, 1)).toThrow('expired');
  });
  it('shrinks pages to the byte boundary while every large metadata row remains reachable', () => {
    const { store } = open();
    const rows = Array.from({ length: 8 }, (_, index) => {
      const item = row(index), id = 'x'.repeat(240);
      item.metadata.relations = Array.from({ length: 512 }, (_, link) => ({
        reference: { source: 'goal' as const, sourceId: id + link }, owner: { workspaceId: id, sessionId: id }, kind: 'parent' as const }));
      item.metadata.relationTotal = 512;
      item.metadata.runReferences = Array.from({ length: 256 }, (_, link) => ({ workspaceId: id, sessionId: id, runId: id + link }));
      item.metadata.runReferenceTotal = 256;
      return item;
    });
    const id = seal(store, rows), first = store.page('authorized-a', filter, id, null, 128);
    expect(first.rows.length).toBeLessThan(8); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(2 * 1024 * 1024);
    const seen = [...first.rows]; let cursor = first.nextCursor;
    while (cursor) { const page = store.page('authorized-a', filter, null, cursor, 128); seen.push(...page.rows); cursor = page.nextCursor; }
    expect(seen).toHaveLength(8);
    expect(() => store.page('authorized-a', filter, id, null, 129)).toThrow('limit_invalid');
  });
  it('fences competing owners and preserves an unknown database byte for byte', () => {
    const fixture = open(), competing = new SqliteTaskQuerySnapshotStore(fixture.root); fixture.stores.push(competing);
    expect(competing.available).toBe(false); expect(fixture.store.available).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'ariadne-task-snapshots-unknown-'));
    const file = join(root, TASK_QUERY_SNAPSHOT_RELATIVE_PATH); mkdirSync(dirname(file), { recursive: true });
    const foreign = new DatabaseSync(file); foreign.exec('CREATE TABLE unknown(value TEXT); PRAGMA user_version=99;'); foreign.close();
    const before = readFileSync(file), unavailable = new SqliteTaskQuerySnapshotStore(root);
    fixtures.push({ root, stores: [unavailable] }); expect(unavailable.available).toBe(false);
    expect(readFileSync(file)).toEqual(before);
  });
  it('preserves a familiar schema with an unknown trigger instead of rebuilding it', () => {
    const fixture = open(); seal(fixture.store, [row(1)]); fixture.store.close();
    const file = join(fixture.root, TASK_QUERY_SNAPSHOT_RELATIVE_PATH), foreign = new DatabaseSync(file);
    foreign.exec('CREATE TRIGGER unknown_format AFTER DELETE ON task_query_snapshots BEGIN SELECT 1; END;'); foreign.close();
    const before = readFileSync(file), reopened = new SqliteTaskQuerySnapshotStore(fixture.root); fixture.stores.push(reopened);
    expect(reopened.available).toBe(false); expect(readFileSync(file)).toEqual(before);
    const inspect = new DatabaseSync(file, { readOnly: true });
    expect(Number(inspect.prepare('SELECT count(*) count FROM task_query_rows').get()!.count)).toBe(1); inspect.close();
  });
});
