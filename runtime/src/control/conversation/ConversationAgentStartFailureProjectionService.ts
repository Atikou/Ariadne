import {
  ConversationAuthorityError,
  assertProjectConversationAgentStartFailureCommand,
  createConversationAuthorityReceipt,
  digestConversationMessageContent,
  fingerprintConversationAuthorityCommand,
  projectConversationAgentStartFailure,
  type ProjectConversationAgentStartFailureCommand
} from '../../conversation/ConversationAuthority.js';
import {
  fingerprintConversationRunHandoffCommand,
  transitionConversationRunHandoff,
  type FailAgentStartCommand
} from '../../conversation/ConversationRunHandoffSaga.js';
import type { ConversationAuthorityUnitOfWork } from '../ports/ConversationAuthorityPersistence.js';

export interface ProjectConversationAgentStartFailureInput {
  readonly kind: 'conversation.project_agent_start_failure';
  readonly commandId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly messageId: string;
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
  readonly failureCode: string;
  readonly occurredAt: string;
}

export interface ProjectConversationAgentStartFailureResult {
  readonly sagaVersion: number;
  readonly messageId: string;
  readonly replayed: boolean;
}

/** Atomically appends a safe assistant failure and terminalizes the pre-Run handoff. */
export class ConversationAgentStartFailureProjectionService {
  public constructor(private readonly unitOfWork: ConversationAuthorityUnitOfWork) {}

  public async project(
    input: ProjectConversationAgentStartFailureInput
  ): Promise<ProjectConversationAgentStartFailureResult> {
    const contentDigest = await digestConversationMessageContent(input.assistantContent);
    const handoffCommand = failCommand(input);
    const handoffFingerprint = await fingerprintConversationRunHandoffCommand(handoffCommand);
    return this.unitOfWork.authorityTransaction(async (transaction) => {
      const committed = await transaction.loadCommittedAuthorityCommand(input.commandId);
      if (committed !== null) {
        if (
          committed.receipt.kind !== input.kind
          || committed.event.type !== 'conversation.agent_start.failed'
          || committed.receipt.messageId !== input.messageId
          || committed.receipt.sagaId !== input.sagaId
          || committed.receipt.runRequestId !== input.runRequestId
          || committed.receipt.failureCode !== input.failureCode
          || committed.event.contentDigest !== contentDigest
        ) throw new ConversationAuthorityError(
          'CONVERSATION_COMMAND_CONFLICT',
          `Conversation command "${input.commandId}" is bound to a different payload.`
        );
        return {
          sagaVersion: committed.receipt.sagaVersion,
          messageId: committed.receipt.messageId,
          replayed: true
        };
      }
      const session = await transaction.loadSession(input.sessionId);
      if (session === null) throw new ConversationAuthorityError(
        'CONVERSATION_SESSION_NOT_FOUND',
        `Conversation session "${input.sessionId}" does not exist.`
      );
      const command = authorityCommand(input, contentDigest, session.version);
      const commandFingerprint = await fingerprintConversationAuthorityCommand(command);
      if (await transaction.loadMessageHead(command.messageId) !== null) {
        throw new ConversationAuthorityError(
          'CONVERSATION_MESSAGE_ALREADY_EXISTS',
          `Conversation message "${command.messageId}" already exists.`
        );
      }
      const saga = await transaction.loadSaga(command.sagaId);
      const projected = projectConversationAgentStartFailure(
        session,
        command,
        input.assistantContent
      );
      const handoff = transitionConversationRunHandoff(
        saga,
        handoffCommand,
        handoffFingerprint
      );
      const receipt = createConversationAuthorityReceipt(
        command,
        commandFingerprint,
        projected.session.version
      );
      if (receipt.kind !== 'conversation.project_agent_start_failure') {
        throw new ConversationAuthorityError('CONVERSATION_INVARIANT', 'Unexpected receipt kind.');
      }
      await transaction.commitProjectedAgentStartFailure({
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
        sagaVersion: handoff.saga.version,
        messageId: projected.messageVersion.messageId,
        replayed: false
      };
    });
  }
}

function authorityCommand(
  input: ProjectConversationAgentStartFailureInput,
  contentDigest: string,
  expectedSessionVersion: number
): ProjectConversationAgentStartFailureCommand {
  const command: ProjectConversationAgentStartFailureCommand = {
    kind: input.kind,
    commandId: input.commandId,
    eventId: input.eventId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    expectedSessionVersion,
    messageId: input.messageId,
    expectedMessageVersion: null,
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
    failureCode: input.failureCode,
    occurredAt: input.occurredAt
  };
  assertProjectConversationAgentStartFailureCommand(command);
  return command;
}

function failCommand(input: ProjectConversationAgentStartFailureInput): FailAgentStartCommand {
  return {
    kind: 'handoff.fail_agent_start',
    sagaId: input.sagaId,
    commandId: input.handoffCommandId,
    expectedVersion: input.expectedSagaVersion,
    inboxEventId: input.handoffInboxEventId,
    outboxMessageId: input.handoffOutboxMessageId,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    messageId: input.objectiveMessageId,
    messageVersion: input.objectiveMessageVersion,
    objectiveDigest: input.objectiveDigest,
    runRequestId: input.runRequestId,
    agentCommandId: input.agentCommandId,
    failureCode: input.failureCode
  };
}
