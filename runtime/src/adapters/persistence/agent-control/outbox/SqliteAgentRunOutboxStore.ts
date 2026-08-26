import type { DatabaseSync } from 'node:sqlite';

import {
  AgentRunInvariantError,
  AgentRunOutboxClaimConflictError,
  type AgentRunOutboxClaimRequest,
  type AgentRunOutboxPublishRequest,
  type ClaimedAgentRunOutboxMessage
} from '@ariadne/agent-core';

import {
  parseAgentEventRow,
  type AgentEventRow
} from '../rows/AgentEventRowMapper.js';

const MAX_OUTBOX_LEASE_MS = 5 * 60 * 1000;

interface AgentOutboxRow {
  cursor: number;
  event_id: string;
  command_id: string;
  aggregate_id: string;
  aggregate_version: number;
  sequence: number;
  event_json: string;
  created_at: string;
  published_at: string | null;
  published_claim_id: string | null;
  claim_id: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  publish_attempts: number;
  canonical_command_id: string | null;
  canonical_run_id: string | null;
  canonical_run_version: number | null;
  canonical_sequence: number | null;
  canonical_occurred_at: string | null;
  canonical_event_json: string | null;
}

export function assertAgentRunOutboxClaimRequest(
  request: AgentRunOutboxClaimRequest
): void {
  if (
    request.claimId.length === 0
    || !Number.isInteger(request.limit)
    || request.limit <= 0
    || request.limit > 1_000
    || !Number.isInteger(request.leaseMs)
    || request.leaseMs <= 0
    || request.leaseMs > MAX_OUTBOX_LEASE_MS
  ) {
    throw new AgentRunInvariantError(
      'Outbox claims require a non-empty ID, a limit from 1 to 1000, and a lease no longer than five minutes.'
    );
  }
}

export function assertAgentRunOutboxPublishRequest(
  request: AgentRunOutboxPublishRequest
): void {
  if (request.claimId.length === 0 || request.messages.length > 1_000) {
    throw new AgentRunInvariantError(
      'Outbox publish receipts must have a valid claim and bounded batch.'
    );
  }
  const cursors = new Set<number>();
  for (const message of request.messages) {
    if (
      !Number.isInteger(message.cursor)
      || message.cursor <= 0
      || message.eventId.length === 0
      || cursors.has(message.cursor)
    ) {
      throw new AgentRunInvariantError(
        'Outbox publish receipts must be unique durable cursor/event pairs.'
      );
    }
    cursors.add(message.cursor);
  }
}

export async function claimPendingAgentRunOutbox(
  database: DatabaseSync,
  request: AgentRunOutboxClaimRequest,
  claimedAt: string,
  leaseExpiresAt: string
): Promise<readonly ClaimedAgentRunOutboxMessage[]> {
  const existing = selectOutboxRows(
    database,
    'published_at IS NULL AND claim_id=?',
    [request.claimId]
  );
  if (existing.length > 0) {
    if (existing.some((row) =>
      row.claim_expires_at === null || row.claim_expires_at <= claimedAt
    )) {
      throw new AgentRunOutboxClaimConflictError(
        request.claimId,
        `Outbox claim "${request.claimId}" has expired and cannot be renewed.`
      );
    }
    return existing.map(parseClaimedOutboxRow);
  }
  const completed = database.prepare(
    'SELECT COUNT(*) AS count FROM agent_v3_outbox WHERE published_claim_id=?'
  ).get(request.claimId) as { count: number };
  if (completed.count > 0) return [];

  const candidates = database.prepare(
    `SELECT cursor
     FROM agent_v3_outbox
     WHERE published_at IS NULL
       AND (claim_id IS NULL OR claim_expires_at <= ?)
     ORDER BY cursor
     LIMIT ?`
  ).all(claimedAt, request.limit) as unknown as { cursor: number }[];
  const update = database.prepare(
    `UPDATE agent_v3_outbox
     SET claim_id=?, claimed_at=?, claim_expires_at=?,
         publish_attempts=publish_attempts + 1
     WHERE cursor=? AND published_at IS NULL
       AND (claim_id IS NULL OR claim_expires_at <= ?)`
  );
  for (const candidate of candidates) {
    const result = update.run(
      request.claimId,
      claimedAt,
      leaseExpiresAt,
      candidate.cursor,
      claimedAt
    );
    if (Number(result.changes) !== 1) {
      throw new AgentRunOutboxClaimConflictError(
        request.claimId,
        'The pending outbox set changed while it was being claimed.'
      );
    }
  }
  return selectOutboxRows(
    database,
    'published_at IS NULL AND claim_id=?',
    [request.claimId]
  ).map(parseClaimedOutboxRow);
}

export async function markAgentRunOutboxPublished(
  database: DatabaseSync,
  request: AgentRunOutboxPublishRequest,
  publishedAt: string
): Promise<void> {
  if (request.messages.length === 0) return;
  const rows: AgentOutboxRow[] = [];
  for (const message of request.messages) {
    const row = database.prepare(
      'SELECT * FROM agent_v3_outbox WHERE cursor=?'
    ).get(message.cursor) as AgentOutboxRow | undefined;
    if (row === undefined || row.event_id !== message.eventId) {
      throw new AgentRunOutboxClaimConflictError(
        request.claimId,
        'An outbox publish receipt does not match its durable event.'
      );
    }
    if (row.published_at !== null) {
      if (row.published_claim_id !== request.claimId) {
        throw new AgentRunOutboxClaimConflictError(
          request.claimId,
          'An outbox message was already published by a different claim.'
        );
      }
      rows.push(row);
      continue;
    }
    if (
      row.claim_id !== request.claimId
      || row.claim_expires_at === null
      || row.claim_expires_at < publishedAt
    ) {
      throw new AgentRunOutboxClaimConflictError(
        request.claimId,
        'The outbox claim is missing, belongs to another publisher, or has expired.'
      );
    }
    rows.push(row);
  }

  const update = database.prepare(
    `UPDATE agent_v3_outbox
     SET published_at=?, published_claim_id=?,
         claim_id=NULL, claimed_at=NULL, claim_expires_at=NULL
     WHERE cursor=? AND event_id=? AND published_at IS NULL AND claim_id=?`
  );
  for (const row of rows) {
    if (row.published_at !== null) continue;
    const result = update.run(
      publishedAt,
      request.claimId,
      row.cursor,
      row.event_id,
      request.claimId
    );
    if (Number(result.changes) !== 1) {
      throw new AgentRunOutboxClaimConflictError(
        request.claimId,
        'The outbox claim changed before publish acknowledgement.'
      );
    }
  }
}

export function countUnpublishedAgentRunOutbox(database: DatabaseSync): number {
  const row = database.prepare(
    'SELECT COUNT(*) AS count FROM agent_v3_outbox WHERE published_at IS NULL'
  ).get() as { count: number };
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw storageCorruption('agent_v3_outbox:pending_count_invalid');
  }
  return count;
}

export function recoverAbandonedAgentOutboxClaims(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(
      `UPDATE agent_v3_outbox
       SET claim_id=NULL, claimed_at=NULL, claim_expires_at=NULL
       WHERE published_at IS NULL AND claim_id IS NOT NULL;`
    );
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw storageCorruption('agent_v3_outbox:owner_takeover_recovery_failed', error);
  }
}

function selectOutboxRows(
  database: DatabaseSync,
  where: string,
  parameters: readonly (string | number)[]
): AgentOutboxRow[] {
  return database.prepare(
    `SELECT outbox.cursor, outbox.event_id, outbox.command_id,
            outbox.aggregate_id, outbox.aggregate_version,
            outbox.sequence,
            outbox.event_json, outbox.created_at,
            outbox.published_at, outbox.published_claim_id,
            outbox.claim_id, outbox.claimed_at,
            outbox.claim_expires_at, outbox.publish_attempts,
            event.command_id AS canonical_command_id,
            event.run_id AS canonical_run_id,
            event.run_version AS canonical_run_version,
            event.sequence AS canonical_sequence,
            event.occurred_at AS canonical_occurred_at,
            event.event_json AS canonical_event_json
     FROM agent_v3_outbox AS outbox
     LEFT JOIN agent_v3_events AS event ON event.event_id=outbox.event_id
     WHERE ${where}
     ORDER BY outbox.cursor`
  ).all(...parameters) as unknown as AgentOutboxRow[];
}

function parseClaimedOutboxRow(row: AgentOutboxRow): ClaimedAgentRunOutboxMessage {
  if (row.claim_id === null || row.claim_expires_at === null) {
    throw storageCorruption(`agent_v3_outbox:${String(row.cursor)}:claim_metadata_missing`);
  }
  if (
    row.canonical_command_id === null
    || row.canonical_run_id === null
    || row.canonical_run_version === null
    || row.canonical_sequence === null
    || row.canonical_occurred_at === null
    || row.canonical_event_json === null
  ) {
    throw storageCorruption(`agent_v3_outbox:${String(row.cursor)}:event_missing`);
  }
  if (row.event_json !== row.canonical_event_json) {
    throw storageCorruption(`agent_v3_outbox:${String(row.cursor)}:event_diverged`);
  }
  const event = parseAgentEventRow({
    event_id: row.event_id,
    command_id: row.canonical_command_id,
    run_id: row.canonical_run_id,
    run_version: row.canonical_run_version,
    sequence: row.canonical_sequence,
    occurred_at: row.canonical_occurred_at,
    event_json: row.canonical_event_json
  } satisfies AgentEventRow);
  if (
    event.commandId !== row.command_id
    || event.sequence !== row.sequence
    || event.runId !== row.aggregate_id
    || event.runVersion !== row.aggregate_version
  ) {
    throw storageCorruption(`agent_v3_outbox:${String(row.cursor)}:event_metadata_mismatch`);
  }
  return {
    cursor: row.cursor,
    eventId: row.event_id,
    claimId: row.claim_id,
    leaseExpiresAt: row.claim_expires_at,
    event,
    createdAt: row.created_at,
    publishAttempts: row.publish_attempts
  };
}

function storageCorruption(message: string, cause?: unknown): Error {
  return new Error(`agent_v3_storage_corruption:${message}`, { cause });
}
