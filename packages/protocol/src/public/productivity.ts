import { z } from 'zod';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, publicProjectionCanonicalIdSchema } from './projection.js';

const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nullableVersionSchema = versionSchema.nullable();
const textSchema = z.string().trim().min(1).max(2_000);
const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']);
const goalStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete']);
const occurrenceCursorSchema = z.object({
  dueAt: z.string().datetime({ offset: true }), occurrenceId: publicProjectionCanonicalIdSchema
}).strict();
const occurrenceSchema = z.object({
  occurrenceId: publicProjectionCanonicalIdSchema, scheduleId: publicProjectionCanonicalIdSchema,
  dueAt: z.string().datetime({ offset: true }), prompt: textSchema,
  status: z.enum(['pending', 'dispatching', 'submitted', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  errorCode: z.enum([
    'schedule_session_unavailable', 'schedule_cancelled', 'schedule_submission_deadline_exceeded',
    'schedule_worker_stopped', 'conversation_version_conflict', 'schedule_submission_rejected',
    'schedule_submission_uncertain', 'schedule_submission_failed'
  ]).nullable(),
  canRetry: z.boolean(),
  nextAttemptAt: z.string().datetime({ offset: true }).nullable().optional(),
  attemptDeadlineAt: z.string().datetime({ offset: true }).nullable().optional(),
  execution: z.object({
    status: z.enum(['handoff_pending','starting','start_failed','queued','running','waiting','recovering','waiting_children','waiting_input','cancelling','completed','failed','cancelled']),
    runId: publicProjectionCanonicalIdSchema.nullable(), resultPending: z.boolean(),
    resultSummary: z.string().max(4_000).nullable()
  }).strict().nullable().optional()
}).strict();

export const productivityCommandSchemas = [
  z.object({
    kind: z.literal('goal.put'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    goalId: publicProjectionCanonicalIdSchema, expectedVersion: nullableVersionSchema,
    title: textSchema, phase: z.string().trim().min(1).max(128), status: goalStatusSchema,
    roundCap: z.number().int().min(1).max(10_000)
  }).strict(),
  z.object({
    kind: z.literal('todo.snapshot.replace'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    goalId: publicProjectionCanonicalIdSchema, expectedGoalVersion: versionSchema,
    expectedRevision: nullableVersionSchema,
    items: z.array(z.object({
      todoId: publicProjectionCanonicalIdSchema, title: textSchema, status: todoStatusSchema,
      dependsOn: z.array(publicProjectionCanonicalIdSchema).max(256).optional()
    }).strict()).max(256)
  }).strict(),
  z.object({
    kind: z.literal('productivity.query'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({
    kind: z.literal('workflow.start'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    workflowId: publicProjectionCanonicalIdSchema, goalId: publicProjectionCanonicalIdSchema,
    expectedGoalVersion: versionSchema, expectedTodoRevision: versionSchema,
    todoIds: z.array(publicProjectionCanonicalIdSchema).min(1).max(256),
    maxConcurrency: z.number().int().min(1).max(16),
    maxTransitions: z.number().int().min(1).max(10_000),
    executionMode: z.enum(['manual', 'agent']).optional(),
    deadlineAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    kind: z.literal('workflow.advance'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    workflowId: publicProjectionCanonicalIdSchema, expectedVersion: versionSchema,
    completed: z.array(z.object({
      todoId: publicProjectionCanonicalIdSchema,
      outcome: z.enum(['completed', 'failed']),
      summary: z.string().trim().min(1).max(4_000)
    }).strict()).min(1).max(16)
  }).strict(),
  z.object({
    kind: z.literal('workflow.cancel'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    workflowId: publicProjectionCanonicalIdSchema, expectedVersion: versionSchema
  }).strict(),
  z.object({
    kind: z.literal('schedule.create'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    scheduleId: publicProjectionCanonicalIdSchema, prompt: textSchema,
    timing: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('once'), at: z.string().datetime({ offset: true }), missPolicy: z.enum(['skip', 'run_once']) }).strict(),
      z.object({ kind: z.literal('interval'), intervalMs: z.number().int().min(1_000).max(31_536_000_000) }).strict(),
      z.object({ kind: z.literal('cron'), expression: z.string().trim().min(1).max(256), timezone: z.string().trim().min(1).max(128), missPolicy: z.enum(['skip', 'run_once']) }).strict()
    ])
  }).strict(),
  z.object({
    kind: z.literal('schedule.transition'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    scheduleId: publicProjectionCanonicalIdSchema, expectedVersion: versionSchema,
    action: z.enum(['pause', 'resume', 'cancel'])
  }).strict(),
  z.object({
    kind: z.literal('schedules.query'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({
    kind: z.literal('schedule.occurrences.query'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    before: occurrenceCursorSchema.nullable(), limit: z.number().int().min(1).max(100)
  }).strict(),
  z.object({
    kind: z.literal('schedule.occurrence.retry'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    occurrenceId: publicProjectionCanonicalIdSchema,
    expectedAttempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
  }).strict(),
  z.object({
    kind: z.literal('goal.autonomy.start'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    goalId: publicProjectionCanonicalIdSchema, expectedVersion: versionSchema,
    criteria: z.array(textSchema).min(1).max(32), maxConcurrency: z.number().int().min(1).max(16),
    deadlineAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    kind: z.literal('goal.autonomy.transition'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    goalId: publicProjectionCanonicalIdSchema, expectedVersion: versionSchema, action: z.enum(['pause', 'resume'])
  }).strict()
] as const;

const todoItemSchema = z.object({
  todoId: publicProjectionCanonicalIdSchema, title: textSchema, status: todoStatusSchema, ordinal: z.number().int().nonnegative(),
  dependsOn: z.array(publicProjectionCanonicalIdSchema).max(256).optional()
}).strict();
const goalSchema = z.object({
  goalId: publicProjectionCanonicalIdSchema, workspaceId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema, version: versionSchema, title: textSchema,
  phase: z.string().trim().min(1).max(128), status: goalStatusSchema,
  roundCap: z.number().int().min(1).max(10_000), roundsUsed: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
  autonomy: z.object({
    status: z.enum(['planning', 'executing', 'verifying', 'stopping', 'paused', 'blocked', 'complete']),
    criteria: z.array(textSchema).min(1).max(32), deadlineAt: z.string().datetime({ offset: true }),
    maxConcurrency: z.number().int().min(1).max(16), plannerAttempts: z.number().int().nonnegative(),
    sessionId: publicProjectionCanonicalIdSchema.nullable(), runId: publicProjectionCanonicalIdSchema.nullable(),
    workflowId: publicProjectionCanonicalIdSchema.nullable(), summary: z.string().max(4_000),
    completedBy: z.enum(['verification', 'user']).optional(),
    assessment: z.array(z.object({ criterion: z.number().int().min(0).max(31), status: z.literal('passed'),
      evidence: z.string().trim().min(1).max(4_000) }).strict()).min(1).max(32).optional()
  }).strict().optional()
}).strict();
const workflowSchema = z.object({
  workflowId: publicProjectionCanonicalIdSchema, goalId: publicProjectionCanonicalIdSchema,
  version: versionSchema, status: z.enum(['running', 'cancelling', 'completed', 'failed', 'cancelled']),
  executionMode: z.enum(['manual', 'agent']).optional(),
  taskRuns: z.array(z.object({
    todoId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    runId: publicProjectionCanonicalIdSchema.nullable()
  }).strict()).optional(),
  maxConcurrency: z.number().int().min(1).max(16), maxTransitions: z.number().int().positive(),
  transitionsUsed: z.number().int().nonnegative(), deadlineAt: z.string().datetime({ offset: true }),
  activeTodoIds: z.array(publicProjectionCanonicalIdSchema), pendingTodoIds: z.array(publicProjectionCanonicalIdSchema),
  dependencies: z.array(z.object({ todoId: publicProjectionCanonicalIdSchema,
    dependsOn: z.array(publicProjectionCanonicalIdSchema).max(256) }).strict()).max(256).optional(),
  results: z.array(z.object({ todoId: publicProjectionCanonicalIdSchema, outcome: z.enum(['completed', 'failed', 'cancelled']), summary: z.string().max(4_000) }).strict())
}).strict();
const scheduleSchema = z.object({
  scheduleId: publicProjectionCanonicalIdSchema, workspaceId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema, version: versionSchema,
  status: z.enum(['active', 'paused', 'cancelled', 'completed']), prompt: textSchema,
  timing: productivityCommandSchemas[6].shape.timing,
  nextFireAt: z.string().datetime({ offset: true }).nullable(), fireCount: z.number().int().nonnegative()
}).strict();

export const productivityResultSchemas = [
  z.object({ kind: z.literal('goal.updated'), goal: goalSchema }).strict(),
  z.object({ kind: z.literal('todo.snapshot.replaced'), goalId: publicProjectionCanonicalIdSchema, revision: versionSchema, items: z.array(todoItemSchema) }).strict(),
  z.object({ kind: z.literal('productivity.query_result'), goal: goalSchema.nullable(), todoRevision: versionSchema.nullable(), todos: z.array(todoItemSchema), workflows: z.array(workflowSchema) }).strict(),
  z.object({ kind: z.literal('workflow.updated'), workflow: workflowSchema }).strict(),
  z.object({ kind: z.literal('schedule.updated'), schedule: scheduleSchema }).strict(),
  z.object({ kind: z.literal('schedules.query_result'), schedules: z.array(scheduleSchema) }).strict(),
  z.object({ kind: z.literal('schedule.occurrences.query_result'), occurrences: z.array(occurrenceSchema).max(100), nextCursor: occurrenceCursorSchema.nullable() }).strict(),
  z.object({ kind: z.literal('schedule.occurrence.updated'), occurrence: occurrenceSchema }).strict()
] as const;

export type ProductivityCommand = z.infer<(typeof productivityCommandSchemas)[number]>;
export type ProductivityResult = z.infer<(typeof productivityResultSchemas)[number]>;
