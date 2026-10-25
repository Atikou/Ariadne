import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { publicProjectionCanonicalIdSchema, taskReferenceSchema, taskRelationSchema, taskSourceMetadataSchema,
  type TaskSourceMetadata } from '@ariadne/protocol/public';
import type { ProductivityTaskCatalogPageV1, ProductivityTaskReadScope, ProductivityTaskReference } from '../../control/ports/ProductivityTaskCatalogReadV1.js';

type SourceRow = {
  source: ProductivityTaskReference['source']; source_id: string; workspace_id: string; session_id: string;
  version: number | null; attempts: number | null; status: string; title: string; updated_at: string | null; due_at: string | null;
  body_id: string | null; body_version: number | null; body_status: string | null;
  body_workspace: string | null; body_session: string | null; autonomy_status: string | null;
};
const sources = `
  SELECT 'goal' source,goal_id source_id,workspace_id,session_id,version,NULL attempts,status,
    json_extract(goal_json,'$.title') title,updated_at,json_extract(goal_json,'$.agentExecution.deadlineAt') due_at,
    json_extract(goal_json,'$.goalId') body_id,json_extract(goal_json,'$.version') body_version,
    json_extract(goal_json,'$.status') body_status,json_extract(goal_json,'$.workspaceId') body_workspace,
    json_extract(goal_json,'$.sessionId') body_session,json_extract(goal_json,'$.agentExecution.status') autonomy_status
    FROM productivity_goals
  UNION ALL SELECT 'workflow',workflow_id,workspace_id,session_id,version,NULL,status,
    '工作流 #'||substr(workflow_id,-8),updated_at,json_extract(workflow_json,'$.deadlineAt'),
    json_extract(workflow_json,'$.workflowId'),json_extract(workflow_json,'$.version'),json_extract(workflow_json,'$.status'),NULL,NULL,NULL
    FROM productivity_workflows
  UNION ALL SELECT 'schedule',schedule_id,workspace_id,session_id,version,NULL,status,
    '调度 #'||substr(schedule_id,-8),updated_at,next_fire_at,json_extract(schedule_json,'$.scheduleId'),
    json_extract(schedule_json,'$.version'),json_extract(schedule_json,'$.status'),json_extract(schedule_json,'$.workspaceId'),json_extract(schedule_json,'$.sessionId'),NULL
    FROM productivity_schedules
  UNION ALL SELECT 'occurrence',occurrence_id,workspace_id,session_id,NULL,attempts,status,
    '触发 #'||substr(occurrence_id,-8),NULL,due_at,NULL,NULL,NULL,NULL,NULL,NULL FROM productivity_schedule_occurrences
`;

/** Uses the existing owner's connection and read transaction; selects no prompt or result body. */
export class SqliteProductivityTaskCatalogRead {
  constructor(private readonly database: DatabaseSync) {}

  readPage(scope: ProductivityTaskReadScope, after: ProductivityTaskReference | null, limit: number): ProductivityTaskCatalogPageV1 {
    validateLimit(limit);
    const { predicate, parameters } = scopedPredicate(scope);
    if (after !== null) {
      if (taskReferenceSchema.parse(after).source === 'run') throw new Error('productivity_task_catalog_cursor_source_invalid');
      parameters.push(after.source, after.source, after.sourceId);
    }
    const rows = this.database.prepare(`SELECT * FROM (${sources}) WHERE ${predicate}
      ${after === null ? '' : 'AND (source>? OR (source=? AND source_id>?))'} ORDER BY source,source_id LIMIT ?`)
      .all(...parameters, limit + 1) as unknown as SourceRow[];
    const page = rows.slice(0, limit), last = page.at(-1);
    return { rows: page.map(row => this.metadata(row)), next: rows.length > limit && last
      ? { source: last.source, sourceId: last.source_id } : null,
      observedAt: new Date().toISOString(), eventCursor: Number(this.database.prepare('SELECT coalesce(max(cursor),0) cursor FROM productivity_events').get()!.cursor) };
  }

  readItem(scope: ProductivityTaskReadScope, reference: ProductivityTaskReference): TaskSourceMetadata | null {
    const row = this.sourceRow(scope, reference);
    return row ? this.metadata(row) : null;
  }

  readRelations(scope: ProductivityTaskReadScope, reference: ProductivityTaskReference,
    expected: Pick<TaskSourceMetadata, 'version' | 'attempts'>, afterIndex: number, limit: number) {
    validateLimit(limit);
    if (!Number.isSafeInteger(afterIndex) || afterIndex < 0) throw new Error('productivity_task_relation_cursor_invalid');
    const row = this.sourceRow(scope, reference);
    if (!row) return { status: 'missing' as const };
    this.assertSourceIdentity(row);
    if (row.version !== expected.version || row.attempts !== expected.attempts)
      return { status: 'stale' as const, currentVersion: row.version, currentAttempts: row.attempts };
    const total = this.linkCount(reference), rows = this.links(row, afterIndex, limit);
    return { status: 'ok' as const, rows, total, nextIndex: afterIndex + rows.length < total ? afterIndex + rows.length : null };
  }

  private sourceRow(scope: ProductivityTaskReadScope, reference: ProductivityTaskReference): SourceRow | null {
    if (taskReferenceSchema.parse(reference).source === 'run') throw new Error('productivity_task_catalog_reference_source_invalid');
    const { predicate, parameters } = scopedPredicate(scope);
    return this.database.prepare(`SELECT * FROM (${sources}) WHERE ${predicate} AND source=? AND source_id=?`)
      .get(...parameters, reference.source, reference.sourceId) as unknown as SourceRow | undefined ?? null;
  }

  private assertSourceIdentity(row: SourceRow): void {
    if (row.source === 'occurrence') return;
    if (row.body_id !== row.source_id || row.body_version !== row.version || row.body_status !== row.status
      || (row.source !== 'workflow' && (row.body_workspace !== row.workspace_id || row.body_session !== row.session_id)))
      throw new Error('productivity_task_catalog_source_identity_conflict');
  }

  private metadata(row: SourceRow): TaskSourceMetadata {
    this.assertSourceIdentity(row);
    const reference = { source: row.source, sourceId: row.source_id }, relationTotal = this.linkCount(reference);
    const relations = this.links(row, 0, 32);
    const runReferenceTotal = this.database.prepare(`SELECT count(*) count FROM (${linkSql(reference.source)}) WHERE target_source='run'`).get(reference.sourceId)!.count;
    const runReferences = this.database.prepare(`SELECT * FROM (${linkSql(reference.source)}) WHERE target_source='run' ORDER BY kind,target_source,target_id,target_session LIMIT 32`)
      .all(reference.sourceId).map(link => ({ workspaceId: row.workspace_id, sessionId: String(link.target_session), runId: String(link.target_id) }));
    return taskSourceMetadataSchema.parse({ reference, workspaceId: row.workspace_id, sessionId: row.session_id,
      title: row.title, sourceStatus: row.status, state: taskState(row), version: row.version, attempts: row.attempts,
      updatedAt: row.updated_at, dueAt: row.due_at, relations, relationTotal, runReferences, runReferenceTotal: Number(runReferenceTotal) });
  }
  private linkCount(reference: ProductivityTaskReference): number {
    return Number(this.database.prepare(`SELECT count(*) count FROM (${linkSql(reference.source)})`).get(reference.sourceId)!.count);
  }
  private links(row: SourceRow, after: number, limit: number) {
    return this.database.prepare(`SELECT * FROM (${linkSql(row.source)}) ORDER BY kind,target_source,target_id,target_session LIMIT ? OFFSET ?`)
      .all(row.source_id, limit, after).map(link => taskRelationSchema.parse({
        kind: link.kind, reference: { source: link.target_source, sourceId: link.target_id },
        owner: { workspaceId: row.workspace_id, sessionId: link.target_session } }));
  }
}

function scopedPredicate(scope: ProductivityTaskReadScope): { predicate: string; parameters: SQLInputValue[] } {
  const clauses: string[] = [], parameters: SQLInputValue[] = [];
  if (scope.workspaceIds !== null) {
    for (const id of scope.workspaceIds) publicProjectionCanonicalIdSchema.parse(id);
    clauses.push(scope.workspaceIds.length ? `workspace_id IN (${scope.workspaceIds.map(() => '?').join(',')})` : '0');
    parameters.push(...scope.workspaceIds);
  }
  if (scope.session !== null) {
    publicProjectionCanonicalIdSchema.parse(scope.session.workspaceId); publicProjectionCanonicalIdSchema.parse(scope.session.sessionId);
    clauses.push('workspace_id=? AND session_id=?'); parameters.push(scope.session.workspaceId, scope.session.sessionId);
  }
  return { predicate: clauses.join(' AND ') || '1', parameters };
}
function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('productivity_task_catalog_limit_invalid');
}
function linkSql(source: ProductivityTaskReference['source']): string {
  if (source === 'goal') return `WITH selected AS (SELECT goal_json,session_id FROM productivity_goals WHERE goal_id=?)
    SELECT DISTINCT 'workflow' kind,'workflow' target_source,item.value target_id,selected.session_id target_session
      FROM selected,json_each(selected.goal_json,'$.agentExecution.workflowIds') item
    UNION SELECT DISTINCT 'planner','run',json_extract(item.value,'$.runId'),json_extract(item.value,'$.sessionId')
      FROM selected,json_each(selected.goal_json,'$.agentExecution.tasks') item WHERE json_extract(item.value,'$.runId') IS NOT NULL`;
  if (source === 'workflow') return `WITH selected AS (SELECT workflow_json,goal_id,session_id FROM productivity_workflows WHERE workflow_id=?)
    SELECT 'goal' kind,'goal' target_source,goal_id target_id,session_id target_session FROM selected
    UNION SELECT DISTINCT 'execution','run',json_extract(item.value,'$.runId'),json_extract(item.value,'$.sessionId')
      FROM selected,json_each(selected.workflow_json,'$.agentExecution.tasks') item WHERE json_extract(item.value,'$.runId') IS NOT NULL`;
  if (source === 'occurrence') return `SELECT 'schedule' kind,'schedule' target_source,schedule_id target_id,session_id target_session
    FROM productivity_schedule_occurrences WHERE occurrence_id=?`;
  return `SELECT 'schedule' kind,'schedule' target_source,schedule_id target_id,session_id target_session
    FROM productivity_schedules WHERE schedule_id=? AND 0`;
}
function taskState(row: SourceRow): TaskSourceMetadata['state'] {
  if (row.source === 'goal') {
    if (row.status === 'complete') return 'completed';
    if (row.status === 'paused' || row.status === 'blocked') return row.status;
    if (row.status === 'active') return row.autonomy_status === 'stopping' ? 'cancelling' : 'running';
  } else if (row.source === 'schedule') {
    if (row.status === 'active') return 'scheduled';
    if (row.status === 'paused' || row.status === 'completed' || row.status === 'cancelled') return row.status;
  } else if (row.source === 'occurrence') {
    if (row.status === 'pending' || row.status === 'dispatching') return 'queued';
    if (row.status === 'submitted') return 'unknown'; // Submission alone supplies no Run execution fact.
    if (row.status === 'failed' || row.status === 'cancelled') return row.status;
  } else if (['running', 'cancelling', 'completed', 'failed', 'cancelled'].includes(row.status)) return row.status as TaskSourceMetadata['state'];
  throw new Error('productivity_task_catalog_source_status_invalid');
}
