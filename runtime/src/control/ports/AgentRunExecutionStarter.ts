/**
 * Immutable command emitted after Conversation has durably linked an admitted
 * Agent Run. Implementations must bind `executionIntentId` to the exact command
 * payload and persist that receipt before returning.
 */
export interface AgentRunExecutionIntent {
  readonly kind: 'agent.execution.start';
  readonly executionIntentId: string;
  readonly sourceOutboxMessageId: string;
  readonly sagaId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly objectiveMessageId: string;
  readonly objectiveMessageVersion: number;
  readonly objectiveDigest: string;
  readonly runRequestId: string;
  readonly runId: string;
  readonly admittedRunVersion: number;
  readonly occurredAt: string;
}

/** Durable proof that the exact execution intent was committed or replayed. */
export interface AgentRunExecutionIntentReceipt {
  readonly executionIntentId: string;
  readonly sourceOutboxMessageId: string;
  readonly runId: string;
  readonly admittedRunVersion: number;
  readonly replayed: boolean;
}

export type AgentRunExecutionIntentState =
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  | 'settled';

export interface AgentRunExecutionIntentClaimRequest {
  readonly claimId: string;
  readonly leaseMs: number;
  readonly limit: number;
}

/**
 * A claim is safe to abandon or reclaim because the external dispatch fence
 * has not been crossed yet. Schedulers must durably call
 * `markExecutionDispatchStarted` before invoking an external executor.
 */
export interface ClaimedAgentRunExecutionIntent {
  readonly intent: AgentRunExecutionIntent;
  readonly intentDigest: string;
  readonly admissionCommandId: string;
  readonly claimId: string;
  readonly leaseExpiresAt: string;
  readonly claimAttempts: number;
}

export interface AgentRunExecutionIntentRecoveryCursor {
  readonly createdAt: string;
  readonly executionIntentId: string;
}

export interface AgentRunExecutionIntentRecoveryRequest {
  readonly limit?: number;
  readonly after?: AgentRunExecutionIntentRecoveryCursor;
}

export interface RecoverableAgentRunExecutionIntent {
  readonly intent: AgentRunExecutionIntent;
  readonly intentDigest: string;
  readonly admissionCommandId: string;
  readonly state: Exclude<AgentRunExecutionIntentState, 'settled'>;
  readonly dispatchAttemptId: string | null;
  readonly dispatchStartedAt: string | null;
  readonly externalDispatchId: string | null;
  readonly dispatchReceiptDigest: string | null;
  readonly dispatchedAt: string | null;
}

export interface AgentRunExecutionIntentRecoveryPage {
  readonly items: readonly RecoverableAgentRunExecutionIntent[];
  readonly nextCursor?: AgentRunExecutionIntentRecoveryCursor;
}

export interface StartAgentRunExecutionDispatchRequest {
  readonly executionIntentId: string;
  readonly claimId: string;
  readonly dispatchAttemptId: string;
  readonly startedAt: string;
}

export interface MarkAgentRunExecutionDispatchedRequest {
  readonly executionIntentId: string;
  readonly dispatchAttemptId: string;
  readonly externalDispatchId: string;
  readonly dispatchReceiptDigest: string;
  readonly dispatchedAt: string;
}

export interface SettleAgentRunExecutionIntentRequest {
  readonly executionIntentId: string;
  readonly dispatchAttemptId: string;
  readonly externalDispatchId: string;
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  readonly settlementDigest: string;
  readonly settledAt: string;
}

export interface AgentRunExecutionIntentStateReceipt {
  readonly executionIntentId: string;
  readonly state: AgentRunExecutionIntentState;
  readonly dispatchAttemptId: string;
  readonly replayed: boolean;
}

/**
 * Narrow downstream boundary for linked Runs. There is deliberately no
 * optional/no-op implementation: a production coordinator without this port
 * is invalid and must fail closed before it can claim an outbox message.
 */
export interface AgentRunExecutionStarter {
  startExecutionIntent(
    intent: AgentRunExecutionIntent,
    signal: AbortSignal
  ): Promise<AgentRunExecutionIntentReceipt>;
}

/**
 * Durable scheduler ledger. `dispatching` is intentionally sticky: a process
 * crash or unknown external result is recovery work, never evidence that the
 * execution did not happen.
 */
export interface AgentRunExecutionIntentLedger
extends AgentRunExecutionStarter {
  claimPendingExecutionIntents(
    request: AgentRunExecutionIntentClaimRequest
  ): Promise<readonly ClaimedAgentRunExecutionIntent[]>;
  listExecutionIntentRecovery(
    request?: AgentRunExecutionIntentRecoveryRequest
  ): Promise<AgentRunExecutionIntentRecoveryPage>;
  markExecutionDispatchStarted(
    request: StartAgentRunExecutionDispatchRequest
  ): Promise<AgentRunExecutionIntentStateReceipt>;
  markExecutionDispatched(
    request: MarkAgentRunExecutionDispatchedRequest
  ): Promise<AgentRunExecutionIntentStateReceipt>;
  settleExecutionIntent(
    request: SettleAgentRunExecutionIntentRequest
  ): Promise<AgentRunExecutionIntentStateReceipt>;
}
