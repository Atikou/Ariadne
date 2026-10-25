import { createHmac, timingSafeEqual } from 'node:crypto';
import { RUNTIME_DERIVED_DATABASE_PATHS } from '@ariadne/protocol/host';
import { z } from 'zod';
import { taskCenterPageSchema, taskCenterFilterSchema, taskReferenceKey, type TaskCenterFilter,
  type TaskDirectoryRow } from '@ariadne/protocol/public';

export const TASK_QUERY_SNAPSHOT_RELATIVE_PATH = RUNTIME_DERIVED_DATABASE_PATHS.taskQuery;
export const TASK_QUERY_SNAPSHOT_LIFETIME_MS = 300_000;
export const MAX_TASK_QUERY_SNAPSHOTS = 16;
export const taskSnapshotCoverageSchema = taskCenterPageSchema.shape.watermarks;
export type TaskSnapshotCoverage = z.infer<typeof taskSnapshotCoverageSchema>;
export class TaskQuerySnapshotReset extends Error {
  constructor(public readonly reason: 'expired' | 'invalid_cursor' | 'scope_changed' | 'unavailable') {
    super(`task_query_snapshot_reset:${reason}`); this.name = 'TaskQuerySnapshotReset';
  }
}
export const taskSnapshotCursorSchema = z.object({ snapshotId: z.string().uuid(), scopeKey: z.string().min(1),
  filterKey: z.string().regex(/^[a-f0-9]{64}$/u), time: z.string(), key: z.string().min(1), start: z.boolean() }).strict()
  .superRefine((value, context) => {
    if (value.start && (value.time !== '' || value.key !== 'first'))
      context.addIssue({ code: 'custom', message: 'Task first-page cursor has an invalid position.' });
  });
export type TaskSnapshotCursor = z.infer<typeof taskSnapshotCursorSchema>;
export function encodeTaskSnapshotCursor(value: TaskSnapshotCursor, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(taskSnapshotCursorSchema.parse(value))).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function decodeTaskSnapshotCursor(encoded: string, secret: Buffer): TaskSnapshotCursor {
  try {
    if (encoded.length > 2048) throw new Error('oversized');
    const parts = encoded.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed');
    const actual = Buffer.from(parts[1], 'base64url');
    const expected = createHmac('sha256', secret).update(parts[0]).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('signature');
    return taskSnapshotCursorSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
  } catch { throw new TaskQuerySnapshotReset('invalid_cursor'); }
}
export function matchesTaskCenterFilter(row: TaskDirectoryRow, filter: TaskCenterFilter): boolean {
  const item = row.metadata;
  return (filter.reference === null || taskReferenceKey(filter.reference) === taskReferenceKey(item.reference))
    && (filter.workspaceId === null || item.workspaceId === filter.workspaceId)
    && (filter.sessionId === null || item.sessionId === filter.sessionId)
    && (filter.includeArchived || !row.archived) && filter.sources.includes(item.reference.source)
    && (filter.states.length === 0 || filter.states.includes(item.state))
    && (filter.updatedFrom === null || (item.updatedAt !== null && item.updatedAt >= filter.updatedFrom))
    && (filter.updatedThrough === null || (item.updatedAt !== null && item.updatedAt <= filter.updatedThrough));
}
