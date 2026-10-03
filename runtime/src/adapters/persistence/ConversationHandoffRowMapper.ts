import { DatabaseSync } from 'node:sqlite';
import {
  assertValidConversationRunHandoffSaga,
  type ConversationRunHandoffEvent,
  type ConversationRunHandoffOutboxMessage,
  type ConversationRunHandoffSaga
} from '../../conversation/ConversationRunHandoffSaga.js';
import { type SagaRow } from './ConversationHandoffStorageTypes.js';
import { isPlainObject, storageInvariant } from './ConversationHandoffStorageValidation.js';

export function selectSagaRow(database: DatabaseSync, sagaId: string): SagaRow | undefined {
  return database.prepare(
    `SELECT saga.saga_id, saga.version, saga.session_id, saga.workspace_id,
            saga.message_id, saga.message_version, saga.objective_digest,
            saga.stage_kind, saga.saga_json, saga.created_at, saga.updated_at,
            message.content_digest AS authoritative_content_digest
     FROM conversation_handoff_sagas AS saga
     LEFT JOIN conversation_message_versions AS message
       ON message.message_id=saga.message_id
      AND message.version=saga.message_version
      AND message.session_id=saga.session_id
      AND message.workspace_id=saga.workspace_id
     WHERE saga.saga_id=?`
  ).get(sagaId) as SagaRow | undefined;
}

export function parseSagaRow(row: SagaRow, source: string): ConversationRunHandoffSaga {
  const saga = parseSagaJson(row.saga_json, source);
  if (
    saga.sagaId !== row.saga_id
    || saga.version !== row.version
    || saga.sessionId !== row.session_id
    || saga.workspaceId !== row.workspace_id
    || saga.messageId !== row.message_id
    || saga.messageVersion !== row.message_version
    || saga.objectiveDigest !== row.objective_digest
    || saga.stage.kind !== row.stage_kind
    || saga.createdAt !== row.created_at
    || saga.updatedAt !== row.updated_at
    || row.authoritative_content_digest === null
    || saga.objectiveDigest !== row.authoritative_content_digest
  ) {
    throw storageInvariant(`${source}:column_identity_mismatch`);
  }
  return saga;
}

export function parseSagaJson(value: string, source: string): ConversationRunHandoffSaga {
  const parsed = parseJson(value, source) as ConversationRunHandoffSaga;
  try {
    assertValidConversationRunHandoffSaga(parsed);
  } catch (error) {
    throw storageInvariant(`${source}:invalid_saga`, error);
  }
  return parsed;
}

export function parseEvent(value: string, source: string): ConversationRunHandoffEvent {
  const parsed = parseJson(value, source);
  if (!isPlainObject(parsed) || typeof parsed.type !== 'string') {
    throw storageInvariant(`${source}:invalid_event`);
  }
  return parsed as unknown as ConversationRunHandoffEvent;
}

export function parseOutboxMessage(
  value: string,
  source: string
): ConversationRunHandoffOutboxMessage {
  const parsed = parseJson(value, source);
  if (!isPlainObject(parsed) || typeof parsed.kind !== 'string') {
    throw storageInvariant(`${source}:invalid_message`);
  }
  return parsed as unknown as ConversationRunHandoffOutboxMessage;
}

function parseJson(value: string, source: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw storageInvariant(`${source}:invalid_json`, error);
  }
}
