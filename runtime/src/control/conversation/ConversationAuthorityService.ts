import {
  ConversationAuthorityError,
  acceptConversationUserMessage,
  assertAcceptConversationUserMessageCommand,
  assertCreateConversationSessionCommand,
  assertMutateConversationSessionCommand,
  assertValidConversationAuthorityEvent,
  assertValidConversationAuthorityReceipt,
  assertValidConversationMessageVersion,
  createConversationAuthorityReceipt,
  createConversationSession,
  mutateConversationSession,
  digestConversationMessagePayload,
  fingerprintConversationAuthorityCommand,
  type AcceptConversationUserMessageCommand,
  type AcceptedConversationUserMessage,
  type ConversationAuthorityCommandReceipt,
  type CreateConversationSessionCommand,
  type CreatedConversationSession,
  type MutateConversationSessionCommand,
  type MutatedConversationSession
} from '../../conversation/ConversationAuthority.js';
import {
  assertValidConversationRunHandoffSaga,
  fingerprintConversationRunHandoffCommand,
  projectConversationRunHandoffArtifacts,
  transitionConversationRunHandoff,
  type AcceptConversationMessageCommand,
  type ConversationRunHandoffTransition
} from '../../conversation/ConversationRunHandoffSaga.js';
import type {
  CommittedConversationAuthorityCommand,
  ConversationAuthorityTransaction,
  ConversationAuthorityUnitOfWork
} from '../ports/ConversationAuthorityPersistence.js';

export interface CreateConversationSessionResult extends CreatedConversationSession {
  readonly receipt: Extract<
    ConversationAuthorityCommandReceipt,
    { readonly kind: 'conversation.create_session' }
  >;
  readonly replayed: boolean;
}

export interface AcceptConversationUserMessageResult
extends Omit<AcceptedConversationUserMessage, 'event'>,
Omit<ConversationRunHandoffTransition, 'event'> {
  readonly authorityEvent: AcceptedConversationUserMessage['event'];
  readonly handoffEvent: ConversationRunHandoffTransition['event'];
  readonly receipt: Extract<
    ConversationAuthorityCommandReceipt,
    { readonly kind: 'conversation.accept_user_message' }
  >;
  readonly replayed: boolean;
}

export interface MutateConversationSessionResult {
  readonly event: MutatedConversationSession['event'];
  readonly receipt: Extract<
    ConversationAuthorityCommandReceipt,
    { readonly kind: 'conversation.mutate_session' }
  >;
  readonly resultingSessionVersion: number;
  readonly replayed: boolean;
}

/**
 * Sole application entry for authoritative Conversation creation and user
 * message acceptance. It deliberately has no IPC or production wiring yet.
 */
export class ConversationAuthorityService {
  public constructor(private readonly unitOfWork: ConversationAuthorityUnitOfWork) {}

  public async createSession(
    input: CreateConversationSessionCommand
  ): Promise<CreateConversationSessionResult> {
    const command = snapshotCreateConversationSessionCommand(input);
    const commandFingerprint = await fingerprintConversationAuthorityCommand(command);
    return this.unitOfWork.authorityTransaction(async (transaction) => {
      const committed = await transaction.loadCommittedAuthorityCommand(command.commandId);
      if (committed !== null) {
        assertExactCommittedCommand(committed, commandFingerprint, command.kind);
        return replayCreatedSession(committed, command);
      }
      const existing = await transaction.loadSession(command.sessionId);
      if (existing !== null) {
        throw new ConversationAuthorityError(
          'CONVERSATION_SESSION_ALREADY_EXISTS',
          `Conversation session "${command.sessionId}" already exists.`
        );
      }
      const created = createConversationSession(command);
      const receipt = createConversationAuthorityReceipt(
        command,
        commandFingerprint,
        created.session.version
      ) as CreateConversationSessionResult['receipt'];
      await transaction.commitCreatedSession({ ...created, receipt });
      return { ...created, receipt, replayed: false };
    });
  }

  public async acceptUserMessage(
    input: AcceptConversationUserMessageCommand
  ): Promise<AcceptConversationUserMessageResult> {
    const command = snapshotAcceptConversationUserMessageCommand(input);
    const contentDigest = await digestConversationMessagePayload({
      content: command.content,
      ...(command.attachments === undefined ? {} : { attachments: command.attachments }),
      ...(command.execution === undefined ? {} : { execution: command.execution })
    });
    const commandFingerprint = await fingerprintConversationAuthorityCommand(
      command,
      contentDigest
    );
    const handoffCommand = createAcceptedHandoffCommand(command, contentDigest);
    const handoffFingerprint = await fingerprintConversationRunHandoffCommand(
      handoffCommand
    );
    return this.unitOfWork.authorityTransaction(async (transaction) => {
      const committed = await transaction.loadCommittedAuthorityCommand(command.commandId);
      if (committed !== null) {
        assertExactCommittedCommand(committed, commandFingerprint, command.kind);
        return replayAcceptedUserMessage(
          transaction,
          committed,
          command,
          contentDigest,
          handoffCommand,
          handoffFingerprint
        );
      }
      if (await transaction.loadMessageHead(command.messageId) !== null) {
        throw new ConversationAuthorityError(
          'CONVERSATION_MESSAGE_ALREADY_EXISTS',
          `Conversation message "${command.messageId}" already exists.`
        );
      }
      const current = await transaction.loadSession(command.sessionId);
      const accepted = acceptConversationUserMessage(current, command, contentDigest);
      const handoff = transitionConversationRunHandoff(
        null,
        handoffCommand,
        handoffFingerprint
      );
      const receipt = createConversationAuthorityReceipt(
        command,
        commandFingerprint,
        accepted.session.version
      ) as AcceptConversationUserMessageResult['receipt'];
      await transaction.commitAcceptedUserMessage({
        receipt,
        expectedSessionVersion: command.expectedSessionVersion,
        ...accepted,
        handoff: {
          commandId: handoffCommand.commandId,
          commandFingerprint: handoffFingerprint,
          sagaId: handoffCommand.sagaId,
          expectedVersion: null,
          resultingVersion: handoff.saga.version,
          ...handoff
        }
      });
      return {
        session: accepted.session,
        messageHead: accepted.messageHead,
        messageVersion: accepted.messageVersion,
        authorityEvent: accepted.event,
        saga: handoff.saga,
        handoffEvent: handoff.event,
        outbox: handoff.outbox,
        receipt,
        replayed: false
      };
    });
  }

  public async mutateSession(
    input: MutateConversationSessionCommand
  ): Promise<MutateConversationSessionResult> {
    const command = snapshotMutateConversationSessionCommand(input);
    const commandFingerprint = await fingerprintConversationAuthorityCommand(command);
    return this.unitOfWork.authorityTransaction(async (transaction) => {
      const committed = await transaction.loadCommittedAuthorityCommand(command.commandId);
      if (committed !== null) {
        assertExactCommittedCommand(committed, commandFingerprint, command.kind);
        return replayMutatedSession(committed, command);
      }
      const current = await transaction.loadSession(command.sessionId);
      const mutated = mutateConversationSession(current, command);
      const receipt = createConversationAuthorityReceipt(
        command,
        commandFingerprint,
        mutated.session.version
      ) as MutateConversationSessionResult['receipt'];
      await transaction.commitMutatedSession({
        receipt,
        expectedSessionVersion: command.expectedSessionVersion,
        ...mutated
      });
      return {
        event: mutated.event,
        receipt,
        resultingSessionVersion: mutated.session.version,
        replayed: false
      };
    });
  }
}

function snapshotCreateConversationSessionCommand(
  input: CreateConversationSessionCommand
): CreateConversationSessionCommand {
  assertCreateConversationSessionCommand(input);
  return {
    kind: input.kind,
    commandId: input.commandId,
    eventId: input.eventId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    expectedVersion: input.expectedVersion,
    occurredAt: input.occurredAt
  };
}

function snapshotMutateConversationSessionCommand(
  input: MutateConversationSessionCommand
): MutateConversationSessionCommand {
  assertMutateConversationSessionCommand(input);
  return {
    kind: input.kind,
    commandId: input.commandId,
    eventId: input.eventId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    expectedSessionVersion: input.expectedSessionVersion,
    mutation: { ...input.mutation },
    occurredAt: input.occurredAt
  };
}

function snapshotAcceptConversationUserMessageCommand(
  input: AcceptConversationUserMessageCommand
): AcceptConversationUserMessageCommand {
  assertAcceptConversationUserMessageCommand(input);
  return {
    kind: input.kind,
    commandId: input.commandId,
    eventId: input.eventId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    expectedSessionVersion: input.expectedSessionVersion,
    messageId: input.messageId,
    expectedMessageVersion: input.expectedMessageVersion,
    content: input.content,
    ...(input.attachments === undefined
      ? {}
      : { attachments: input.attachments.map((attachment) => ({ ...attachment })) }),
    ...(input.execution === undefined
      ? {}
      : { execution: structuredClone(input.execution) }),
    sagaId: input.sagaId,
    handoffCommandId: input.handoffCommandId,
    handoffOutboxMessageId: input.handoffOutboxMessageId,
    occurredAt: input.occurredAt
  };
}

function createAcceptedHandoffCommand(
  command: AcceptConversationUserMessageCommand,
  contentDigest: string
): AcceptConversationMessageCommand {
  return {
    kind: 'handoff.accept_message',
    sagaId: command.sagaId,
    commandId: command.handoffCommandId,
    expectedVersion: null,
    inboxEventId: command.eventId,
    outboxMessageId: command.handoffOutboxMessageId,
    occurredAt: command.occurredAt,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    messageId: command.messageId,
    messageVersion: 1,
    objectiveDigest: contentDigest
  };
}

function assertExactCommittedCommand(
  committed: CommittedConversationAuthorityCommand,
  expectedFingerprint: string,
  expectedKind: ConversationAuthorityCommandReceipt['kind']
): void {
  try {
    assertValidConversationAuthorityReceipt(committed.receipt);
    assertValidConversationAuthorityEvent(committed.event);
  } catch (error) {
    throw storageCorruption('Committed Conversation authority command is invalid.', error);
  }
  if (
    committed.receipt.commandFingerprint !== expectedFingerprint
    || committed.receipt.kind !== expectedKind
  ) {
    throw new ConversationAuthorityError(
      'CONVERSATION_COMMAND_CONFLICT',
      `Conversation command "${committed.receipt.commandId}" is bound to a different payload.`
    );
  }
}

function replayCreatedSession(
  committed: CommittedConversationAuthorityCommand,
  command: CreateConversationSessionCommand
): CreateConversationSessionResult {
  const receipt = committed.receipt;
  const event = committed.event;
  if (
    receipt.kind !== 'conversation.create_session'
    || event.type !== 'conversation.session.created'
    || receipt.commandId !== command.commandId
    || receipt.eventId !== command.eventId
    || receipt.sessionId !== command.sessionId
    || receipt.workspaceId !== command.workspaceId
    || receipt.committedAt !== command.occurredAt
    || event.eventId !== receipt.eventId
    || event.commandId !== receipt.commandId
    || event.sessionId !== receipt.sessionId
    || event.workspaceId !== receipt.workspaceId
    || event.sessionVersion !== receipt.resultingSessionVersion
    || event.occurredAt !== receipt.committedAt
  ) throw storageCorruption('Create Session receipt and event binding differs.');
  return {
    session: {
      sessionId: receipt.sessionId,
      workspaceId: receipt.workspaceId,
      version: receipt.resultingSessionVersion,
      title: 'Conversation',
      status: 'active',
      createdAt: receipt.committedAt,
      updatedAt: receipt.committedAt
    },
    event,
    receipt,
    replayed: true
  };
}

function replayMutatedSession(
  committed: CommittedConversationAuthorityCommand,
  command: MutateConversationSessionCommand
): MutateConversationSessionResult {
  const { receipt, event } = committed;
  if (
    receipt.kind !== 'conversation.mutate_session'
    || event.type !== 'conversation.session.updated'
    || receipt.commandId !== command.commandId
    || receipt.eventId !== command.eventId
    || receipt.sessionId !== command.sessionId
    || receipt.workspaceId !== command.workspaceId
    || receipt.committedAt !== command.occurredAt
    || event.eventId !== receipt.eventId
    || event.commandId !== receipt.commandId
    || event.sessionId !== receipt.sessionId
    || event.workspaceId !== receipt.workspaceId
    || event.sessionVersion !== receipt.resultingSessionVersion
    || event.occurredAt !== receipt.committedAt
    || JSON.stringify(event.mutation) !== JSON.stringify(command.mutation)
  ) throw storageCorruption('Mutate Session receipt and event binding differs.');
  return {
    event,
    receipt,
    resultingSessionVersion: receipt.resultingSessionVersion,
    replayed: true
  };
}

async function replayAcceptedUserMessage(
  transaction: ConversationAuthorityTransaction,
  committed: CommittedConversationAuthorityCommand,
  command: AcceptConversationUserMessageCommand,
  contentDigest: string,
  handoffCommand: AcceptConversationMessageCommand,
  handoffFingerprint: string
): Promise<AcceptConversationUserMessageResult> {
  const receipt = committed.receipt;
  const event = committed.event;
  if (
    receipt.kind !== 'conversation.accept_user_message'
    || event.type !== 'conversation.user_message.accepted'
    || receipt.commandId !== command.commandId
    || receipt.eventId !== command.eventId
    || receipt.sessionId !== command.sessionId
    || receipt.workspaceId !== command.workspaceId
    || receipt.messageId !== command.messageId
    || receipt.messageVersion !== 1
    || receipt.sagaId !== command.sagaId
    || receipt.committedAt !== command.occurredAt
    || event.eventId !== receipt.eventId
    || event.commandId !== receipt.commandId
    || event.sessionId !== receipt.sessionId
    || event.workspaceId !== receipt.workspaceId
    || event.sessionVersion !== receipt.resultingSessionVersion
    || event.messageId !== receipt.messageId
    || event.messageVersion !== receipt.messageVersion
    || event.contentDigest !== contentDigest
    || event.occurredAt !== receipt.committedAt
  ) throw storageCorruption('Accepted Message receipt and event binding differs.');

  const [currentSession, exactSession, messageHead, messageVersion, committedHandoff] = await Promise.all([
    transaction.loadSession(receipt.sessionId),
    transaction.loadSessionVersion(receipt.sessionId, receipt.resultingSessionVersion),
    transaction.loadMessageHead(receipt.messageId),
    transaction.loadMessageVersion(receipt.messageId, receipt.messageVersion),
    transaction.loadCommittedCommand(handoffCommand.commandId)
  ]);
  if (
    currentSession === null
    || exactSession === null
    || messageHead === null
    || messageVersion === null
    || committedHandoff === null
  ) {
    throw storageCorruption('Accepted Message replay artifacts are incomplete.');
  }
  try {
    assertValidConversationMessageVersion(messageVersion);
    assertValidConversationRunHandoffSaga(committedHandoff.saga);
  } catch (error) {
    throw storageCorruption('Accepted Message replay artifacts are invalid.', error);
  }
  if (
    currentSession.sessionId !== receipt.sessionId
    || currentSession.workspaceId !== receipt.workspaceId
    || currentSession.version < receipt.resultingSessionVersion
    || exactSession.sessionId !== receipt.sessionId
    || exactSession.workspaceId !== receipt.workspaceId
    || exactSession.version !== receipt.resultingSessionVersion
    || exactSession.updatedAt !== receipt.committedAt
    || messageHead.messageId !== receipt.messageId
    || messageHead.sessionId !== receipt.sessionId
    || messageHead.workspaceId !== receipt.workspaceId
    || messageHead.latestVersion < receipt.messageVersion
    || messageHead.createdAt !== receipt.committedAt
    || messageVersion.sessionId !== receipt.sessionId
    || messageVersion.workspaceId !== receipt.workspaceId
    || messageVersion.payload.content !== command.content
    || JSON.stringify(messageVersion.payload.execution) !== JSON.stringify(command.execution)
    || messageVersion.contentDigest !== contentDigest
    || messageVersion.createdAt !== receipt.committedAt
    || committedHandoff.commandFingerprint !== handoffFingerprint
    || committedHandoff.sagaId !== receipt.sagaId
    || committedHandoff.resultingVersion !== 1
  ) throw storageCorruption('Accepted Message replay artifacts differ from the command.');
  const saga = committedHandoff.saga;
  const projected = projectConversationRunHandoffArtifacts(saga);
  if (
    saga.sessionId !== receipt.sessionId
    || saga.workspaceId !== receipt.workspaceId
    || saga.messageId !== receipt.messageId
    || saga.messageVersion !== receipt.messageVersion
    || saga.objectiveDigest !== contentDigest
    || saga.createdAt !== receipt.committedAt
    || saga.processedSteps[0]?.commandId !== handoffCommand.commandId
    || saga.processedSteps[0]?.inboxEventId !== receipt.eventId
    || saga.processedSteps[0]?.outboxMessageId !== handoffCommand.outboxMessageId
  ) throw storageCorruption('Accepted Message Handoff receipt binding differs.');
  const session = exactSession;
  return {
    session,
    messageHead: {
      messageId: receipt.messageId,
      sessionId: receipt.sessionId,
      workspaceId: receipt.workspaceId,
      latestVersion: receipt.messageVersion,
      createdAt: receipt.committedAt,
      updatedAt: receipt.committedAt
    },
    messageVersion,
    authorityEvent: event,
    saga,
    handoffEvent: projected.event,
    outbox: projected.outbox,
    receipt,
    replayed: true
  };
}

function storageCorruption(message: string, cause?: unknown): ConversationAuthorityError {
  return new ConversationAuthorityError(
    'CONVERSATION_STORAGE_CORRUPTION',
    message,
    cause === undefined ? undefined : { cause }
  );
}
