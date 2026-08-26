import { createHash } from 'node:crypto';

import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  publicMessageProjectionV3Schema,
  publicSessionProjectionV3Schema,
  redactPublicProjectionTextV3,
  type ProjectionCommitV3,
  type PublicMessageProjectionV3,
  type PublicSessionProjectionV3
} from '@ariadne/protocol/public';

import {
  assertValidConversationAuthorityEvent,
  assertValidConversationMessageVersion,
  assertValidConversationSession
} from '../conversation/ConversationAuthority.js';
import { assertValidProjectionCommitV3 } from './PublicProjectionContractV3.js';
import type {
  ConversationProjectionReader,
  ConversationProjectionRecord
} from './ConversationProjectionPorts.js';
import type { PublicProjectionCommitSink } from './PublicProjectionPorts.js';

const DEFAULT_READ_LIMIT = 500;
const MAX_PUBLIC_MESSAGE_CONTENT_LENGTH = 100_000;
const TRUNCATION_SUFFIX = '\n[public projection truncated]';

export interface ConversationPublicProjectionPublisherOptions {
  readonly readLimit?: number;
}

export interface ConversationPublicProjectionPublishResult {
  readonly readRecords: number;
  readonly projectedRecords: number;
  readonly afterCursor: number;
}

/**
 * Rebuildable Conversation authority projector. Its source cursor is only an
 * in-process scan optimization: every restart replays from zero and relies on
 * stable commit identity plus per-Session source versions for convergence.
 */
export class ConversationPublicProjectionPublisher {
  private readonly readLimit: number;
  private afterCursor = 0;
  private activePublish: Promise<ConversationPublicProjectionPublishResult> | null = null;

  public constructor(
    private readonly source: ConversationProjectionReader,
    private readonly sink: PublicProjectionCommitSink,
    options: ConversationPublicProjectionPublisherOptions = {}
  ) {
    this.readLimit = options.readLimit ?? DEFAULT_READ_LIMIT;
    if (
      !Number.isSafeInteger(this.readLimit)
      || this.readLimit < 1
      || this.readLimit > 1_000
    ) {
      throw new Error('conversation_projection_read_limit_invalid');
    }
  }

  public publishPending(): Promise<ConversationPublicProjectionPublishResult> {
    if (this.activePublish === null) {
      this.activePublish = this.publishBatch().finally(() => {
        this.activePublish = null;
      });
    }
    return this.activePublish;
  }

  private async publishBatch(): Promise<ConversationPublicProjectionPublishResult> {
    const records = await this.source.readProjectionRecords({
      afterCursor: this.afterCursor,
      limit: this.readLimit
    });
    let previousCursor = this.afterCursor;
    let projectedRecords = 0;
    for (const record of records) {
      if (
        !Number.isSafeInteger(record.cursor)
        || record.cursor <= previousCursor
      ) {
        throw new Error('conversation_projection_source_cursor_invalid');
      }
      await this.sink.append(projectConversationAuthorityRecordV3(record));
      previousCursor = record.cursor;
      this.afterCursor = record.cursor;
      projectedRecords += 1;
    }
    return {
      readRecords: records.length,
      projectedRecords,
      afterCursor: this.afterCursor
    };
  }
}

export function projectConversationAuthorityRecordV3(
  record: ConversationProjectionRecord
): ProjectionCommitV3 {
  const { event, session, messageVersion } = record;
  assertValidConversationAuthorityEvent(event);
  assertValidConversationSession(session);
  if (
    session.sessionId !== event.sessionId
    || session.workspaceId !== event.workspaceId
    || session.version < event.sessionVersion
    || Date.parse(session.updatedAt) < Date.parse(event.occurredAt)
  ) {
    throw new Error('conversation_projection_session_mismatch');
  }

  const changes: ProjectionCommitV3['changes'][number][] = [{
    feature: 'sessions',
    operation: 'upsert',
    aggregateId: event.sessionId,
    aggregateVersion: event.sessionVersion,
    projectedAt: event.occurredAt,
    dto: projectPublicSession(event, session.createdAt)
  }];
  if (
    event.type === 'conversation.user_message.accepted'
    || event.type === 'conversation.agent_result.projected'
    || event.type === 'conversation.agent_start.failed'
  ) {
    if (messageVersion === null) {
      throw new Error('conversation_projection_message_missing');
    }
    assertValidConversationMessageVersion(messageVersion);
    if (
      messageVersion.messageId !== event.messageId
      || messageVersion.version !== event.messageVersion
      || messageVersion.sessionId !== event.sessionId
      || messageVersion.workspaceId !== event.workspaceId
      || messageVersion.contentDigest !== event.contentDigest
      || messageVersion.createdAt !== event.occurredAt
    ) {
      throw new Error('conversation_projection_message_mismatch');
    }
    changes.push({
      feature: 'messages',
      operation: 'upsert',
      aggregateId: messageVersion.messageId,
      aggregateVersion: messageVersion.version,
      projectedAt: event.occurredAt,
      dto: projectPublicMessage(messageVersion, event)
    });
  } else if (messageVersion !== null) {
    throw new Error('conversation_projection_unexpected_message');
  }

  return assertValidProjectionCommitV3({
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: conversationProjectionEventId(event.eventId),
    sourceId: conversationProjectionSourceId(event.sessionId),
    sourceCursor: event.sessionVersion,
    occurredAt: event.occurredAt,
    changes
  });
}

export function conversationProjectionEventId(authorityEventId: string): string {
  return hashedPublicId('conversation.changed', 'authority-event', authorityEventId);
}

export function conversationProjectionSourceId(sessionId: string): string {
  return hashedPublicId('conversation', 'session-source', sessionId);
}

function projectPublicSession(
  event: ConversationProjectionRecord['event'],
  createdAt: string
): PublicSessionProjectionV3 {
  return publicSessionProjectionV3Schema.parse({
    sessionId: event.sessionId,
    workspaceId: event.workspaceId,
    version: event.sessionVersion,
    title: 'Conversation',
    pinned: false,
    status: 'active',
    createdAt,
    updatedAt: event.occurredAt
  });
}

function projectPublicMessage(
  message: NonNullable<ConversationProjectionRecord['messageVersion']>,
  event: ConversationProjectionRecord['event']
): PublicMessageProjectionV3 {
  return publicMessageProjectionV3Schema.parse({
    messageId: message.messageId,
    sessionId: message.sessionId,
    ...(event.type === 'conversation.agent_result.projected'
      ? { runId: event.runId }
      : {}),
    version: message.version,
    role: message.role,
    content: publicMessageContent(message.payload.content),
    status: 'completed',
    createdAt: message.createdAt,
    updatedAt: message.createdAt
  });
}

function publicMessageContent(content: string): string {
  const redacted = redactPublicProjectionTextV3(content);
  if (redacted.length <= MAX_PUBLIC_MESSAGE_CONTENT_LENGTH) return redacted;
  return redacted.slice(
    0,
    MAX_PUBLIC_MESSAGE_CONTENT_LENGTH - TRUNCATION_SUFFIX.length
  ) + TRUNCATION_SUFFIX;
}

function hashedPublicId(
  prefix: string,
  namespace: string,
  sourceId: string
): string {
  if (
    typeof sourceId !== 'string'
    || sourceId.length === 0
    || sourceId.length > 256
    || sourceId.trim() !== sourceId
  ) {
    throw new Error('conversation_projection_identity_invalid');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(['ariadne.public-projection', namespace, sourceId]), 'utf8')
    .digest('hex');
  return `${prefix}:${digest}`;
}
