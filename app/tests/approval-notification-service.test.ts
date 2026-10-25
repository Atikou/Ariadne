import { describe, expect, it, vi } from 'vitest';
import { ApprovalNotificationService } from '../src/main/services/approval-notification-service';
import type { DecisionNotificationItem, DecisionNotificationReference } from '../src/main/services/decision-notification-source';

const decision = (overrides: Partial<DecisionNotificationItem> = {}): DecisionNotificationItem => ({
  decisionId: 'decision-1', sessionId: 'session-1', runId: 'run-1', version: 1,
  kind: 'permission', status: 'pending', title: '创建项目', ...overrides
});
function fixture() {
  let items: readonly DecisionNotificationItem[] = [decision()];
  let focused = false;
  let allowed = true;
  let click: (() => void) | undefined;
  let shown: (() => void) | undefined, closed: (() => void) | undefined, failed: (() => void) | undefined;
  const notification = { onClick: (handler: () => void) => { click = handler; },
    onShown: (handler: () => void) => { shown = handler; }, onClosed: (handler: () => void) => { closed = handler; },
    onFailed: (handler: () => void) => { failed = handler; }, show: vi.fn(() => shown?.()), close: vi.fn() };
  const host = { isSupported: () => true, isWindowFocused: () => focused, canNotify: vi.fn(async () => allowed),
    create: vi.fn(() => notification), activateApplication: vi.fn(), removeHistory: vi.fn(async () => true) };
  const read = vi.fn(async () => items);
  const recorded = new Map<string, number>();
  const receipts = { shouldNotify: (item: DecisionNotificationItem) => recorded.get(item.decisionId) !== item.version,
    references: () => [...recorded].map(([decisionId, version]) => ({ decisionId, version, sessionId: 'session-1', runId: 'run-1' })),
    recordShown: vi.fn(async (item: DecisionNotificationItem) => { recorded.set(item.decisionId, item.version); }),
    retainPending: vi.fn(async (ids: ReadonlySet<string>) => { for (const id of recorded.keys()) if (!ids.has(id)) recorded.delete(id); }),
    flush: async () => undefined };
  const current = vi.fn(async (item: DecisionNotificationReference) => items.find(row => row.decisionId === item.decisionId) ?? null);
  const service = new ApprovalNotificationService(host, read, current, receipts);
  return { service, host, read, notification, receipts, current, shown: () => shown?.(), closed: () => closed?.(), failed: () => failed?.(),
    setItems: (value: readonly DecisionNotificationItem[]) => { items = value; },
    focus: (value: boolean) => { focused = value; }, allow: (value: boolean) => { allowed = value; },
    click: async () => { click?.(); await vi.waitFor(() => expect(host.activateApplication).toHaveBeenCalled()); }
  };
}
describe('authoritative Decision notification consumer', () => {
  it('pauses the original reader and ignores delayed native receipts until the same consumer resumes', async () => {
    const f = fixture();
    f.notification.show.mockImplementationOnce(() => undefined);
    await f.service.refresh(); expect(f.host.create).toHaveBeenCalledOnce();
    await f.service.pauseForMaintenance(); f.shown();
    expect(f.receipts.recordShown).not.toHaveBeenCalled();
    await f.service.refresh(); expect(f.host.create).toHaveBeenCalledOnce();
    expect(f.service.showTestNotification().shown).toBe(false);
    await f.service.resumeAfterMaintenance(); expect(f.host.create).toHaveBeenCalledTimes(2);
    expect(f.receipts.recordShown).toHaveBeenCalledOnce();
  });

  it('drains a pending source read without changing receipts or delivering after pause', async () => {
    const f = fixture(); let release!: (items: readonly DecisionNotificationItem[]) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const refresh = f.service.refresh(), pause = f.service.pauseForMaintenance();
    release([decision()]); await refresh; await pause;
    expect(f.host.create).not.toHaveBeenCalled(); expect(f.receipts.retainPending).not.toHaveBeenCalled();
    await f.service.resumeAfterMaintenance(); expect(f.host.create).toHaveBeenCalledOnce();
  });
  it('removes settled OS history with a new Main consumer that has no notification handle', async () => {
    const f = fixture(); await f.receipts.recordShown(decision()); f.setItems([]);
    await f.service.refresh();
    expect(f.host.removeHistory).toHaveBeenCalledExactlyOnceWith([{ decisionId: 'decision-1', sessionId: 'session-1', runId: 'run-1', version: 1 }]);
    expect(f.host.create).not.toHaveBeenCalled(); expect(f.receipts.references()).toEqual([]);
  });
  it('retains unconfirmed history cleanup for retry without blocking unrelated pending decisions', async () => {
    const f = fixture(); await f.receipts.recordShown(decision());
    f.setItems([decision({ decisionId: 'decision-2' })]); f.host.removeHistory.mockResolvedValueOnce(false);
    await f.service.refresh();
    expect(f.receipts.references().map(row => row.decisionId)).toEqual(['decision-1', 'decision-2']);
    expect(f.host.create).toHaveBeenCalledOnce();
    await f.service.refresh();
    expect(f.receipts.references().map(row => row.decisionId)).toEqual(['decision-2']);
    expect(f.host.removeHistory).toHaveBeenCalledTimes(2);
  });
  it('removes old-version OS history while focused and preserves a new pending decision for later display', async () => {
    const f = fixture(); await f.receipts.recordShown(decision()); f.focus(true);
    f.setItems([decision({ version: 2 })]); await f.service.refresh();
    expect(f.host.removeHistory).toHaveBeenCalledOnce(); expect(f.receipts.references()).toEqual([]);
    f.focus(false); await f.service.refresh(); expect(f.host.create).toHaveBeenCalledOnce();
    expect(f.receipts.references()[0]?.version).toBe(2);
  });
  it('revalidates a stored notification reference with a fresh service and no live handle', async () => {
    const f = fixture();
    f.setItems([decision({ status: 'approved', version: 2 })]);
    await f.service.activateReference({ decisionId: 'decision-1', sessionId: 'session-1', runId: 'run-1', version: 1 });
    expect(f.current).toHaveBeenCalledOnce();
    expect(f.host.activateApplication).toHaveBeenCalledExactlyOnceWith('session-1', 'decision-1');
    expect(f.host.create).not.toHaveBeenCalled();
  });
  it('suppresses while focused and checks pending Decisions when moved into background', async () => {
    const f = fixture(); f.focus(true); await f.service.refresh();
    expect(f.host.create).not.toHaveBeenCalled();
    f.focus(false); await f.service.refresh(); expect(f.host.create).toHaveBeenCalledOnce();
  });
  it('deduplicates the same version, includes questions and closes settled notifications', async () => {
    const f = fixture(); f.setItems([decision({ kind: 'user_question' })]);
    await f.service.refresh(); await f.service.refresh(); expect(f.host.create).toHaveBeenCalledOnce();
    f.setItems([decision({ kind: 'user_question', version: 2, status: 'approved' })]);
    await f.service.refresh(); expect(f.notification.close).toHaveBeenCalledOnce();
    f.setItems([decision({ decisionId: 'decision-2', kind: 'plan' })]);
    await f.service.refresh(); expect(f.host.create).toHaveBeenCalledTimes(2);
  });
  it('recovers a pending item after policy suppression ends', async () => {
    const f = fixture(); f.allow(false); await f.service.refresh(); expect(f.host.create).not.toHaveBeenCalled();
    f.allow(true); await f.service.refresh(); expect(f.host.create).toHaveBeenCalledOnce();
  });
  it('revalidates the navigation reference and passes the exact Decision id without approving it', async () => {
    const f = fixture(); await f.service.refresh(); await f.click();
    expect(f.host.activateApplication).toHaveBeenCalledWith('session-1', 'decision-1');
  });
  it('does not navigate to a deleted Decision', async () => {
    const f = fixture(); await f.service.refresh(); f.setItems([]); await f.click();
    expect(f.host.activateApplication).toHaveBeenCalledWith();
  });
  it('waits for application activation before reconciling the clicked Decision', async () => {
    const f = fixture(); let release!: () => void;
    f.host.activateApplication.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await f.service.refresh(); const readsBeforeClick = f.read.mock.calls.length;
    await f.click(); expect(f.read).toHaveBeenCalledTimes(readsBeforeClick);
    release(); await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(readsBeforeClick + 1));
    expect(f.host.activateApplication).toHaveBeenCalledOnce();
  });
  it('falls back to waking the app on a failed lookup, but does not retry failed window activation', async () => {
    const f = fixture(); const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      f.current.mockRejectedValueOnce(new Error('unavailable'));
      f.host.activateApplication.mockImplementationOnce(() => Promise.reject(new Error('window unavailable')));
      await f.service.refresh(); await f.click();
      await vi.waitFor(() => expect(logged).toHaveBeenCalledWith('Notification navigation could not be completed.'));
      expect(f.host.activateApplication).toHaveBeenCalledExactlyOnceWith();
    } finally { logged.mockRestore(); }
  });
  it('coalesces wake hints and rereads updates arriving during synchronization', async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.read.mockImplementationOnce(async () => { await gate; return [decision()]; });
    const first = f.service.refresh(); f.service.refresh(); f.setItems([]); release(); await first;
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.host.create).not.toHaveBeenCalled();
  });
  it('does not show a stale notification when settlement happens during policy evaluation', async () => {
    const f = fixture(); let release!: (value: boolean) => void;
    f.host.canNotify.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.service.refresh(); await vi.waitFor(() => expect(f.host.canNotify).toHaveBeenCalled());
    f.setItems([]); f.service.refresh(); release(true); await first;
    expect(f.host.create).not.toHaveBeenCalled();
  });
  it('prevents delayed reads from resurrecting notifications after disposal', async () => {
    const f = fixture(); let release!: () => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([decision()]); }));
    const first = f.service.refresh(); f.service.dispose(); release(); await first;
    expect(f.host.create).not.toHaveBeenCalled();
  });
  it('retains the explicit channel preview', () => {
    const f = fixture(); expect(f.service.showTestNotification()).toEqual({ shown: true, supported: true });
    expect(f.notification.show).toHaveBeenCalledOnce();
  });
  it('records delivery only on native show, and retries failed delivery after its bounded cooldown', async () => {
    const f = fixture(); f.notification.show.mockImplementation(() => undefined);
    await f.service.refresh(); expect(f.receipts.recordShown).not.toHaveBeenCalled();
    f.failed(); await f.service.refresh(); expect(f.host.create).toHaveBeenCalledOnce();
    const taskNow = Date.now(); const time = vi.spyOn(Date, 'now').mockReturnValue(taskNow + 61_000);
    try { await f.service.refresh(); expect(f.host.create).toHaveBeenCalledTimes(2); f.shown();
      expect(f.receipts.recordShown).toHaveBeenCalledOnce(); }
    finally { time.mockRestore(); }
  });
  it('does not permanently hide a pending receipt after a closed toast when the receipt becomes eligible again', async () => {
    const f = fixture(); await f.service.refresh(); f.closed();
    await f.service.refresh(); expect(f.host.create).toHaveBeenCalledOnce();
    f.receipts.shouldNotify = () => true; await f.service.refresh(); expect(f.host.create).toHaveBeenCalledTimes(2);
  });
  it('removes a settled notification from Notification Center after its banner has closed', async () => {
    const f = fixture(); await f.service.refresh(); f.closed();
    f.setItems([]); await f.service.refresh();
    expect(f.notification.close).toHaveBeenCalledOnce();
    expect(f.receipts.retainPending).toHaveBeenLastCalledWith(new Set());
  });
  it('navigates to an already settled Decision through the revalidated summary without approving it', async () => {
    const f = fixture(); await f.service.refresh(); f.setItems([decision({ status: 'approved', version: 2 })]); await f.click();
    expect(f.current).toHaveBeenCalledWith(decision());
    expect(f.host.activateApplication).toHaveBeenCalledWith('session-1', 'decision-1');
    expect(f.notification.close).toHaveBeenCalledOnce();
  });
});
