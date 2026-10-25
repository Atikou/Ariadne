import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { taskCenterFilterSchema, taskDirectoryRowSchema, taskReferenceKey, taskReferenceSchema,
  taskSourceSchema, type TaskCenterFilter, type TaskDirectoryRow, type TaskReference } from '@ariadne/protocol/public';

/** Same leased derived connection as the immutable snapshots; only public metadata. */
export class TaskQueryCurrentIndex {
  constructor(private readonly database: DatabaseSync) {}
  merge(source: TaskReference['source'], tag: string, rows: readonly TaskDirectoryRow[]): void {
    taskSourceSchema.parse(source);
    if (!tag || tag.length > 128 || rows.length > 128) throw new Error('task_query_current_batch_invalid');
    const validated = rows.map(row => taskDirectoryRowSchema.parse(row));
    if (validated.some(row => row.metadata.reference.source !== source)) throw new Error('task_query_current_source_mismatch');
    const insert = this.database.prepare(`INSERT INTO task_query_current VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_key) DO UPDATE SET source=excluded.source,workspace_id=excluded.workspace_id,
      session_id=excluded.session_id,state=excluded.state,archived=excluded.archived,sort_time=excluded.sort_time,
      scan_tag=excluded.scan_tag,row_json=excluded.row_json`);
    for (const row of validated) insert.run(taskReferenceKey(row.metadata.reference), source,
      row.metadata.workspaceId, row.metadata.sessionId, row.metadata.state, row.archived ? 1 : 0,
      row.metadata.updatedAt ?? '', tag, JSON.stringify(row));
  }
  finish(source: TaskReference['source'], tag: string): void {
    taskSourceSchema.parse(source);
    this.database.prepare('DELETE FROM task_query_current WHERE source=? AND scan_tag<>?').run(source, tag);
  }
  item(reference: TaskReference): TaskDirectoryRow | null {
    const row = this.database.prepare('SELECT row_json FROM task_query_current WHERE task_key=?')
      .get(taskReferenceKey(taskReferenceSchema.parse(reference)));
    return row ? taskDirectoryRowSchema.parse(JSON.parse(String(row.row_json))) : null;
  }
  mergeDecisions(tag: string, decisions: readonly TaskDirectoryRow['decisions'][number][]): void {
    if (!tag || tag.length > 128 || decisions.length > 128) throw new Error('task_query_decision_batch_invalid');
    const insert = this.database.prepare(`INSERT INTO task_query_decisions VALUES (?,?,?,?,?,?)
      ON CONFLICT(decision_id) DO UPDATE SET workspace_id=excluded.workspace_id,session_id=excluded.session_id,
      run_id=excluded.run_id,scan_tag=excluded.scan_tag,reference_json=excluded.reference_json`);
    for (const input of decisions) {
      const decision = taskDirectoryRowSchema.shape.decisions.element.parse(input);
      insert.run(decision.decisionId, decision.workspaceId, decision.sessionId, decision.runId, tag, JSON.stringify(decision));
    }
  }
  finishDecisions(tag: string): void {
    this.database.prepare('DELETE FROM task_query_decisions WHERE scan_tag<>?').run(tag);
  }
  decisions(workspaceId: string, sessionId: string, runId: string): TaskDirectoryRow['decisions'] {
    const rows = this.database.prepare(`SELECT reference_json FROM task_query_decisions
      WHERE workspace_id=? AND session_id=? AND run_id=? ORDER BY decision_id LIMIT 129`).all(workspaceId, sessionId, runId);
    if (rows.length > 128) throw new Error('task_query_decision_summary_incomplete');
    return rows.map(row => taskDirectoryRowSchema.shape.decisions.element.parse(JSON.parse(String(row.reference_json))));
  }
  /** Snapshot copying is one synchronous SQL statement, without an unbounded JS result array. */
  capture(snapshotId: string, input: TaskCenterFilter, authorizedWorkspaces: readonly string[] | null): void {
    const filter = taskCenterFilterSchema.parse(input), clauses: string[] = [], parameters: SQLInputValue[] = [snapshotId];
    const select = (field: string, values: readonly string[]) => {
      clauses.push(values.length ? `${field} IN (${values.map(() => '?').join(',')})` : '0'); parameters.push(...values);
    };
    if (authorizedWorkspaces !== null) select('workspace_id', authorizedWorkspaces);
    if (filter.reference !== null) { clauses.push('task_key=?'); parameters.push(taskReferenceKey(filter.reference)); }
    if (filter.workspaceId !== null) { clauses.push('workspace_id=?'); parameters.push(filter.workspaceId); }
    if (filter.sessionId !== null) { clauses.push('session_id=?'); parameters.push(filter.sessionId); }
    if (!filter.includeArchived) clauses.push('archived=0');
    select('source', filter.sources);
    if (filter.states.length) select('state', filter.states);
    if (filter.updatedFrom !== null) { clauses.push('sort_time>=?'); parameters.push(filter.updatedFrom); }
    if (filter.updatedThrough !== null) { clauses.push("sort_time<>'' AND sort_time<=?"); parameters.push(filter.updatedThrough); }
    this.database.prepare(`INSERT INTO task_query_rows SELECT ?,task_key,sort_time,row_json FROM task_query_current WHERE ${clauses.join(' AND ')}`)
      .run(...parameters);
  }
}
