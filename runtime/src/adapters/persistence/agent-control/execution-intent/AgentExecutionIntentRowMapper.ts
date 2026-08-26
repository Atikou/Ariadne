import type { DatabaseSync } from 'node:sqlite';

import {
  canonicalizeAgentControlData,
  sha256AgentControlData
} from '@ariadne/agent-core';
import type {
  AgentRunExecutionIntent,
  AgentRunExecutionIntentReceipt,
  AgentRunExecutionIntentState
} from '../../../../control/ports/AgentRunExecutionStarter.js';
import {
  assertExecutionIntent,
  isCanonicalExecutionId,
  isCanonicalTimestamp,
  isCommandDigest,
  isExecutionIntentState,
  parseJson,
  storageCorruption
} from './AgentExecutionIntentValidation.js';

export interface AgentExecutionIntentRow {
  execution_intent_id: string;
  source_outbox_message_id: string;
  intent_digest: string;
  intent_json: string;
  run_id: string;
  admitted_run_version: number;
  admission_command_id: string;
  created_at: string;
  state: AgentRunExecutionIntentState;
  claim_id: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  claim_attempts: number;
  dispatch_attempt_id: string | null;
  dispatch_started_at: string | null;
  external_dispatch_id: string | null;
  dispatch_receipt_digest: string | null;
  dispatched_at: string | null;
  settlement_outcome: 'completed' | 'failed' | 'cancelled' | null;
  settlement_digest: string | null;
  settled_at: string | null;
}



export function loadExecutionIntentRow(
  database: DatabaseSync,
  executionIntentId: string
): AgentExecutionIntentRow | undefined {
  return database.prepare(
    'SELECT * FROM agent_v3_execution_intents WHERE execution_intent_id=?'
  ).get(executionIntentId) as AgentExecutionIntentRow | undefined;
}

export async function decodeAndVerifyExecutionIntent(
  row: AgentExecutionIntentRow
): Promise<AgentRunExecutionIntent> {
  const source = `agent_v3_execution_intents:${row.execution_intent_id}`;
  const parsed = parseJson(row.intent_json, source);
  try {
    assertExecutionIntent(parsed as AgentRunExecutionIntent);
  } catch (error) {
    throw storageCorruption(`${source}:invalid_intent`, error);
  }
  const intent = parsed as AgentRunExecutionIntent;
  if (
    canonicalizeAgentControlData(intent) !== row.intent_json
    || await sha256AgentControlData(intent) !== row.intent_digest
    || intent.executionIntentId !== row.execution_intent_id
    || intent.sourceOutboxMessageId !== row.source_outbox_message_id
    || intent.runId !== row.run_id
    || intent.admittedRunVersion !== row.admitted_run_version
    || intent.occurredAt !== row.created_at
    || !isCanonicalExecutionId(row.admission_command_id)
    || !isExecutionIntentState(row.state)
    || !Number.isSafeInteger(row.claim_attempts)
    || row.claim_attempts < 0
  ) {
    throw storageCorruption(`${source}:metadata_mismatch`);
  }
  assertExecutionIntentStateMetadata(row, source);
  return intent;
}

function assertExecutionIntentStateMetadata(
  row: AgentExecutionIntentRow,
  source: string
): void {
  const hasClaim = row.claim_id !== null
    || row.claimed_at !== null
    || row.claim_expires_at !== null;
  if (hasClaim) {
    if (
      row.state !== 'pending'
      || row.claim_id === null
      || row.claimed_at === null
      || row.claim_expires_at === null
      || !isCanonicalExecutionId(row.claim_id)
      || !isCanonicalTimestamp(row.claimed_at)
      || !isCanonicalTimestamp(row.claim_expires_at)
      || row.claim_expires_at <= row.claimed_at
    ) {
      throw storageCorruption(`${source}:claim_metadata_mismatch`);
    }
  }
  if (row.state === 'pending') {
    if (
      row.dispatch_attempt_id !== null
      || row.dispatch_started_at !== null
      || row.external_dispatch_id !== null
      || row.dispatch_receipt_digest !== null
      || row.dispatched_at !== null
      || row.settlement_outcome !== null
      || row.settlement_digest !== null
      || row.settled_at !== null
    ) throw storageCorruption(`${source}:pending_metadata_mismatch`);
    return;
  }
  if (
    hasClaim
    || row.dispatch_attempt_id === null
    || row.dispatch_started_at === null
    || !isCanonicalExecutionId(row.dispatch_attempt_id)
    || !isCanonicalTimestamp(row.dispatch_started_at)
  ) {
    throw storageCorruption(`${source}:dispatch_start_metadata_mismatch`);
  }
  if (row.state === 'dispatching') {
    if (
      row.external_dispatch_id !== null
      || row.dispatch_receipt_digest !== null
      || row.dispatched_at !== null
      || row.settlement_outcome !== null
      || row.settlement_digest !== null
      || row.settled_at !== null
    ) throw storageCorruption(`${source}:dispatching_metadata_mismatch`);
    return;
  }
  if (
    row.external_dispatch_id === null
    || row.dispatch_receipt_digest === null
    || row.dispatched_at === null
    || !isCanonicalExecutionId(row.external_dispatch_id)
    || !isCommandDigest(row.dispatch_receipt_digest)
    || !isCanonicalTimestamp(row.dispatched_at)
    || row.dispatched_at < row.dispatch_started_at
  ) {
    throw storageCorruption(`${source}:dispatched_metadata_mismatch`);
  }
  if (row.state === 'dispatched') {
    if (
      row.settlement_outcome !== null
      || row.settlement_digest !== null
      || row.settled_at !== null
    ) throw storageCorruption(`${source}:unsettled_metadata_mismatch`);
    return;
  }
  if (
    row.settlement_outcome === null
    || row.settlement_digest === null
    || row.settled_at === null
    || !['completed', 'failed', 'cancelled'].includes(row.settlement_outcome)
    || !isCommandDigest(row.settlement_digest)
    || !isCanonicalTimestamp(row.settled_at)
    || row.settled_at < row.dispatched_at
  ) {
    throw storageCorruption(`${source}:settlement_metadata_mismatch`);
  }
}

export function executionIntentReceipt(
  row: AgentExecutionIntentRow,
  replayed: boolean
): AgentRunExecutionIntentReceipt {
  return {
    executionIntentId: row.execution_intent_id,
    sourceOutboxMessageId: row.source_outbox_message_id,
    runId: row.run_id,
    admittedRunVersion: row.admitted_run_version,
    replayed
  };
}
