import { z } from 'zod';
import { publicProjectionCanonicalIdSchema as id } from './projection.js';

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const productivityTaskFaultSchema = z.object({
  faultId: id, taskKind: z.enum(['workflow', 'goal', 'schedule']), entityId: id, taskId: id,
  workspaceId: id, ownerSessionId: id, sessionId: id, revision,
  state: z.enum(['quarantined', 'reconciling', 'resolved']),
  code: z.enum(['submission_identity_conflict', 'task_authority_conflict', 'result_authority_conflict', 'cancellation_rejected']),
  occurredAt: z.string().datetime(), updatedAt: z.string().datetime()
}).strict();
const scope = { contractVersion: z.literal('1.0'), workspaceId: id, sessionId: id };
export const productivityTaskRecoveryReferenceSchema = z.object({ faultId: id, claimRevision: revision,
  commandId: id, expectedRevision: revision }).strict().refine(value => value.claimRevision === value.expectedRevision + 1);
export const productivityTaskRecoveryCommandSchema = z.object({
  kind: z.literal('productivity.task.reconcile'), ...scope, faultId: id, expectedRevision: revision
}).strict();
export const productivityTaskIsolationCommandSchemas = [
  z.object({ kind: z.literal('productivity.task_faults.query'), ...scope,
    limit: z.number().int().min(1).max(128), afterFaultId: id.optional() }).strict(),
  productivityTaskRecoveryCommandSchema,
  z.object({ kind: z.literal('productivity.task_recovery.claims.query'), ...scope,
    claims: z.array(z.object({ faultId: id, revision }).strict()).max(128) }).strict()
] as const;
export const productivityTaskRecoveryResultSchema = z.object({
  kind: z.literal('productivity.task.reconciled'),
  outcome: z.enum(['recovered', 'unresolved', 'superseded']), fault: productivityTaskFaultSchema
}).strict();
export const productivityTaskIsolationResultSchemas = [
  z.object({ kind: z.literal('productivity.task_faults.query_result'), contractVersion: z.literal('1.0'),
    workspaceId: id, sessionId: id, faults: z.array(productivityTaskFaultSchema).max(128), nextFaultId: id.nullable()
  }).strict(), productivityTaskRecoveryResultSchema,
  z.object({ kind: z.literal('productivity.task_recovery.claims_result'), ...scope,
    references: z.array(productivityTaskRecoveryReferenceSchema).max(128) }).strict()
] as const;
export type ProductivityTaskRecoveryCommand = z.infer<typeof productivityTaskRecoveryCommandSchema>;
export type ProductivityTaskRecoveryResult = z.infer<typeof productivityTaskRecoveryResultSchema>;
