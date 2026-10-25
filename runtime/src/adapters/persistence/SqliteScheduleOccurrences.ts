import { ProductivityCommandRejected } from './ProductivityCommandRejected.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ProductivityCommand, ProductivityResult } from '@ariadne/protocol/public';
import { SCHEDULE_SUBMISSION_MAX_ATTEMPTS, scheduleSubmissionRetryDelay } from './ScheduleSubmissionPolicy.js';
import type { ScheduledSubmissionIdentity } from '../../control/ports/ProductivityAuthority.js';
export type { ScheduledSubmissionIdentity } from '../../control/ports/ProductivityAuthority.js';

type Occurrence = Extract<ProductivityResult, { kind: 'schedule.occurrence.updated' }>['occurrence'];
type Query = Extract<ProductivityCommand, { kind: 'schedule.occurrences.query' }>;
type Row = {
  occurrence_id: string; schedule_id: string; prompt: string; due_at: string; status: Occurrence['status'];
  attempts: number; last_error: string | null; schedule_status: string; attempt_started_at: string | null; next_attempt_at: string | null;
};
const columns = 'o.occurrence_id,o.schedule_id,o.prompt,o.due_at,o.status,o.attempts,o.last_error,o.attempt_started_at,o.next_attempt_at,s.status AS schedule_status';
const available = `NOT EXISTS (SELECT 1 FROM productivity_task_faults f WHERE f.task_kind='schedule'
  AND f.entity_id=o.schedule_id AND f.task_id=o.occurrence_id AND f.state<>'resolved')`;

/** Called in the materialization transaction; expired crashed attempts still count and receive durable backoff. */
export function recoverExpiredScheduleClaims(database: DatabaseSync, now: string): void {
  const rows = database.prepare(`SELECT occurrence_id,attempts FROM productivity_schedule_occurrences o
    WHERE status='dispatching' AND attempt_started_at IS NOT NULL AND julianday(next_attempt_at)<=julianday(?) AND ${available}`)
    .all(now) as unknown as { occurrence_id: string; attempts: number }[];
  for (const row of rows) database.prepare(`UPDATE productivity_schedule_occurrences SET attempt_started_at=NULL,
    status=?,next_attempt_at=?,last_error='schedule_submission_uncertain' WHERE occurrence_id=?`)
    .run(row.attempts < SCHEDULE_SUBMISSION_MAX_ATTEMPTS ? 'dispatching' : 'failed',
      row.attempts < SCHEDULE_SUBMISSION_MAX_ATTEMPTS ? retryAt(row.attempts, now) : null, row.occurrence_id);
}

export function pendingScheduleOccurrences(database: DatabaseSync, limit: number, now: string): readonly ScheduledSubmissionIdentity[] {
  const rows = database.prepare(`SELECT occurrence_id,schedule_id,workspace_id,session_id,prompt,due_at,command_id,message_id,attempts
    FROM productivity_schedule_occurrences o WHERE status IN ('pending','dispatching') AND attempt_started_at IS NULL
    AND (next_attempt_at IS NULL OR julianday(next_attempt_at)<=julianday(?))
    AND ${available}
    AND (status='pending' OR attempts<?)
    AND (status='dispatching' OR EXISTS (SELECT 1 FROM productivity_schedules s WHERE s.schedule_id=o.schedule_id AND s.status IN ('active','completed')))
    ORDER BY julianday(due_at),occurrence_id LIMIT ?`).all(now, SCHEDULE_SUBMISSION_MAX_ATTEMPTS, limit) as unknown as
    { occurrence_id: string; schedule_id: string; workspace_id: string; session_id: string; prompt: string; due_at: string; command_id: string; message_id: string; attempts: number }[];
  return rows.map(projectIdentity);
}

type IdentityRow = { occurrence_id: string; schedule_id: string; workspace_id: string; session_id: string; prompt: string; due_at: string; command_id: string; message_id: string; attempts: number };
function projectIdentity(row: IdentityRow): ScheduledSubmissionIdentity { return { occurrenceId: row.occurrence_id, scheduleId: row.schedule_id, workspaceId: row.workspace_id,
    sessionId: row.session_id, prompt: row.prompt, dueAt: row.due_at, commandId: row.command_id, messageId: row.message_id, attempts: row.attempts };
}

export function claimedScheduleOccurrences(database: DatabaseSync): readonly ScheduledSubmissionIdentity[] {
  return (database.prepare(`SELECT occurrence_id,schedule_id,workspace_id,session_id,prompt,due_at,command_id,message_id,attempts
    FROM productivity_schedule_occurrences o WHERE status='dispatching' AND attempt_started_at IS NOT NULL
    AND ${available} ORDER BY due_at,occurrence_id`)
    .all() as unknown as IdentityRow[]).map(projectIdentity);
}

export function claimScheduleOccurrence(database: DatabaseSync, occurrenceId: string, now: string, timeoutMs: number): boolean {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('schedule_submission_timeout_invalid');
  return database.prepare(`UPDATE productivity_schedule_occurrences SET status='dispatching',attempts=attempts+1,
    attempt_started_at=?,next_attempt_at=? WHERE occurrence_id=? AND attempts<? AND attempt_started_at IS NULL
    AND (next_attempt_at IS NULL OR julianday(next_attempt_at)<=julianday(?))
    AND (status='pending' OR (status='dispatching' AND attempts<?))
    AND NOT EXISTS (SELECT 1 FROM productivity_task_faults f WHERE f.task_kind='schedule'
      AND f.entity_id=productivity_schedule_occurrences.schedule_id AND f.task_id=productivity_schedule_occurrences.occurrence_id AND f.state<>'resolved')
    AND (status='dispatching' OR EXISTS (SELECT 1 FROM productivity_schedules s
      WHERE s.schedule_id=productivity_schedule_occurrences.schedule_id AND s.status IN ('active','completed')))`)
    .run(now, new Date(Date.parse(now) + timeoutMs).toISOString(), occurrenceId, Number.MAX_SAFE_INTEGER, now, SCHEDULE_SUBMISSION_MAX_ATTEMPTS).changes === 1;
}

export function settleScheduleOccurrence(database: DatabaseSync, occurrenceId: string, success: boolean, errorCode: string | undefined, retryable: boolean, now: string): void {
  const row = database.prepare(`SELECT attempts,attempt_started_at FROM productivity_schedule_occurrences
    WHERE occurrence_id=? AND status='dispatching' AND attempt_started_at IS NOT NULL`).get(occurrenceId) as
    { attempts: number; attempt_started_at: string } | undefined;
  if (row === undefined) throw new Error('schedule_occurrence_not_pending');
  if (Date.parse(now) < Date.parse(row.attempt_started_at)) throw new Error('schedule_occurrence_clock_regressed');
  const retry = !success && retryable && row.attempts < SCHEDULE_SUBMISSION_MAX_ATTEMPTS;
  database.prepare(`UPDATE productivity_schedule_occurrences SET status=?,attempt_started_at=NULL,next_attempt_at=?,last_error=? WHERE occurrence_id=?`)
    .run(success ? 'submitted' : retry ? 'dispatching' : 'failed', retry ? retryAt(row.attempts, now) : null,
      success ? null : scheduleSubmissionErrorCode(errorCode ?? 'schedule_submission_failed'), occurrenceId);
}

function retryAt(attempts: number, now: string): string { return new Date(Date.parse(now) + scheduleSubmissionRetryDelay(attempts)).toISOString(); }

/** Public failure vocabulary; exception messages and historical private details never cross this boundary. */
export function scheduleSubmissionErrorCode(code: string | null): Occurrence['errorCode'] {
  if (code === null) return null;
  switch (code) {
    case 'schedule_session_unavailable': case 'schedule_cancelled':
    case 'schedule_submission_deadline_exceeded': case 'schedule_worker_stopped':
    case 'conversation_version_conflict': case 'schedule_submission_rejected':
    case 'schedule_submission_uncertain': case 'schedule_submission_failed': return code;
    case 'schedule_v3_submission_uncertain': return 'schedule_submission_uncertain';
    default: return 'schedule_submission_failed';
  }
}

export function queryScheduleOccurrences(database: DatabaseSync, command: Query): Extract<
  ProductivityResult, { kind: 'schedule.occurrences.query_result' }
> {
  const before = command.before;
  const rows = database.prepare(
    `SELECT ${columns} FROM productivity_schedule_occurrences o
     JOIN productivity_schedules s ON s.schedule_id=o.schedule_id
     WHERE o.workspace_id=? AND o.session_id=?
     AND (? IS NULL OR julianday(o.due_at)<julianday(?)
       OR (julianday(o.due_at)=julianday(?) AND o.occurrence_id<?))
     ORDER BY julianday(o.due_at) DESC,o.occurrence_id DESC LIMIT ?`
  ).all(command.workspaceId, command.sessionId, before?.dueAt ?? null, before?.dueAt ?? null,
    before?.dueAt ?? null, before?.occurrenceId ?? null, command.limit + 1) as unknown as Row[];
  const occurrences = rows.slice(0, command.limit).map(project);
  const last = occurrences.at(-1);
  return {
    kind: 'schedule.occurrences.query_result', occurrences,
    nextCursor: rows.length > command.limit && last !== undefined
      ? { dueAt: last.dueAt, occurrenceId: last.occurrenceId } : null
  };
}

/** An explicit retry preserves lifetime attempts and the original message/command identities. */
export function retryScheduleOccurrence(
  database: DatabaseSync, command: Extract<ProductivityCommand, { kind: 'schedule.occurrence.retry' }>
): Extract<ProductivityResult, { kind: 'schedule.occurrence.updated' }> {
  const row = database.prepare(
    `SELECT ${columns} FROM productivity_schedule_occurrences o
     JOIN productivity_schedules s ON s.schedule_id=o.schedule_id
     WHERE o.occurrence_id=? AND o.workspace_id=? AND o.session_id=?`
  ).get(command.occurrenceId, command.workspaceId, command.sessionId) as Row | undefined;
  if (row === undefined) throw new ProductivityCommandRejected('schedule_occurrence_not_found');
  if (row.attempts !== command.expectedAttempts) throw new ProductivityCommandRejected('schedule_occurrence_version_conflict');
  if (!project(row).canRetry) throw new ProductivityCommandRejected('schedule_occurrence_retry_unavailable');
  database.prepare(
    `UPDATE productivity_schedule_occurrences SET status='pending',attempt_started_at=NULL,next_attempt_at=NULL WHERE occurrence_id=?`
  ).run(row.occurrence_id);
  return { kind: 'schedule.occurrence.updated', occurrence: project({ ...row, status: 'pending', attempt_started_at: null, next_attempt_at: null }) };
}

function project(row: Row): Occurrence {
  return {
    occurrenceId: row.occurrence_id, scheduleId: row.schedule_id, prompt: row.prompt, dueAt: row.due_at,
    status: row.status, attempts: row.attempts, errorCode: scheduleSubmissionErrorCode(row.last_error),
    nextAttemptAt: row.attempt_started_at === null ? row.next_attempt_at : null,
    attemptDeadlineAt: row.attempt_started_at === null ? null : row.next_attempt_at,
    canRetry: row.status === 'failed' && row.attempts < Number.MAX_SAFE_INTEGER
      && (row.schedule_status === 'active' || row.schedule_status === 'completed')
  };
}
