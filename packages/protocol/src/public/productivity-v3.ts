import { z } from 'zod';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, publicProjectionCanonicalIdSchema } from './projection-v3.js';

const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nullableVersionSchema = versionSchema.nullable();
const textSchema = z.string().trim().min(1).max(2_000);
const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
const goalStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete']);

export const productivityCommandSchemas = [
  z.object({
    kind: z.literal('goal.put.v3'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    goalId: publicProjectionCanonicalIdSchema, expectedVersion: nullableVersionSchema,
    title: textSchema, phase: z.string().trim().min(1).max(128), status: goalStatusSchema,
    roundCap: z.number().int().min(1).max(10_000)
  }).strict(),
  z.object({
    kind: z.literal('todo.snapshot.replace.v3'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    goalId: publicProjectionCanonicalIdSchema, expectedGoalVersion: versionSchema,
    expectedRevision: nullableVersionSchema,
    items: z.array(z.object({
      todoId: publicProjectionCanonicalIdSchema, title: textSchema, status: todoStatusSchema
    }).strict()).max(256)
  }).strict(),
  z.object({
    kind: z.literal('productivity.query.v3'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({
    kind: z.literal('workflow.start.v3'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    workflowId: publicProjectionCanonicalIdSchema, goalId: publicProjectionCanonicalIdSchema,
    expectedGoalVersion: versionSchema, expectedTodoRevision: versionSchema,
    todoIds: z.array(publicProjectionCanonicalIdSchema).min(1).max(256),
    maxConcurrency: z.number().int().min(1).max(16),
    maxTransitions: z.number().int().min(1).max(10_000),
    deadlineAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    kind: z.literal('workflow.advance.v3'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    workflowId: publicProjectionCanonicalIdSchema, expectedVersion: versionSchema,
    completed: z.array(z.object({
      todoId: publicProjectionCanonicalIdSchema,
      outcome: z.enum(['completed', 'failed']),
      summary: z.string().trim().min(1).max(4_000)
    }).strict()).min(1).max(16)
  }).strict(),
  z.object({
    kind: z.literal('workflow.cancel.v3'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    workflowId: publicProjectionCanonicalIdSchema, expectedVersion: versionSchema
  }).strict(),
  z.object({
    kind: z.literal('schedule.create.v3'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    scheduleId: publicProjectionCanonicalIdSchema, prompt: textSchema,
    timing: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('once'), at: z.string().datetime({ offset: true }), missPolicy: z.enum(['skip', 'run_once']) }).strict(),
      z.object({ kind: z.literal('interval'), intervalMs: z.number().int().min(1_000).max(31_536_000_000) }).strict(),
      z.object({ kind: z.literal('cron'), expression: z.string().trim().min(1).max(256), timezone: z.string().trim().min(1).max(128), missPolicy: z.enum(['skip', 'run_once']) }).strict()
    ])
  }).strict(),
  z.object({
    kind: z.literal('schedule.transition.v3'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
    scheduleId: publicProjectionCanonicalIdSchema, expectedVersion: versionSchema,
    action: z.enum(['pause', 'resume', 'cancel'])
  }).strict(),
  z.object({
    kind: z.literal('schedules.query.v3'), contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema
  }).strict()
] as const;

const todoItemSchema = z.object({
  todoId: publicProjectionCanonicalIdSchema, title: textSchema, status: todoStatusSchema, ordinal: z.number().int().nonnegative()
}).strict();
const goalSchema = z.object({
  goalId: publicProjectionCanonicalIdSchema, workspaceId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema, version: versionSchema, title: textSchema,
  phase: z.string().trim().min(1).max(128), status: goalStatusSchema,
  roundCap: z.number().int().min(1).max(10_000), roundsUsed: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true })
}).strict();
const workflowSchema = z.object({
  workflowId: publicProjectionCanonicalIdSchema, goalId: publicProjectionCanonicalIdSchema,
  version: versionSchema, status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  maxConcurrency: z.number().int().min(1).max(16), maxTransitions: z.number().int().positive(),
  transitionsUsed: z.number().int().nonnegative(), deadlineAt: z.string().datetime({ offset: true }),
  activeTodoIds: z.array(publicProjectionCanonicalIdSchema), pendingTodoIds: z.array(publicProjectionCanonicalIdSchema),
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
  z.object({ kind: z.literal('goal.updated.v3'), goal: goalSchema }).strict(),
  z.object({ kind: z.literal('todo.snapshot.replaced.v3'), goalId: publicProjectionCanonicalIdSchema, revision: versionSchema, items: z.array(todoItemSchema) }).strict(),
  z.object({ kind: z.literal('productivity.query_result.v3'), goal: goalSchema.nullable(), todoRevision: versionSchema.nullable(), todos: z.array(todoItemSchema), workflows: z.array(workflowSchema) }).strict(),
  z.object({ kind: z.literal('workflow.updated.v3'), workflow: workflowSchema }).strict(),
  z.object({ kind: z.literal('schedule.updated.v3'), schedule: scheduleSchema }).strict(),
  z.object({ kind: z.literal('schedules.query_result.v3'), schedules: z.array(scheduleSchema) }).strict()
] as const;

export type ProductivityCommand = z.infer<(typeof productivityCommandSchemas)[number]>;
export type ProductivityResult = z.infer<(typeof productivityResultSchemas)[number]>;
