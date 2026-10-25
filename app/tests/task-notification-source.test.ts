import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskCenterPageSchema, runtimeCommandSchema, type RuntimeCommand, type RuntimeResult, type TaskDirectoryRow } from '@ariadne/protocol/public';
import { TaskNotificationReceipts, type TaskNotificationPreferences } from '../src/main/persistence/task-notification-receipts';
import { TaskNotificationSource } from '../src/main/services/task-notification-source';
import { ApprovalNotificationService, type ApprovalNotificationContent } from '../src/main/services/approval-notification-service';

const directories: string[] = [], stores: TaskNotificationReceipts[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const enabledAt = '2026-10-06T00:00:00.000Z', observedAt = '2026-10-06T00:01:00.000Z';
const row = (id: string, state: 'completed' | 'failed' = 'completed'): TaskDirectoryRow => ({ metadata: {
  reference: { source: 'run', sourceId: id }, workspaceId: 'workspace-a', sessionId: 'session-a', title: `Public ${id}`,
  sourceStatus: state, state, version: 8, attempts: null, updatedAt: observedAt, dueAt: null,
  relations: [], relationTotal: 0, runReferences: [], runReferenceTotal: 0 }, archived: false, decisions: [], result: state === 'completed' ? 'available' : 'none' });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'Ariadne-task-source-')); directories.push(directory);
  const receipts = new TaskNotificationReceipts(join(directory, 'delivery.db'), () => Date.parse(enabledAt)); stores.push(receipts); await receipts.initialize();
  let preferences: TaskNotificationPreferences = { completed: true, failed: true }, rows = [row('run-a'), row('run-b', 'failed')], partial = false, stale = false;
  const request = vi.fn(async (input: RuntimeCommand): Promise<RuntimeResult> => {
    const command = runtimeCommandSchema.parse(input);
    if (command.kind === 'tasks.query') {
      const offset = command.cursor ? Number(command.cursor.split('-').at(-1)) : 0;
      const filtered = rows.filter(row => command.filter.states.includes(row.metadata.state)
        && (!command.filter.updatedFrom || (row.metadata.updatedAt !== null && row.metadata.updatedAt >= command.filter.updatedFrom)));
      return taskCenterPageSchema.parse({ kind: 'tasks.query_result', contractVersion: '1.0', snapshotId: 'snapshot-a', capturedAt: observedAt,
        expiresAt: '2026-10-06T00:06:00.000Z', consistency: 'eventual', filter: command.filter, complete: !partial, indexedTotal: filtered.length,
        watermarks: ['projection', 'productivity', 'conversation'].map(source => ({ source, status: partial && source === 'conversation' ? 'building' : 'ready',
          capturedAt: observedAt, revision: 1, diagnosticCode: null })), rows: filtered.slice(offset, offset + 1), pageCursor: `cursor-${offset}`,
        nextCursor: offset + 1 < filtered.length ? `cursor-${offset + 1}` : null });
    }
    if (command.kind !== 'tasks.navigate') throw new Error('unexpected');
    return { kind: 'tasks.navigate_result', contractVersion: '1.0', status: stale ? 'stale' : 'ok', reference: command.reference,
      workspaceId: command.workspaceId, sessionId: command.sessionId, current: rows.find(item => item.metadata.reference.sourceId === command.reference.sourceId)?.metadata ?? null,
      target: stale ? null : { moduleId: command.destination === 'result' ? 'chat.main' : 'agent.status', workspaceId: command.workspaceId,
        sessionId: command.sessionId, runId: command.reference.sourceId, expectedRunVersion: command.expectedVersion, decisionId: null,
        expectedDecisionVersion: null, resultReference: command.destination === 'result' ? { sessionId: command.sessionId,
          messageId: 'result-message', messageVersion: 1, contentDigest: 'sha256:' + 'a'.repeat(64) } : null } };
  });
  const source = new TaskNotificationSource(request, receipts, () => preferences); source.configure();
  return { source, receipts, request, rows: (value: TaskDirectoryRow[]) => { rows = value; },
    preferences: (value: TaskNotificationPreferences) => { preferences = value; source.configure(); }, partial: () => { partial = true; }, stale: () => { stale = true; } };
}
async function collect(source: TaskNotificationSource) { const rows = []; for await (const row of source.read()) rows.push(row); return rows; }

describe('terminal reminders on the original Main notification owner', () => {
  it('uses stable bounded authorized metadata pages; never reads result bodies or occurrence delivery as completion', async () => {
    const f = await fixture(); expect((await collect(f.source)).map(item => item.reference.runId)).toEqual(['run-a', 'run-b']);
    expect(f.request.mock.calls.map(([command]) => command.kind)).toEqual(['tasks.query', 'tasks.query']);
    expect(f.request.mock.calls[0]![0]).toMatchObject({ filter: { sources: ['run'], states: ['completed', 'failed'], includeArchived: false, updatedFrom: enabledAt }, limit: 128 });
    f.receipts.shown((await collect(f.source))[0]!.reference);
    expect((await collect(f.source)).map(item => item.reference.runId)).toEqual(['run-b']);
  });
  it('rejects incomplete owner coverage, historic metadata and completion without a verified result', async () => {
    const f = await fixture(); f.rows([{ ...row('run-a'), result: 'pending' }, { ...row('run-b'), metadata: { ...row('run-b').metadata, updatedAt: '2026-10-05T23:59:59.000Z' } }]);
    expect(await collect(f.source)).toEqual([]);
    f.partial(); await expect(collect(f.source)).rejects.toThrow('task_notification_source_incomplete');
  });
  it('drops pages captured before a preference disable/re-enable', async () => {
    const f = await fixture(); const original = f.request.getMockImplementation()!;
    let release!: () => void;
    f.request.mockImplementationOnce(async command => { await new Promise<void>(resolve => { release = resolve; }); return original(command); });
    const pending = collect(f.source); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.preferences({ completed: false, failed: false }); f.preferences({ completed: true, failed: true }); release();
    expect(await pending).toEqual([]);
  });
  it('shares suppression, observed-show deduplication and exact revalidated click navigation', async () => {
    const f = await fixture(); let allowed = false; const shown = new Map<string, () => void>(), clicks = new Map<string, () => void>();
    const host = { isSupported: () => true, isWindowFocused: () => false, canNotify: vi.fn(async () => allowed),
      removeHistory: async () => true, activateApplication: vi.fn(), activateTask: vi.fn(),
      create: vi.fn((content: ApprovalNotificationContent) => ({ onClick: (handler: () => void) => { clicks.set(content.taskNavigation!.runId, handler); },
        onShown: (handler: () => void) => { shown.set(content.taskNavigation!.runId, handler); }, onClosed: () => undefined,
        onFailed: () => undefined, show: () => undefined, close: () => undefined })) };
    const service = new ApprovalNotificationService(host, async () => [], async () => null,
      { references: () => [], shouldNotify: () => false, recordShown: async () => undefined, retainPending: async () => undefined, flush: async () => undefined }, f.source);
    await service.refresh(); expect(host.create).not.toHaveBeenCalled(); allowed = true;
    await service.refresh(); expect(host.create).toHaveBeenCalledTimes(2);
    shown.get('run-a')!(); shown.get('run-b')!(); await service.refresh(); expect(host.create).toHaveBeenCalledTimes(2);
    clicks.get('run-a')!(); await vi.waitFor(() => expect(host.activateTask).toHaveBeenCalledOnce());
    expect(host.activateTask.mock.calls[0]![0]).toMatchObject({ target: { moduleId: 'chat.main', expectedRunVersion: 8,
      resultReference: { messageId: 'result-message' } } });
    f.stale(); await service.activateTaskReference(host.create.mock.calls[0]![0].taskNavigation!);
    expect(host.activateApplication).toHaveBeenCalledOnce(); expect(host.activateTask).toHaveBeenCalledOnce(); service.dispose();
  });
});
