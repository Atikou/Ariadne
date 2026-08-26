import {
  ConversationRunHandoffError,
  assertValidConversationRunHandoffCommand,
  fingerprintConversationRunHandoffCommand,
  transitionConversationRunHandoff,
  type ConversationRunHandoffCommand,
  type ConversationRunHandoffEvent,
  type ConversationRunHandoffOutboxMessage,
  type ConversationRunHandoffSaga
} from '../../conversation/ConversationRunHandoffSaga.js';
import type {
  ConversationRunHandoffUnitOfWork
} from '../ports/ConversationRunHandoffPersistence.js';

export type {
  CommittedConversationRunHandoffCommand,
  ConversationRunHandoffCommit,
  ConversationRunHandoffTransaction,
  ConversationRunHandoffUnitOfWork
} from '../ports/ConversationRunHandoffPersistence.js';

export interface ConversationRunHandoffCommandResult {
  readonly saga: ConversationRunHandoffSaga;
  readonly event: ConversationRunHandoffEvent;
  readonly outbox: ConversationRunHandoffOutboxMessage;
  readonly replayed: boolean;
}

/** Sole write entry for the cross-store handoff saga. */
export class ConversationRunHandoffSagaService {
  public constructor(private readonly unitOfWork: ConversationRunHandoffUnitOfWork) {}

  public async execute(
    input: ConversationRunHandoffCommand
  ): Promise<ConversationRunHandoffCommandResult> {
    const command = snapshotConversationRunHandoffCommand(input);
    const commandFingerprint = await fingerprintConversationRunHandoffCommand(command);
    return this.unitOfWork.transaction(async (transaction) => {
      const committed = await transaction.loadCommittedCommand(command.commandId);
      if (committed !== null) {
        if (
          committed.sagaId !== command.sagaId
          || committed.commandFingerprint !== commandFingerprint
        ) {
          throw new ConversationRunHandoffError(
            'HANDOFF_COMMAND_CONFLICT',
            `Command "${command.commandId}" is bound to a different handoff payload.`
          );
        }
        return {
          saga: committed.saga,
          event: committed.event,
          outbox: committed.outbox,
          replayed: true
        };
      }

      const current = await transaction.loadSaga(command.sagaId);
      const transition = transitionConversationRunHandoff(
        current,
        command,
        commandFingerprint
      );
      await transaction.commit({
        commandId: command.commandId,
        commandFingerprint,
        sagaId: command.sagaId,
        expectedVersion: command.expectedVersion,
        resultingVersion: transition.saga.version,
        saga: transition.saga,
        event: transition.event,
        outbox: transition.outbox
      });
      return { ...transition, replayed: false };
    });
  }
}

function snapshotConversationRunHandoffCommand(
  input: ConversationRunHandoffCommand
): ConversationRunHandoffCommand {
  assertValidConversationRunHandoffCommand(input);
  const identity = {
    sagaId: input.sagaId,
    commandId: input.commandId,
    expectedVersion: input.expectedVersion,
    inboxEventId: input.inboxEventId,
    outboxMessageId: input.outboxMessageId,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    messageId: input.messageId,
    messageVersion: input.messageVersion,
    objectiveDigest: input.objectiveDigest
  };
  switch (input.kind) {
    case 'handoff.accept_message':
      return { kind: input.kind, ...identity, expectedVersion: null };
    case 'handoff.request_agent_run':
      return {
        kind: input.kind,
        ...identity,
        expectedVersion: input.expectedVersion,
        runRequestId: input.runRequestId,
        agentCommandId: input.agentCommandId
      };
    case 'handoff.fail_agent_start':
      return {
        kind: input.kind,
        ...identity,
        expectedVersion: input.expectedVersion,
        runRequestId: input.runRequestId,
        agentCommandId: input.agentCommandId,
        failureCode: input.failureCode
      };
    case 'handoff.link_agent_run':
      return {
        kind: input.kind,
        ...identity,
        expectedVersion: input.expectedVersion,
        runRequestId: input.runRequestId,
        agentCommandId: input.agentCommandId,
        runId: input.runId,
        admittedRunVersion: input.admittedRunVersion
      };
    case 'handoff.project_agent_result':
      return {
        kind: input.kind,
        ...identity,
        expectedVersion: input.expectedVersion,
        runRequestId: input.runRequestId,
        agentCommandId: input.agentCommandId,
        runId: input.runId,
        admittedRunVersion: input.admittedRunVersion,
        resultRunVersion: input.resultRunVersion,
        resultStatus: input.resultStatus,
        sourceRunEventId: input.sourceRunEventId
      };
  }
}
