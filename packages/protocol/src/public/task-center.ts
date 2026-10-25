import { z } from 'zod';
import { publicProjectionCanonicalIdSchema as id, publicProjectionCanonicalTimestampSchema as timestamp } from './projection.js';

export const TASK_CENTER_QUERY_VERSION = '1.0' as const;
export const MAX_TASK_CENTER_PAGE_ROWS = 128;
export const MAX_TASK_CENTER_PAGE_BYTES = 2 * 1024 * 1024;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const taskSourceSchema = z.enum(['run', 'goal', 'workflow', 'schedule', 'occurrence']);
export const taskStateSchema = z.enum(['queued', 'running', 'waiting_confirmation', 'blocked', 'paused',
  'recovering', 'cancelling', 'completed', 'failed', 'cancelled', 'scheduled', 'unknown']);
export const taskReferenceSchema = z.object({ source: taskSourceSchema, sourceId: id }).strict();
export type TaskReference = z.infer<typeof taskReferenceSchema>;
export function taskReferenceKey(reference: TaskReference): string {
  const validated = taskReferenceSchema.parse(reference);
  return `${validated.source}:${validated.sourceId}`;
}

export const taskOwnerReferenceSchema = z.object({ workspaceId: id, sessionId: id }).strict();
export const taskRunReferenceSchema = taskOwnerReferenceSchema.extend({ runId: id }).strict();
export const taskRelationSchema = z.object({ reference: taskReferenceSchema, owner: taskOwnerReferenceSchema,
  kind: z.enum(['parent', 'goal', 'workflow', 'schedule', 'occurrence', 'execution', 'planner']) }).strict();

/** Lists contain metadata and stable references, never prompts or result bodies. */
export const taskSourceMetadataSchema = z.object({
  reference: taskReferenceSchema, workspaceId: id, sessionId: id,
  title: z.string().trim().min(1).max(2_000), sourceStatus: z.string().trim().min(1).max(64),
  state: taskStateSchema, version: revision.nullable(), attempts: count.nullable(),
  updatedAt: timestamp.nullable(), dueAt: timestamp.nullable(),
  relations: z.array(taskRelationSchema).max(512), relationTotal: count,
  runReferences: z.array(taskRunReferenceSchema).max(256), runReferenceTotal: count
}).strict().superRefine((row, context) => {
  if (row.reference.source === 'occurrence' ? row.version !== null || row.attempts === null
    : row.version === null || row.attempts !== null) {
    context.addIssue({ code: 'custom', message: 'Source revision must retain its own version or occurrence attempts.' });
  }
  if (row.relationTotal < row.relations.length || row.runReferenceTotal < row.runReferences.length)
    context.addIssue({ code: 'custom', message: 'Bounded task links contradict their source totals.' });
  const references = new Set<string>();
  for (const relation of row.relations) {
    const key = JSON.stringify([relation.kind, relation.reference.source, relation.reference.sourceId,
      relation.owner.workspaceId, relation.owner.sessionId]);
    if (references.has(key)) context.addIssue({ code: 'custom', message: 'Task relation is duplicated.' });
    references.add(key);
  }
});
export type TaskSourceMetadata = z.infer<typeof taskSourceMetadataSchema>;

const decision = taskOwnerReferenceSchema.extend({ runId: id, decisionId: id, version: revision,
  kind: z.enum(['permission', 'plan', 'recovery', 'budget', 'user_question']) }).strict();
export const taskDirectoryRowSchema = z.object({ metadata: taskSourceMetadataSchema, archived: z.boolean(),
  decisions: z.array(decision).max(128), result: z.enum(['none', 'pending', 'available', 'unavailable'])
}).strict();
export type TaskDirectoryRow = z.infer<typeof taskDirectoryRowSchema>;

export const taskCenterFilterSchema = z.object({
  reference: taskReferenceSchema.nullable().default(null),
  workspaceId: id.nullable(), sessionId: id.nullable(), includeArchived: z.boolean(),
  sources: z.array(taskSourceSchema).min(1).max(5), states: z.array(taskStateSchema).max(12),
  updatedFrom: timestamp.nullable(), updatedThrough: timestamp.nullable()
}).strict().superRefine((filter, context) => {
  if (filter.sessionId !== null && filter.workspaceId === null) context.addIssue({ code: 'custom', message: 'Session filter requires its Workspace.' });
  if (filter.reference !== null && !filter.sources.includes(filter.reference.source))
    context.addIssue({ code: 'custom', message: 'Task identity escaped the selected source types.' });
  if (new Set(filter.sources).size !== filter.sources.length || new Set(filter.states).size !== filter.states.length)
    context.addIssue({ code: 'custom', message: 'Task filter contains duplicate selections.' });
  if (filter.updatedFrom !== null && filter.updatedThrough !== null && filter.updatedFrom > filter.updatedThrough)
    context.addIssue({ code: 'custom', message: 'Task time interval is reversed.' });
});
export type TaskCenterFilter = z.infer<typeof taskCenterFilterSchema>;

export const taskCenterQuerySchema = z.object({ kind: z.literal('tasks.query'), contractVersion: z.literal(TASK_CENTER_QUERY_VERSION),
  filter: taskCenterFilterSchema, cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_.-]+$/u).nullable(),
  limit: z.number().int().min(1).max(MAX_TASK_CENTER_PAGE_ROWS), refresh: z.boolean().default(false)
}).strict();
export const taskCenterNavigationSchema = z.object({ kind: z.literal('tasks.navigate'), contractVersion: z.literal(TASK_CENTER_QUERY_VERSION),
  reference: taskReferenceSchema, workspaceId: id, sessionId: id, expectedVersion: revision.nullable(),
  expectedAttempts: count.nullable(), expectedSourceStatus: z.string().trim().min(1).max(64),
  decisionId: id.nullable(), expectedDecisionVersion: revision.nullable(),
  destination: z.enum(['details', 'decision', 'result', 'recovery'])
}).strict().superRefine((request, context) => {
  if (request.reference.source === 'occurrence' ? request.expectedVersion !== null || request.expectedAttempts === null
    : request.expectedVersion === null || request.expectedAttempts !== null)
    context.addIssue({ code: 'custom', message: 'Navigation requires the displayed source revision.' });
  if (request.destination === 'decision' ? request.decisionId === null || request.expectedDecisionVersion === null
    : request.decisionId !== null || request.expectedDecisionVersion !== null)
    context.addIssue({ code: 'custom', message: 'Decision navigation requires its exact displayed identity and revision.' });
});
export type TaskCenterQuery = z.infer<typeof taskCenterQuerySchema>;
export type TaskCenterNavigation = z.infer<typeof taskCenterNavigationSchema>;

const relationReadFields = {
  reference: taskReferenceSchema.extend({ source: taskSourceSchema.exclude(['run']) }), workspaceId: id, sessionId: id,
  expectedVersion: revision.nullable(), expectedAttempts: count.nullable(),
  expectedSourceStatus: z.string().trim().min(1).max(64), afterIndex: count
};
export const taskCenterRelationsQuerySchema = z.object({ kind: z.literal('tasks.relations'),
  contractVersion: z.literal(TASK_CENTER_QUERY_VERSION), ...relationReadFields,
  limit: z.number().int().min(1).max(MAX_TASK_CENTER_PAGE_ROWS)
}).strict().superRefine((request, context) => {
  if (request.reference.source === 'occurrence' ? request.expectedVersion !== null || request.expectedAttempts === null
    : request.expectedVersion === null || request.expectedAttempts !== null)
    context.addIssue({ code: 'custom', message: 'Relation reads require the displayed source revision.' });
});
export type TaskCenterRelationsQuery = z.infer<typeof taskCenterRelationsQuerySchema>;
export const taskCenterRelationsResultSchema = z.object({ kind: z.literal('tasks.relations_result'),
  contractVersion: z.literal(TASK_CENTER_QUERY_VERSION), ...relationReadFields,
  status: z.enum(['ok', 'missing', 'unauthorized', 'archived', 'stale', 'unavailable']),
  rows: z.array(taskRelationSchema).max(MAX_TASK_CENTER_PAGE_ROWS), sourceTotal: count.nullable(), nextIndex: count.nullable()
}).strict().superRefine((result, context) => {
  if (result.reference.source === 'occurrence' ? result.expectedVersion !== null || result.expectedAttempts === null
    : result.expectedVersion === null || result.expectedAttempts !== null)
    context.addIssue({ code: 'custom', message: 'Relation results require their source revision.' });
  if (result.status === 'ok' ? result.sourceTotal === null
    || (result.nextIndex !== null && (result.nextIndex <= result.afterIndex || result.nextIndex >= result.sourceTotal))
    : result.rows.length !== 0 || result.sourceTotal !== null || result.nextIndex !== null)
    context.addIssue({ code: 'custom', message: 'Relation page contradicts its source boundary or outcome.' });
  const keys = result.rows.map(row => `${row.kind}:${taskReferenceKey(row.reference)}:${row.owner.workspaceId}:${row.owner.sessionId}`);
  if (new Set(keys).size !== keys.length || (result.sourceTotal !== null && result.rows.length > result.sourceTotal))
    context.addIssue({ code: 'custom', message: 'Relation page repeats or exceeds its source rows.' });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_TASK_CENTER_PAGE_BYTES)
    context.addIssue({ code: 'custom', message: 'Relation page exceeds the byte boundary.' });
});
export type TaskCenterRelationsResult = z.infer<typeof taskCenterRelationsResultSchema>;

const watermark = z.object({ source: z.enum(['projection', 'productivity', 'conversation']),
  status: z.enum(['ready', 'building', 'unavailable']), revision: count.nullable(), capturedAt: timestamp,
  diagnosticCode: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u).nullable()
}).strict();
export const taskCenterPageSchema = z.object({ kind: z.literal('tasks.query_result'), contractVersion: z.literal(TASK_CENTER_QUERY_VERSION),
  snapshotId: id, capturedAt: timestamp, expiresAt: timestamp, consistency: z.literal('eventual'),
  filter: taskCenterFilterSchema, complete: z.boolean(), watermarks: z.array(watermark).length(3),
  indexedTotal: count, rows: z.array(taskDirectoryRowSchema).max(MAX_TASK_CENTER_PAGE_ROWS),
  pageCursor: taskCenterQuerySchema.shape.cursor.unwrap(), nextCursor: taskCenterQuerySchema.shape.cursor
}).strict().superRefine((page, context) => {
  if (page.expiresAt <= page.capturedAt || new Set(page.watermarks.map(item => item.source)).size !== 3)
    context.addIssue({ code: 'custom', message: 'Task snapshot lifetime or source coverage is invalid.' });
  if (page.complete !== page.watermarks.every(item => item.status === 'ready'))
    context.addIssue({ code: 'custom', message: 'Task completeness contradicts source coverage.' });
  const keys = page.rows.map(row => taskReferenceKey(row.metadata.reference));
  if (new Set(keys).size !== keys.length || page.indexedTotal < page.rows.length)
    context.addIssue({ code: 'custom', message: 'Task page duplicates identity or contradicts its indexed count.' });
  for (const row of page.rows) {
    const metadata = row.metadata, filter = page.filter;
    if ((filter.workspaceId !== null && metadata.workspaceId !== filter.workspaceId)
      || (filter.sessionId !== null && metadata.sessionId !== filter.sessionId)
      || !filter.sources.includes(metadata.reference.source) || (filter.states.length > 0 && !filter.states.includes(metadata.state))
      || (filter.reference !== null && taskReferenceKey(filter.reference) !== taskReferenceKey(metadata.reference))
      || (!filter.includeArchived && row.archived)
      || (filter.updatedFrom !== null && (metadata.updatedAt === null || metadata.updatedAt < filter.updatedFrom))
      || (filter.updatedThrough !== null && (metadata.updatedAt === null || metadata.updatedAt > filter.updatedThrough)))
      context.addIssue({ code: 'custom', message: 'Task row escaped its requested filter scope.' });
  }
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > MAX_TASK_CENTER_PAGE_BYTES)
    context.addIssue({ code: 'custom', message: 'Task page exceeds the byte boundary.' });
});
export type TaskCenterPage = z.infer<typeof taskCenterPageSchema>;

export const taskCenterResetSchema = z.object({ kind: z.literal('tasks.query_reset'),
  contractVersion: z.literal(TASK_CENTER_QUERY_VERSION),
  reason: z.enum(['expired', 'invalid_cursor', 'scope_changed', 'unavailable']) }).strict();
/** Reuses the original Conversation reference without importing the enclosing public module. */
export function createTaskCenterNavigationResultSchema<T extends z.ZodType>(messageReference: T) {
  return z.object({ kind: z.literal('tasks.navigate_result'), contractVersion: z.literal(TASK_CENTER_QUERY_VERSION),
    status: z.enum(['ok', 'missing', 'unauthorized', 'archived', 'stale', 'unavailable', 'pending']),
    reference: taskReferenceSchema, workspaceId: id, sessionId: id, current: taskSourceMetadataSchema.nullable(),
    target: z.object({ moduleId: z.enum(['agent.status', 'permissions', 'agent.plan', 'productivity.control', 'chat.main']),
      workspaceId: id, sessionId: id,
      runId: id.nullable(), expectedRunVersion: revision.nullable(), decisionId: id.nullable(),
      expectedDecisionVersion: revision.nullable(), resultReference: messageReference.nullable() }).strict().nullable()
  }).strict().superRefine((result, context) => {
    if ((result.status === 'ok') !== (result.target !== null))
      context.addIssue({ code: 'custom', message: 'Task navigation target contradicts its outcome.' });
    if (result.current !== null && (taskReferenceKey(result.current.reference) !== taskReferenceKey(result.reference)
      || result.current.workspaceId !== result.workspaceId || result.current.sessionId !== result.sessionId))
      context.addIssue({ code: 'custom', message: 'Task navigation metadata escaped its requested owner.' });
    if ((result.status === 'unauthorized' || result.status === 'missing') && result.current !== null)
      context.addIssue({ code: 'custom', message: 'Inaccessible task navigation exported source metadata.' });
    const target = result.target;
    if (target && ((target.runId === null) !== (target.expectedRunVersion === null)
      || (target.decisionId === null) !== (target.expectedDecisionVersion === null)
      || (target.decisionId !== null && target.runId === null)))
      context.addIssue({ code: 'custom', message: 'Task navigation target contradicts its exact authority references.' });
  });
}
