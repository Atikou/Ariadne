import { createHash } from 'node:crypto';
import { z } from 'zod';
import { publicProjectionCanonicalIdSchema, productivityTaskRecoveryCommandSchema } from '@ariadne/protocol/public';
import { readPersistedAuthorityJson } from './SqliteAuthorityHealth.js';
import { commandReceiptIdentity } from './CommandReceiptIdentity.js';

export const productivityTaskRecoveryClaimReceiptSchema = z.object({ kind: z.literal('productivity.task_recovery_claim'),
  contractVersion: z.literal('1.0'), commandId: publicProjectionCanonicalIdSchema,
  request: productivityTaskRecoveryCommandSchema, claimRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
}).strict().refine(value => value.claimRevision === value.request.expectedRevision + 1 && !value.commandId.startsWith('task-claim-'));
export function taskRecoveryClaimReceiptId(faultId: string, revision: number): string {
  return `task-claim-${createHash('sha256').update(JSON.stringify([faultId, revision])).digest('hex').slice(0, 48)}`;
}
export function readTaskRecoveryClaimReceipt(json: string, commandId: string, fingerprint: string) {
  return readPersistedAuthorityJson('productivity', json, value => {
    const receipt = productivityTaskRecoveryClaimReceiptSchema.parse(value);
    if (commandId !== taskRecoveryClaimReceiptId(receipt.request.faultId, receipt.claimRevision)
      || fingerprint !== commandReceiptIdentity(receipt.request).fingerprint) throw new Error('productivity_task_recovery_claim_binding_invalid');
    return receipt;
  });
}
