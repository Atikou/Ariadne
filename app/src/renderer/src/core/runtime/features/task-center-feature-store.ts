import { TASK_CENTER_QUERY_VERSION, taskCenterFilterSchema, taskCenterPageSchema, taskCenterNavigationResultSchema,
  taskReferenceKey, type TaskCenterFilter, type TaskCenterPage, type TaskDirectoryRow, type TaskCenterNavigation,
  type TaskCenterNavigationResult, taskCenterRelationsResultSchema, type TaskCenterRelationsResult } from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';

export interface TaskCenterSnapshot {
  readonly filter: TaskCenterFilter; readonly page: TaskCenterPage | null;
  readonly loading: boolean; readonly navigating: boolean; readonly error: string | null;
  readonly pageNumber: number; readonly hasPrevious: boolean; readonly releasedPrevious: boolean;
  readonly selectedKey: string | null; readonly selected: TaskDirectoryRow | null; readonly scrollTop: number;
}
const initialFilter: TaskCenterFilter = { reference: null, workspaceId: null, sessionId: null, includeArchived: false,
  sources: ['run', 'goal', 'workflow', 'schedule', 'occurrence'], states: [], updatedFrom: null, updatedThrough: null };
const navigationMessages: Record<Exclude<TaskCenterNavigationResult['status'], 'ok'>, string> = {
  missing: '原记录已不存在或不属于此会话。', unauthorized: '当前没有权限访问此任务。', archived: '目标会话已归档，请先恢复会话。',
  stale: '任务状态已变化，请刷新后重新选择。', unavailable: '原记录暂时不可用，请重试或查看恢复入口。', pending: '结果还在同步，请稍后重试。'
};

/** One public page plus at most 32 previous cursor positions; filters survive module/session navigation. */
export class TaskCenterFeatureStore {
  private state: TaskCenterSnapshot = { filter: initialFilter, page: null, loading: false, navigating: false,
    error: null, pageNumber: 1, hasPrevious: false, releasedPrevious: false, selectedKey: null, selected: null, scrollTop: 0 };
  private readonly listeners = new Set<() => void>();
  private currentCursor: string | null = null;
  private previous: Array<string | null> = [];
  private generation = 0;
  private navigationGeneration = 0;
  readonly view = { getSnapshot: () => this.state,
    subscribe: (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; } };
  constructor(private readonly gateway: RuntimeFeatureCommandGateway) {}
  async setFilter(input: TaskCenterFilter): Promise<void> {
    const filter = taskCenterFilterSchema.parse(input);
    this.patch({ filter, scrollTop: 0, selectedKey: null, selected: null }); await this.refresh(false);
  }
  async refresh(sourceRefresh = true): Promise<void> {
    this.previous = []; this.currentCursor = null;
    this.patch({ page: null, pageNumber: 1, hasPrevious: false, releasedPrevious: false });
    await this.read(null, sourceRefresh);
  }
  async navigatePage(direction: 'next' | 'previous'): Promise<void> {
    if (this.state.loading) return;
    const previous = [...this.previous];
    let cursor: string | null, releasedPrevious = this.state.releasedPrevious;
    if (direction === 'next') {
      if (!this.state.page?.nextCursor) return;
      cursor = this.state.page.nextCursor;
      previous.push(this.currentCursor);
      if (previous.length > 32) { previous.shift(); releasedPrevious = true; }
    } else {
      if (!previous.length) return;
      cursor = previous.pop()!;
    }
    await this.read(cursor, false, { previous, releasedPrevious,
      pageNumber: this.state.pageNumber + (direction === 'next' ? 1 : -1) });
  }
  rememberScroll(scrollTop: number): void {
    if (Number.isFinite(scrollTop)) this.patch({ scrollTop: Math.max(0, scrollTop) });
  }
  select(row: TaskDirectoryRow): void {
    this.navigationGeneration++;
    this.patch({ selectedKey: taskReferenceKey(row.metadata.reference), selected: row, navigating: false });
  }
  async requestNavigation(row: TaskDirectoryRow, destination: TaskCenterNavigation['destination'],
    decision: TaskDirectoryRow['decisions'][number] | null = null): Promise<TaskCenterNavigationResult | null> {
    const generation = ++this.navigationGeneration;
    this.patch({ navigating: true, error: null, selectedKey: taskReferenceKey(row.metadata.reference) });
    try {
      const result = await this.gateway.execute({ kind: 'tasks.navigate', contractVersion: TASK_CENTER_QUERY_VERSION,
        reference: row.metadata.reference, workspaceId: row.metadata.workspaceId, sessionId: row.metadata.sessionId,
        expectedVersion: row.metadata.version, expectedAttempts: row.metadata.attempts, expectedSourceStatus: row.metadata.sourceStatus,
        destination, decisionId: decision?.decisionId ?? null, expectedDecisionVersion: decision?.version ?? null });
      if (generation !== this.navigationGeneration) return null;
      const parsed = taskCenterNavigationResultSchema.parse(result);
      if (taskReferenceKey(parsed.reference) !== taskReferenceKey(row.metadata.reference)
        || parsed.workspaceId !== row.metadata.workspaceId || parsed.sessionId !== row.metadata.sessionId)
        throw new Error('task_navigation_scope_mismatch');
      if (parsed.status !== 'ok') this.patch({ error: navigationMessages[parsed.status] });
      return parsed;
    } catch { if (generation === this.navigationGeneration) this.patch({ error: '任务导航失败，请重试。' }); return null; }
    finally { if (generation === this.navigationGeneration) this.patch({ navigating: false }); }
  }
  dispose(): void { this.generation++; this.navigationGeneration++; this.listeners.clear(); }
  async lookup(reference: TaskDirectoryRow['metadata']['reference'], workspaceId: string, sessionId: string): Promise<TaskDirectoryRow | null> {
    const generation = this.generation;
    const filter: TaskCenterFilter = { ...initialFilter, reference, workspaceId, sessionId, includeArchived: true };
    const result = await this.gateway.execute({ kind: 'tasks.query', contractVersion: TASK_CENTER_QUERY_VERSION,
      filter, cursor: null, limit: 1, refresh: false });
    if (generation !== this.generation || result.kind !== 'tasks.query_result') return null;
    const page = taskCenterPageSchema.parse(result);
    if (JSON.stringify(page.filter) !== JSON.stringify(filter)) throw new Error('任务关联查询范围已变化。');
    const row = page.rows[0];
    return row && taskReferenceKey(row.metadata.reference) === taskReferenceKey(reference)
      && row.metadata.workspaceId === workspaceId && row.metadata.sessionId === sessionId ? row : null;
  }
  async relations(row: TaskDirectoryRow, afterIndex: number): Promise<TaskCenterRelationsResult | null> {
    const metadata = row.metadata;
    if (metadata.reference.source === 'run') return null;
    const generation = this.generation;
    const result = taskCenterRelationsResultSchema.parse(await this.gateway.execute({ kind: 'tasks.relations',
      contractVersion: TASK_CENTER_QUERY_VERSION, reference: { source: metadata.reference.source, sourceId: metadata.reference.sourceId },
      workspaceId: metadata.workspaceId, sessionId: metadata.sessionId, expectedVersion: metadata.version,
      expectedAttempts: metadata.attempts, expectedSourceStatus: metadata.sourceStatus, afterIndex, limit: 32 }));
    if (generation !== this.generation) return null;
    if (taskReferenceKey(result.reference) !== taskReferenceKey(metadata.reference) || result.workspaceId !== metadata.workspaceId
      || result.sessionId !== metadata.sessionId || result.expectedVersion !== metadata.version || result.expectedAttempts !== metadata.attempts
      || result.expectedSourceStatus !== metadata.sourceStatus || result.afterIndex !== afterIndex) throw new Error('任务关联范围已变化。');
    if (result.status !== 'ok') throw new Error(navigationMessages[result.status]);
    return result;
  }
  private async read(cursor: string | null, refresh: boolean, navigation?: {
    previous: Array<string | null>; releasedPrevious: boolean; pageNumber: number;
  }): Promise<void> {
    const generation = ++this.generation; this.navigationGeneration++;
    const filter = this.state.filter, snapshotId = cursor === null ? null : this.state.page?.snapshotId;
    this.patch({ loading: true, navigating: false, error: null });
    try {
      const result = await this.gateway.execute({ kind: 'tasks.query', contractVersion: TASK_CENTER_QUERY_VERSION,
        filter, cursor, limit: 32, refresh });
      if (generation !== this.generation) return;
      if (result.kind === 'tasks.query_reset') {
        this.previous = []; this.currentCursor = null;
        this.patch({ page: null, selected: null, selectedKey: null, pageNumber: 1, hasPrevious: false, releasedPrevious: false,
          error: result.reason === 'unavailable' ? '任务目录暂时不可用，请重试。'
          : result.reason === 'scope_changed' ? '查询范围已变化或不可访问，请重新选择范围。' : '查询页已失效，请刷新列表。' });
        return;
      }
      const page = taskCenterPageSchema.parse(result);
      if (JSON.stringify(page.filter) !== JSON.stringify(filter)
        || (snapshotId !== null && snapshotId !== undefined && page.snapshotId !== snapshotId)) throw new Error('task_page_scope_mismatch');
      this.currentCursor = page.pageCursor;
      if (navigation) this.previous = navigation.previous;
      const selected = page.rows.find(row => taskReferenceKey(row.metadata.reference) === this.state.selectedKey) ?? this.state.selected;
      this.patch({ page, selected, ...(navigation ? { pageNumber: navigation.pageNumber,
        hasPrevious: navigation.previous.length > 0, releasedPrevious: navigation.releasedPrevious, scrollTop: 0 } : {}) });
    } catch { if (generation === this.generation) this.patch({ error: '任务目录读取失败，请重试。' }); }
    finally { if (generation === this.generation) this.patch({ loading: false }); }
  }
  private patch(update: Partial<TaskCenterSnapshot>): void {
    this.state = { ...this.state, ...update }; for (const listener of this.listeners) listener();
  }
}
