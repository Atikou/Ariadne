export type ProductivityTaskKind = 'workflow' | 'goal' | 'schedule';
export type ProductivityTaskFaultCode = 'submission_identity_conflict' | 'task_authority_conflict'
  | 'result_authority_conflict' | 'cancellation_rejected';
export interface ProductivityTaskFaultV1 {
  readonly faultId: string;
  readonly taskKind: ProductivityTaskKind;
  readonly entityId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly ownerSessionId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly state: 'quarantined' | 'reconciling' | 'resolved';
  readonly code: ProductivityTaskFaultCode;
  readonly occurredAt: string;
  readonly updatedAt: string;
}

/** An explicit extension of the existing Productivity owner. Quarantine is
 * fault metadata, not a new task outcome, command ledger or execution owner. */
export interface ProductivityTaskIsolationV1 {
  quarantineTask(taskKind: ProductivityTaskKind, entityId: string, taskId: string,
    code: ProductivityTaskFaultCode, now: Date): Promise<ProductivityTaskFaultV1 | null>;
  isTaskQuarantined(taskKind: ProductivityTaskKind, entityId: string, taskId: string): Promise<boolean>;
  queryTaskFaults(workspaceId: string, sessionId: string, limit: number,
    afterFaultId?: string): Promise<{ readonly faults: readonly ProductivityTaskFaultV1[]; readonly nextFaultId: string | null }>;
}

/** Private read-only reconciliation input. Bodies and original command IDs
 * never enter the fault DTO or the independent public health endpoint. */
export interface ProductivityTaskRecoveryClaimV1 {
  readonly fault: ProductivityTaskFaultV1;
  readonly sourceDigest: string;
  readonly messageId: string;
  readonly submitCommandId: string;
  readonly createCommandId?: string;
  readonly title?: string;
  readonly prompt: string;
  readonly context?: FrozenConversationContext;
  readonly runId?: string;
  readonly dependencyMessages?: readonly { readonly reference: ConversationMessageReference }[];
  readonly terminal?: { readonly kind: 'submission' | 'execution'; readonly status: 'submitted' | 'completed' | 'failed' | 'cancelled' | 'unknown';
    readonly runVersion?: number; readonly resultMessage?: ConversationMessageReference };
}

export class ProductivityTaskInvariantError extends Error {
  public constructor(public readonly code: ProductivityTaskFaultCode, cause?: unknown) {
    super(`productivity_task_invariant:${code}`, { cause }); this.name = 'ProductivityTaskInvariantError';
  }
}
import type { ConversationMessageReference } from '@ariadne/protocol/public';
import type { FrozenConversationContext } from './ConversationContext.js';
