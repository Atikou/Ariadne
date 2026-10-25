import type { DecisionNotificationItem, DecisionNotificationReference } from './decision-notification-source';
import type { DecisionNotificationReceipts } from '../persistence/decision-notification-receipts';
import type { TaskNotificationSource, TaskNotificationItem } from './task-notification-source';
import type { TaskNotificationReference } from '@shared/task-notification';
import type { TaskCenterNavigationResult } from '@ariadne/protocol/public';

export interface ApprovalNotificationContent { title: string; body: string; navigation?: DecisionNotificationReference; taskNavigation?: TaskNotificationReference }
export interface ApprovalNotificationHandle {
  onClick(handler: () => void): void;
  onShown(handler: () => void): void;
  onClosed(handler: () => void): void;
  onFailed(handler: () => void): void;
  show(): void;
  close(): void;
}
export interface ApprovalNotificationHost {
  isSupported(): boolean;
  isWindowFocused(): boolean;
  canNotify(): Promise<boolean>;
  create(content: ApprovalNotificationContent): ApprovalNotificationHandle;
  removeHistory(references: readonly DecisionNotificationReference[]): Promise<boolean>;
  activateApplication(sessionId?: string, decisionId?: string): void | Promise<void>;
  activateTask?(navigation: TaskCenterNavigationResult): void | Promise<void>;
}

/** A presentation consumer of authoritative public Decisions, with one coalesced reader. */
export class ApprovalNotificationService {
  private readonly visible = new Map<string, { item: DecisionNotificationItem; handle: ApprovalNotificationHandle; requestedAt: number; bannerClosed: boolean }>();
  private readonly retryAfter = new Map<string, number>();
  private readonly pending = new Map<string, DecisionNotificationItem>();
  private sync: Promise<void> | null = null;
  private dirty = false;
  private disposed = false;
  private paused = false;
  private get inactive(): boolean { return this.disposed || this.paused; }
  private readonly taskBanners = new Map<string, { item: TaskNotificationItem; handle: ApprovalNotificationHandle; requestedAt: number }>();

  constructor(private readonly host: ApprovalNotificationHost,
    private readonly read: () => Promise<readonly DecisionNotificationItem[]>,
    private readonly readCurrent: (item: DecisionNotificationReference) => Promise<DecisionNotificationItem | null>,
    private readonly receipts: DecisionNotificationReceipts,
    private readonly tasks?: TaskNotificationSource) {}

  refresh(): Promise<void> {
    if (this.inactive) return Promise.resolve();
    this.dirty = true;
    if (this.sync) return this.sync;
    this.sync = this.synchronize().finally(() => { this.sync = null; });
    return this.sync;
  }

  private async synchronize(): Promise<void> {
    let requested = 0;
    while (this.dirty && !this.inactive) {
      this.dirty = false;
      const items = await this.read();
      if (this.inactive) return;
      if (this.dirty) continue;
      this.pending.clear();
      for (const item of items) if (item.status === 'pending') this.pending.set(item.decisionId, item);
      for (const id of this.visible.keys()) if (!this.pending.has(id)) {
        this.visible.get(id)?.handle.close(); this.visible.delete(id);
      }
      for (const id of this.retryAfter.keys()) if (!this.pending.has(id)) this.retryAfter.delete(id);
      await this.receipts.flush();
      if (this.inactive) return;
      const references = this.receipts.references();
      const stale = references.filter(reference => {
        const current = this.pending.get(reference.decisionId);
        return !current || current.sessionId !== reference.sessionId || current.runId !== reference.runId || current.version !== reference.version;
      }).slice(0, 64);
      let removed = false;
      if (stale.length) {
        try { removed = await this.host.removeHistory(stale); }
        catch { console.warn('Decision notification history cleanup failed; display receipts are retained.'); }
      }
      if (this.inactive) return;
      const removedIds = new Set(removed ? stale.map(reference => reference.decisionId) : []);
      // Unconfirmed OS removal stays retryable across Main restarts. This is
      // display bookkeeping, never pending/settled business authority.
      await this.receipts.retainPending(new Set([...this.pending.keys(), ...references.map(reference => reference.decisionId)]
        .filter(id => !removedIds.has(id))));
      if (this.inactive) return;
      for (const [id, item] of this.pending) {
        if (requested >= 3) break;
        if (this.host.isWindowFocused() || !this.host.isSupported() || !this.receipts.shouldNotify(item)
          || (this.retryAfter.get(id) ?? 0) > Date.now()) continue;
        const previous = this.visible.get(id);
        if (previous?.item.version === item.version && !previous.bannerClosed && Date.now() - previous.requestedAt < 30_000) continue;
        if (!await this.host.canNotify()) continue;
        // A wake arriving during policy evaluation invalidates this view; read it again.
        if (this.inactive || this.dirty || this.host.isWindowFocused()) break;
        const notification = this.host.create({ title: 'Ariadne 需要你的确认',
          body: `${truncate(item.title, 96)}\n打开 Ariadne 查看详情。`,
          navigation: { decisionId: item.decisionId, sessionId: item.sessionId, runId: item.runId, version: item.version } });
        notification.onClick(() => { void this.activateReference(item); });
        this.visible.get(id)?.handle.close();
        const entry = { item, handle: notification, requestedAt: Date.now(), bannerClosed: false };
        this.visible.set(id, entry);
        notification.onShown(() => {
          if (this.inactive || this.visible.get(id) !== entry || this.pending.get(id)?.version !== item.version) return;
          void this.receipts.recordShown(item).catch(() => { console.error('Notification display receipt could not be saved.'); });
        });
        // A closed banner may still live in Notification Center. Keep its
        // handle until settlement/replacement so close() can remove that item.
        notification.onClosed(() => { entry.bannerClosed = true; });
        notification.onFailed(() => { if (this.visible.get(id) !== entry) return;
          this.visible.delete(id); this.retryAfter.set(id, Date.now() + 60_000); });
        try { notification.show(); requested++; }
        catch { this.visible.delete(id); this.retryAfter.set(id, Date.now() + 60_000); }
      }
      // Both kinds share this reader, policy and per-wake delivery budget.
      try { requested += await this.synchronizeTasks(3 - requested); }
      catch { console.warn('Task reminder source is unavailable; approval reminders remain active.'); }
    }
  }

  private async synchronizeTasks(budget: number): Promise<number> {
    const tasks = this.tasks;
    if (!tasks || this.inactive) return 0;
    tasks.configure();
    for (const [key, banner] of this.taskBanners) if (!tasks.isCurrent(banner.item) || Date.now() - banner.requestedAt >= 30_000) {
      banner.handle.close(); this.taskBanners.delete(key);
    }
    if (budget <= 0 || this.inactive || this.dirty || this.host.isWindowFocused() || !this.host.isSupported()) return 0;
    let requested = 0;
    for await (const item of tasks.read()) {
      if (this.inactive || this.dirty || this.host.isWindowFocused()) break;
      if (!tasks.isCurrent(item) || !await tasks.current(item.reference) || !await this.host.canNotify()) continue;
      if (this.inactive || this.dirty || this.host.isWindowFocused() || !tasks.isCurrent(item)) break;
      const key = item.reference.runId;
      const notification = this.host.create({ title: item.reference.state === 'completed' ? 'Ariadne 任务已完成' : 'Ariadne 任务失败',
        body: `${truncate(item.title, 96)}\n打开 Ariadne 查看${item.reference.state === 'completed' ? '结果' : '任务详情'}。`, taskNavigation: item.reference });
      tasks.receipts.requested(item.reference);
      this.taskBanners.get(key)?.handle.close();
      if (!this.taskBanners.has(key) && this.taskBanners.size >= 3) {
        const oldest = this.taskBanners.entries().next().value;
        if (oldest) { oldest[1].handle.close(); this.taskBanners.delete(oldest[0]); }
      }
      const entry = { item, handle: notification, requestedAt: Date.now() }; this.taskBanners.set(key, entry);
      notification.onClick(() => { void this.activateTaskReference(item.reference); });
      notification.onShown(() => { if (!this.inactive && this.taskBanners.get(key) === entry) tasks.receipts.shown(item.reference); });
      notification.onClosed(() => { if (this.taskBanners.get(key) === entry) this.taskBanners.delete(key); });
      notification.onFailed(() => { if (this.taskBanners.get(key) === entry) { this.taskBanners.delete(key); tasks.receipts.failed(item.reference); } });
      try { notification.show(); requested++; }
      catch { this.taskBanners.delete(key); tasks.receipts.failed(item.reference); }
      if (requested >= budget) break;
    }
    return requested;
  }

  async activateTaskReference(reference: TaskNotificationReference): Promise<void> {
    if (this.inactive) return;
    let current: TaskCenterNavigationResult | null = null;
    try { current = await this.tasks?.current(reference) ?? null; } catch { /* Wake without stale navigation. */ }
    if (this.inactive) return;
    try {
      if (current && this.host.activateTask) await this.host.activateTask(current);
      else await this.host.activateApplication();
      await this.refresh();
    } catch { console.error('Task notification navigation could not be completed.'); }
  }

  async activateReference(item: DecisionNotificationReference): Promise<void> {
    if (this.inactive) return;
    let current: DecisionNotificationItem | null = null;
    try {
      current = await this.readCurrent(item);
    } catch { /* A failed reference lookup can wake the app without stale navigation. */ }
    if (this.inactive) return;
    try {
      if (current) await this.host.activateApplication(current.sessionId, current.decisionId);
      else await this.host.activateApplication();
      await this.refresh();
    } catch { console.error('Notification navigation could not be completed.'); }
  }

  showTestNotification(): { shown: boolean; supported: boolean } {
    const supported = this.host.isSupported();
    if (!supported || this.inactive) return { shown: false, supported };
    const notification = this.host.create({ title: 'Ariadne 权限通知测试',
      body: '这是后台权限申请的 Windows 通知预览。点击可返回 Ariadne。' });
    notification.onClick(() => {
      if (this.inactive) return;
      void Promise.resolve().then(() => this.host.activateApplication())
        .catch(() => { console.error('Notification navigation could not be completed.'); });
    });
    notification.show();
    return { shown: true, supported };
  }

  dispose(): void {
    this.disposed = true;
    for (const notification of this.visible.values()) notification.handle.close();
    this.visible.clear(); this.retryAfter.clear(); this.pending.clear();
    for (const entry of this.taskBanners.values()) entry.handle.close();
    this.taskBanners.clear();
  }

  /** Stop the existing consumer; never replace it with a second reader. */
  async pauseForMaintenance(): Promise<void> {
    this.paused = true; this.dirty = false;
    const handles = [...this.visible.values(), ...this.taskBanners.values()].map(entry => entry.handle);
    this.visible.clear(); this.taskBanners.clear();
    for (const handle of handles) handle.close();
    await this.sync;
    await this.receipts.flush();
  }

  resumeAfterMaintenance(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.paused = false;
    return this.refresh();
  }
}

function truncate(value: string, maximumLength: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > maximumLength ? `${normalized.slice(0, maximumLength - 1)}…` : normalized;
}
