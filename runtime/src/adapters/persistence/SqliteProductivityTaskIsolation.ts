import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { publicProjectionCanonicalIdSchema } from '@ariadne/protocol/public';
import { z } from 'zod';
import type { ProductivityTaskFaultCode, ProductivityTaskFaultV1, ProductivityTaskKind } from '../../control/ports/ProductivityTaskIsolationV1.js';
import { markAuthorityIntegrityError, readPersistedAuthorityJson } from './SqliteAuthorityHealth.js';
import { parseWorkflowExecutionRecord } from './SqliteWorkflowExecution.js';
import { parseGoalExecutionRecord } from './SqliteGoalAutonomy.js';

const id = publicProjectionCanonicalIdSchema;
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const rowSchema = z.object({
  fault_id: id, task_kind: z.enum(['workflow','goal','schedule']), entity_id: id, task_id: id,
  workspace_id: id, owner_session_id: id, session_id: id, message_id: id, create_command_id: id.nullable(), submit_command_id: id,
  source_version: integer, source_status: z.enum(['unclaimed','claimed','submitted','pending','dispatching']),
  revision: integer, state: z.enum(['quarantined','reconciling','resolved']),
  code: z.enum(['submission_identity_conflict','task_authority_conflict','result_authority_conflict','cancellation_rejected']),
  occurred_at: z.string().datetime(), updated_at: z.string().datetime(), identity_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
}).strict();
type Row = z.infer<typeof rowSchema>;
type Identity = Pick<Row, 'task_kind' | 'entity_id' | 'task_id' | 'workspace_id' | 'owner_session_id' | 'session_id' | 'message_id'
  | 'create_command_id' | 'submit_command_id' | 'source_version' | 'source_status'>;
type CurrentIdentity = Omit<Identity, 'source_status'> & { source_status: Identity['source_status'] | 'terminal' | 'failed' | 'cancelled'; source_record_digest: string };

/** Called only inside the existing Productivity owner's transaction. This
 * mapper never changes Goal/Workflow/Occurrence state or sends commands. */
export class SqliteProductivityTaskIsolation {
  public constructor(private readonly database: DatabaseSync) {}
  public quarantine(kind: ProductivityTaskKind, entityId: string, taskId: string,
    code: ProductivityTaskFaultCode, now: Date): ProductivityTaskFaultV1 | null {
    if (!this.database.isTransaction) throw new Error('productivity_task_isolation_transaction_required');
    id.parse(entityId); id.parse(taskId);
    const identity = this.currentIdentity(kind, entityId, taskId);
    if (identity === null) return null; // A real terminal source needs no quarantine.
    const existing = this.read(kind, entityId, taskId);
    if (existing !== null) {
      if (existing.state === 'quarantined') return project(existing);
      if (existing.state === 'reconciling') throw new Error('productivity_task_fault_recovery_required');
      const updated = this.update({ ...existing, ...identity, revision: existing.revision + 1,
        state: 'quarantined', code, updated_at: now.toISOString() }, existing.revision);
      return project(updated);
    }
    const timestamp = now.toISOString();
    const record = { ...identity, fault_id: faultId(kind, entityId, taskId), revision: 1,
      state: 'quarantined' as const, code, occurred_at: timestamp, updated_at: timestamp };
    const row = rowSchema.parse({ ...record, identity_digest: recordDigest(record) });
    this.database.prepare(`INSERT INTO productivity_task_faults (
      fault_id,task_kind,entity_id,task_id,workspace_id,owner_session_id,session_id,message_id,create_command_id,submit_command_id,
      source_version,source_status,revision,state,code,occurred_at,updated_at,identity_digest
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.fault_id,row.task_kind,row.entity_id,row.task_id,row.workspace_id,
      row.owner_session_id,row.session_id,row.message_id,row.create_command_id,row.submit_command_id,row.source_version,
      row.source_status,row.revision,row.state,row.code,row.occurred_at,row.updated_at,row.identity_digest);
    return project(row);
  }
  public beginReconcile(workspaceId: string, ownerSessionId: string, faultId: string, expectedRevision: number, now: Date) {
    this.requireTransaction();
    const row = this.readScoped(workspaceId, ownerSessionId, faultId);
    if (row.revision !== expectedRevision || row.state === 'resolved') throw new Error('productivity_task_fault_recovery_conflict');
    const identity = this.currentIdentity(row.task_kind, row.entity_id, row.task_id, true);
    const updated = this.update({ ...row, revision: row.revision + 1, state: 'reconciling', updated_at: now.toISOString() }, row.revision);
    return { fault: project(updated), sourceDigest: identityDigest(identity), identity };
  }
  public finishReconcile(workspaceId: string, ownerSessionId: string, faultId: string, expectedRevision: number,
    sourceDigest: string, verified: boolean, now: Date): ProductivityTaskFaultV1 {
    this.requireTransaction();
    const row = this.readScoped(workspaceId, ownerSessionId, faultId);
    if (row.revision !== expectedRevision || row.state !== 'reconciling') throw new Error('productivity_task_fault_recovery_conflict');
    const identity = this.currentIdentity(row.task_kind, row.entity_id, row.task_id, true);
    const unchanged = identityDigest(identity) === sourceDigest;
    return project(this.update({ ...row, revision: row.revision + 1,
      state: verified && unchanged ? 'resolved' : 'quarantined', updated_at: now.toISOString() }, row.revision));
  }
  public readRecoveryClaim(workspaceId: string, ownerSessionId: string, faultId: string, revision: number) {
    this.requireTransaction();
    const row = this.readScoped(workspaceId, ownerSessionId, faultId);
    if (row.revision !== revision || row.state !== 'reconciling') return null;
    const identity = this.currentIdentity(row.task_kind, row.entity_id, row.task_id, true);
    return { fault: project(row), sourceDigest: identityDigest(identity), identity };
  }
  public readFault(workspaceId: string, ownerSessionId: string, faultId: string): ProductivityTaskFaultV1 {
    this.requireTransaction();
    return project(this.readScoped(workspaceId, ownerSessionId, faultId));
  }
  private requireTransaction(): void {
    if (!this.database.isTransaction) throw new Error('productivity_task_isolation_transaction_required');
  }
  private readScoped(workspaceId: string, ownerSessionId: string, faultId: string): Row {
    id.parse(workspaceId); id.parse(ownerSessionId); id.parse(faultId);
    const value = this.database.prepare('SELECT * FROM productivity_task_faults WHERE fault_id=? AND workspace_id=? AND owner_session_id=?')
      .get(faultId, workspaceId, ownerSessionId);
    if (value === undefined) throw new Error('productivity_task_fault_not_found');
    return this.parse(value);
  }
  private update(value: Row, expectedRevision: number): Row {
    const next = rowSchema.parse({ ...value, identity_digest: recordDigest(value) });
    if (Date.parse(next.updated_at) < Date.parse(next.occurred_at)) throw new Error('productivity_task_fault_clock_regressed');
    const columns = Object.keys(rowSchema.shape).filter(column => column !== 'fault_id') as Exclude<keyof Row, 'fault_id'>[];
    const result = this.database.prepare(`UPDATE productivity_task_faults SET ${columns.map(column => `${column}=?`).join(',')}
      WHERE fault_id=? AND revision=? AND julianday(updated_at)<=julianday(?)`)
      .run(...columns.map(column => next[column]), next.fault_id, expectedRevision, next.updated_at);
    if (result.changes !== 1) throw new Error('productivity_task_fault_recovery_conflict');
    this.assertRecordedIdentity(next);
    return next;
  }
  public isQuarantined(kind: ProductivityTaskKind, entityId: string, taskId: string): boolean {
    const row = this.read(kind, entityId, taskId);
    return row !== null && row.state !== 'resolved';
  }
  public query(workspaceId: string, sessionId: string, limit: number, afterFaultId?: string):
    { readonly faults: readonly ProductivityTaskFaultV1[]; readonly nextFaultId: string | null } {
    id.parse(workspaceId); id.parse(sessionId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('productivity_task_fault_page_limit_invalid');
    if (afterFaultId !== undefined) id.parse(afterFaultId);
    const rows = this.database.prepare(`SELECT * FROM productivity_task_faults WHERE workspace_id=? AND owner_session_id=?
      AND (? IS NULL OR fault_id>?) ORDER BY fault_id LIMIT ?`).all(workspaceId, sessionId, afterFaultId ?? null, afterFaultId ?? null, limit + 1)
      .map(value => this.parse(value));
    return { faults: Object.freeze(rows.slice(0, limit).map(project)), nextFaultId: rows.length > limit ? rows[limit - 1]!.fault_id : null };
  }
  public audit(): number {
    let count = 0;
    for (const value of this.database.prepare('SELECT * FROM productivity_task_faults ORDER BY fault_id').iterate()) { this.parse(value); count += 1; }
    return count;
  }
  private read(kind: ProductivityTaskKind, entityId: string, taskId: string): Row | null {
    const value = this.database.prepare('SELECT * FROM productivity_task_faults WHERE task_kind=? AND entity_id=? AND task_id=?')
      .get(kind, entityId, taskId);
    return value === undefined ? null : this.parse(value);
  }
  private parse(value: unknown): Row {
    let row: Row;
    try { row = rowSchema.parse(value); } catch (cause) { throw corruption('shape', cause); }
    if (row.fault_id !== faultId(row.task_kind, row.entity_id, row.task_id) || row.identity_digest !== recordDigest(row)
      || Date.parse(row.updated_at) < Date.parse(row.occurred_at)
      || ((row.task_kind === 'schedule') !== (row.create_command_id === null))) throw corruption('identity');
    this.assertRecordedIdentity(row);
    return row;
  }
  private currentIdentity(kind: ProductivityTaskKind, entityId: string, taskId: string, includeTerminal?: false): Identity | null;
  private currentIdentity(kind: ProductivityTaskKind, entityId: string, taskId: string, includeTerminal: true): CurrentIdentity;
  private currentIdentity(kind: ProductivityTaskKind, entityId: string, taskId: string, includeTerminal = false): Identity | CurrentIdentity | null {
    if (kind === 'schedule') {
      const row = this.database.prepare(`SELECT o.*,s.version AS schedule_version,s.workspace_id AS schedule_workspace_id,s.session_id AS schedule_session_id FROM productivity_schedule_occurrences o
        JOIN productivity_schedules s ON s.schedule_id=o.schedule_id WHERE o.occurrence_id=? AND o.schedule_id=?`).get(taskId, entityId);
      if (row === undefined) throw new Error('productivity_task_not_found');
      if (!['pending','dispatching','submitted','failed','cancelled'].includes(String(row.status))) throw corruption('schedule_current_status');
      if (row.workspace_id !== row.schedule_workspace_id || row.session_id !== row.schedule_session_id) throw corruption('schedule_current_scope');
      if (!includeTerminal && !['pending','dispatching'].includes(String(row.status))) return null;
      if (row.command_id !== stableId('schedule-command', taskId) || row.message_id !== stableId('schedule-message', taskId))
        throw corruption('schedule_current_identity');
      const identity = { task_kind: kind, entity_id: entityId, task_id: taskId, workspace_id: String(row.workspace_id), owner_session_id: String(row.session_id), session_id: String(row.session_id),
        message_id: String(row.message_id), create_command_id: null, submit_command_id: String(row.command_id),
        source_version: Number(row.schedule_version), source_status: row.status as CurrentIdentity['source_status'] };
      return includeTerminal ? { ...identity, source_record_digest: sourceRecordDigest(JSON.stringify(row)) } : identity as Identity;
    }
    const table = kind === 'workflow' ? 'productivity_workflows' : 'productivity_goals';
    const column = kind === 'workflow' ? 'workflow' : 'goal';
    const row = this.database.prepare(`SELECT * FROM ${table} WHERE ${column}_id=?`).get(entityId);
    if (row === undefined) throw new Error('productivity_task_not_found');
    const record = kind === 'workflow'
      ? readPersistedAuthorityJson('productivity', String(row.workflow_json), parseWorkflowExecutionRecord)
      : readPersistedAuthorityJson('productivity', String(row.goal_json), parseGoalExecutionRecord);
    const task = record.agentExecution?.tasks.find(candidate => candidate.todoId === taskId);
    if (task === undefined) throw new Error('productivity_task_not_found');
    if (record.version !== row.version || record.status !== row.status
      || ('goalId' in record && kind === 'workflow' && record.goalId !== row.goal_id)
      || ('workflowId' in record && record.workflowId !== entityId)
      || ('workspaceId' in record && (record.workspaceId !== row.workspace_id || record.sessionId !== row.session_id || record.goalId !== entityId)))
      throw corruption('current_source_binding');
    if (task.status === 'terminal' && !includeTerminal) return null;
    const identity = { task_kind: kind, entity_id: entityId, task_id: taskId, workspace_id: String(row.workspace_id), owner_session_id: String(row.session_id), session_id: task.sessionId,
      message_id: task.messageId, create_command_id: task.createCommandId, submit_command_id: task.submitCommandId,
      source_version: record.version, source_status: task.status };
    return includeTerminal ? { ...identity, source_record_digest: sourceRecordDigest(String(row[`${column}_json`])) } : identity as Identity;
  }
  private assertRecordedIdentity(row: Row): void {
    if (row.task_kind === 'schedule') {
      const actual = this.database.prepare(`SELECT o.schedule_id,o.workspace_id,o.session_id,o.message_id,o.command_id,s.version
        FROM productivity_schedule_occurrences o JOIN productivity_schedules s ON s.schedule_id=o.schedule_id WHERE o.occurrence_id=?`)
        .get(row.task_id);
      if (!actual || actual.schedule_id !== row.entity_id || actual.workspace_id !== row.workspace_id
        || actual.session_id !== row.session_id || actual.session_id !== row.owner_session_id
        || actual.message_id !== row.message_id || actual.command_id !== row.submit_command_id
        || Number(actual.version) < row.source_version
        || row.message_id !== stableId('schedule-message', row.task_id) || row.submit_command_id !== stableId('schedule-command', row.task_id)) throw corruption('schedule_source');
      return;
    }
    const kind = row.task_kind;
    const event = this.database.prepare('SELECT kind,event_json FROM productivity_events WHERE command_id=? AND kind=?')
      .get(stableId(`${kind}-execution-version`, row.entity_id, String(row.source_version)), `${kind}.execution.updated`);
    if (!event) throw corruption('task_source_missing');
    const source = kind === 'workflow'
      ? readPersistedAuthorityJson('productivity', String(event.event_json), parseWorkflowExecutionRecord)
      : readPersistedAuthorityJson('productivity', String(event.event_json), parseGoalExecutionRecord);
    const task = source.agentExecution?.tasks.find(candidate => candidate.todoId === row.task_id);
    if (!task || source.version !== row.source_version || task.status !== row.source_status || task.sessionId !== row.session_id
      || task.messageId !== row.message_id || task.createCommandId !== row.create_command_id || task.submitCommandId !== row.submit_command_id)
      throw corruption('task_source_identity');
    if (kind === 'goal' && 'workspaceId' in source && (source.workspaceId !== row.workspace_id
      || source.sessionId !== row.owner_session_id || source.goalId !== row.entity_id)) throw corruption('task_source_scope');
    if (kind === 'workflow') {
      const current = this.database.prepare('SELECT workspace_id,session_id FROM productivity_workflows WHERE workflow_id=?').get(row.entity_id);
      if (!current || current.workspace_id !== row.workspace_id || current.session_id !== row.owner_session_id
        || ('workflowId' in source && source.workflowId !== row.entity_id)) throw corruption('task_source_scope');
    }
  }
}

function project(row: Row): ProductivityTaskFaultV1 {
  return Object.freeze({ faultId: row.fault_id, taskKind: row.task_kind, entityId: row.entity_id, taskId: row.task_id,
    workspaceId: row.workspace_id, ownerSessionId: row.owner_session_id, sessionId: row.session_id, revision: row.revision, state: row.state,
    code: row.code, occurredAt: row.occurred_at, updatedAt: row.updated_at });
}
function recordDigest(row: Omit<Row, 'identity_digest'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([row.task_kind,row.entity_id,row.task_id,row.workspace_id,row.owner_session_id,row.session_id,
    row.message_id,row.create_command_id,row.submit_command_id,row.source_version,row.source_status,
    row.fault_id,row.revision,row.state,row.code,row.occurred_at,row.updated_at])).digest('hex')}`;
}
function identityDigest(identity: CurrentIdentity): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}
function sourceRecordDigest(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function stableId(...parts: string[]): string { return `id-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 48)}`; }
function faultId(kind: string, entityId: string, taskId: string): string { return stableId('task-fault', kind, entityId, taskId); }
function corruption(reason: string, cause?: unknown): Error {
  return markAuthorityIntegrityError('productivity', new Error(`productivity_task_fault_storage:${reason}`, { cause }));
}
