import type { ProductivityTaskRecoveryCommand, ProductivityTaskRecoveryResult } from '@ariadne/protocol/public';
import type { ProductivityTaskFaultV1, ProductivityTaskRecoveryClaimV1 } from './ProductivityTaskIsolationV1.js';

export type ProductivityTaskRecoveryReceiptV1 = {
  readonly kind: 'productivity.task_recovery_receipt'; readonly contractVersion: '1.0';
  readonly request: ProductivityTaskRecoveryCommand; readonly claimFault: ProductivityTaskFaultV1; readonly sourceDigest: string;
} & ({ readonly phase: 'reconciling' } | { readonly phase: 'completed'; readonly result: ProductivityTaskRecoveryResult });
export type ProductivityTaskRecoveryAdmissionV1 = { readonly kind: 'completed'; readonly result: ProductivityTaskRecoveryResult }
  | { readonly kind: 'reconciling'; readonly claim: ProductivityTaskRecoveryClaimV1 };

/** Same Productivity transaction/command owner. Staged recovery changes only
 * fault metadata and its new command receipt; it dispatches no task effects. */
export interface ProductivityTaskRecoveryAuthorityV1 {
  beginTaskRecoveryCommand(commandId: string, request: ProductivityTaskRecoveryCommand, now?: Date): Promise<ProductivityTaskRecoveryAdmissionV1>;
  finishTaskRecoveryCommand(commandId: string, request: ProductivityTaskRecoveryCommand,
    claim: ProductivityTaskRecoveryClaimV1, verified: boolean, now?: Date): Promise<ProductivityTaskRecoveryResult>;
  readTaskRecoveryCommand(commandId: string, request: ProductivityTaskRecoveryCommand): Promise<ProductivityTaskRecoveryReceiptV1 | null>;
}
