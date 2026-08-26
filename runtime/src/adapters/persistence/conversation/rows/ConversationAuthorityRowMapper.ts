import { createHash } from 'node:crypto';

import {
  ConversationAuthorityError,
  assertValidConversationAuthorityEvent,
  assertValidConversationAuthorityReceipt,
  assertValidConversationMessageHead,
  assertValidConversationMessageVersion,
  assertValidConversationSession,
  type ConversationAuthorityCommandReceipt,
  type ConversationAuthorityEvent,
  type ConversationMessageHead,
  type ConversationMessageVersion,
  type ConversationSession
} from '../../../../conversation/ConversationAuthority.js';
import type {
  CommittedConversationAuthorityCommand
} from '../../../../control/ports/ConversationAuthorityPersistence.js';

export interface SessionRow {
  session_id: string;
  workspace_id: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MessageHeadRow {
  message_id: string;
  session_id: string;
  workspace_id: string;
  latest_version: number;
  created_at: string;
  updated_at: string;
}

export interface MessageVersionRow {
  message_id: string;
  version: number;
  session_id: string;
  workspace_id: string;
  role: string;
  payload_json: string;
  content_digest: string;
  created_at: string;
}

export interface AuthorityCommandRow {
  command_id: string;
  command_kind: string;
  command_fingerprint: string;
  event_id: string;
  session_id: string;
  workspace_id: string;
  expected_session_version: number | null;
  resulting_session_version: number;
  message_id: string | null;
  message_version: number | null;
  saga_id: string | null;
  saga_version: number | null;
  handoff_command_id: string | null;
  handoff_inbox_event_id: string | null;
  handoff_outbox_message_id: string | null;
  run_id: string | null;
  run_version: number | null;
  result_status: string | null;
  source_run_event_id: string | null;
  committed_at: string;
  stored_event_id: string;
  event_session_id: string;
  event_workspace_id: string;
  event_session_version: number;
  event_kind: string;
  event_json: string;
  event_occurred_at: string;
}

export interface AuthorityProjectionEventRow {
  projection_cursor: number;
  event_json: string;
}


export function parseSessionRow(row: SessionRow, source: string): ConversationSession {
  const session: ConversationSession = {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  try {
    assertValidConversationSession(session);
  } catch (error) {
    throw authorityStorageCorruption(`${source}:invalid`, error);
  }
  return session;
}

export function parseMessageHeadRow(
  row: MessageHeadRow,
  source: string
): ConversationMessageHead {
  const head: ConversationMessageHead = {
    messageId: row.message_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    latestVersion: Number(row.latest_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  try {
    assertValidConversationMessageHead(head);
  } catch (error) {
    throw authorityStorageCorruption(`${source}:invalid`, error);
  }
  return head;
}

export function parseMessageVersionRow(
  row: MessageVersionRow,
  source: string
): ConversationMessageVersion {
  const payload = parseJson(row.payload_json, `${source}:payload`);
  const message = {
    messageId: row.message_id,
    version: Number(row.version),
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    role: row.role,
    payload,
    contentDigest: row.content_digest,
    createdAt: row.created_at
  } as ConversationMessageVersion;
  try {
    assertValidConversationMessageVersion(message);
  } catch (error) {
    throw authorityStorageCorruption(`${source}:invalid`, error);
  }
  assertMessageContentDigest(message, source);
  return message;
}

export function parseAuthorityCommandRow(
  row: AuthorityCommandRow
): CommittedConversationAuthorityCommand {
  const common = {
    commandId: row.command_id,
    commandFingerprint: row.command_fingerprint,
    eventId: row.event_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    resultingSessionVersion: Number(row.resulting_session_version),
    committedAt: row.committed_at
  };
  const receipt = (row.command_kind === 'conversation.create_session'
    ? {
        ...common,
        kind: row.command_kind,
        messageId: null,
        messageVersion: null,
        sagaId: null
      }
    : row.command_kind === 'conversation.accept_user_message'
      ? {
          ...common,
          kind: row.command_kind,
          messageId: row.message_id,
          messageVersion: row.message_version,
          sagaId: row.saga_id
        }
      : row.command_kind === 'conversation.project_agent_start_failure'
        ? {
            ...common,
            kind: row.command_kind,
            messageId: row.message_id,
            messageVersion: row.message_version,
            sagaId: row.saga_id,
            sagaVersion: row.saga_version,
            handoffCommandId: row.handoff_command_id,
            handoffInboxEventId: row.handoff_inbox_event_id,
            handoffOutboxMessageId: row.handoff_outbox_message_id,
            runRequestId: row.run_id,
            failureCode: row.source_run_event_id
          }
        : {
          ...common,
          kind: row.command_kind,
          messageId: row.message_id,
          messageVersion: row.message_version,
          sagaId: row.saga_id,
          sagaVersion: row.saga_version,
          handoffCommandId: row.handoff_command_id,
          handoffInboxEventId: row.handoff_inbox_event_id,
          handoffOutboxMessageId: row.handoff_outbox_message_id,
          runId: row.run_id,
          resultRunVersion: row.run_version,
          resultStatus: row.result_status,
          sourceRunEventId: row.source_run_event_id
        }) as ConversationAuthorityCommandReceipt;
  const event = parseJson(
    row.event_json,
    `authority-command:${row.command_id}:event`
  ) as ConversationAuthorityEvent;
  try {
    assertValidConversationAuthorityReceipt(receipt);
    assertValidConversationAuthorityEvent(event);
  } catch (error) {
    throw authorityStorageCorruption(`authority-command:${row.command_id}:invalid`, error);
  }
  if (
    event.eventId !== receipt.eventId
    || event.commandId !== receipt.commandId
    || event.sessionId !== receipt.sessionId
    || event.workspaceId !== receipt.workspaceId
    || event.sessionVersion !== receipt.resultingSessionVersion
    || event.type !== row.event_kind
    || row.stored_event_id !== event.eventId
    || row.event_session_id !== event.sessionId
    || row.event_workspace_id !== event.workspaceId
    || Number(row.event_session_version) !== event.sessionVersion
    || event.occurredAt !== row.event_occurred_at
    || receipt.committedAt !== row.event_occurred_at
    || (
      receipt.kind === 'conversation.project_agent_result'
      && (
        event.type !== 'conversation.agent_result.projected'
        || event.messageId !== receipt.messageId
        || event.messageVersion !== receipt.messageVersion
        || event.sagaId !== receipt.sagaId
        || event.sagaVersion !== receipt.sagaVersion
        || event.runId !== receipt.runId
        || event.resultRunVersion !== receipt.resultRunVersion
        || event.resultStatus !== receipt.resultStatus
        || event.sourceRunEventId !== receipt.sourceRunEventId
      )
    )
    || (
      receipt.kind === 'conversation.project_agent_start_failure'
      && (
        event.type !== 'conversation.agent_start.failed'
        || event.messageId !== receipt.messageId
        || event.messageVersion !== receipt.messageVersion
        || event.sagaId !== receipt.sagaId
        || event.sagaVersion !== receipt.sagaVersion
        || event.runRequestId !== receipt.runRequestId
        || event.failureCode !== receipt.failureCode
      )
    )
    || (
      receipt.kind === 'conversation.create_session'
        ? row.expected_session_version !== null
        : row.expected_session_version === null
          || row.expected_session_version + 1 !== receipt.resultingSessionVersion
    )
  ) throw authorityStorageCorruption(`authority-command:${row.command_id}:column_mismatch`);
  return { receipt, event };
}


export function assertMessageContentDigest(
  message: ConversationMessageVersion,
  source: string
): void {
  const actual = `sha256:${createHash('sha256')
    .update(message.payload.content, 'utf8')
    .digest('hex')}`;
  if (actual !== message.contentDigest) {
    throw authorityStorageCorruption(`${source}:content_digest_mismatch`);
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
