import { describe, expect, it, vi } from 'vitest';
import { runtimeCommandSchema, taskCenterPageSchema, type RuntimeCommand, type RuntimeResult,
  type TaskCenterPage, type TaskDirectoryRow } from '@ariadne/protocol/public';
import { TaskCenterFeatureStore } from '../src/renderer/src/core/runtime/features/task-center-feature-store';

const timestamp = '2026-10-06T00:00:00.000Z';
function row(id = 'run-a'): TaskDirectoryRow {
  return { metadata: { reference: { source: 'run', sourceId: id }, workspaceId: 'workspace-a', sessionId: 'session-a',
    title: '任务', sourceStatus: 'running', state: 'running', version: 3, attempts: null, updatedAt: timestamp, dueAt: null,
    relations: [], relationTotal: 0, runReferences: [], runReferenceTotal: 0 }, archived: false, decisions: [], result: 'none' };
}
function page(command: Extract<RuntimeCommand, { kind: 'tasks.query' }>, position = 1): TaskCenterPage {
  return taskCenterPageSchema.parse({ kind: 'tasks.query_result', contractVersion: '1.0', snapshotId: 'snapshot-a',
    capturedAt: timestamp, expiresAt: '2026-10-06T00:05:00.000Z', consistency: 'eventual', filter: command.filter,
    complete: true, watermarks: ['projection', 'productivity', 'conversation'].map(source => ({ source, status: 'ready',
      revision: null, capturedAt: timestamp, diagnosticCode: null })), indexedTotal: 3,
    rows: command.filter.states.length && !command.filter.states.includes('running') ? [] : [row(command.filter.reference?.sourceId ?? `run-${position}`)], pageCursor: `cursor-${position}`, nextCursor: position < 3 ? `cursor-${position + 1}` : null });
}
function fixture(handler: (command: RuntimeCommand) => Promise<RuntimeResult>) {
  const execute = vi.fn((input: RuntimeCommand) => handler(runtimeCommandSchema.parse(input)));
  return { store: new TaskCenterFeatureStore({ execute }), execute };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('bounded task center interaction store', () => {
  it('returns to the same immutable first-page cursor and retains filters, selection and scroll', async () => {
    const f = fixture(async command => {
      if (command.kind !== 'tasks.query') throw new Error('unexpected');
      return page(command, command.cursor === 'cursor-2' ? 2 : 1);
    });
    await f.store.refresh(false);
    f.store.select(f.store.view.getSnapshot().page!.rows[0]!);
    f.store.rememberScroll(92);
    expect(f.store.view.getSnapshot()).toMatchObject({ scrollTop: 92, selectedKey: 'run:run-1' });
    await f.store.navigatePage('next'); await f.store.navigatePage('previous');
    expect(f.execute.mock.calls[2]?.[0]).toMatchObject({ kind: 'tasks.query', cursor: 'cursor-1', refresh: false });
    expect(f.store.view.getSnapshot()).toMatchObject({ pageNumber: 1, hasPrevious: false, selectedKey: 'run:run-1' });
  });
  it('rejects late responses after a filter change', async () => {
    const pending = deferred<RuntimeResult>();
    const f = fixture(async command => {
      if (command.kind !== 'tasks.query') throw new Error('unexpected');
      return command.filter.states.length ? { ...page(command), rows: [] } : pending.promise;
    });
    const old = f.store.refresh(false);
    const oldCommand = f.execute.mock.calls[0]![0] as Extract<RuntimeCommand, { kind: 'tasks.query' }>;
    await f.store.setFilter({ ...f.store.view.getSnapshot().filter, states: ['failed'] });
    pending.resolve(page(oldCommand)); await old;
    expect(f.store.view.getSnapshot().page?.filter.states).toEqual(['failed']);
    expect(f.store.view.getSnapshot().page?.rows).toEqual([]);
  });
  it('clears an expired directory and preserves an explicit partial coverage response', async () => {
    let expired = false;
    const f = fixture(async command => {
      if (command.kind !== 'tasks.query') throw new Error('unexpected');
      if (expired) return { kind: 'tasks.query_reset', contractVersion: '1.0', reason: 'expired' };
      const result = page(command); result.complete = false;
      result.watermarks[1] = { ...result.watermarks[1]!, status: 'unavailable', diagnosticCode: 'source_unavailable' };
      return result;
    });
    await f.store.refresh(false); expect(f.store.view.getSnapshot().page?.complete).toBe(false);
    expired = true; await f.store.navigatePage('next');
    expect(f.store.view.getSnapshot()).toMatchObject({ page: null, loading: false });
    expect(f.store.view.getSnapshot().error).toContain('失效');
  });
  it('queries an exact related reference without replacing the directory or its scroll position', async () => {
    const f = fixture(async command => {
      if (command.kind !== 'tasks.query') throw new Error('unexpected'); return page(command);
    });
    await f.store.refresh(false); f.store.rememberScroll(80);
    const snapshot = f.store.view.getSnapshot();
    const related = await f.store.lookup({ source: 'run', sourceId: 'related-run' }, 'workspace-a', 'session-a');
    expect(related?.metadata.reference.sourceId).toBe('related-run');
    expect(f.store.view.getSnapshot()).toBe(snapshot);
    expect(f.execute.mock.calls[1]?.[0]).toMatchObject({ kind: 'tasks.query', filter: { reference: { source: 'run', sourceId: 'related-run' } }, limit: 1 });
  });
  it('sends exact source and decision versions and rejects a foreign navigation response', async () => {
    const selected = row();
    const decision = { workspaceId: 'workspace-a', sessionId: 'session-a', runId: 'run-a', decisionId: 'decision-a', version: 2, kind: 'permission' as const };
    const f = fixture(async command => {
      if (command.kind !== 'tasks.navigate') throw new Error('unexpected');
      return { kind: 'tasks.navigate_result', contractVersion: '1.0', status: 'missing', reference: command.reference,
        workspaceId: 'other-workspace', sessionId: command.sessionId, current: null, target: null };
    });
    expect(await f.store.requestNavigation(selected, 'decision', decision)).toBeNull();
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 3, expectedAttempts: null, expectedSourceStatus: 'running', decisionId: 'decision-a', expectedDecisionVersion: 2 });
    expect(f.store.view.getSnapshot()).toMatchObject({ navigating: false, error: '任务导航失败，请重试。' });
  });
  it('drops navigation completed after a newer directory request', async () => {
    const pending = deferred<RuntimeResult>();
    const f = fixture(async command => command.kind === 'tasks.query' ? page(command) : pending.promise);
    const old = f.store.requestNavigation(row(), 'details');
    await f.store.refresh(false);
    pending.resolve({ kind: 'tasks.navigate_result', contractVersion: '1.0', status: 'stale', reference: row().metadata.reference,
      workspaceId: 'workspace-a', sessionId: 'session-a', current: row().metadata, target: null });
    expect(await old).toBeNull(); expect(f.store.view.getSnapshot()).toMatchObject({ navigating: false, error: null });
  });
  it('drops a pending navigation when the user selects a different task', async () => {
    const pending = deferred<RuntimeResult>();
    const f = fixture(async () => pending.promise), old = f.store.requestNavigation(row(), 'details');
    f.store.select(row('new-selection'));
    pending.resolve({ kind: 'tasks.navigate_result', contractVersion: '1.0', status: 'stale', reference: row().metadata.reference,
      workspaceId: 'workspace-a', sessionId: 'session-a', current: row().metadata, target: null });
    expect(await old).toBeNull();
    expect(f.store.view.getSnapshot()).toMatchObject({ selectedKey: 'run:new-selection', navigating: false, error: null });
  });
});
