import { z } from 'zod';
import { productivityTaskRecoveryCommandSchema, productivityTaskRecoveryResultSchema, productivityTaskFaultSchema } from '@ariadne/protocol/public';
import { commandReceiptIdentity } from './CommandReceiptIdentity.js';
import { readPersistedAuthorityJson } from './SqliteAuthorityHealth.js';

const base = { kind: z.literal('productivity.task_recovery_receipt'), contractVersion: z.literal('1.0'),
  request: productivityTaskRecoveryCommandSchema, claimFault: productivityTaskFaultSchema,
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u) };
export const productivityTaskRecoveryReceiptSchema = z.discriminatedUnion('phase', [
  z.object({ ...base, phase: z.literal('reconciling') }).strict(),
  z.object({ ...base, phase: z.literal('completed'), result: productivityTaskRecoveryResultSchema }).strict()
]).superRefine((value, context) => {
  const { request, claimFault } = value;
  if (claimFault.workspaceId !== request.workspaceId || claimFault.ownerSessionId !== request.sessionId
    || claimFault.faultId !== request.faultId || claimFault.state !== 'reconciling'
    || claimFault.revision !== request.expectedRevision + 1) context.addIssue({ code: 'custom', message: 'Recovery claim binding invalid.' });
  if (value.phase === 'completed') {
    const { result } = value;
    if (result.fault.faultId !== request.faultId || result.fault.workspaceId !== request.workspaceId
      || result.fault.ownerSessionId !== request.sessionId || result.fault.revision < claimFault.revision
      || result.fault.taskKind !== claimFault.taskKind || result.fault.entityId !== claimFault.entityId
      || result.fault.taskId !== claimFault.taskId || result.fault.sessionId !== claimFault.sessionId
      || Date.parse(result.fault.updatedAt) < Date.parse(claimFault.updatedAt)
      || (result.outcome === 'recovered' && result.fault.state !== 'resolved')
      || (result.outcome !== 'superseded' && result.fault.revision !== claimFault.revision + 1)
      || (result.outcome === 'unresolved' && result.fault.state !== 'quarantined'))
      context.addIssue({ code: 'custom', message: 'Recovery result binding invalid.' });
  }
});
export type ProductivityTaskRecoveryReceipt = z.infer<typeof productivityTaskRecoveryReceiptSchema>;
export function readProductivityTaskRecoveryReceipt(json: string, fingerprint: string): ProductivityTaskRecoveryReceipt {
  return readPersistedAuthorityJson('productivity', json, value => {
    const receipt = productivityTaskRecoveryReceiptSchema.parse(value);
    if (commandReceiptIdentity(receipt.request).fingerprint !== fingerprint) throw new Error('productivity_task_recovery_fingerprint_invalid');
    return receipt;
  });
}
