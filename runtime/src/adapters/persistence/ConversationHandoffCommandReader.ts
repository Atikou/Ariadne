import { DatabaseSync } from 'node:sqlite';
import {
  type ConversationRunHandoffEvent,
  type ConversationRunHandoffOutboxMessage,
  type ConversationRunHandoffSaga
} from '../../conversation/ConversationRunHandoffSaga.js';
import type { CommittedConversationRunHandoffCommand } from '../../control/ports/ConversationRunHandoffPersistence.js';
import {
  type CommandRow,
  type EventRow,
  type OutboxRow
} from './ConversationHandoffStorageTypes.js';
import {
  assertCanonicalId,
  assertDigest,
  storageInvariant
} from './ConversationHandoffStorageValidation.js';
import {
  parseEvent,
  parseOutboxMessage,
  parseSagaJson
} from './ConversationHandoffRowMapper.js';
import { assertExpectedArtifacts } from './ConversationHandoffCommitValidation.js';

export function loadCommittedCommand(
  database: DatabaseSync,
  row: CommandRow
): CommittedConversationRunHandoffCommand {
  assertCanonicalId(row.command_id, 'stored command ID');
  assertDigest(row.command_fingerprint, 'stored command fingerprint');
  const saga = parseSagaJson(
    row.result_saga_json,
    `command:${row.command_id}:result_saga`
  );
  if (saga.sagaId !== row.saga_id || saga.version !== row.resulting_version) {
    throw storageInvariant(`command:${row.command_id}:saga_identity_mismatch`);
  }
  const eventRow = database.prepare(
    `SELECT command_id, saga_id, saga_version, event_json, occurred_at
     FROM conversation_handoff_events WHERE command_id=?`
  ).get(row.command_id) as EventRow | undefined;
  const outboxRow = database.prepare(
    `SELECT cursor, message_id, command_id, saga_id, saga_version,
            message_kind, message_json, created_at, published_at,
            published_claim_id, claim_id, claimed_at, claim_expires_at,
            claim_attempts
     FROM conversation_handoff_outbox WHERE command_id=?`
  ).get(row.command_id) as OutboxRow | undefined;
  if (eventRow === undefined || outboxRow === undefined) {
    throw storageInvariant(`command:${row.command_id}:artifacts_missing`);
  }
  const event = parseEvent(eventRow.event_json, `command:${row.command_id}:event`);
  const outbox = parseOutboxMessage(
    outboxRow.message_json,
    `command:${row.command_id}:outbox`
  );
  assertArtifactRows(row, saga, eventRow, event, outboxRow, outbox);
  assertExpectedArtifacts(saga, event, outbox);
  const step = saga.processedSteps[saga.version - 1];
  if (
    step === undefined
    || step.commandId !== row.command_id
    || step.fingerprint !== row.command_fingerprint
  ) {
    throw storageInvariant(`command:${row.command_id}:receipt_step_mismatch`);
  }
  return {
    commandId: row.command_id,
    commandFingerprint: row.command_fingerprint,
    sagaId: row.saga_id,
    resultingVersion: row.resulting_version,
    saga,
    event,
    outbox
  };
}

function assertArtifactRows(
  command: CommandRow,
  saga: ConversationRunHandoffSaga,
  eventRow: EventRow,
  event: ConversationRunHandoffEvent,
  outboxRow: OutboxRow,
  outbox: ConversationRunHandoffOutboxMessage
): void {
  if (
    eventRow.command_id !== command.command_id
    || eventRow.saga_id !== saga.sagaId
    || eventRow.saga_version !== saga.version
    || eventRow.occurred_at !== saga.updatedAt
    || event.sagaVersion !== saga.version
    || outboxRow.command_id !== command.command_id
    || outboxRow.saga_id !== saga.sagaId
    || outboxRow.saga_version !== saga.version
    || outboxRow.message_id !== outbox.messageId
    || outboxRow.message_kind !== outbox.kind
    || outboxRow.created_at !== saga.updatedAt
    || outbox.sagaId !== saga.sagaId
    || outbox.sagaVersion !== saga.version
    || outbox.occurredAt !== saga.updatedAt
  ) {
    throw storageInvariant(`command:${command.command_id}:artifact_row_mismatch`);
  }
}
