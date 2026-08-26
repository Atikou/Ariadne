import type { DatabaseSync } from 'node:sqlite';

import {
  canonicalizeAgentControlData,
  sha256AgentControlData
} from '@ariadne/agent-core';
import type {
  AgentRunExecutionIntent,
  AgentRunExecutionIntentClaimRequest,
  AgentRunExecutionIntentReceipt,
  AgentRunExecutionIntentRecoveryPage,
  AgentRunExecutionIntentRecoveryRequest,
  AgentRunExecutionIntentStateReceipt,
  ClaimedAgentRunExecutionIntent,
  MarkAgentRunExecutionDispatchedRequest,
  RecoverableAgentRunExecutionIntent,
  SettleAgentRunExecutionIntentRequest,
  StartAgentRunExecutionDispatchRequest
} from '../../../../control/ports/AgentRunExecutionStarter.js';
import {
  assertExecutionIntent,
  assertExecutionIntentClaimRequest,
  assertExecutionIntentRecoveryRequest,
  assertMarkExecutionDispatchedRequest,
  assertSettleExecutionIntentRequest,
  assertStartExecutionDispatchRequest,
  executionClaimConflict,
  executionIntentConflict,
  executionStateConflict,
  isSqliteUniqueConstraint,
  storageCorruption
} from './AgentExecutionIntentValidation.js';
import {
  decodeAndVerifyExecutionIntent,
  executionIntentReceipt,
  loadExecutionIntentRow,
  type AgentExecutionIntentRow
} from './AgentExecutionIntentRowMapper.js';

export {
  AgentRunExecutionIntentStoreError
} from './AgentExecutionIntentValidation.js';

export type AgentExecutionAdmissionVerifier = (
  intent: AgentRunExecutionIntent
) => Promise<string>;

export class SqliteAgentExecutionIntentStore {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly verifyAdmission: AgentExecutionAdmissionVerifier
  ) {}

  public async start(
    intent: AgentRunExecutionIntent,
    callerSignal: AbortSignal
  ): Promise<AgentRunExecutionIntentReceipt> {
    assertExecutionIntent(intent);
    callerSignal.throwIfAborted();
    const canonicalIntent = canonicalizeAgentControlData(intent);
    const intentDigest = await sha256AgentControlData(intent);
    const existing = loadExecutionIntentRow(this.database, intent.executionIntentId);
    if (existing !== undefined) {
      const decoded = await decodeAndVerifyExecutionIntent(existing);
      if (
        existing.intent_digest !== intentDigest
        || existing.intent_json !== canonicalIntent
        || canonicalizeAgentControlData(decoded) !== canonicalIntent
      ) {
        throw executionIntentConflict(
          intent.executionIntentId,
          'immutable_intent_mismatch'
        );
      }
      callerSignal.throwIfAborted();
      return executionIntentReceipt(existing, true);
    }

    const admissionCommandId = await this.verifyAdmission(intent);
    callerSignal.throwIfAborted();
    try {
      this.database.prepare(
        `INSERT INTO agent_v3_execution_intents (
           execution_intent_id, source_outbox_message_id,
           intent_digest, intent_json, run_id, admitted_run_version,
           admission_command_id, created_at, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      ).run(
        intent.executionIntentId,
        intent.sourceOutboxMessageId,
        intentDigest,
        canonicalIntent,
        intent.runId,
        intent.admittedRunVersion,
        admissionCommandId,
        intent.occurredAt
      );
    } catch (error) {
      if (isSqliteUniqueConstraint(error)) {
        throw executionIntentConflict(
          intent.executionIntentId,
          'source_outbox_or_identity_conflict',
          error
        );
      }
      throw error;
    }
    callerSignal.throwIfAborted();
    const inserted = loadExecutionIntentRow(this.database, intent.executionIntentId);
    if (inserted === undefined) {
      throw storageCorruption(
        `agent_v3_execution_intents:${intent.executionIntentId}:insert_missing`
      );
    }
    await decodeAndVerifyExecutionIntent(inserted);
    return executionIntentReceipt(inserted, false);
  }

  public claimPending(
    request: AgentRunExecutionIntentClaimRequest,
    claimedAt: string,
    leaseExpiresAt: string
  ): Promise<readonly ClaimedAgentRunExecutionIntent[]> {
    assertExecutionIntentClaimRequest(request);
    return claimPendingExecutionIntents(
      this.database,
      request,
      claimedAt,
      leaseExpiresAt
    );
  }

  public listRecovery(
    request: AgentRunExecutionIntentRecoveryRequest = {}
  ): Promise<AgentRunExecutionIntentRecoveryPage> {
    assertExecutionIntentRecoveryRequest(request);
    return listExecutionIntentRecovery(this.database, request);
  }

  public markDispatchStarted(
    request: StartAgentRunExecutionDispatchRequest,
    now: string
  ): Promise<AgentRunExecutionIntentStateReceipt> {
    assertStartExecutionDispatchRequest(request);
    return markExecutionDispatchStarted(this.database, request, now);
  }

  public markDispatched(
    request: MarkAgentRunExecutionDispatchedRequest,
    now: string
  ): Promise<AgentRunExecutionIntentStateReceipt> {
    assertMarkExecutionDispatchedRequest(request);
    return markExecutionDispatched(this.database, request, now);
  }

  public settle(
    request: SettleAgentRunExecutionIntentRequest,
    now: string
  ): Promise<AgentRunExecutionIntentStateReceipt> {
    assertSettleExecutionIntentRequest(request);
    return settleExecutionIntent(this.database, request, now);
  }

  public recoverAbandonedClaims(): void {
    recoverAbandonedAgentExecutionIntentClaims(this.database);
  }
}

async function claimPendingExecutionIntents(
  database: DatabaseSync,
  request: AgentRunExecutionIntentClaimRequest,
  claimedAt: string,
  leaseExpiresAt: string
): Promise<readonly ClaimedAgentRunExecutionIntent[]> {
  const existing = database.prepare(
    `SELECT * FROM agent_v3_execution_intents
     WHERE state='pending' AND claim_id=?
     ORDER BY created_at, execution_intent_id`
  ).all(request.claimId) as unknown as AgentExecutionIntentRow[];
  if (existing.length > 0) {
    if (existing.some((row) => (
      row.claim_expires_at === null || row.claim_expires_at <= claimedAt
    ))) {
      throw executionClaimConflict(
        `Execution claim "${request.claimId}" expired and cannot be renewed.`
      );
    }
    return Promise.all(existing.map((row) => claimedExecutionIntent(row)));
  }

  const candidates = database.prepare(
    `SELECT execution_intent_id
     FROM agent_v3_execution_intents
     WHERE state='pending'
       AND (claim_id IS NULL OR claim_expires_at <= ?)
     ORDER BY created_at, execution_intent_id
     LIMIT ?`
  ).all(claimedAt, request.limit) as unknown as Array<{
    execution_intent_id: string;
  }>;
  const update = database.prepare(
    `UPDATE agent_v3_execution_intents
     SET claim_id=?, claimed_at=?, claim_expires_at=?,
         claim_attempts=claim_attempts + 1
     WHERE execution_intent_id=? AND state='pending'
       AND (claim_id IS NULL OR claim_expires_at <= ?)`
  );
  for (const candidate of candidates) {
    const changed = update.run(
      request.claimId,
      claimedAt,
      leaseExpiresAt,
      candidate.execution_intent_id,
      claimedAt
    );
    if (Number(changed.changes) !== 1) {
      throw executionClaimConflict(
        'The pending execution-intent set changed while it was being claimed.'
      );
    }
  }
  const claimed = database.prepare(
    `SELECT * FROM agent_v3_execution_intents
     WHERE state='pending' AND claim_id=?
     ORDER BY created_at, execution_intent_id`
  ).all(request.claimId) as unknown as AgentExecutionIntentRow[];
  return Promise.all(claimed.map((row) => claimedExecutionIntent(row)));
}

async function claimedExecutionIntent(
  row: AgentExecutionIntentRow
): Promise<ClaimedAgentRunExecutionIntent> {
  const intent = await decodeAndVerifyExecutionIntent(row);
  if (
    row.state !== 'pending'
    || row.claim_id === null
    || row.claim_expires_at === null
  ) {
    throw storageCorruption(
      `agent_v3_execution_intents:${row.execution_intent_id}:claim_missing`
    );
  }
  return {
    intent,
    intentDigest: row.intent_digest,
    admissionCommandId: row.admission_command_id,
    claimId: row.claim_id,
    leaseExpiresAt: row.claim_expires_at,
    claimAttempts: row.claim_attempts
  };
}

async function listExecutionIntentRecovery(
  database: DatabaseSync,
  request: AgentRunExecutionIntentRecoveryRequest
): Promise<AgentRunExecutionIntentRecoveryPage> {
  const limit = request.limit ?? 100;
  const rows = request.after === undefined
    ? database.prepare(
      `SELECT * FROM agent_v3_execution_intents
       WHERE state<>'settled'
       ORDER BY created_at, execution_intent_id
       LIMIT ?`
    ).all(limit + 1) as unknown as AgentExecutionIntentRow[]
    : database.prepare(
      `SELECT * FROM agent_v3_execution_intents
       WHERE state<>'settled'
         AND (created_at > ? OR (created_at = ? AND execution_intent_id > ?))
       ORDER BY created_at, execution_intent_id
       LIMIT ?`
    ).all(
      request.after.createdAt,
      request.after.createdAt,
      request.after.executionIntentId,
      limit + 1
    ) as unknown as AgentExecutionIntentRow[];
  const pageRows = rows.slice(0, limit);
  const items = await Promise.all(pageRows.map(recoverableExecutionIntent));
  if (rows.length <= limit) return { items };
  const last = pageRows[pageRows.length - 1];
  if (last === undefined) return { items };
  return {
    items,
    nextCursor: {
      createdAt: last.created_at,
      executionIntentId: last.execution_intent_id
    }
  };
}

async function recoverableExecutionIntent(
  row: AgentExecutionIntentRow
): Promise<RecoverableAgentRunExecutionIntent> {
  const intent = await decodeAndVerifyExecutionIntent(row);
  if (row.state === 'settled') {
    throw storageCorruption(
      `agent_v3_execution_intents:${row.execution_intent_id}:settled_in_recovery`
    );
  }
  return {
    intent,
    intentDigest: row.intent_digest,
    admissionCommandId: row.admission_command_id,
    state: row.state,
    dispatchAttemptId: row.dispatch_attempt_id,
    dispatchStartedAt: row.dispatch_started_at,
    externalDispatchId: row.external_dispatch_id,
    dispatchReceiptDigest: row.dispatch_receipt_digest,
    dispatchedAt: row.dispatched_at
  };
}

async function markExecutionDispatchStarted(
  database: DatabaseSync,
  request: StartAgentRunExecutionDispatchRequest,
  now: string
): Promise<AgentRunExecutionIntentStateReceipt> {
  const row = loadExecutionIntentRow(database, request.executionIntentId);
  if (row === undefined) {
    throw executionStateConflict('Execution intent does not exist.');
  }
  await decodeAndVerifyExecutionIntent(row);
  if (row.state !== 'pending') {
    if (
      row.dispatch_attempt_id === request.dispatchAttemptId
      && row.dispatch_started_at === request.startedAt
    ) return executionStateReceipt(row, true);
    throw executionStateConflict(
      'Execution intent already crossed a different dispatch boundary.'
    );
  }
  if (
    row.claim_id !== request.claimId
    || row.claim_expires_at === null
    || row.claim_expires_at <= now
    || request.startedAt > now
    || request.startedAt > row.claim_expires_at
  ) {
    throw executionClaimConflict(
      'Execution dispatch start requires its exact active pending claim.'
    );
  }
  if (request.startedAt < row.created_at) {
    throw executionStateConflict(
      'Execution dispatch cannot start before its durable intent exists.'
    );
  }
  const changed = database.prepare(
    `UPDATE agent_v3_execution_intents
     SET state='dispatching', claim_id=NULL, claimed_at=NULL,
         claim_expires_at=NULL, dispatch_attempt_id=?, dispatch_started_at=?
     WHERE execution_intent_id=? AND state='pending' AND claim_id=?`
  ).run(
    request.dispatchAttemptId,
    request.startedAt,
    request.executionIntentId,
    request.claimId
  );
  if (Number(changed.changes) !== 1) {
    throw executionStateConflict(
      'Execution intent changed before its dispatch fence was committed.'
    );
  }
  const updated = requireExecutionIntentRow(database, request.executionIntentId);
  await decodeAndVerifyExecutionIntent(updated);
  return executionStateReceipt(updated, false);
}

async function markExecutionDispatched(
  database: DatabaseSync,
  request: MarkAgentRunExecutionDispatchedRequest,
  now: string
): Promise<AgentRunExecutionIntentStateReceipt> {
  const row = requireExecutionIntentRow(database, request.executionIntentId);
  await decodeAndVerifyExecutionIntent(row);
  if (row.state === 'dispatched' || row.state === 'settled') {
    if (
      row.dispatch_attempt_id === request.dispatchAttemptId
      && row.external_dispatch_id === request.externalDispatchId
      && row.dispatch_receipt_digest === request.dispatchReceiptDigest
      && row.dispatched_at === request.dispatchedAt
    ) return executionStateReceipt(row, true);
    throw executionStateConflict('Committed external dispatch receipt is immutable.');
  }
  if (
    row.state !== 'dispatching'
    || row.dispatch_attempt_id !== request.dispatchAttemptId
    || row.dispatch_started_at === null
    || request.dispatchedAt < row.dispatch_started_at
    || request.dispatchedAt > now
  ) {
    throw executionStateConflict(
      'External dispatch must bind the exact durable dispatching boundary.'
    );
  }
  const changed = database.prepare(
    `UPDATE agent_v3_execution_intents
     SET state='dispatched', external_dispatch_id=?,
         dispatch_receipt_digest=?, dispatched_at=?
     WHERE execution_intent_id=? AND state='dispatching'
       AND dispatch_attempt_id=?`
  ).run(
    request.externalDispatchId,
    request.dispatchReceiptDigest,
    request.dispatchedAt,
    request.executionIntentId,
    request.dispatchAttemptId
  );
  if (Number(changed.changes) !== 1) {
    throw executionStateConflict(
      'Execution intent changed before its external receipt was committed.'
    );
  }
  const updated = requireExecutionIntentRow(database, request.executionIntentId);
  await decodeAndVerifyExecutionIntent(updated);
  return executionStateReceipt(updated, false);
}

async function settleExecutionIntent(
  database: DatabaseSync,
  request: SettleAgentRunExecutionIntentRequest,
  now: string
): Promise<AgentRunExecutionIntentStateReceipt> {
  const row = requireExecutionIntentRow(database, request.executionIntentId);
  await decodeAndVerifyExecutionIntent(row);
  if (row.state === 'settled') {
    if (
      row.dispatch_attempt_id === request.dispatchAttemptId
      && row.external_dispatch_id === request.externalDispatchId
      && row.settlement_outcome === request.outcome
      && row.settlement_digest === request.settlementDigest
      && row.settled_at === request.settledAt
    ) return executionStateReceipt(row, true);
    throw executionStateConflict('Committed execution settlement is immutable.');
  }
  if (
    row.state !== 'dispatched'
    || row.dispatch_attempt_id !== request.dispatchAttemptId
    || row.external_dispatch_id !== request.externalDispatchId
    || row.dispatched_at === null
    || request.settledAt < row.dispatched_at
    || request.settledAt > now
  ) {
    throw executionStateConflict(
      'Execution settlement requires an exact known external dispatch receipt.'
    );
  }
  const changed = database.prepare(
    `UPDATE agent_v3_execution_intents
     SET state='settled', settlement_outcome=?, settlement_digest=?, settled_at=?
     WHERE execution_intent_id=? AND state='dispatched'
       AND dispatch_attempt_id=? AND external_dispatch_id=?`
  ).run(
    request.outcome,
    request.settlementDigest,
    request.settledAt,
    request.executionIntentId,
    request.dispatchAttemptId,
    request.externalDispatchId
  );
  if (Number(changed.changes) !== 1) {
    throw executionStateConflict(
      'Execution intent changed before its settlement was committed.'
    );
  }
  const updated = requireExecutionIntentRow(database, request.executionIntentId);
  await decodeAndVerifyExecutionIntent(updated);
  return executionStateReceipt(updated, false);
}

function requireExecutionIntentRow(
  database: DatabaseSync,
  executionIntentId: string
): AgentExecutionIntentRow {
  const row = loadExecutionIntentRow(database, executionIntentId);
  if (row === undefined) {
    throw executionStateConflict('Execution intent does not exist.');
  }
  return row;
}

function executionStateReceipt(
  row: AgentExecutionIntentRow,
  replayed: boolean
): AgentRunExecutionIntentStateReceipt {
  if (row.dispatch_attempt_id === null) {
    throw storageCorruption(
      `agent_v3_execution_intents:${row.execution_intent_id}:dispatch_attempt_missing`
    );
  }
  return {
    executionIntentId: row.execution_intent_id,
    state: row.state,
    dispatchAttemptId: row.dispatch_attempt_id,
    replayed
  };
}

function recoverAbandonedAgentExecutionIntentClaims(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(
      `UPDATE agent_v3_execution_intents
       SET claim_id=NULL, claimed_at=NULL, claim_expires_at=NULL
       WHERE state='pending' AND claim_id IS NOT NULL;`
    );
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw storageCorruption(
      'agent_v3_execution_intents:owner_takeover_recovery_failed',
      error
    );
  }
}
