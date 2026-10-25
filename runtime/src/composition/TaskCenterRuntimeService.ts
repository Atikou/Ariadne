import { createHash } from 'node:crypto';
import { TASK_CENTER_QUERY_VERSION, taskCenterQuerySchema, type TaskCenterQuery,
  type TaskCenterPage, type TaskCenterNavigation, type TaskCenterNavigationResult, type TaskCenterRelationsQuery,
  type taskCenterResetSchema } from '@ariadne/protocol/public';
import type { z } from 'zod';
import type { ShutdownContext } from '../ingress/ShutdownContext.js';
import { TaskQuerySnapshotReset } from '../adapters/persistence/TaskQuerySnapshotRecords.js';
import { TaskCenterSourceCollector, type TaskCenterSources } from './TaskCenterSourceCollector.js';
import { TaskCenterNavigationResolver } from './TaskCenterNavigationResolver.js';
import { TaskCenterRelationReader } from './TaskCenterRelationReader.js';

/** One bounded background scan; query calls copy the current public read model into fixed pages. */
export class TaskCenterRuntimeService {
  private readonly collector: TaskCenterSourceCollector;
  private readonly navigation: TaskCenterNavigationResolver;
  private readonly authorization: readonly string[] | null;
  private readonly scopeKey: string;
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private started = false;
  constructor(private readonly sources: TaskCenterSources) {
    this.authorization = sources.authorizedWorkspaceIds.length ? [...sources.authorizedWorkspaceIds].sort() : null;
    this.scopeKey = createHash('sha256').update(JSON.stringify(this.authorization)).digest('hex');
    this.collector = new TaskCenterSourceCollector(sources); this.navigation = new TaskCenterNavigationResolver(sources);
  }
  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true; this.refresh();
    this.timer = setInterval(() => this.refresh(), 10_000); this.timer.unref();
  }
  refresh(): void {
    if (this.active !== null || this.controller.signal.aborted || !this.sources.index.available) return;
    this.active = this.collector.collect(this.controller.signal).catch(() => {
      // Source diagnostics are minimal watermarks. Shutdown abort is not a source result.
    }).finally(() => { this.active = null; });
  }
  async query(input: TaskCenterQuery, signal: AbortSignal): Promise<TaskCenterPage | z.infer<typeof taskCenterResetSchema>> {
    const request = taskCenterQuerySchema.parse(input); signal.throwIfAborted();
    if (this.controller.signal.aborted || !this.sources.index.available) return this.reset('unavailable');
    if (request.filter.workspaceId !== null && this.authorization !== null
      && !this.authorization.includes(request.filter.workspaceId)) return this.reset('scope_changed');
    if (request.filter.sessionId !== null) {
      const owner = await this.sources.conversation.readSession(request.filter.sessionId);
      signal.throwIfAborted();
      if (owner === null || owner.workspaceId !== request.filter.workspaceId) return this.reset('scope_changed');
    }
    if (request.cursor === null && request.refresh) this.refresh();
    try {
      const snapshot = request.cursor === null ? this.sources.index.captureCurrent(this.scopeKey,
        request.filter, this.collector.watermarks(), this.authorization) : null;
      signal.throwIfAborted();
      return this.sources.index.page(this.scopeKey, request.filter, snapshot, request.cursor, request.limit);
    } catch (error) {
      signal.throwIfAborted();
      return this.reset(error instanceof TaskQuerySnapshotReset ? error.reason : 'unavailable');
    }
  }
  async navigate(request: TaskCenterNavigation, signal: AbortSignal): Promise<TaskCenterNavigationResult> {
    signal.throwIfAborted();
    return this.navigation.resolve(request, signal);
  }
  relations(request: TaskCenterRelationsQuery, signal: AbortSignal) {
    signal.throwIfAborted();
    return new TaskCenterRelationReader(this.sources).read(request, signal);
  }
  async stop(context: ShutdownContext): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer); this.timer = null;
    this.controller.abort(new Error('task_center_stopping'));
    await this.active; context.throwIfExpired();
  }
  private reset(reason: z.infer<typeof taskCenterResetSchema>['reason']): z.infer<typeof taskCenterResetSchema> {
    return { kind: 'tasks.query_reset', contractVersion: TASK_CENTER_QUERY_VERSION, reason };
  }
}
