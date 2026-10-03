import { DatabaseSync } from 'node:sqlite';
import { projectConversationRunHandoffArtifacts, type ConversationRunHandoffOutboxMessage } from '../../conversation/ConversationRunHandoffSaga.js';
import type {
  ClaimedConversationOutboxMessage,
  ConversationOutboxClaimRequest,
  ConversationOutboxPublishRequest
} from '../../control/ports/ConversationRunHandoffOutbox.js';
import { ConversationOutboxClaimError, type OutboxRow } from './ConversationHandoffStorageTypes.js';
import {
  assertCanonicalId,
  assertCanonicalUtcTimestamp,
  storageInvariant
} from './ConversationHandoffStorageValidation.js';
import { parseOutboxMessage, parseSagaJson } from './ConversationHandoffRowMapper.js';
import { assertExpectedArtifacts } from './ConversationHandoffCommitValidation.js';

const MAX_OUTBOX_LEASE_MS = 5 * 60 * 1000;

export function claimPendingOutbox(
  database: DatabaseSync,
  request: ConversationOutboxClaimRequest,
  claimedAt: string
): readonly ClaimedConversationOutboxMessage[] {
  const existing = selectOutbox(database, 'published_at IS NULL AND claim_id=?', [
    request.claimId
  ]);
  if (existing.length > 0) {
    if (existing.some((row) => row.claim_expires_at === null || row.claim_expires_at <= claimedAt)) {
      throw new ConversationOutboxClaimError(
        request.claimId,
        `Conversation outbox claim "${request.claimId}" expired.`
      );
    }
    return existing.map(parseClaimedOutbox);
  }
  const completed = database.prepare(
    `SELECT COUNT(*) AS count FROM conversation_handoff_outbox
     WHERE published_claim_id=?`
  ).get(request.claimId) as { count: number };
  if (Number(completed.count) > 0) return [];

  const claimExpiresAt = new Date(Date.parse(claimedAt) + request.leaseMs).toISOString();
  const candidates = database.prepare(
    `SELECT cursor FROM conversation_handoff_outbox
     WHERE published_at IS NULL
       AND (claim_id IS NULL OR claim_expires_at <= ?)
     ORDER BY cursor LIMIT ?`
  ).all(claimedAt, request.limit) as unknown as Array<{ cursor: number }>;
  const update = database.prepare(
    `UPDATE conversation_handoff_outbox
     SET claim_id=?, claimed_at=?, claim_expires_at=?,
         claim_attempts=claim_attempts + 1
     WHERE cursor=? AND published_at IS NULL
       AND (claim_id IS NULL OR claim_expires_at <= ?)`
  );
  for (const candidate of candidates) {
    const result = update.run(
      request.claimId,
      claimedAt,
      claimExpiresAt,
      candidate.cursor,
      claimedAt
    );
    if (Number(result.changes) !== 1) {
      throw new ConversationOutboxClaimError(
        request.claimId,
        'Conversation outbox claim lost its candidate set.'
      );
    }
  }
  return selectOutbox(database, 'published_at IS NULL AND claim_id=?', [
    request.claimId
  ]).map(parseClaimedOutbox);
}

export function acknowledgeOutbox(
  database: DatabaseSync,
  request: ConversationOutboxPublishRequest,
  publishedAt: string
): void {
  const rows: OutboxRow[] = [];
  for (const receipt of request.messages) {
    const row = database.prepare(
      `SELECT outbox.cursor, outbox.message_id, outbox.command_id,
              outbox.saga_id, outbox.saga_version, outbox.message_kind,
              outbox.message_json, outbox.created_at, outbox.published_at,
              outbox.published_claim_id, outbox.claim_id, outbox.claimed_at,
              outbox.claim_expires_at, outbox.claim_attempts,
              command.command_fingerprint, command.result_saga_json
       FROM conversation_handoff_outbox AS outbox
       LEFT JOIN conversation_handoff_commands AS command
         ON command.command_id=outbox.command_id
       WHERE outbox.cursor=?`
    ).get(receipt.cursor) as OutboxRow | undefined;
    if (row === undefined || row.message_id !== receipt.messageId) {
      throw new ConversationOutboxClaimError(
        request.claimId,
        'Conversation outbox ACK does not match its durable cursor and message.'
      );
    }
    parseAndValidateOutboxRow(row);
    if (row.published_at !== null) {
      if (row.published_claim_id !== request.claimId) {
        throw new ConversationOutboxClaimError(
          request.claimId,
          'Conversation outbox message was ACKed by a different claim.'
        );
      }
      rows.push(row);
      continue;
    }
    if (
      row.claim_id !== request.claimId
      || row.claim_expires_at === null
      || row.claim_expires_at <= publishedAt
    ) {
      throw new ConversationOutboxClaimError(
        request.claimId,
        'Conversation outbox ACK claim is missing, changed, or expired.'
      );
    }
    rows.push(row);
  }

  const update = database.prepare(
    `UPDATE conversation_handoff_outbox
     SET published_at=?, published_claim_id=?,
         claim_id=NULL, claimed_at=NULL, claim_expires_at=NULL
     WHERE cursor=? AND message_id=? AND published_at IS NULL AND claim_id=?`
  );
  for (const row of rows) {
    if (row.published_at !== null) continue;
    const result = update.run(
      publishedAt,
      request.claimId,
      row.cursor,
      row.message_id,
      request.claimId
    );
    if (Number(result.changes) !== 1) {
      throw new ConversationOutboxClaimError(
        request.claimId,
        'Conversation outbox ACK lost its exact durable claim.'
      );
    }
  }
}

function selectOutbox(
  database: DatabaseSync,
  where: string,
  parameters: readonly (string | number)[]
): OutboxRow[] {
  return database.prepare(
    `SELECT outbox.cursor, outbox.message_id, outbox.command_id,
            outbox.saga_id, outbox.saga_version, outbox.message_kind,
            outbox.message_json, outbox.created_at, outbox.published_at,
            outbox.published_claim_id, outbox.claim_id, outbox.claimed_at,
            outbox.claim_expires_at, outbox.claim_attempts,
            command.command_fingerprint, command.result_saga_json
     FROM conversation_handoff_outbox AS outbox
     LEFT JOIN conversation_handoff_commands AS command
       ON command.command_id=outbox.command_id
     WHERE ${where} ORDER BY outbox.cursor`
  ).all(...parameters) as unknown as OutboxRow[];
}

function parseClaimedOutbox(row: OutboxRow): ClaimedConversationOutboxMessage {
  if (row.claim_id === null || row.claimed_at === null || row.claim_expires_at === null) {
    throw storageInvariant(`outbox:${String(row.cursor)}:claim_metadata_missing`);
  }
  const message = parseAndValidateOutboxRow(row);
  return {
    cursor: row.cursor,
    claimId: row.claim_id,
    claimedAt: row.claimed_at,
    claimExpiresAt: row.claim_expires_at,
    claimAttempts: row.claim_attempts,
    message
  };
}

function parseAndValidateOutboxRow(row: OutboxRow): ConversationRunHandoffOutboxMessage {
  const message = parseOutboxMessage(row.message_json, `outbox:${String(row.cursor)}`);
  if (row.result_saga_json === null || row.command_fingerprint === null) {
    throw storageInvariant(`outbox:${String(row.cursor)}:command_receipt_missing`);
  }
  const saga = parseSagaJson(
    row.result_saga_json,
    `outbox:${String(row.cursor)}:result_saga`
  );
  const step = saga.processedSteps[saga.version - 1];
  if (
    !Number.isSafeInteger(row.cursor)
    || row.cursor <= 0
    || row.message_id !== message.messageId
    || row.saga_id !== message.sagaId
    || row.saga_version !== message.sagaVersion
    || row.message_kind !== message.kind
    || row.created_at !== message.occurredAt
    || saga.sagaId !== row.saga_id
    || saga.version !== row.saga_version
    || step === undefined
    || step.commandId !== row.command_id
    || step.fingerprint !== row.command_fingerprint
    || step.outboxMessageId !== row.message_id
    || !Number.isSafeInteger(row.claim_attempts)
    || row.claim_attempts < 0
  ) {
    throw storageInvariant(`outbox:${String(row.cursor)}:row_identity_mismatch`);
  }
  assertExpectedArtifacts(
    saga,
    projectConversationRunHandoffArtifacts(saga).event,
    message
  );
  assertCanonicalId(row.command_id, `outbox:${String(row.cursor)}:command_id`);
  assertOptionalOutboxMetadata(row);
  return message;
}

function assertOptionalOutboxMetadata(row: OutboxRow): void {
  if (row.published_at !== null) assertCanonicalUtcTimestamp(
    row.published_at,
    `outbox:${String(row.cursor)}:published_at`
  );
  if (row.published_claim_id !== null) {
    assertCanonicalId(
      row.published_claim_id,
      `outbox:${String(row.cursor)}:published_claim_id`
    );
  }
  if (row.claim_id === null && row.claimed_at === null && row.claim_expires_at === null) return;
  if (row.claim_id === null || row.claimed_at === null || row.claim_expires_at === null) {
    throw storageInvariant(`outbox:${String(row.cursor)}:partial_claim_metadata`);
  }
  assertCanonicalId(row.claim_id, `outbox:${String(row.cursor)}:claim_id`);
  assertCanonicalUtcTimestamp(row.claimed_at, `outbox:${String(row.cursor)}:claimed_at`);
  assertCanonicalUtcTimestamp(
    row.claim_expires_at,
    `outbox:${String(row.cursor)}:claim_expires_at`
  );
  if (Date.parse(row.claim_expires_at) <= Date.parse(row.claimed_at)) {
    throw storageInvariant(`outbox:${String(row.cursor)}:claim_time_invalid`);
  }
}

export function assertClaimRequest(request: ConversationOutboxClaimRequest): void {
  assertCanonicalId(request.claimId, 'outbox claim ID');
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
    throw new Error('conversation_outbox_claim_limit_invalid');
  }
  if (
    !Number.isSafeInteger(request.leaseMs)
    || request.leaseMs < 1
    || request.leaseMs > MAX_OUTBOX_LEASE_MS
  ) {
    throw new Error('conversation_outbox_claim_lease_invalid');
  }
}

export function assertPublishRequest(request: ConversationOutboxPublishRequest): void {
  assertCanonicalId(request.claimId, 'outbox ACK claim ID');
  if (!Array.isArray(request.messages)) {
    throw new Error('conversation_outbox_ack_messages_invalid');
  }
  const cursors = new Set<number>();
  const messageIds = new Set<string>();
  for (const message of request.messages) {
    if (!Number.isSafeInteger(message.cursor) || message.cursor <= 0) {
      throw new Error('conversation_outbox_ack_cursor_invalid');
    }
    assertCanonicalId(message.messageId, 'outbox ACK message ID');
    if (cursors.has(message.cursor) || messageIds.has(message.messageId)) {
      throw new Error('conversation_outbox_ack_duplicate');
    }
    cursors.add(message.cursor);
    messageIds.add(message.messageId);
  }
}
