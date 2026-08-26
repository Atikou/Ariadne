import type {
  AgentRunExecutionIntent,
  AgentRunExecutionIntentClaimRequest,
  AgentRunExecutionIntentRecoveryRequest,
  AgentRunExecutionIntentState,
  MarkAgentRunExecutionDispatchedRequest,
  SettleAgentRunExecutionIntentRequest,
  StartAgentRunExecutionDispatchRequest
} from '../../../../control/ports/AgentRunExecutionStarter.js';

const MAX_EXECUTION_INTENT_LEASE_MS = 5 * 60 * 1000;

export class AgentRunExecutionIntentStoreError extends Error {
  public constructor(
    public readonly code:
      | 'AGENT_EXECUTION_INTENT_INVALID'
      | 'AGENT_EXECUTION_INTENT_CONFLICT'
      | 'AGENT_EXECUTION_ADMISSION_MISMATCH'
      | 'AGENT_EXECUTION_CLAIM_CONFLICT'
      | 'AGENT_EXECUTION_STATE_CONFLICT',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AgentRunExecutionIntentStoreError';
  }
}



export function assertExecutionIntent(intent: AgentRunExecutionIntent): void {
  if (
    !hasExactDataKeys(intent, [
      'kind',
      'executionIntentId',
      'sourceOutboxMessageId',
      'sagaId',
      'sessionId',
      'workspaceId',
      'objectiveMessageId',
      'objectiveMessageVersion',
      'objectiveDigest',
      'runRequestId',
      'runId',
      'admittedRunVersion',
      'occurredAt'
    ])
    || intent.kind !== 'agent.execution.start'
    || ![
      intent.executionIntentId,
      intent.sourceOutboxMessageId,
      intent.sagaId,
      intent.sessionId,
      intent.workspaceId,
      intent.objectiveMessageId,
      intent.runRequestId,
      intent.runId
    ].every(isCanonicalExecutionId)
    || !Number.isSafeInteger(intent.objectiveMessageVersion)
    || intent.objectiveMessageVersion <= 0
    || intent.admittedRunVersion !== 1
    || !isCommandDigest(intent.objectiveDigest)
    || !isCanonicalTimestamp(intent.occurredAt)
  ) {
    throw new AgentRunExecutionIntentStoreError(
      'AGENT_EXECUTION_INTENT_INVALID',
      'Execution intent must be one exact canonical linked-Run command.'
    );
  }
}

export function assertExecutionIntentClaimRequest(
  request: AgentRunExecutionIntentClaimRequest
): void {
  if (
    !hasExactDataKeys(request, ['claimId', 'leaseMs', 'limit'])
    || !isCanonicalExecutionId(request.claimId)
    || !Number.isSafeInteger(request.limit)
    || request.limit <= 0
    || request.limit > 1_000
    || !Number.isSafeInteger(request.leaseMs)
    || request.leaseMs <= 0
    || request.leaseMs > MAX_EXECUTION_INTENT_LEASE_MS
  ) {
    throw executionIntentInvalid(
      'Execution intent claims require a canonical ID, a bounded batch, and a lease no longer than five minutes.'
    );
  }
}

export function assertExecutionIntentRecoveryRequest(
  request: AgentRunExecutionIntentRecoveryRequest
): void {
  const expectedKeys = request.after === undefined ? ['limit'] : ['limit', 'after'];
  const actualKeys = Object.keys(request);
  if (
    actualKeys.some((key) => !expectedKeys.includes(key))
    || (request.limit !== undefined && (
      !Number.isSafeInteger(request.limit)
      || request.limit <= 0
      || request.limit > 1_000
    ))
    || (
      request.after !== undefined
      && (
        !hasExactDataKeys(request.after, ['createdAt', 'executionIntentId'])
        || !isCanonicalTimestamp(request.after.createdAt)
        || !isCanonicalExecutionId(request.after.executionIntentId)
      )
    )
  ) {
    throw executionIntentInvalid('Execution intent recovery query is invalid.');
  }
}

export function assertStartExecutionDispatchRequest(
  request: StartAgentRunExecutionDispatchRequest
): void {
  if (
    !hasExactDataKeys(request, [
      'executionIntentId', 'claimId', 'dispatchAttemptId', 'startedAt'
    ])
    || !isCanonicalExecutionId(request.executionIntentId)
    || !isCanonicalExecutionId(request.claimId)
    || !isCanonicalExecutionId(request.dispatchAttemptId)
    || !isCanonicalTimestamp(request.startedAt)
  ) {
    throw executionIntentInvalid('Execution dispatch start receipt is invalid.');
  }
}

export function assertMarkExecutionDispatchedRequest(
  request: MarkAgentRunExecutionDispatchedRequest
): void {
  if (
    !hasExactDataKeys(request, [
      'executionIntentId',
      'dispatchAttemptId',
      'externalDispatchId',
      'dispatchReceiptDigest',
      'dispatchedAt'
    ])
    || !isCanonicalExecutionId(request.executionIntentId)
    || !isCanonicalExecutionId(request.dispatchAttemptId)
    || !isCanonicalExecutionId(request.externalDispatchId)
    || !isCommandDigest(request.dispatchReceiptDigest)
    || !isCanonicalTimestamp(request.dispatchedAt)
  ) {
    throw executionIntentInvalid('Execution dispatched receipt is invalid.');
  }
}

export function assertSettleExecutionIntentRequest(
  request: SettleAgentRunExecutionIntentRequest
): void {
  if (
    !hasExactDataKeys(request, [
      'executionIntentId',
      'dispatchAttemptId',
      'externalDispatchId',
      'outcome',
      'settlementDigest',
      'settledAt'
    ])
    || !isCanonicalExecutionId(request.executionIntentId)
    || !isCanonicalExecutionId(request.dispatchAttemptId)
    || !isCanonicalExecutionId(request.externalDispatchId)
    || !['completed', 'failed', 'cancelled'].includes(request.outcome)
    || !isCommandDigest(request.settlementDigest)
    || !isCanonicalTimestamp(request.settledAt)
  ) {
    throw executionIntentInvalid('Execution settlement receipt is invalid.');
  }
}


function hasExactDataKeys(value: object, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  if (
    actual.length !== keys.length
    || actual.some((key) => !allowed.has(key))
    || keys.some((key) => !Object.hasOwn(value, key))
  ) return false;
  return actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.get === undefined
      && descriptor.set === undefined;
  });
}

export function isCanonicalExecutionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value.trim() === value;
}

export function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function isExecutionIntentState(value: unknown): value is AgentRunExecutionIntentState {
  return value === 'pending'
    || value === 'dispatching'
    || value === 'dispatched'
    || value === 'settled';
}

export function isSqliteUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/iu.test(error.message);
}

function executionIntentInvalid(message: string): AgentRunExecutionIntentStoreError {
  return new AgentRunExecutionIntentStoreError(
    'AGENT_EXECUTION_INTENT_INVALID',
    message
  );
}

export function executionIntentConflict(
  executionIntentId: string,
  reason: string,
  cause?: unknown
): AgentRunExecutionIntentStoreError {
  return new AgentRunExecutionIntentStoreError(
    'AGENT_EXECUTION_INTENT_CONFLICT',
    `Execution intent "${executionIntentId}" conflicts with its durable identity (${reason}).`,
    cause === undefined ? undefined : { cause }
  );
}

function executionAdmissionMismatch(message: string): AgentRunExecutionIntentStoreError {
  return new AgentRunExecutionIntentStoreError(
    'AGENT_EXECUTION_ADMISSION_MISMATCH',
    message
  );
}

export function executionClaimConflict(message: string): AgentRunExecutionIntentStoreError {
  return new AgentRunExecutionIntentStoreError(
    'AGENT_EXECUTION_CLAIM_CONFLICT',
    message
  );
}

export function executionStateConflict(message: string): AgentRunExecutionIntentStoreError {
  return new AgentRunExecutionIntentStoreError(
    'AGENT_EXECUTION_STATE_CONFLICT',
    message
  );
}


export function isCommandDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function parseJson(value: string, source: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw storageCorruption(`${source}:invalid_json`, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function storageCorruption(message: string, cause?: unknown): Error {
  return new Error(`agent_v3_storage_corruption:${message}`, { cause });
}
