import {
  conversationMessageExecutionV3Schema,
  imageAttachmentRefV3Schema,
  type ImageAttachmentRefV3,
  type ConversationMessageExecutionV3
} from '@ariadne/protocol/public';
import type { ConversationRunResultStatus } from './ConversationRunHandoffSaga.js';

export interface ConversationSession {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly version: number;
  readonly title: string;
  readonly status: 'active' | 'archived';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationMessageHead {
  readonly messageId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly latestVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationMessagePayload {
  readonly content: string;
  readonly attachments?: readonly ImageAttachmentRefV3[];
  readonly execution?: ConversationMessageExecutionV3;
}

export interface ConversationMessageVersion {
  readonly messageId: string;
  readonly version: number;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly role: 'user' | 'assistant';
  readonly payload: ConversationMessagePayload;
  readonly contentDigest: string;
  readonly createdAt: string;
}

interface ConversationAuthorityCommandBase {
  readonly commandId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly occurredAt: string;
}

export interface CreateConversationSessionCommand
extends ConversationAuthorityCommandBase {
  readonly kind: 'conversation.create_session';
  readonly expectedVersion: null;
  readonly title?: string;
}

export type ConversationSessionMutation =
  | { readonly kind: 'rename'; readonly title: string }
  | { readonly kind: 'set_status'; readonly status: 'active' | 'archived' };

export interface MutateConversationSessionCommand
extends ConversationAuthorityCommandBase {
  readonly kind: 'conversation.mutate_session';
  readonly expectedSessionVersion: number;
  readonly mutation: ConversationSessionMutation;
}

export interface AcceptConversationUserMessageCommand
extends ConversationAuthorityCommandBase {
  readonly kind: 'conversation.accept_user_message';
  readonly expectedSessionVersion: number;
  readonly messageId: string;
  readonly expectedMessageVersion: null;
  readonly content: string;
  readonly attachments?: readonly ImageAttachmentRefV3[];
  readonly execution?: ConversationMessageExecutionV3;
  readonly sagaId: string;
  readonly handoffCommandId: string;
  readonly handoffOutboxMessageId: string;
}

/**
 * Reference-only authority command for one resolved terminal Agent result.
 * The assistant body is deliberately absent; only its digest crosses the
 * command, receipt, event, Saga, inbox, and outbox authority boundaries.
 */
export interface ProjectConversationAgentResultCommand
extends ConversationAuthorityCommandBase {
  readonly kind: 'conversation.project_agent_result';
  readonly expectedSessionVersion: number;
  readonly messageId: string;
  readonly expectedMessageVersion: null;
  readonly contentDigest: string;
  readonly sagaId: string;
  readonly expectedSagaVersion: number;
  readonly handoffCommandId: string;
  readonly handoffInboxEventId: string;
  readonly handoffOutboxMessageId: string;
  readonly objectiveMessageId: string;
  readonly objectiveMessageVersion: number;
  readonly objectiveDigest: string;
  readonly runRequestId: string;
  readonly agentCommandId: string;
  readonly runId: string;
  readonly admittedRunVersion: number;
  readonly resultRunVersion: number;
  readonly resultStatus: ConversationRunResultStatus;
  readonly sourceRunEventId: string;
}

export interface ProjectConversationAgentStartFailureCommand
extends ConversationAuthorityCommandBase {
  readonly kind: 'conversation.project_agent_start_failure';
  readonly expectedSessionVersion: number;
  readonly messageId: string;
  readonly expectedMessageVersion: null;
  readonly contentDigest: string;
  readonly sagaId: string;
  readonly expectedSagaVersion: number;
  readonly handoffCommandId: string;
  readonly handoffInboxEventId: string;
  readonly handoffOutboxMessageId: string;
  readonly objectiveMessageId: string;
  readonly objectiveMessageVersion: number;
  readonly objectiveDigest: string;
  readonly runRequestId: string;
  readonly agentCommandId: string;
  readonly failureCode: string;
}

export type ConversationAuthorityCommand =
  | CreateConversationSessionCommand
  | MutateConversationSessionCommand
  | AcceptConversationUserMessageCommand
  | ProjectConversationAgentStartFailureCommand
  | ProjectConversationAgentResultCommand;

export type ConversationAuthorityEvent =
  | {
      readonly eventId: string;
      readonly type: 'conversation.agent_start.failed';
      readonly commandId: string;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly sessionVersion: number;
      readonly messageId: string;
      readonly messageVersion: number;
      readonly contentDigest: string;
      readonly sagaId: string;
      readonly sagaVersion: number;
      readonly runRequestId: string;
      readonly failureCode: string;
      readonly occurredAt: string;
    }
  | {
      readonly eventId: string;
      readonly type: 'conversation.session.created';
      readonly commandId: string;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly sessionVersion: number;
      readonly occurredAt: string;
    }
  | {
      readonly eventId: string;
      readonly type: 'conversation.session.updated';
      readonly commandId: string;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly sessionVersion: number;
      readonly mutation: ConversationSessionMutation;
      readonly occurredAt: string;
    }
  | {
      readonly eventId: string;
      readonly type: 'conversation.user_message.accepted';
      readonly commandId: string;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly sessionVersion: number;
      readonly messageId: string;
      readonly messageVersion: number;
      readonly contentDigest: string;
      readonly occurredAt: string;
    }
  | {
      readonly eventId: string;
      readonly type: 'conversation.agent_result.projected';
      readonly commandId: string;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly sessionVersion: number;
      readonly messageId: string;
      readonly messageVersion: number;
      readonly contentDigest: string;
      readonly sagaId: string;
      readonly sagaVersion: number;
      readonly runId: string;
      readonly resultRunVersion: number;
      readonly resultStatus: ConversationRunResultStatus;
      readonly sourceRunEventId: string;
      readonly occurredAt: string;
    };

export type ConversationAuthorityCommandReceipt =
  | {
      readonly commandId: string;
      readonly kind: 'conversation.create_session';
      readonly commandFingerprint: string;
      readonly eventId: string;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly resultingSessionVersion: number;
      readonly messageId: null;
      readonly messageVersion: null;
      readonly sagaId: null;
      readonly committedAt: string;
    }
  | {
      readonly commandId: string;
      readonly kind: 'conversation.accept_user_message';
      readonly commandFingerprint: string;
      readonly eventId: string;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly resultingSessionVersion: number;
      readonly messageId: string;
      readonly messageVersion: number;
      readonly sagaId: string;
      readonly committedAt: string;
    }
  | {
      readonly commandId: string;
      readonly kind: 'conversation.mutate_session';
      readonly commandFingerprint: string;
      readonly eventId: string;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly resultingSessionVersion: number;
      readonly messageId: null;
      readonly messageVersion: null;
      readonly sagaId: null;
      readonly committedAt: string;
    }
  | {
      readonly commandId: string;
      readonly kind: 'conversation.project_agent_start_failure';
      readonly commandFingerprint: string;
      readonly eventId: string;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly resultingSessionVersion: number;
      readonly messageId: string;
      readonly messageVersion: number;
      readonly sagaId: string;
      readonly sagaVersion: number;
      readonly handoffCommandId: string;
      readonly handoffInboxEventId: string;
      readonly handoffOutboxMessageId: string;
      readonly runRequestId: string;
      readonly failureCode: string;
      readonly committedAt: string;
    }
  | {
      readonly commandId: string;
      readonly kind: 'conversation.project_agent_result';
      readonly commandFingerprint: string;
      readonly eventId: string;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly resultingSessionVersion: number;
      readonly messageId: string;
      readonly messageVersion: number;
      readonly sagaId: string;
      readonly sagaVersion: number;
      readonly handoffCommandId: string;
      readonly handoffInboxEventId: string;
      readonly handoffOutboxMessageId: string;
      readonly runId: string;
      readonly resultRunVersion: number;
      readonly resultStatus: ConversationRunResultStatus;
      readonly sourceRunEventId: string;
      readonly committedAt: string;
    };

export interface CreatedConversationSession {
  readonly session: ConversationSession;
  readonly event: Extract<
    ConversationAuthorityEvent,
    { readonly type: 'conversation.session.created' }
  >;
}

export interface MutatedConversationSession {
  readonly session: ConversationSession;
  readonly event: Extract<
    ConversationAuthorityEvent,
    { readonly type: 'conversation.session.updated' }
  >;
}

export interface AcceptedConversationUserMessage {
  readonly session: ConversationSession;
  readonly messageHead: ConversationMessageHead;
  readonly messageVersion: ConversationMessageVersion;
  readonly event: Extract<
    ConversationAuthorityEvent,
    { readonly type: 'conversation.user_message.accepted' }
  >;
}

export interface ProjectedConversationAgentResult {
  readonly session: ConversationSession;
  readonly messageHead: ConversationMessageHead;
  readonly messageVersion: ConversationMessageVersion;
  readonly event: Extract<
    ConversationAuthorityEvent,
    { readonly type: 'conversation.agent_result.projected' }
  >;
}

export interface ProjectedConversationAgentStartFailure {
  readonly session: ConversationSession;
  readonly messageHead: ConversationMessageHead;
  readonly messageVersion: ConversationMessageVersion;
  readonly event: Extract<ConversationAuthorityEvent, {
    readonly type: 'conversation.agent_start.failed';
  }>;
}

export class ConversationAuthorityError extends Error {
  public constructor(
    public readonly code:
      | 'CONVERSATION_INVARIANT'
      | 'CONVERSATION_COMMAND_CONFLICT'
      | 'CONVERSATION_SESSION_ALREADY_EXISTS'
      | 'CONVERSATION_SESSION_NOT_FOUND'
      | 'CONVERSATION_SESSION_VERSION_CONFLICT'
      | 'CONVERSATION_SESSION_ARCHIVED'
      | 'CONVERSATION_SESSION_MUTATION_UNCHANGED'
      | 'CONVERSATION_WORKSPACE_MISMATCH'
      | 'CONVERSATION_MESSAGE_ALREADY_EXISTS'
      | 'CONVERSATION_STORAGE_CORRUPTION',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ConversationAuthorityError';
  }
}

export function createConversationSession(
  command: CreateConversationSessionCommand
): CreatedConversationSession {
  assertCreateConversationSessionCommand(command);
  const session: ConversationSession = {
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    version: 1,
    title: command.title ?? 'Conversation',
    status: 'active',
    createdAt: command.occurredAt,
    updatedAt: command.occurredAt
  };
  const event: CreatedConversationSession['event'] = {
    eventId: command.eventId,
    type: 'conversation.session.created',
    commandId: command.commandId,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    sessionVersion: 1,
    occurredAt: command.occurredAt
  };
  assertValidConversationSession(session);
  assertValidConversationAuthorityEvent(event);
  return { session, event };
}

export function mutateConversationSession(
  current: ConversationSession | null,
  command: MutateConversationSessionCommand
): MutatedConversationSession {
  assertMutateConversationSessionCommand(command);
  if (current === null) {
    throw new ConversationAuthorityError(
      'CONVERSATION_SESSION_NOT_FOUND',
      `Conversation session "${command.sessionId}" does not exist.`
    );
  }
  assertValidConversationSession(current);
  if (current.sessionId !== command.sessionId) {
    throw invariant('Loaded Conversation session identity differs from the command.');
  }
  if (current.workspaceId !== command.workspaceId) {
    throw new ConversationAuthorityError(
      'CONVERSATION_WORKSPACE_MISMATCH',
      'Conversation session is bound to a different workspace.'
    );
  }
  if (current.version !== command.expectedSessionVersion) {
    throw new ConversationAuthorityError(
      'CONVERSATION_SESSION_VERSION_CONFLICT',
      `Expected Conversation session version ${String(command.expectedSessionVersion)}, found ${String(current.version)}.`
    );
  }
  if (Date.parse(command.occurredAt) < Date.parse(current.updatedAt)) {
    throw invariant('Conversation Session mutation cannot move its clock backwards.');
  }
  if (
    (command.mutation.kind === 'rename' && current.title === command.mutation.title)
    || (command.mutation.kind === 'set_status' && current.status === command.mutation.status)
  ) {
    throw new ConversationAuthorityError(
      'CONVERSATION_SESSION_MUTATION_UNCHANGED',
      'Conversation Session mutation would not change authoritative state.'
    );
  }
  const nextVersion = current.version + 1;
  if (!Number.isSafeInteger(nextVersion)) throw invariant('Conversation session version overflow.');
  const session: ConversationSession = {
    ...current,
    version: nextVersion,
    ...(command.mutation.kind === 'rename'
      ? { title: command.mutation.title }
      : { status: command.mutation.status }),
    updatedAt: command.occurredAt
  };
  const event: MutatedConversationSession['event'] = {
    eventId: command.eventId,
    type: 'conversation.session.updated',
    commandId: command.commandId,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    sessionVersion: nextVersion,
    mutation: { ...command.mutation },
    occurredAt: command.occurredAt
  };
  assertValidConversationSession(session);
  assertValidConversationAuthorityEvent(event);
  return { session, event };
}

export function acceptConversationUserMessage(
  current: ConversationSession | null,
  command: AcceptConversationUserMessageCommand,
  contentDigest: string
): AcceptedConversationUserMessage {
  assertAcceptConversationUserMessageCommand(command);
  assertDigest(contentDigest, 'contentDigest');
  if (current === null) {
    throw new ConversationAuthorityError(
      'CONVERSATION_SESSION_NOT_FOUND',
      `Conversation session "${command.sessionId}" does not exist.`
    );
  }
  assertValidConversationSession(current);
  if (current.sessionId !== command.sessionId) {
    throw invariant('Loaded Conversation session identity differs from the command.');
  }
  if (current.workspaceId !== command.workspaceId) {
    throw new ConversationAuthorityError(
      'CONVERSATION_WORKSPACE_MISMATCH',
      'Conversation session is bound to a different workspace.'
    );
  }
  if (current.status !== 'active') {
    throw new ConversationAuthorityError(
      'CONVERSATION_SESSION_ARCHIVED',
      'Archived Conversation sessions cannot accept new user messages.'
    );
  }
  if (current.version !== command.expectedSessionVersion) {
    throw new ConversationAuthorityError(
      'CONVERSATION_SESSION_VERSION_CONFLICT',
      `Expected Conversation session version ${String(command.expectedSessionVersion)}, found ${String(current.version)}.`
    );
  }
  if (Date.parse(command.occurredAt) < Date.parse(current.updatedAt)) {
    throw invariant('Conversation messages cannot move the Session clock backwards.');
  }
  const nextVersion = current.version + 1;
  if (!Number.isSafeInteger(nextVersion)) {
    throw invariant('Conversation session version overflow.');
  }
  const session: ConversationSession = {
    ...current,
    version: nextVersion,
    updatedAt: command.occurredAt
  };
  const messageHead: ConversationMessageHead = {
    messageId: command.messageId,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    latestVersion: 1,
    createdAt: command.occurredAt,
    updatedAt: command.occurredAt
  };
  const messageVersion: ConversationMessageVersion = {
    messageId: command.messageId,
    version: 1,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    role: 'user',
    payload: {
      content: command.content,
      ...(command.attachments === undefined
        ? {}
        : { attachments: command.attachments.map((attachment) => ({ ...attachment })) }),
      ...(command.execution === undefined
        ? {}
        : { execution: structuredClone(command.execution) })
    },
    contentDigest,
    createdAt: command.occurredAt
  };
  const event: AcceptedConversationUserMessage['event'] = {
    eventId: command.eventId,
    type: 'conversation.user_message.accepted',
    commandId: command.commandId,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    sessionVersion: nextVersion,
    messageId: command.messageId,
    messageVersion: 1,
    contentDigest,
    occurredAt: command.occurredAt
  };
  assertValidConversationSession(session);
  assertValidConversationMessageHead(messageHead);
  assertValidConversationMessageVersion(messageVersion);
  assertValidConversationAuthorityEvent(event);
  return { session, messageHead, messageVersion, event };
}

export function projectConversationAgentResult(
  current: ConversationSession | null,
  command: ProjectConversationAgentResultCommand,
  assistantContent: string
): ProjectedConversationAgentResult {
  assertProjectConversationAgentResultCommand(command);
  assertMessageContent(assistantContent);
  if (current === null) {
    throw new ConversationAuthorityError(
      'CONVERSATION_SESSION_NOT_FOUND',
      `Conversation session "${command.sessionId}" does not exist.`
    );
  }
  assertValidConversationSession(current);
  if (current.sessionId !== command.sessionId) {
    throw invariant('Loaded Conversation session identity differs from the command.');
  }
  if (current.workspaceId !== command.workspaceId) {
    throw new ConversationAuthorityError(
      'CONVERSATION_WORKSPACE_MISMATCH',
      'Conversation session is bound to a different workspace.'
    );
  }
  if (current.version !== command.expectedSessionVersion) {
    throw new ConversationAuthorityError(
      'CONVERSATION_SESSION_VERSION_CONFLICT',
      `Expected Conversation session version ${String(command.expectedSessionVersion)}, found ${String(current.version)}.`
    );
  }
  if (Date.parse(command.occurredAt) < Date.parse(current.updatedAt)) {
    throw invariant('Conversation messages cannot move the Session clock backwards.');
  }
  const nextVersion = current.version + 1;
  if (!Number.isSafeInteger(nextVersion)) {
    throw invariant('Conversation session version overflow.');
  }
  const session: ConversationSession = {
    ...current,
    version: nextVersion,
    updatedAt: command.occurredAt
  };
  const messageHead: ConversationMessageHead = {
    messageId: command.messageId,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    latestVersion: 1,
    createdAt: command.occurredAt,
    updatedAt: command.occurredAt
  };
  const messageVersion: ConversationMessageVersion = {
    messageId: command.messageId,
    version: 1,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    role: 'assistant',
    payload: { content: assistantContent },
    contentDigest: command.contentDigest,
    createdAt: command.occurredAt
  };
  const event: ProjectedConversationAgentResult['event'] = {
    eventId: command.eventId,
    type: 'conversation.agent_result.projected',
    commandId: command.commandId,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    sessionVersion: nextVersion,
    messageId: command.messageId,
    messageVersion: 1,
    contentDigest: command.contentDigest,
    sagaId: command.sagaId,
    sagaVersion: command.expectedSagaVersion + 1,
    runId: command.runId,
    resultRunVersion: command.resultRunVersion,
    resultStatus: command.resultStatus,
    sourceRunEventId: command.sourceRunEventId,
    occurredAt: command.occurredAt
  };
  assertValidConversationSession(session);
  assertValidConversationMessageHead(messageHead);
  assertValidConversationMessageVersion(messageVersion);
  assertValidConversationAuthorityEvent(event);
  return { session, messageHead, messageVersion, event };
}

export function projectConversationAgentStartFailure(
  current: ConversationSession | null,
  command: ProjectConversationAgentStartFailureCommand,
  assistantContent: string
): ProjectedConversationAgentStartFailure {
  assertProjectConversationAgentStartFailureCommand(command);
  const base = projectAssistantMessage(current, command, assistantContent);
  const event: ProjectedConversationAgentStartFailure['event'] = {
    eventId: command.eventId,
    type: 'conversation.agent_start.failed',
    commandId: command.commandId,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    sessionVersion: base.session.version,
    messageId: command.messageId,
    messageVersion: 1,
    contentDigest: command.contentDigest,
    sagaId: command.sagaId,
    sagaVersion: command.expectedSagaVersion + 1,
    runRequestId: command.runRequestId,
    failureCode: command.failureCode,
    occurredAt: command.occurredAt
  };
  assertValidConversationAuthorityEvent(event);
  return { ...base, event };
}

function projectAssistantMessage(
  current: ConversationSession | null,
  command: ProjectConversationAgentStartFailureCommand,
  assistantContent: string
): Omit<ProjectedConversationAgentStartFailure, 'event'> {
  assertMessageContent(assistantContent);
  if (current === null) throw new ConversationAuthorityError(
    'CONVERSATION_SESSION_NOT_FOUND',
    `Conversation session "${command.sessionId}" does not exist.`
  );
  assertValidConversationSession(current);
  if (current.sessionId !== command.sessionId) throw invariant(
    'Loaded Conversation session identity differs from the command.'
  );
  if (current.workspaceId !== command.workspaceId) throw new ConversationAuthorityError(
    'CONVERSATION_WORKSPACE_MISMATCH',
    'Conversation session is bound to a different workspace.'
  );
  if (current.version !== command.expectedSessionVersion) throw new ConversationAuthorityError(
    'CONVERSATION_SESSION_VERSION_CONFLICT',
    `Expected Conversation session version ${String(command.expectedSessionVersion)}, found ${String(current.version)}.`
  );
  if (Date.parse(command.occurredAt) < Date.parse(current.updatedAt)) throw invariant(
    'Conversation messages cannot move the Session clock backwards.'
  );
  const session = { ...current, version: current.version + 1, updatedAt: command.occurredAt };
  const messageHead: ConversationMessageHead = {
    messageId: command.messageId, sessionId: command.sessionId,
    workspaceId: command.workspaceId, latestVersion: 1,
    createdAt: command.occurredAt, updatedAt: command.occurredAt
  };
  const messageVersion: ConversationMessageVersion = {
    messageId: command.messageId, version: 1, sessionId: command.sessionId,
    workspaceId: command.workspaceId, role: 'assistant',
    payload: { content: assistantContent }, contentDigest: command.contentDigest,
    createdAt: command.occurredAt
  };
  assertValidConversationSession(session);
  assertValidConversationMessageHead(messageHead);
  assertValidConversationMessageVersion(messageVersion);
  return { session, messageHead, messageVersion };
}

export async function digestConversationMessageContent(content: string): Promise<string> {
  assertMessageContent(content);
  return sha256(content);
}

export async function digestConversationMessagePayload(
  payload: ConversationMessagePayload
): Promise<string> {
  assertConversationMessagePayload(payload, 'messagePayload');
  return sha256(conversationMessageDigestSource(payload));
}

/** Legacy text-only rows retain their original digest identity. */
export function conversationMessageDigestSource(payload: ConversationMessagePayload): string {
  return payload.attachments === undefined
    ? payload.content
    : JSON.stringify({
        version: 1,
        content: payload.content,
        attachments: payload.attachments
      });
}

export async function fingerprintConversationAuthorityCommand(
  command: ConversationAuthorityCommand,
  contentDigest?: string
): Promise<string> {
  if (command.kind === 'conversation.create_session') {
    assertCreateConversationSessionCommand(command);
    return sha256(JSON.stringify([
      command.kind,
      command.commandId,
      command.eventId,
      command.sessionId,
      command.workspaceId,
      command.expectedVersion,
      command.occurredAt
    ]));
  }
  if (command.kind === 'conversation.mutate_session') {
    assertMutateConversationSessionCommand(command);
    return sha256(JSON.stringify([
      command.kind,
      command.commandId,
      command.eventId,
      command.sessionId,
      command.workspaceId,
      command.expectedSessionVersion,
      command.mutation,
      command.occurredAt
    ]));
  }
  if (command.kind === 'conversation.accept_user_message') {
    assertAcceptConversationUserMessageCommand(command);
    if (contentDigest === undefined) {
      throw invariant('Accept command fingerprint requires its content digest.');
    }
    assertDigest(contentDigest, 'contentDigest');
    return sha256(JSON.stringify([
      command.kind,
      command.commandId,
      command.eventId,
      command.sessionId,
      command.workspaceId,
      command.expectedSessionVersion,
      command.messageId,
      command.expectedMessageVersion,
      contentDigest,
      command.sagaId,
      command.handoffCommandId,
      command.handoffOutboxMessageId,
      command.occurredAt
    ]));
  }
  if (command.kind === 'conversation.project_agent_start_failure') {
    assertProjectConversationAgentStartFailureCommand(command);
    return sha256(JSON.stringify(Object.values(command)));
  }
  assertProjectConversationAgentResultCommand(command);
  return sha256(JSON.stringify([
    command.kind,
    command.commandId,
    command.eventId,
    command.sessionId,
    command.workspaceId,
    command.expectedSessionVersion,
    command.messageId,
    command.expectedMessageVersion,
    command.contentDigest,
    command.sagaId,
    command.expectedSagaVersion,
    command.handoffCommandId,
    command.handoffInboxEventId,
    command.handoffOutboxMessageId,
    command.objectiveMessageId,
    command.objectiveMessageVersion,
    command.objectiveDigest,
    command.runRequestId,
    command.agentCommandId,
    command.runId,
    command.admittedRunVersion,
    command.resultRunVersion,
    command.resultStatus,
    command.sourceRunEventId,
    command.occurredAt
  ]));
}

export function createConversationAuthorityReceipt(
  command: ConversationAuthorityCommand,
  commandFingerprint: string,
  resultingSessionVersion: number
): ConversationAuthorityCommandReceipt {
  assertDigest(commandFingerprint, 'commandFingerprint');
  assertSafePositiveInteger(resultingSessionVersion, 'resultingSessionVersion');
  if (command.kind === 'conversation.create_session') {
    assertCreateConversationSessionCommand(command);
    return {
      commandId: command.commandId,
      kind: command.kind,
      commandFingerprint,
      eventId: command.eventId,
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      resultingSessionVersion,
      messageId: null,
      messageVersion: null,
      sagaId: null,
      committedAt: command.occurredAt
    };
  }
  if (command.kind === 'conversation.mutate_session') {
    assertMutateConversationSessionCommand(command);
    return {
      commandId: command.commandId,
      kind: command.kind,
      commandFingerprint,
      eventId: command.eventId,
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      resultingSessionVersion,
      messageId: null,
      messageVersion: null,
      sagaId: null,
      committedAt: command.occurredAt
    };
  }
  if (command.kind === 'conversation.accept_user_message') {
    assertAcceptConversationUserMessageCommand(command);
    return {
      commandId: command.commandId,
      kind: command.kind,
      commandFingerprint,
      eventId: command.eventId,
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      resultingSessionVersion,
      messageId: command.messageId,
      messageVersion: 1,
      sagaId: command.sagaId,
      committedAt: command.occurredAt
    };
  }
  if (command.kind === 'conversation.project_agent_start_failure') {
    assertProjectConversationAgentStartFailureCommand(command);
    return {
      commandId: command.commandId, kind: command.kind, commandFingerprint,
      eventId: command.eventId, sessionId: command.sessionId,
      workspaceId: command.workspaceId, resultingSessionVersion,
      messageId: command.messageId, messageVersion: 1, sagaId: command.sagaId,
      sagaVersion: command.expectedSagaVersion + 1,
      handoffCommandId: command.handoffCommandId,
      handoffInboxEventId: command.handoffInboxEventId,
      handoffOutboxMessageId: command.handoffOutboxMessageId,
      runRequestId: command.runRequestId, failureCode: command.failureCode,
      committedAt: command.occurredAt
    };
  }
  assertProjectConversationAgentResultCommand(command);
  return {
    commandId: command.commandId,
    kind: command.kind,
    commandFingerprint,
    eventId: command.eventId,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    resultingSessionVersion,
    messageId: command.messageId,
    messageVersion: 1,
    sagaId: command.sagaId,
    sagaVersion: command.expectedSagaVersion + 1,
    handoffCommandId: command.handoffCommandId,
    handoffInboxEventId: command.handoffInboxEventId,
    handoffOutboxMessageId: command.handoffOutboxMessageId,
    runId: command.runId,
    resultRunVersion: command.resultRunVersion,
    resultStatus: command.resultStatus,
    sourceRunEventId: command.sourceRunEventId,
    committedAt: command.occurredAt
  };
}

export function assertValidConversationSession(session: ConversationSession): void {
  assertExactObjectKeys(session, [
    'sessionId', 'workspaceId', 'version', 'title', 'status', 'createdAt', 'updatedAt'
  ], 'session');
  assertCanonicalId(session.sessionId, 'session.sessionId');
  assertCanonicalId(session.workspaceId, 'session.workspaceId');
  assertSafePositiveInteger(session.version, 'session.version');
  assertSessionTitle(session.title, 'session.title');
  if (session.status !== 'active' && session.status !== 'archived') {
    throw invariant('Conversation Session status is invalid.');
  }
  assertTimestamp(session.createdAt, 'session.createdAt');
  assertTimestamp(session.updatedAt, 'session.updatedAt');
  if (Date.parse(session.updatedAt) < Date.parse(session.createdAt)) {
    throw invariant('Conversation Session updatedAt cannot precede createdAt.');
  }
}

export function assertValidConversationMessageHead(head: ConversationMessageHead): void {
  assertExactObjectKeys(head, [
    'messageId', 'sessionId', 'workspaceId', 'latestVersion', 'createdAt', 'updatedAt'
  ], 'messageHead');
  assertCanonicalId(head.messageId, 'messageHead.messageId');
  assertCanonicalId(head.sessionId, 'messageHead.sessionId');
  assertCanonicalId(head.workspaceId, 'messageHead.workspaceId');
  assertSafePositiveInteger(head.latestVersion, 'messageHead.latestVersion');
  assertTimestamp(head.createdAt, 'messageHead.createdAt');
  assertTimestamp(head.updatedAt, 'messageHead.updatedAt');
  if (Date.parse(head.updatedAt) < Date.parse(head.createdAt)) {
    throw invariant('Conversation Message head updatedAt cannot precede createdAt.');
  }
}

export function assertValidConversationMessageVersion(
  message: ConversationMessageVersion
): void {
  assertExactObjectKeys(message, [
    'messageId', 'version', 'sessionId', 'workspaceId', 'role',
    'payload', 'contentDigest', 'createdAt'
  ], 'messageVersion');
  assertCanonicalId(message.messageId, 'messageVersion.messageId');
  assertSafePositiveInteger(message.version, 'messageVersion.version');
  assertCanonicalId(message.sessionId, 'messageVersion.sessionId');
  assertCanonicalId(message.workspaceId, 'messageVersion.workspaceId');
  if (message.role !== 'user' && message.role !== 'assistant') {
    throw invariant('Conversation message role is invalid.');
  }
  assertConversationMessagePayload(message.payload, 'messageVersion.payload');
  if (message.payload.execution !== undefined) {
    if (message.role !== 'user') {
      throw invariant('Only user messages may carry execution preferences.');
    }
    assertConversationMessageExecution(message.payload.execution);
  }
  assertDigest(message.contentDigest, 'messageVersion.contentDigest');
  assertTimestamp(message.createdAt, 'messageVersion.createdAt');
}

export function assertValidConversationAuthorityEvent(
  event: ConversationAuthorityEvent
): void {
  const commonKeys = [
    'eventId', 'type', 'commandId', 'sessionId', 'workspaceId',
    'sessionVersion', 'occurredAt'
  ];
  assertExactObjectKeys(
    event,
    event.type === 'conversation.user_message.accepted'
      ? [...commonKeys, 'messageId', 'messageVersion', 'contentDigest']
      : event.type === 'conversation.agent_result.projected'
        ? [
            ...commonKeys,
            'messageId',
            'messageVersion',
            'contentDigest',
            'sagaId',
            'sagaVersion',
            'runId',
            'resultRunVersion',
            'resultStatus',
            'sourceRunEventId'
          ]
        : event.type === 'conversation.agent_start.failed'
          ? [...commonKeys, 'messageId', 'messageVersion', 'contentDigest',
              'sagaId', 'sagaVersion', 'runRequestId', 'failureCode']
          : event.type === 'conversation.session.updated'
            ? [...commonKeys, 'mutation']
      : commonKeys,
    'authorityEvent'
  );
  assertCanonicalId(event.eventId, 'authorityEvent.eventId');
  assertCanonicalId(event.commandId, 'authorityEvent.commandId');
  assertCanonicalId(event.sessionId, 'authorityEvent.sessionId');
  assertCanonicalId(event.workspaceId, 'authorityEvent.workspaceId');
  assertSafePositiveInteger(event.sessionVersion, 'authorityEvent.sessionVersion');
  assertTimestamp(event.occurredAt, 'authorityEvent.occurredAt');
  if (event.type === 'conversation.user_message.accepted') {
    assertCanonicalId(event.messageId, 'authorityEvent.messageId');
    assertSafePositiveInteger(event.messageVersion, 'authorityEvent.messageVersion');
    assertDigest(event.contentDigest, 'authorityEvent.contentDigest');
  } else if (event.type === 'conversation.agent_result.projected') {
    assertCanonicalId(event.messageId, 'authorityEvent.messageId');
    assertSafePositiveInteger(event.messageVersion, 'authorityEvent.messageVersion');
    assertDigest(event.contentDigest, 'authorityEvent.contentDigest');
    assertCanonicalId(event.sagaId, 'authorityEvent.sagaId');
    assertSafePositiveInteger(event.sagaVersion, 'authorityEvent.sagaVersion');
    assertCanonicalId(event.runId, 'authorityEvent.runId');
    assertSafePositiveInteger(event.resultRunVersion, 'authorityEvent.resultRunVersion');
    assertTerminalResultStatus(event.resultStatus, 'authorityEvent.resultStatus');
    assertCanonicalId(event.sourceRunEventId, 'authorityEvent.sourceRunEventId');
  } else if (event.type === 'conversation.agent_start.failed') {
    assertCanonicalId(event.messageId, 'authorityEvent.messageId');
    assertSafePositiveInteger(event.messageVersion, 'authorityEvent.messageVersion');
    assertDigest(event.contentDigest, 'authorityEvent.contentDigest');
    assertCanonicalId(event.sagaId, 'authorityEvent.sagaId');
    assertSafePositiveInteger(event.sagaVersion, 'authorityEvent.sagaVersion');
    assertCanonicalId(event.runRequestId, 'authorityEvent.runRequestId');
    assertCanonicalId(event.failureCode, 'authorityEvent.failureCode');
  } else if (event.type === 'conversation.session.updated') {
    assertConversationSessionMutation(event.mutation, 'authorityEvent.mutation');
  } else if (event.type !== 'conversation.session.created') {
    throw invariant('Conversation authority event type is invalid.');
  }
}

export function assertValidConversationAuthorityReceipt(
  receipt: ConversationAuthorityCommandReceipt
): void {
  const commonKeys = [
    'commandId', 'kind', 'commandFingerprint', 'eventId', 'sessionId',
    'workspaceId', 'resultingSessionVersion', 'messageId', 'messageVersion',
    'sagaId', 'committedAt'
  ];
  assertExactObjectKeys(
    receipt,
    receipt.kind === 'conversation.project_agent_result'
      ? [
          ...commonKeys,
          'sagaVersion',
          'handoffCommandId',
          'handoffInboxEventId',
          'handoffOutboxMessageId',
          'runId',
          'resultRunVersion',
          'resultStatus',
          'sourceRunEventId'
        ]
      : receipt.kind === 'conversation.project_agent_start_failure'
        ? [...commonKeys, 'sagaVersion', 'handoffCommandId',
            'handoffInboxEventId', 'handoffOutboxMessageId',
            'runRequestId', 'failureCode']
        : commonKeys,
    'authorityReceipt'
  );
  assertCanonicalId(receipt.commandId, 'authorityReceipt.commandId');
  assertDigest(receipt.commandFingerprint, 'authorityReceipt.commandFingerprint');
  assertCanonicalId(receipt.eventId, 'authorityReceipt.eventId');
  assertCanonicalId(receipt.sessionId, 'authorityReceipt.sessionId');
  assertCanonicalId(receipt.workspaceId, 'authorityReceipt.workspaceId');
  assertSafePositiveInteger(
    receipt.resultingSessionVersion,
    'authorityReceipt.resultingSessionVersion'
  );
  assertTimestamp(receipt.committedAt, 'authorityReceipt.committedAt');
  if (receipt.kind === 'conversation.create_session') {
    if (
      receipt.resultingSessionVersion !== 1
      || receipt.messageId !== null
      || receipt.messageVersion !== null
      || receipt.sagaId !== null
    ) throw invariant('Create Session receipt binding is invalid.');
    return;
  }
  if (receipt.kind === 'conversation.mutate_session') {
    if (
      receipt.messageId !== null
      || receipt.messageVersion !== null
      || receipt.sagaId !== null
    ) throw invariant('Mutate Session receipt binding is invalid.');
    return;
  }
  if (receipt.kind === 'conversation.project_agent_result') {
    assertCanonicalId(receipt.messageId, 'authorityReceipt.messageId');
    assertSafePositiveInteger(receipt.messageVersion, 'authorityReceipt.messageVersion');
    assertCanonicalId(receipt.sagaId, 'authorityReceipt.sagaId');
    assertSafePositiveInteger(receipt.sagaVersion, 'authorityReceipt.sagaVersion');
    assertCanonicalId(receipt.handoffCommandId, 'authorityReceipt.handoffCommandId');
    assertCanonicalId(receipt.handoffInboxEventId, 'authorityReceipt.handoffInboxEventId');
    assertCanonicalId(receipt.handoffOutboxMessageId, 'authorityReceipt.handoffOutboxMessageId');
    assertCanonicalId(receipt.runId, 'authorityReceipt.runId');
    assertSafePositiveInteger(
      receipt.resultRunVersion,
      'authorityReceipt.resultRunVersion'
    );
    assertTerminalResultStatus(receipt.resultStatus, 'authorityReceipt.resultStatus');
    assertCanonicalId(receipt.sourceRunEventId, 'authorityReceipt.sourceRunEventId');
    return;
  }
  if (receipt.kind === 'conversation.project_agent_start_failure') {
    assertCanonicalId(receipt.messageId, 'authorityReceipt.messageId');
    assertSafePositiveInteger(receipt.messageVersion, 'authorityReceipt.messageVersion');
    assertCanonicalId(receipt.sagaId, 'authorityReceipt.sagaId');
    assertSafePositiveInteger(receipt.sagaVersion, 'authorityReceipt.sagaVersion');
    assertCanonicalId(receipt.handoffCommandId, 'authorityReceipt.handoffCommandId');
    assertCanonicalId(receipt.handoffInboxEventId, 'authorityReceipt.handoffInboxEventId');
    assertCanonicalId(receipt.handoffOutboxMessageId, 'authorityReceipt.handoffOutboxMessageId');
    assertCanonicalId(receipt.runRequestId, 'authorityReceipt.runRequestId');
    assertCanonicalId(receipt.failureCode, 'authorityReceipt.failureCode');
    return;
  }
  if (receipt.kind !== 'conversation.accept_user_message') {
    throw invariant('Conversation authority receipt kind is invalid.');
  }
  assertCanonicalId(receipt.messageId, 'authorityReceipt.messageId');
  assertSafePositiveInteger(receipt.messageVersion, 'authorityReceipt.messageVersion');
  assertCanonicalId(receipt.sagaId, 'authorityReceipt.sagaId');
}

export function assertCreateConversationSessionCommand(
  command: CreateConversationSessionCommand
): void {
  assertExactObjectKeys(command, [
    'kind', 'commandId', 'eventId', 'sessionId', 'workspaceId',
    'expectedVersion', ...(command.title === undefined ? [] : ['title']), 'occurredAt'
  ], 'createSessionCommand');
  assertCommandBase(command);
  if (command.kind !== 'conversation.create_session' || command.expectedVersion !== null) {
    throw invariant('Create Session command shape is invalid.');
  }
  if (command.title !== undefined) assertSessionTitle(command.title, 'createSessionCommand.title');
}

export function assertMutateConversationSessionCommand(
  command: MutateConversationSessionCommand
): void {
  assertExactObjectKeys(command, [
    'kind', 'commandId', 'eventId', 'sessionId', 'workspaceId',
    'expectedSessionVersion', 'mutation', 'occurredAt'
  ], 'mutateSessionCommand');
  assertCommandBase(command);
  if (command.kind !== 'conversation.mutate_session') {
    throw invariant('Mutate Session command shape is invalid.');
  }
  assertSafePositiveInteger(
    command.expectedSessionVersion,
    'mutateSessionCommand.expectedSessionVersion'
  );
  assertConversationSessionMutation(command.mutation, 'mutateSessionCommand.mutation');
}

export function assertAcceptConversationUserMessageCommand(
  command: AcceptConversationUserMessageCommand
): void {
  assertExactObjectKeys(command, [
    'kind', 'commandId', 'eventId', 'sessionId', 'workspaceId',
    'expectedSessionVersion', 'messageId', 'expectedMessageVersion', 'content',
    ...(command.attachments === undefined ? [] : ['attachments']),
    ...(command.execution === undefined ? [] : ['execution']),
    'sagaId', 'handoffCommandId', 'handoffOutboxMessageId', 'occurredAt'
  ], 'acceptUserMessageCommand');
  assertCommandBase(command);
  if (
    command.kind !== 'conversation.accept_user_message'
    || command.expectedMessageVersion !== null
  ) throw invariant('Accept user Message command shape is invalid.');
  assertSafePositiveInteger(
    command.expectedSessionVersion,
    'acceptUserMessageCommand.expectedSessionVersion'
  );
  assertCanonicalId(command.messageId, 'acceptUserMessageCommand.messageId');
  assertMessageContentOrAttachments(command.content, command.attachments);
  if (command.attachments !== undefined) {
    assertImageAttachments(command.attachments, 'acceptUserMessageCommand.attachments');
  }
  if (command.execution !== undefined) {
    assertConversationMessageExecution(command.execution);
  }
  assertCanonicalId(command.sagaId, 'acceptUserMessageCommand.sagaId');
  assertCanonicalId(command.handoffCommandId, 'acceptUserMessageCommand.handoffCommandId');
  assertCanonicalId(
    command.handoffOutboxMessageId,
    'acceptUserMessageCommand.handoffOutboxMessageId'
  );
  const identities = [
    command.commandId,
    command.eventId,
    command.sagaId,
    command.handoffCommandId,
    command.handoffOutboxMessageId,
    command.messageId
  ];
  if (new Set(identities).size !== identities.length) {
    throw invariant('Accept user Message identities must be distinct.');
  }
}

function assertConversationMessagePayload(
  payload: ConversationMessagePayload,
  location: string
): void {
  assertExactObjectKeys(payload, [
    'content',
    ...(payload.attachments === undefined ? [] : ['attachments']),
    ...(payload.execution === undefined ? [] : ['execution'])
  ], location);
  assertMessageContentOrAttachments(payload.content, payload.attachments);
  if (payload.attachments !== undefined) {
    assertImageAttachments(payload.attachments, `${location}.attachments`);
  }
}

function assertImageAttachments(
  attachments: readonly ImageAttachmentRefV3[],
  location: string
): void {
  if (!Array.isArray(attachments) || attachments.length === 0 || attachments.length > 4) {
    throw invariant(`${location} must contain one through four images.`);
  }
  for (const [index, attachment] of attachments.entries()) {
    if (!imageAttachmentRefV3Schema.safeParse(attachment).success) {
      throw invariant(`${location}[${String(index)}] is invalid.`);
    }
  }
}

export function assertProjectConversationAgentResultCommand(
  command: ProjectConversationAgentResultCommand
): void {
  assertExactObjectKeys(command, [
    'kind',
    'commandId',
    'eventId',
    'sessionId',
    'workspaceId',
    'expectedSessionVersion',
    'messageId',
    'expectedMessageVersion',
    'contentDigest',
    'sagaId',
    'expectedSagaVersion',
    'handoffCommandId',
    'handoffInboxEventId',
    'handoffOutboxMessageId',
    'objectiveMessageId',
    'objectiveMessageVersion',
    'objectiveDigest',
    'runRequestId',
    'agentCommandId',
    'runId',
    'admittedRunVersion',
    'resultRunVersion',
    'resultStatus',
    'sourceRunEventId',
    'occurredAt'
  ], 'projectAgentResultCommand');
  assertCommandBase(command);
  if (
    command.kind !== 'conversation.project_agent_result'
    || command.expectedMessageVersion !== null
  ) throw invariant('Project Agent result command shape is invalid.');
  assertSafePositiveInteger(
    command.expectedSessionVersion,
    'projectAgentResultCommand.expectedSessionVersion'
  );
  assertCanonicalId(command.messageId, 'projectAgentResultCommand.messageId');
  assertDigest(command.contentDigest, 'projectAgentResultCommand.contentDigest');
  assertCanonicalId(command.sagaId, 'projectAgentResultCommand.sagaId');
  assertSafePositiveInteger(
    command.expectedSagaVersion,
    'projectAgentResultCommand.expectedSagaVersion'
  );
  assertCanonicalId(
    command.handoffCommandId,
    'projectAgentResultCommand.handoffCommandId'
  );
  assertCanonicalId(
    command.handoffInboxEventId,
    'projectAgentResultCommand.handoffInboxEventId'
  );
  assertCanonicalId(
    command.handoffOutboxMessageId,
    'projectAgentResultCommand.handoffOutboxMessageId'
  );
  assertCanonicalId(
    command.objectiveMessageId,
    'projectAgentResultCommand.objectiveMessageId'
  );
  assertSafePositiveInteger(
    command.objectiveMessageVersion,
    'projectAgentResultCommand.objectiveMessageVersion'
  );
  assertDigest(command.objectiveDigest, 'projectAgentResultCommand.objectiveDigest');
  assertCanonicalId(command.runRequestId, 'projectAgentResultCommand.runRequestId');
  assertCanonicalId(command.agentCommandId, 'projectAgentResultCommand.agentCommandId');
  assertCanonicalId(command.runId, 'projectAgentResultCommand.runId');
  assertSafePositiveInteger(
    command.admittedRunVersion,
    'projectAgentResultCommand.admittedRunVersion'
  );
  assertSafePositiveInteger(
    command.resultRunVersion,
    'projectAgentResultCommand.resultRunVersion'
  );
  if (command.resultRunVersion < command.admittedRunVersion) {
    throw invariant('Projected Agent result cannot precede its admitted Run version.');
  }
  assertTerminalResultStatus(
    command.resultStatus,
    'projectAgentResultCommand.resultStatus'
  );
  assertCanonicalId(
    command.sourceRunEventId,
    'projectAgentResultCommand.sourceRunEventId'
  );
  const identities = [
    command.commandId,
    command.eventId,
    command.messageId,
    command.handoffCommandId,
    command.handoffInboxEventId,
    command.handoffOutboxMessageId
  ];
  if (new Set(identities).size !== identities.length) {
    throw invariant('Project Agent result identities must be distinct.');
  }
}

export function assertProjectConversationAgentStartFailureCommand(
  command: ProjectConversationAgentStartFailureCommand
): void {
  assertExactObjectKeys(command, [
    'kind', 'commandId', 'eventId', 'sessionId', 'workspaceId',
    'expectedSessionVersion', 'messageId', 'expectedMessageVersion',
    'contentDigest', 'sagaId', 'expectedSagaVersion', 'handoffCommandId',
    'handoffInboxEventId', 'handoffOutboxMessageId', 'objectiveMessageId',
    'objectiveMessageVersion', 'objectiveDigest', 'runRequestId',
    'agentCommandId', 'failureCode', 'occurredAt'
  ], 'projectAgentStartFailureCommand');
  assertCommandBase(command);
  if (command.kind !== 'conversation.project_agent_start_failure'
    || command.expectedMessageVersion !== null) throw invariant(
      'Project Agent start failure command shape is invalid.'
    );
  assertSafePositiveInteger(command.expectedSessionVersion, 'command.expectedSessionVersion');
  assertCanonicalId(command.messageId, 'command.messageId');
  assertDigest(command.contentDigest, 'command.contentDigest');
  assertCanonicalId(command.sagaId, 'command.sagaId');
  assertSafePositiveInteger(command.expectedSagaVersion, 'command.expectedSagaVersion');
  assertCanonicalId(command.handoffCommandId, 'command.handoffCommandId');
  assertCanonicalId(command.handoffInboxEventId, 'command.handoffInboxEventId');
  assertCanonicalId(command.handoffOutboxMessageId, 'command.handoffOutboxMessageId');
  assertCanonicalId(command.objectiveMessageId, 'command.objectiveMessageId');
  assertSafePositiveInteger(command.objectiveMessageVersion, 'command.objectiveMessageVersion');
  assertDigest(command.objectiveDigest, 'command.objectiveDigest');
  assertCanonicalId(command.runRequestId, 'command.runRequestId');
  assertCanonicalId(command.agentCommandId, 'command.agentCommandId');
  assertCanonicalId(command.failureCode, 'command.failureCode');
}

function assertCommandBase(command: ConversationAuthorityCommandBase): void {
  assertCanonicalId(command.commandId, 'command.commandId');
  assertCanonicalId(command.eventId, 'command.eventId');
  assertCanonicalId(command.sessionId, 'command.sessionId');
  assertCanonicalId(command.workspaceId, 'command.workspaceId');
  assertTimestamp(command.occurredAt, 'command.occurredAt');
  if (command.commandId === command.eventId) {
    throw invariant('Conversation command and event identities must be distinct.');
  }
}

function assertConversationSessionMutation(
  mutation: ConversationSessionMutation,
  location: string
): void {
  if (mutation.kind === 'rename') {
    assertExactObjectKeys(mutation, ['kind', 'title'], location);
    assertSessionTitle(mutation.title, `${location}.title`);
    return;
  }
  if (mutation.kind === 'set_status') {
    assertExactObjectKeys(mutation, ['kind', 'status'], location);
    if (mutation.status !== 'active' && mutation.status !== 'archived') {
      throw invariant(`${location}.status is invalid.`);
    }
    return;
  }
  throw invariant(`${location}.kind is invalid.`);
}

function assertSessionTitle(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length < 1
    || value.length > 80
  ) throw invariant(`${field} must contain 1 to 80 trimmed characters.`);
}

function assertMessageContent(content: unknown): asserts content is string {
  if (
    typeof content !== 'string'
    || content.length === 0
    || content.length > 1_048_576
  ) throw invariant('Conversation message content must contain 1..1048576 code units.');
}

function assertMessageContentOrAttachments(
  content: unknown,
  attachments: readonly ImageAttachmentRefV3[] | undefined
): asserts content is string {
  if (
    typeof content !== 'string'
    || content.length > 1_048_576
    || (content.trim().length === 0 && attachments === undefined)
  ) {
    throw invariant(
      'Conversation user message must contain text or one through four image attachments.'
    );
  }
}

function assertConversationMessageExecution(
  value: unknown
): asserts value is ConversationMessageExecutionV3 {
  if (!conversationMessageExecutionV3Schema.safeParse(value).success) {
    throw invariant('Conversation message execution preferences are invalid.');
  }
}

function assertCanonicalId(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
  ) throw invariant(`${field} must be a canonical identifier.`);
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw invariant(`${field} must be a canonical SHA-256 digest.`);
  }
}

function assertSafePositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw invariant(`${field} must be a positive safe integer.`);
  }
}

function assertTerminalResultStatus(
  value: unknown,
  field: string
): asserts value is ConversationRunResultStatus {
  if (value !== 'completed' && value !== 'failed' && value !== 'cancelled') {
    throw invariant(`${field} must be terminal.`);
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw invariant(`${field} must be a canonical UTC timestamp.`);
}

function assertExactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
  field: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invariant(`${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Object.keys(value);
  const expected = new Set(expectedKeys);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || keys.length !== expectedKeys.length
    || keys.some((key) => !expected.has(key))
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined;
    })
  ) throw invariant(`${field} has an unexpected shape.`);
}

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw invariant('Conversation identity requires Web Crypto.');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function invariant(message: string, cause?: unknown): ConversationAuthorityError {
  return new ConversationAuthorityError(
    'CONVERSATION_INVARIANT',
    message,
    cause === undefined ? undefined : { cause }
  );
}
