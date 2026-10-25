import { TASK_CENTER_QUERY_VERSION, taskCenterRelationsQuerySchema, taskCenterRelationsResultSchema,
  type TaskCenterRelationsQuery, type TaskCenterRelationsResult } from '@ariadne/protocol/public';
import type { TaskCenterSources } from './TaskCenterSourceCollector.js';
import { TaskCenterNavigationResolver } from './TaskCenterNavigationResolver.js';

/** Versioned Source links. Their total counts Source associations, not proven executions. */
export class TaskCenterRelationReader {
  constructor(private readonly sources: TaskCenterSources) {}
  async read(input: TaskCenterRelationsQuery, signal: AbortSignal): Promise<TaskCenterRelationsResult> {
    const request = taskCenterRelationsQuerySchema.parse(input);
    const { limit: _limit, kind: _kind, ...identity } = request;
    const outcome = (status: TaskCenterRelationsResult['status'], rows: TaskCenterRelationsResult['rows'] = [],
      sourceTotal: number | null = null, nextIndex: number | null = null): TaskCenterRelationsResult => taskCenterRelationsResultSchema.parse({
      ...identity, kind: 'tasks.relations_result', status, rows, sourceTotal, nextIndex });
    const navigation = new TaskCenterNavigationResolver(this.sources);
    const sourceNavigation = { kind: 'tasks.navigate' as const, contractVersion: TASK_CENTER_QUERY_VERSION,
      reference: request.reference, workspaceId: request.workspaceId, sessionId: request.sessionId,
      expectedVersion: request.expectedVersion, expectedAttempts: request.expectedAttempts,
      expectedSourceStatus: request.expectedSourceStatus, destination: 'details' as const, decisionId: null, expectedDecisionVersion: null };
    const before = await navigation.resolve(sourceNavigation, signal);
    if (before.status !== 'ok') return outcome(before.status === 'pending' ? 'unavailable' : before.status);
    if (!this.sources.productivity) return outcome('unavailable');
    const page = await this.sources.productivity.readTaskRelations({ workspaceIds: [request.workspaceId],
      session: { workspaceId: request.workspaceId, sessionId: request.sessionId } }, request.reference,
    { version: request.expectedVersion, attempts: request.expectedAttempts }, request.afterIndex, request.limit);
    signal.throwIfAborted();
    if (page.status !== 'ok') return outcome(page.status);
    const rows: TaskCenterRelationsResult['rows'] = [];
    for (const link of page.rows) {
      signal.throwIfAborted();
      if (this.sources.authorizedWorkspaceIds.length && !this.sources.authorizedWorkspaceIds.includes(link.owner.workspaceId)) continue;
      const owner = await this.sources.conversation.readSession(link.owner.sessionId);
      if (owner?.workspaceId !== link.owner.workspaceId) continue;
      if (link.reference.source === 'run') {
        const run = await this.sources.loadRun(link.reference.sourceId);
        if (run?.binding.workspace.workspaceId !== link.owner.workspaceId || run.binding.sessionId !== link.owner.sessionId) continue;
      }
      rows.push(link);
    }
    const after = await navigation.resolve(sourceNavigation, signal);
    if (after.status !== 'ok') return outcome(after.status === 'pending' ? 'unavailable' : after.status);
    return outcome('ok', rows, page.total, page.nextIndex);
  }
}
