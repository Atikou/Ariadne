import type { DatabaseSync } from 'node:sqlite';

import {
  ConversationAuthorityError,
  assertValidConversationAuthorityEvent,
  type ConversationAuthorityEvent,
  type ConversationMessageVersion
} from '../../../../conversation/ConversationAuthority.js';
import type {
  ConversationProjectionReadRequest,
  ConversationProjectionRecord
} from '../../../../projection/ConversationProjectionPorts.js';
import {
  parseMessageVersionRow,
  parseSessionRow,
  type AuthorityProjectionEventRow,
  type MessageVersionRow,
  type SessionRow
} from '../rows/ConversationAuthorityRowMapper.js';

export function readConversationProjectionRecords(
  database: DatabaseSync,
  request: ConversationProjectionReadRequest
): readonly ConversationProjectionRecord[] {
  assertProjectionReadRequest(request);
  return readProjectionRecordsUnchecked(database, request);
}

function readProjectionRecordsUnchecked(
  database: DatabaseSync,
  request: ConversationProjectionReadRequest
): readonly ConversationProjectionRecord[] {
  const rows = database.prepare(
    `SELECT rowid AS projection_cursor, event_json
     FROM conversation_events
     WHERE rowid > ?
     ORDER BY rowid ASC
     LIMIT ?`
  ).all(request.afterCursor, request.limit) as unknown as AuthorityProjectionEventRow[];

  return rows.map((row) => {
    const cursor = Number(row.projection_cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 1) {
      throw authorityStorageCorruption('projection_event_cursor_invalid');
    }
    const event = parseJson(
      row.event_json,
      `projection-event:${String(cursor)}`
    ) as ConversationAuthorityEvent;
    try {
      assertValidConversationAuthorityEvent(event);
    } catch (error) {
      throw authorityStorageCorruption(
        `projection-event:${String(cursor)}:invalid`,
        error
      );
    }
    const sessionRow = database.prepare(
      `SELECT session_id, workspace_id, version, created_at, updated_at
       FROM conversation_sessions WHERE session_id=?`
    ).get(event.sessionId) as SessionRow | undefined;
    if (sessionRow === undefined) {
      throw authorityStorageCorruption(
        `projection-event:${String(cursor)}:session_missing`
      );
    }
    const session = parseSessionRow(
      sessionRow,
      `projection-event:${String(cursor)}:session`
    );
    if (
      session.workspaceId !== event.workspaceId
      || session.version < event.sessionVersion
      || Date.parse(session.updatedAt) < Date.parse(event.occurredAt)
      || (
        event.type === 'conversation.session.created'
        && (
          event.sessionVersion !== 1
          || session.createdAt !== event.occurredAt
        )
      )
    ) {
      throw authorityStorageCorruption(
        `projection-event:${String(cursor)}:session_mismatch`
      );
    }

    let messageVersion: ConversationMessageVersion | null = null;
    if (
      event.type === 'conversation.user_message.accepted'
      || event.type === 'conversation.agent_result.projected'
      || event.type === 'conversation.agent_start.failed'
    ) {
      const messageRow = database.prepare(
        `SELECT message_id, version, session_id, workspace_id, role,
                payload_json, content_digest, created_at
         FROM conversation_message_versions
         WHERE message_id=? AND version=?`
      ).get(event.messageId, event.messageVersion) as MessageVersionRow | undefined;
      if (messageRow === undefined) {
        throw authorityStorageCorruption(
          `projection-event:${String(cursor)}:message_missing`
        );
      }
      messageVersion = parseMessageVersionRow(
        messageRow,
        `projection-event:${String(cursor)}:message`
      );
      if (
        messageVersion.sessionId !== event.sessionId
        || messageVersion.workspaceId !== event.workspaceId
        || messageVersion.contentDigest !== event.contentDigest
        || messageVersion.createdAt !== event.occurredAt
      ) {
        throw authorityStorageCorruption(
          `projection-event:${String(cursor)}:message_mismatch`
        );
      }
    }
    return { cursor, event, session, messageVersion };
  });
}


function assertProjectionReadRequest(
  request: ConversationProjectionReadRequest
): void {
  if (
    typeof request !== 'object'
    || request === null
    || Array.isArray(request)
    || Object.keys(request).length !== 2
    || !Object.prototype.hasOwnProperty.call(request, 'afterCursor')
    || !Object.prototype.hasOwnProperty.call(request, 'limit')
    || !Number.isSafeInteger(request.afterCursor)
    || request.afterCursor < 0
    || !Number.isSafeInteger(request.limit)
    || request.limit < 1
    || request.limit > 1_000
  ) {
    throw new Error('conversation_projection_read_request_invalid');
  }
}


function parseJson(value: string, source: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw authorityStorageCorruption(`${source}:invalid_json`, error);
  }
}

function authorityStorageCorruption(
  message: string,
  cause?: unknown
): ConversationAuthorityError {
  return new ConversationAuthorityError(
    'CONVERSATION_STORAGE_CORRUPTION',
    `Conversation storage corruption: ${message}.`,
    cause === undefined ? undefined : { cause }
  );
}
