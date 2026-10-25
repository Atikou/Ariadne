import { taskCenterPageSchema, runtimeResultSchema, type RuntimeCommand, type RuntimeResult,
  type TaskCenterNavigationResult, type TaskDirectoryRow } from '@ariadne/protocol/public';
import { taskNotificationReferenceSchema, type TaskNotificationReference } from '@shared/task-notification';
import { TaskNotificationReceipts, type TaskNotificationPreferences } from '../persistence/task-notification-receipts';

export interface TaskNotificationItem { reference: TaskNotificationReference; title: string; preferenceRevision: number }

/** Reads the authorized task directory in bounded, immutable pages. Completion
 * means an actual Core terminal run, never a submitted schedule occurrence. */
export class TaskNotificationSource {
  private preferenceRevision = 0;
  private preferenceKey: string | null = null;
  constructor(private readonly request: (command: RuntimeCommand) => Promise<RuntimeResult>,
    readonly receipts: TaskNotificationReceipts, private readonly preferences: () => TaskNotificationPreferences) {}
  configure(): void {
    const preferences = this.preferences(), key = JSON.stringify(preferences);
    if (key !== this.preferenceKey) { this.preferenceKey = key; this.preferenceRevision++; }
    this.receipts.configure(preferences);
  }
  isCurrent(item: TaskNotificationItem): boolean { return item.preferenceRevision === this.preferenceRevision && this.enabled(item.reference); }
  async *read(): AsyncGenerator<TaskNotificationItem> {
    this.configure();
    const preferenceRevision = this.preferenceRevision;
    const windows = this.receipts.configure(this.preferences());
    const states = (['completed', 'failed'] as const).filter(state => windows[state] !== undefined);
    if (!states.length) return;
    const filter = { reference: null, workspaceId: null, sessionId: null, includeArchived: false,
      sources: ['run'] as ['run'], states, updatedFrom: states.map(state => windows[state]!).sort()[0]!, updatedThrough: null };
    let cursor: string | null = null, snapshotId: string | null = null, previousKey: string | null = null, scanned = 0;
    do {
      const result = await this.request({ kind: 'tasks.query', contractVersion: '1.0', filter, cursor, limit: 128, refresh: false });
      if (preferenceRevision !== this.preferenceRevision) return;
      if (result.kind !== 'tasks.query_result') throw new Error('task_notification_source_unavailable');
      const page = taskCenterPageSchema.parse(result);
      if (JSON.stringify(page.filter) !== JSON.stringify(filter)
        || (snapshotId !== null && page.snapshotId !== snapshotId)
        || page.watermarks.some(row => row.source !== 'productivity' && row.status !== 'ready'))
        throw new Error('task_notification_source_incomplete');
      snapshotId = page.snapshotId;
      for (const row of page.rows) {
        const key = `${row.metadata.updatedAt ?? ''}\u0000${row.metadata.reference.sourceId}`;
        // The page contract verifies each page; enforce continuation without an unbounded seen-ID set.
        if (previousKey !== null) {
          const [lastTime, lastId] = previousKey.split('\u0000');
          const time = row.metadata.updatedAt ?? '';
          if (time > lastTime! || (time === lastTime && row.metadata.reference.sourceId <= lastId!))
            throw new Error('task_notification_page_order_invalid');
        }
        previousKey = key;
        if (++scanned > page.indexedTotal) throw new Error('task_notification_page_total_invalid');
        const item = this.item(row, windows);
        if (preferenceRevision !== this.preferenceRevision) return;
        if (item && this.receipts.eligible(item.reference)) yield item;
      }
      if (page.nextCursor !== null && (page.nextCursor === cursor || page.rows.length === 0)) throw new Error('task_notification_page_cursor_invalid');
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
  enabled(reference: TaskNotificationReference): boolean { return this.preferences()[reference.state]; }
  async current(reference: TaskNotificationReference): Promise<TaskCenterNavigationResult | null> {
    const ref = taskNotificationReferenceSchema.parse(reference);
    const result = runtimeResultSchema.parse(await this.request({ kind: 'tasks.navigate', contractVersion: '1.0',
      reference: { source: 'run', sourceId: ref.runId }, workspaceId: ref.workspaceId, sessionId: ref.sessionId,
      expectedVersion: ref.version, expectedAttempts: null, expectedSourceStatus: ref.sourceStatus,
      decisionId: null, expectedDecisionVersion: null, destination: ref.state === 'completed' ? 'result' : 'details' }));
    if (result.kind !== 'tasks.navigate_result' || result.status !== 'ok' || result.reference.source !== 'run'
      || result.reference.sourceId !== ref.runId || result.workspaceId !== ref.workspaceId || result.sessionId !== ref.sessionId
      || result.current?.version !== ref.version || result.current.state !== ref.state || result.current.sourceStatus !== ref.sourceStatus
      || result.target?.workspaceId !== ref.workspaceId || result.target.sessionId !== ref.sessionId
      || result.target.runId !== ref.runId || result.target.expectedRunVersion !== ref.version) return null;
    return result;
  }
  private item(row: TaskDirectoryRow, windows: Partial<Record<'completed' | 'failed', string>>): TaskNotificationItem | null {
    const metadata = row.metadata;
    if (row.archived || metadata.reference.source !== 'run' || metadata.version === null || metadata.updatedAt === null
      || (metadata.state !== 'completed' && metadata.state !== 'failed') || !windows[metadata.state]
      || metadata.updatedAt < windows[metadata.state]! || (metadata.state === 'completed' && row.result !== 'available')) return null;
    return { reference: taskNotificationReferenceSchema.parse({ runId: metadata.reference.sourceId, workspaceId: metadata.workspaceId,
      sessionId: metadata.sessionId, version: metadata.version, state: metadata.state, sourceStatus: metadata.sourceStatus }), title: metadata.title,
      preferenceRevision: this.preferenceRevision };
  }
}
