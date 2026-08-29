import {
  ConversationAuthorityError,
  assertProjectConversationAgentResultCommand,
  assertValidConversationAuthorityEvent,
  assertValidConversationAuthorityReceipt,
  assertValidConversationMessageVersion,
  createConversationAuthorityReceipt,
  digestConversationMessageContent,
  fingerprintConversationAuthorityCommand,
  projectConversationAgentResult,
  type ConversationAuthorityCommandReceipt,
  type ProjectConversationAgentResultCommand,
  type ProjectedConversationAgentResult
} from '../../conversation/ConversationAuthority.js';
import {
  assertValidConversationRunHandoffSaga,
  fingerprintConversationRunHandoffCommand,
  transitionConversationRunHandoff,
  type ConversationRunHandoffTransition,
  type ProjectAgentResultCommand
} from '../../conversation/ConversationRunHandoffSaga.js';
import type {
  CommittedConversationAuthorityCommand,
  ConversationAuthorityTransaction,
  ConversationAuthorityUnitOfWork
} from '../ports/ConversationAuthorityPersistence.js';

export interface ProjectConversationAgentResultInput {
  readonly kind: 'conversation.project_agent_result';
  readonly commandId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly expectedSessionVersion: number;
  readonly messageId: string;
  readonly expectedMessageVersion: null;
  /** Already resolved and policy-safe assistant text; only Message authority persists it. */
  readonly assistantContent: string;
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
  readonly resultStatus: 'completed' | 'failed' | 'cancelled';
  readonly sourceRunEventId: string;
  readonly occurredAt: string;
}

export interface ProjectConversationAgentResultResult
extends Omit<ProjectedConversationAgentResult, 'event'>,
Omit<ConversationRunHandoffTransition, 'event'> {
  readonly authorityEvent: ProjectedConversationAgentResult['event'];
  readonly handoffEvent: ConversationRunHandoffTransition['event'];
  readonly receipt: Extract<
    ConversationAuthorityCommandReceipt,
    { readonly kind: 'conversation.project_agent_result' }
  >;
  readonly replayed: boolean;
}

/**
 * Sole internal command path that turns one exact terminal Agent result into
 * an assistant Message and completes its Handoff Saga in the same Conversation
 * authority transaction. It intentionally performs no Agent payload lookup.
 */
export class ConversationAgentResultProjectionService {
  public constructor(private readonly unitOfWork: ConversationAuthorityUnitOfWork) {}

  public async project(
    input: ProjectConversationAgentResultInput
  ): Promise<ProjectConversationAgentResultResult> {
    const snapshot = snapshotProjectConversationAgentResultInput(input);
    const contentDigest = await digestConversationMessageContent(
      snapshot.assistantContent
    );
    const command = createAuthorityCommand(snapshot, contentDigest);
    const commandFingerprint = await fingerprintConversationAuthorityCommand(command);
    const handoffCommand = createHandoffCommand(command);
    const handoffFingerprint = await fingerprintConversationRunHandoffCommand(
      handoffCommand
    );

    return this.unitOfWork.authorityTransaction(async (transaction) => {
      const committed = await transaction.loadCommittedAuthorityCommand(command.commandId);
      if (committed !== null) {
        assertExactCommittedAuthorityCommand(
          committed,
          commandFingerprint,
          command.kind
        );
        return replayProjectedAgentResult(
          transaction,
          committed,
          command,
          snapshot.assistantContent,
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
      const [currentSession, currentSaga] = await Promise.all([
        transaction.loadSession(command.sessionId),
        transaction.loadSaga(command.sagaId)
      ]);
      const projected = projectConversationAgentResult(
        currentSession,
        command,
        snapshot.assistantContent
      );
      const handoff = transitionConversationRunHandoff(
        currentSaga,
        handoffCommand,
        handoffFingerprint
      );
      const receipt = createConversationAuthorityReceipt(
        command,
        commandFingerprint,
        projected.session.version
      ) as ProjectConversationAgentResultResult['receipt'];
      await transaction.commitProjectedAgentResult({
        receipt,
        expectedSessionVersion: command.expectedSessionVersion,
        ...projected,
        handoff: {
          commandId: handoffCommand.commandId,
          commandFingerprint: handoffFingerprint,
          sagaId: handoffCommand.sagaId,
          expectedVersion: handoffCommand.expectedVersion,
          resultingVersion: handoff.saga.version,
          ...handoff
        }
      });
      return {
        session: projected.session,
        messageHead: projected.messageHead,
        messageVersion: projected.messageVersion,
        authorityEvent: projected.event,
        saga: handoff.saga,
        handoffEvent: handoff.event,
        outbox: handoff.outbox,
        receipt,
        replayed: false
      };
    });
  }
}

function createAuthorityCommand(
  input: ProjectConversationAgentResultInput,
  contentDigest: string
): ProjectConversationAgentResultCommand {
  const command: ProjectConversationAgentResultCommand = {
    kind: input.kind,
    commandId: input.commandId,
    eventId: input.eventId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    expectedSessionVersion: input.expectedSessionVersion,
    messageId: input.messageId,
    expectedMessageVersion: input.expectedMessageVersion,
    contentDigest,
    sagaId: input.sagaId,
    expectedSagaVersion: input.expectedSagaVersion,
    handoffCommandId: input.handoffCommandId,
    handoffInboxEventId: input.handoffInboxEventId,
    handoffOutboxMessageId: input.handoffOutboxMessageId,
    objectiveMessageId: input.objectiveMessageId,
    objectiveMessageVersion: input.objectiveMessageVersion,
    objectiveDigest: input.objectiveDigest,
    runRequestId: input.runRequestId,
    agentCommandId: input.agentCommandId,
    runId: input.runId,
    admittedRunVersion: input.admittedRunVersion,
    resultRunVersion: input.resultRunVersion,
    resultStatus: input.resultStatus,
    sourceRunEventId: input.sourceRunEventId,
    occurredAt: input.occurredAt
  };
  assertProjectConversationAgentResultCommand(command);
  return command;
}

function createHandoffCommand(
  command: ProjectConversationAgentResultCommand
): ProjectAgentResultCommand {
  return {
    kind: 'handoff.project_agent_result',
    sagaId: command.sagaId,
    commandId: command.handoffCommandId,
    expectedVersion: command.expectedSagaVersion,
    inboxEventId: command.handoffInboxEventId,
    outboxMessageId: command.handoffOutboxMessageId,
    occurredAt: command.occurredAt,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    messageId: command.objectiveMessageId,
    messageVersion: command.objectiveMessageVersion,
    objectiveDigest: command.objectiveDigest,
    runRequestId: command.runRequestId,
    agentCommandId: command.agentCommandId,
    runId: command.runId,
    admittedRunVersion: command.admittedRunVersion,
    resultRunVersion: command.resultRunVersion,
    resultStatus: command.resultStatus,
    sourceRunEventId: command.sourceRunEventId
  };
}

function snapshotProjectConversationAgentResultInput(
  input: ProjectConversationAgentResultInput
): ProjectConversationAgentResultInput {
  assertExactInputShape(input);
  const snapshot: ProjectConversationAgentResultInput = {
    kind: input.kind,
    commandId: input.commandId,
    eventId: input.eventId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    expectedSessionVersion: input.expectedSessionVersion,
    messageId: input.messageId,
    expectedMessageVersion: input.expectedMessageVersion,
    assistantContent: input.assistantContent,
    sagaId: input.sagaId,
    expectedSagaVersion: input.expectedSagaVersion,
    handoffCommandId: input.handoffCommandId,
    handoffInboxEventId: input.handoffInboxEventId,
    handoffOutboxMessageId: input.handoffOutboxMessageId,
    objectiveMessageId: input.objectiveMessageId,
    objectiveMessageVersion: input.objectiveMessageVersion,
    objectiveDigest: input.objectiveDigest,
    runRequestId: input.runRequestId,
    agentCommandId: input.agentCommandId,
    runId: input.runId,
    admittedRunVersion: input.admittedRunVersion,
    resultRunVersion: input.resultRunVersion,
    resultStatus: input.resultStatus,
    sourceRunEventId: input.sourceRunEventId,
    occurredAt: input.occurredAt
  };
  if (
    typeof snapshot.assistantContent !== 'string'
    || snapshot.assistantContent.length === 0
    || snapshot.assistantContent.length > 1_048_576
  ) {
    throw new ConversationAuthorityError(
      'CONVERSATION_INVARIANT',
      'Assistant result content must contain 1..1048576 code units.'
    );
  }
  createAuthorityCommand(snapshot, `sha256:${'0'.repeat(64)}`);
  return snapshot;
}

function assertExactInputShape(input: ProjectConversationAgentResultInput): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConversationAuthorityError(
      'CONVERSATION_INVARIANT',
      'Project Agent result input must be a plain object.'
    );
  }
  const prototype = Object.getPrototypeOf(input);
  const expected = [
    'kind',
    'commandId',
    'eventId',
    'sessionId',
    'workspaceId',
    'expectedSessionVersion',
    'messageId',
    'expectedMessageVersion',
    'assistantContent',
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
  ];
  const keys = Object.keys(input);
  const allowed = new Set(expected);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || keys.length !== expected.length
    || keys.some((key) => !allowed.has(key))
    || expected.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
    || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor === undefined
        || descriptor.get !== undefined
        || descriptor.set !== undefined;
    })
  ) {
    throw new ConversationAuthorityError(
      'CONVERSATION_INVARIANT',
      'Project Agent result input has an unexpected shape.'
    );
  }
}

function assertExactCommittedAuthorityCommand(
  committed: CommittedConversationAuthorityCommand,
  expectedFingerprint: string,
  expectedKind: ConversationAuthorityCommandReceipt['kind']
): void {
  try {
    assertValidConversationAuthorityReceipt(committed.receipt);
    assertValidConversationAuthorityEvent(committed.event);
  } catch (error) {
    throw storageCorruption('Committed Agent result authority command is invalid.', error);
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

async function replayProjectedAgentResult(
  transaction: ConversationAuthorityTransaction,
  committed: CommittedConversationAuthorityCommand,
  command: ProjectConversationAgentResultCommand,
  assistantContent: string,
  handoffCommand: ProjectAgentResultCommand,
  handoffFingerprint: string
): Promise<ProjectConversationAgentResultResult> {
  const receipt = committed.receipt;
  const event = committed.event;
  if (
    receipt.kind !== 'conversation.project_agent_result'
    || event.type !== 'conversation.agent_result.projected'
    || receipt.commandId !== command.commandId
    || receipt.eventId !== command.eventId
    || receipt.sessionId !== command.sessionId
    || receipt.workspaceId !== command.workspaceId
    || receipt.messageId !== command.messageId
    || receipt.messageVersion !== 1
    || receipt.sagaId !== command.sagaId
    || receipt.sagaVersion !== command.expectedSagaVersion + 1
    || receipt.handoffCommandId !== command.handoffCommandId
    || receipt.handoffInboxEventId !== command.handoffInboxEventId
    || receipt.handoffOutboxMessageId !== command.handoffOutboxMessageId
    || receipt.runId !== command.runId
    || receipt.resultRunVersion !== command.resultRunVersion
    || receipt.resultStatus !== command.resultStatus
    || receipt.sourceRunEventId !== command.sourceRunEventId
    || receipt.committedAt !== command.occurredAt
    || event.eventId !== receipt.eventId
    || event.commandId !== receipt.commandId
    || event.sessionId !== receipt.sessionId
    || event.workspaceId !== receipt.workspaceId
    || event.sessionVersion !== receipt.resultingSessionVersion
    || event.messageId !== receipt.messageId
    || event.messageVersion !== receipt.messageVersion
    || event.contentDigest !== command.contentDigest
    || event.sagaId !== receipt.sagaId
    || event.sagaVersion !== receipt.sagaVersion
    || event.runId !== receipt.runId
    || event.resultRunVersion !== receipt.resultRunVersion
    || event.resultStatus !== receipt.resultStatus
    || event.sourceRunEventId !== receipt.sourceRunEventId
    || event.occurredAt !== receipt.committedAt
  ) throw storageCorruption('Projected Agent result receipt and event binding differs.');

  const [currentSession, exactSession, messageHead, messageVersion, committedHandoff] = await Promise.all([
    transaction.loadSession(receipt.sessionId),
    transaction.loadSessionVersion(receipt.sessionId, receipt.resultingSessionVersion),
    transaction.loadMessageHead(receipt.messageId),
    transaction.loadMessageVersion(receipt.messageId, receipt.messageVersion),
    transaction.loadCommittedCommand(receipt.handoffCommandId)
  ]);
  if (
    currentSession === null
    || exactSession === null
    || messageHead === null
    || messageVersion === null
    || committedHandoff === null
  ) throw storageCorruption('Projected Agent result replay artifacts are incomplete.');
  try {
    assertValidConversationMessageVersion(messageVersion);
    assertValidConversationRunHandoffSaga(committedHandoff.saga);
  } catch (error) {
    throw storageCorruption('Projected Agent result replay artifacts are invalid.', error);
  }
  const step = committedHandoff.saga.processedSteps[receipt.sagaVersion - 1];
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
    || messageVersion.role !== 'assistant'
    || messageVersion.sessionId !== receipt.sessionId
    || messageVersion.workspaceId !== receipt.workspaceId
    || messageVersion.payload.content !== assistantContent
    || messageVersion.contentDigest !== command.contentDigest
    || messageVersion.createdAt !== receipt.committedAt
    || committedHandoff.commandFingerprint !== handoffFingerprint
    || committedHandoff.sagaId !== receipt.sagaId
    || committedHandoff.resultingVersion !== receipt.sagaVersion
    || committedHandoff.saga.stage.kind !== 'agent_result_projected'
    || committedHandoff.saga.stage.runId !== receipt.runId
    || committedHandoff.saga.stage.resultRunVersion !== receipt.resultRunVersion
    || committedHandoff.saga.stage.resultStatus !== receipt.resultStatus
    || committedHandoff.saga.stage.sourceRunEventId !== receipt.sourceRunEventId
    || step?.commandId !== receipt.handoffCommandId
    || step.inboxEventId !== receipt.handoffInboxEventId
    || step.outboxMessageId !== receipt.handoffOutboxMessageId
  ) throw storageCorruption('Projected Agent result replay artifacts differ from the command.');

  return {
    session: exactSession,
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
    saga: committedHandoff.saga,
    handoffEvent: committedHandoff.event,
    outbox: committedHandoff.outbox,
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
