import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { runtimeResultSchema } from '@ariadne/protocol/public';
import { readPersistedRuntimeResult } from '@ariadne/protocol/compatibility';
import { parseGoalExecutionRecord } from './SqliteGoalAutonomy.js';
import { parseWorkflowExecutionRecord } from './SqliteWorkflowExecution.js';
import { markAuthorityIntegrityError, readPersistedAuthorityJson } from './SqliteAuthorityHealth.js';
import { readProductivityTaskRecoveryReceipt } from './ProductivityTaskRecoveryReceipt.js';
import { readTaskRecoveryClaimReceipt, taskRecoveryClaimReceiptId } from './ProductivityTaskRecoveryClaimReceipt.js';

const schemaV2Digest = 'sha256:39211f0cab9ecae1b7d315a6750aa4f11487a3cc8b6fc2fc05d2885556a765d5';
const tables = Object.freeze({
  productivity_goals: 'goal_id', productivity_todo_snapshots: 'goal_id', productivity_workflows: 'workflow_id',
  productivity_schedules: 'schedule_id', productivity_schedule_occurrences: 'occurrence_id',
  productivity_commands: 'command_id', productivity_events: 'cursor'
});
type Row = Record<string, unknown>;

/** Read-only, row-at-a-time proof before a task-isolation upgrade/recovery.
 * The digest includes original JSON bytes and receipts, not their projections.
 * No repair, normalization or deletion is performed by this audit. */
export function auditProductivityAuthorityV2(database: DatabaseSync): { readonly digest: string; readonly records: number } {
  const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version !== 2) throw new Error('productivity_audit_source_version_invalid');
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all().map(row => ({ ...row, sql: typeof row.sql === 'string' ? row.sql.replace(/\s+/gu, ' ').trim() : null }));
  if (`sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}` !== schemaV2Digest) fail('schema');
  assertProductivitySqliteIntegrity(database);
  return auditProductivityAuthorityRecords(database);
}

/** Business-row proof is also checked after additive DDL. Its caller must
 * separately establish the exact physical schema and SQLite integrity. */
export function auditProductivityAuthorityRecords(database: DatabaseSync): { readonly digest: string; readonly records: number } {
  const hash = createHash('sha256'); let records = 0;
  for (const [table, primary] of Object.entries(tables)) {
    for (const item of database.prepare(`SELECT * FROM ${table} ORDER BY ${primary}`).iterate()) {
      const row = item as Row;
      validate(table, row, database);
      hash.update(table + '\0' + JSON.stringify(row) + '\n'); records += 1;
    }
  }
  return Object.freeze({ digest: `sha256:${hash.digest('hex')}`, records });
}

export function assertProductivitySqliteIntegrity(database: DatabaseSync): void {
  if (database.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')
    || database.prepare('PRAGMA foreign_key_check').all().length !== 0) fail('sqlite_integrity');
}

function validate(table: string, row: Row, database: DatabaseSync): void {
  if (table === 'productivity_goals') {
    const goal = readPersistedAuthorityJson('productivity', text(row.goal_json), parseGoalExecutionRecord);
    if (goal.goalId !== row.goal_id || goal.workspaceId !== row.workspace_id || goal.sessionId !== row.session_id
      || goal.version !== row.version || goal.status !== row.status || goal.updatedAt !== row.updated_at) fail('goal_binding');
  } else if (table === 'productivity_todo_snapshots') {
    readPersistedAuthorityJson('productivity', text(row.items_json), items => runtimeResultSchema.parse({
      kind: 'todo.snapshot.replaced', goalId: row.goal_id, revision: row.revision, items
    }));
    assertGoalScope(database, row); timestamp(row.updated_at);
  } else if (table === 'productivity_workflows') {
    const workflow = readPersistedAuthorityJson('productivity', text(row.workflow_json), parseWorkflowExecutionRecord);
    if (workflow.workflowId !== row.workflow_id || workflow.goalId !== row.goal_id
      || workflow.version !== row.version || workflow.status !== row.status) fail('workflow_binding');
    assertGoalScope(database, row); timestamp(row.updated_at);
  } else if (table === 'productivity_schedules') {
    const result = readPersistedAuthorityJson('productivity', text(row.schedule_json), schedule => runtimeResultSchema.parse({ kind: 'schedule.updated', schedule }));
    if (result.kind !== 'schedule.updated') fail('schedule_shape');
    const schedule = result.schedule;
    if (schedule.scheduleId !== row.schedule_id || schedule.workspaceId !== row.workspace_id || schedule.sessionId !== row.session_id
      || schedule.version !== row.version || schedule.status !== row.status || schedule.nextFireAt !== row.next_fire_at) fail('schedule_binding');
    timestamp(row.created_at); timestamp(row.updated_at);
  } else if (table === 'productivity_schedule_occurrences') {
    const parent = database.prepare('SELECT workspace_id,session_id FROM productivity_schedules WHERE schedule_id=?')
      .get(text(row.schedule_id));
    if (!parent || parent.workspace_id !== row.workspace_id || parent.session_id !== row.session_id) fail('occurrence_scope');
    if (!['pending','dispatching','submitted','failed','cancelled'].includes(text(row.status))
      || !Number.isSafeInteger(row.attempts) || (row.attempts as number) < 0
      || row.command_id !== stableId('schedule-command', text(row.occurrence_id))
      || row.message_id !== stableId('schedule-message', text(row.occurrence_id))) fail('occurrence_identity');
    timestamp(row.due_at);
    if (row.attempt_started_at !== null) {
      timestamp(row.attempt_started_at);
      if (row.status !== 'dispatching' || row.next_attempt_at === null) fail('occurrence_claim');
    }
    if (row.next_attempt_at !== null) timestamp(row.next_attempt_at);
    text(row.prompt);
  } else if (table === 'productivity_commands') {
    text(row.command_id); timestamp(row.committed_at);
    if (!/^sha256:[a-f0-9]{64}$/u.test(text(row.fingerprint))) fail('receipt_fingerprint');
    const kind = readPersistedAuthorityJson('productivity', text(row.result_json), payload =>
      typeof payload === 'object' && payload !== null && 'kind' in payload ? payload.kind : null);
    if (kind === 'productivity.task_recovery_claim') {
      const pointer = readTaskRecoveryClaimReceipt(text(row.result_json), text(row.command_id), text(row.fingerprint));
      const target = database.prepare('SELECT fingerprint,result_json FROM productivity_commands WHERE command_id=?').get(pointer.commandId);
      if (!target) fail('task_recovery_claim_target_missing');
      const receipt = readProductivityTaskRecoveryReceipt(text(target.result_json), text(target.fingerprint));
      if (receipt.claimFault.revision !== pointer.claimRevision || JSON.stringify(receipt.request) !== JSON.stringify(pointer.request)) fail('task_recovery_claim_target');
    } else if (kind === 'productivity.task_recovery_receipt') {
      if (database.prepare('PRAGMA user_version').get()!.user_version !== 3) fail('task_recovery_schema_invalid');
      const receipt = readProductivityTaskRecoveryReceipt(text(row.result_json), text(row.fingerprint));
      const fault = database.prepare('SELECT revision,workspace_id,owner_session_id FROM productivity_task_faults WHERE fault_id=?').get(receipt.request.faultId);
      if (!fault || Number(fault.revision) < receipt.claimFault.revision || fault.workspace_id !== receipt.request.workspaceId
        || fault.owner_session_id !== receipt.request.sessionId) fail('task_recovery_source_binding');
      if (receipt.phase === 'completed' && Number(fault.revision) < receipt.result.fault.revision) fail('task_recovery_result_revision');
      const pointerId = taskRecoveryClaimReceiptId(receipt.request.faultId, receipt.claimFault.revision);
      const rowPointer = database.prepare('SELECT fingerprint,result_json FROM productivity_commands WHERE command_id=?').get(pointerId);
      if (!rowPointer || readTaskRecoveryClaimReceipt(text(rowPointer.result_json), pointerId, text(rowPointer.fingerprint)).commandId !== row.command_id)
        fail('task_recovery_claim_missing');
    } else persistedResult(row.result_json);
  } else if (table === 'productivity_events') {
    text(row.command_id); timestamp(row.occurred_at);
    if (row.kind === 'goal.execution.updated') {
      const goal = readPersistedAuthorityJson('productivity', text(row.event_json), parseGoalExecutionRecord);
      const current = database.prepare('SELECT version,workspace_id,session_id FROM productivity_goals WHERE goal_id=?').get(goal.goalId);
      if (goal.agentExecution === undefined || row.command_id !== stableId('goal-execution-version', goal.goalId, String(goal.version))
        || !current || Number(current.version) < goal.version || current.workspace_id !== goal.workspaceId
        || current.session_id !== goal.sessionId) fail('goal_event_identity');
    } else if (row.kind === 'workflow.execution.updated') {
      const workflow = readPersistedAuthorityJson('productivity', text(row.event_json), parseWorkflowExecutionRecord);
      const current = database.prepare('SELECT version,goal_id FROM productivity_workflows WHERE workflow_id=?').get(workflow.workflowId);
      if (workflow.agentExecution === undefined || row.command_id !== stableId('workflow-execution-version', workflow.workflowId, String(workflow.version))
        || !current || Number(current.version) < workflow.version || current.goal_id !== workflow.goalId) fail('workflow_event_identity');
    }
    else {
      persistedResult(row.event_json);
      const receipt = database.prepare('SELECT result_json FROM productivity_commands WHERE command_id=?').get(text(row.command_id));
      if (!receipt || receipt.result_json !== row.event_json) fail('event_receipt_binding');
    }
  }
}

function persistedResult(value: unknown): void {
  readPersistedAuthorityJson('productivity', text(value), payload => {
    const result = readPersistedRuntimeResult(payload);
    if (!['goal.updated','todo.snapshot.replaced','workflow.updated','schedule.updated','schedule.occurrence.updated'].includes(result.kind)) fail('receipt_kind');
    return result;
  });
}
function assertGoalScope(database: DatabaseSync, row: Row): void {
  const parent = database.prepare('SELECT workspace_id,session_id FROM productivity_goals WHERE goal_id=?').get(text(row.goal_id));
  if (!parent || parent.workspace_id !== row.workspace_id || parent.session_id !== row.session_id) fail('goal_scope');
}
function text(value: unknown): string { if (typeof value !== 'string' || value.length === 0) fail('text'); return value; }
function timestamp(value: unknown): void { if (!Number.isFinite(Date.parse(text(value)))) fail('timestamp'); }
function stableId(...parts: string[]): string { return `id-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 48)}`; }
function fail(reason: string): never { throw markAuthorityIntegrityError('productivity', new Error(`productivity_authority_audit:${reason}`)); }
