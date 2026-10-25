import { z } from 'zod';
import { publicProjectionCanonicalIdSchema } from '../public/projection.js';

const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task_result'), messageId: publicProjectionCanonicalIdSchema }).strict(),
  z.object({ kind: z.literal('tool_result'), toolCallId: publicProjectionCanonicalIdSchema }).strict()
]);
const criterion = z.object({ criterion: z.number().int().min(0).max(31), status: z.enum(['passed', 'failed', 'unknown']),
  evidence: z.string().trim().min(1).max(4_000), sources: z.array(source).min(1).max(32) }).strict();
const task = z.object({ key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u), title: z.string().trim().min(1).max(2_000),
  dependsOn: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u)).max(256) }).strict();
export const goalDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('plan'), summary: z.string().trim().min(1).max(4_000), tasks: z.array(task).min(1).max(256) }).strict(),
  z.object({ decision: z.literal('complete'), summary: z.string().trim().min(1).max(4_000), checks: z.array(criterion).min(1).max(32) }).strict(),
  z.object({ decision: z.literal('blocked'), summary: z.string().trim().min(1).max(4_000) }).strict()
]);
export type GoalDecision = z.infer<typeof goalDecisionSchema>;
