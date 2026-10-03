import { DatabaseSync } from 'node:sqlite';
import {
  assertValidConversationAuthorityEvent,
  assertValidConversationAuthorityReceipt,
  type ConversationAuthorityCommandReceipt,
  type ConversationAuthorityEvent
} from '../../conversation/ConversationAuthority.js';
import { type ConversationRunHandoffSaga } from '../../conversation/ConversationRunHandoffSaga.js';
import type { ConversationRunHandoffCommit } from '../../control/ports/ConversationRunHandoffPersistence.js';
import { parseMessageVersionRow, type MessageVersionRow } from './conversation/rows/ConversationAuthorityRowMapper.js';
import {
  authorityStorageCorruption,
  isConstraintError,
  storageInvariant,
  versionConflict
} from './ConversationHandoffStorageValidation.js';

export function insertAuthorityReceiptAndEvent(
  database: DatabaseSync,
  receipt: ConversationAuthorityCommandReceipt,
  expectedSessionVersion: number | null,
  event: ConversationAuthorityEvent
): void {
  assertValidConversationAuthorityReceipt(receipt);
  assertValidConversationAuthorityEvent(event);
  if (
    receipt.eventId !== event.eventId
    || receipt.commandId !== event.commandId
    || receipt.sessionId !== event.sessionId
    || receipt.workspaceId !== event.workspaceId
    || receipt.resultingSessionVersion !== event.sessionVersion
    || receipt.committedAt !== event.occurredAt
  ) throw authorityStorageCorruption('authority_receipt_event_binding_invalid');
  database.prepare(
    `INSERT INTO conversation_commands(
       command_id, command_kind, command_fingerprint, event_id,
       session_id, workspace_id, expected_session_version,
       resulting_session_version, message_id, message_version, saga_id,
       saga_version, handoff_command_id, handoff_inbox_event_id,
       handoff_outbox_message_id, run_id, run_version, result_status,
       source_run_event_id,
       committed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    receipt.commandId,
    receipt.kind,
    receipt.commandFingerprint,
    receipt.eventId,
    receipt.sessionId,
    receipt.workspaceId,
    expectedSessionVersion,
    receipt.resultingSessionVersion,
    receipt.messageId,
    receipt.messageVersion,
    receipt.sagaId,
    receipt.kind === 'conversation.project_agent_result'
      || receipt.kind === 'conversation.project_agent_start_failure'
      ? receipt.sagaVersion
      : null,
    receipt.kind === 'conversation.project_agent_result'
      || receipt.kind === 'conversation.project_agent_start_failure'
      ? receipt.handoffCommandId
      : null,
    receipt.kind === 'conversation.project_agent_result'
      || receipt.kind === 'conversation.project_agent_start_failure'
      ? receipt.handoffInboxEventId
      : null,
    receipt.kind === 'conversation.project_agent_result'
      || receipt.kind === 'conversation.project_agent_start_failure'
      ? receipt.handoffOutboxMessageId
      : null,
    receipt.kind === 'conversation.project_agent_result'
      ? receipt.runId
      : receipt.kind === 'conversation.project_agent_start_failure'
        ? receipt.runRequestId
      : null,
    receipt.kind === 'conversation.project_agent_result'
      ? receipt.resultRunVersion
      : null,
    receipt.kind === 'conversation.project_agent_result'
      ? receipt.resultStatus
      : null,
    receipt.kind === 'conversation.project_agent_result'
      ? receipt.sourceRunEventId
      : receipt.kind === 'conversation.project_agent_start_failure'
        ? receipt.failureCode
      : null,
    receipt.committedAt
  );
  database.prepare(
    `INSERT INTO conversation_events(
       event_id, command_id, session_id, workspace_id, session_version,
       event_kind, event_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.eventId,
    event.commandId,
    event.sessionId,
    event.workspaceId,
    event.sessionVersion,
    event.type,
    JSON.stringify(event),
    event.occurredAt
  );
}

export function assertAuthoritativeMessageForAcceptedHandoff(
  database: DatabaseSync,
  commit: ConversationRunHandoffCommit
): void {
  const saga = commit.saga;
  const step = saga.processedSteps[0];
  if (saga.version !== 1 || saga.stage.kind !== 'message_accepted') {
    throw storageInvariant('handoff_initial_commit_stage_invalid');
  }
  const row = database.prepare(
    `SELECT message.message_id, message.version, message.session_id,
            message.workspace_id, message.role, message.payload_json,
            message.content_digest, message.created_at
     FROM conversation_message_versions AS message
     INNER JOIN conversation_commands AS command
       ON command.command_kind='conversation.accept_user_message'
      AND command.message_id=message.message_id
      AND command.message_version=message.version
      AND command.session_id=message.session_id
      AND command.workspace_id=message.workspace_id
      AND command.saga_id=?
      AND command.event_id=?
     WHERE message.message_id=? AND message.version=?`
  ).get(
    saga.sagaId,
    step?.inboxEventId ?? null,
    saga.messageId,
    saga.messageVersion
  ) as MessageVersionRow | undefined;
  if (row === undefined) {
    throw storageInvariant('handoff_accept_requires_authoritative_message_version');
  }
  const message = parseMessageVersionRow(
    row,
    `handoff:${saga.sagaId}:authoritative-message`
  );
  if (
    message.sessionId !== saga.sessionId
    || message.workspaceId !== saga.workspaceId
    || message.contentDigest !== saga.objectiveDigest
    || message.createdAt !== saga.createdAt
  ) throw storageInvariant('handoff_accept_authoritative_message_mismatch');
}

export function insertSaga(database: DatabaseSync, saga: ConversationRunHandoffSaga): void {
  try {
    database.prepare(
      `INSERT INTO conversation_handoff_sagas(
         saga_id, version, session_id, workspace_id, message_id,
         message_version, objective_digest, stage_kind, saga_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      saga.sagaId,
      saga.version,
      saga.sessionId,
      saga.workspaceId,
      saga.messageId,
      saga.messageVersion,
      saga.objectiveDigest,
      saga.stage.kind,
      JSON.stringify(saga),
      saga.createdAt,
      saga.updatedAt
    );
  } catch (error) {
    if (isConstraintError(error)) {
      throw versionConflict(saga.sagaId, null, null);
    }
    throw error;
  }
}
