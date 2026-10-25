import { describe, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, runtimeCommandSchema, runtimeResultSchema } from '../src/public.js';

const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-1', sessionId: 'session-1' };
const cursor = { dueAt: '2026-10-04T00:00:00Z', occurrenceId: 'occurrence-1' };
const occurrence = { ...cursor, scheduleId: 'schedule-1', prompt: 'Review the release', status: 'failed', attempts: 8, errorCode: 'schedule_submission_failed', canRetry: true };
describe('schedule submission public contract', () => {
  it('accepts scoped keyset queries and an explicit optimistic retry', () => {
    const query = { ...scope, kind: 'schedule.occurrences.query', before: cursor, limit: 50 };
    const retry = { ...scope, kind: 'schedule.occurrence.retry', occurrenceId: cursor.occurrenceId, expectedAttempts: 8 };
    expect(runtimeCommandSchema.parse(query)).toEqual(query);
    expect(runtimeCommandSchema.parse(retry)).toEqual(retry);
    const page = { kind: 'schedule.occurrences.query_result', occurrences: [occurrence], nextCursor: cursor };
    expect(runtimeResultSchema.parse(page)).toEqual(page);
  });

  it.each([0, 101, -1, 1.5])('rejects an invalid page size: %s', limit => {
    expect(runtimeCommandSchema.safeParse({ ...scope, kind: 'schedule.occurrences.query', before: null, limit }).success).toBe(false);
  });

  it('rejects invalid CAS, protected identifiers and arbitrary error details', () => {
    const retry = { ...scope, kind: 'schedule.occurrence.retry', occurrenceId: cursor.occurrenceId, expectedAttempts: 8 };
    for (const fields of [{ expectedAttempts: -1 }, { expectedAttempts: Number.MAX_SAFE_INTEGER }, { commandId: 'private' }, { resetAttempts: true }]) {
      expect(runtimeCommandSchema.safeParse({ ...retry, ...fields }).success).toBe(false);
    }
    const result = { kind: 'schedule.occurrence.updated', occurrence };
    for (const fields of [{ commandId: 'private' }, { messageId: 'private' }, { errorCode: 'Error: credential=secret' }]) {
      expect(runtimeResultSchema.safeParse({ ...result, occurrence: { ...occurrence, ...fields } }).success).toBe(false);
    }
  });

  it('carries durable deadlines and actual execution separately from submission', () => {
    const item = { ...occurrence, nextAttemptAt: cursor.dueAt, attemptDeadlineAt: null,
      execution: { status: 'completed', runId: 'run-1', resultPending: false, resultSummary: 'Actual assistant result' } };
    const page = { kind: 'schedule.occurrences.query_result', occurrences: [item], nextCursor: null };
    expect(runtimeResultSchema.parse(page)).toEqual(page);
    for (const fields of [{ nextAttemptAt: 'tomorrow' }, { attemptDeadlineAt: 'bad' },
      { execution: { ...item.execution, status: 'submitted' } },
      { execution: { ...item.execution, resultSummary: 'x'.repeat(4001) } },
      { execution: { ...item.execution, commandId: 'private' } },
      { execution: { ...item.execution, messageId: 'private' } },
      { execution: { ...item.execution, objectiveDigest: 'private' } },
      { execution: { ...item.execution, error: 'credential=secret' } }]) {
      expect(runtimeResultSchema.safeParse({ ...page, occurrences: [{ ...item, ...fields }] }).success).toBe(false);
    }
  });
});
