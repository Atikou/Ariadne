import {
  assertValidAgentRun,
  type AgentRun
} from '@ariadne/agent-core';

import {
  assertValidConversationRunHandoffSaga,
  type ConversationRunHandoffSaga
} from '../conversation/ConversationRunHandoffSaga.js';
import {
  deriveConversationAuthorityId,
  deriveConversationRunHandoffStepId
} from '../conversation/ConversationRunHandoffIds.js';
import type {
  ProjectConversationAgentResultInput,
  ProjectConversationAgentResultResult
} from '../control/conversation/ConversationAgentResultProjectionService.js';
import type {
  ConversationRunHandoffLookup
} from '../control/ports/ConversationRunHandoffLookup.js';
import type {
  AgentRunTerminalResultProjectionRequest,
  AgentRunTerminalResultProjectionSink
} from '../projection/AgentRunProjectionPorts.js';
import type {
  AgentTerminalAssistantContentResolver
} from './ProtectedAgentTerminalAssistantContentResolver.js';

export interface AgentTerminalResultProjectionResult {
  readonly sagaId: string;
  readonly sagaVersion: number;
  readonly replayed: boolean;
}

export class ConversationAgentResultCoordinatorError extends Error {
  public constructor(
    public readonly code:
      | 'CONVERSATION_AGENT_RESULT_INVALID'
      | 'CONVERSATION_AGENT_RESULT_SAGA_NOT_FOUND'
      | 'CONVERSATION_AGENT_RESULT_SESSION_NOT_FOUND'
      | 'CONVERSATION_AGENT_RESULT_NOT_LINKED',
    message: string
  ) {
    super(message);
    this.name = 'ConversationAgentResultCoordinatorError';
  }
}

export interface ConversationAgentResultProjector {
  project(
    input: ProjectConversationAgentResultInput
  ): Promise<ProjectConversationAgentResultResult>;
}

/** Projects one terminal Agent fact back into its exact durable Handoff Saga. */
export class ConversationAgentResultCoordinator
implements AgentRunTerminalResultProjectionSink {
  public constructor(
    private readonly lookups: ConversationRunHandoffLookup,
    private readonly projector: ConversationAgentResultProjector,
    private readonly contentResolver: AgentTerminalAssistantContentResolver,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async projectTerminalResult(
    request: AgentRunTerminalResultProjectionRequest
  ): Promise<AgentTerminalResultProjectionResult | null> {
    assertValidAgentRun(request.run);
    assertCanonicalId(request.sourceRunEventId, 'source Run event ID');
    const terminal = terminalResult(request.run);
    if (request.occurredAt !== terminal.occurredAt) {
      throw invalid('Terminal Run event time differs from the aggregate boundary.');
    }
    const objective = request.run.binding.objectiveRef;
    if (objective.kind !== 'conversation_message') return null;
    const saga = await this.lookups.readSagaByMessage(
      objective.messageId,
      objective.messageVersion
    );
    if (saga === null) {
      throw new ConversationAgentResultCoordinatorError(
        'CONVERSATION_AGENT_RESULT_SAGA_NOT_FOUND',
        'Terminal Conversation Run has no durable Handoff Saga.'
      );
    }
    assertExactLinkedSaga(saga, request.run);
    const stage = saga.stage;
    if (stage.kind !== 'agent_run_linked' && stage.kind !== 'agent_result_projected') {
      throw new ConversationAgentResultCoordinatorError(
        'CONVERSATION_AGENT_RESULT_NOT_LINKED',
        'Terminal Conversation Run cannot project before its Handoff is linked.'
      );
    }
    const [
      commandId,
      eventId,
      assistantMessageId,
      handoffCommandId,
      handoffInboxEventId,
      handoffOutboxMessageId
    ] = await Promise.all([
      deriveConversationAuthorityId('agent-result-command', request.sourceRunEventId),
      deriveConversationAuthorityId('agent-result-event', request.sourceRunEventId),
      deriveConversationAuthorityId('agent-result-message', request.sourceRunEventId),
      deriveConversationRunHandoffStepId('result-command', request.sourceRunEventId),
      deriveConversationRunHandoffStepId('result-inbox', request.sourceRunEventId),
      deriveConversationRunHandoffStepId('result-outbox', request.sourceRunEventId)
    ]);
    const committed = await this.lookups.readCommittedAuthorityCommand(commandId);
    let expectedSessionVersion: number;
    let occurredAt: string;
    if (committed !== null) {
      if (
        committed.receipt.kind !== 'conversation.project_agent_result'
        || committed.receipt.commandId !== commandId
        || committed.receipt.resultingSessionVersion <= 1
      ) {
        throw invalid('Committed Conversation result receipt is invalid.');
      }
      expectedSessionVersion = committed.receipt.resultingSessionVersion - 1;
      occurredAt = committed.receipt.committedAt;
    } else {
      const session = await this.lookups.readSession(saga.sessionId);
      if (session === null) {
        throw new ConversationAgentResultCoordinatorError(
          'CONVERSATION_AGENT_RESULT_SESSION_NOT_FOUND',
          'Terminal Conversation Run has no durable Session authority.'
        );
      }
      if (
        session.sessionId !== saga.sessionId
        || session.workspaceId !== saga.workspaceId
      ) {
        throw invalid('Conversation Session authority differs from its Handoff Saga.');
      }
      expectedSessionVersion = session.version;
      occurredAt = resultCommitTime(
        this.now,
        request.occurredAt,
        session.updatedAt
      );
    }
    const assistantContent = await this.contentResolver
      .resolveTerminalAssistantContent(request.run);
    const result = await this.projector.project({
      kind: 'conversation.project_agent_result',
      commandId,
      eventId,
      sessionId: saga.sessionId,
      workspaceId: saga.workspaceId,
      expectedSessionVersion,
      messageId: assistantMessageId,
      expectedMessageVersion: null,
      assistantContent,
      sagaId: saga.sagaId,
      expectedSagaVersion: stage.kind === 'agent_result_projected'
        ? saga.version - 1
        : saga.version,
      handoffCommandId,
      handoffInboxEventId,
      handoffOutboxMessageId,
      objectiveMessageId: saga.messageId,
      objectiveMessageVersion: saga.messageVersion,
      objectiveDigest: saga.objectiveDigest,
      runRequestId: stage.runRequestId,
      agentCommandId: stage.agentCommandId,
      runId: stage.runId,
      admittedRunVersion: stage.admittedRunVersion,
      resultRunVersion: request.run.version,
      resultStatus: terminal.status,
      sourceRunEventId: request.sourceRunEventId,
      occurredAt
    });
    return {
      sagaId: result.saga.sagaId,
      sagaVersion: result.saga.version,
      replayed: result.replayed
    };
  }
}

function resultCommitTime(
  now: () => Date,
  terminalAt: string,
  sessionUpdatedAt: string
): string {
  const current = now();
  const currentMs = current instanceof Date ? current.getTime() : Number.NaN;
  const terminalMs = Date.parse(terminalAt);
  const sessionMs = Date.parse(sessionUpdatedAt);
  if (
    !Number.isFinite(currentMs)
    || !Number.isFinite(terminalMs)
    || !Number.isFinite(sessionMs)
  ) {
    throw invalid('Conversation result commit clock is invalid.');
  }
  return new Date(Math.max(currentMs, terminalMs, sessionMs)).toISOString();
}

function assertExactLinkedSaga(
  saga: ConversationRunHandoffSaga,
  run: AgentRun
): void {
  try {
    assertValidConversationRunHandoffSaga(saga);
  } catch (error) {
    throw invalid('Conversation Handoff Saga is invalid.', error);
  }
  const objective = run.binding.objectiveRef;
  if (
    objective.kind !== 'conversation_message'
    || saga.sessionId !== run.binding.sessionId
    || saga.workspaceId !== run.binding.workspace.workspaceId
    || saga.messageId !== objective.messageId
    || saga.messageVersion !== objective.messageVersion
    || saga.objectiveDigest !== objective.contentDigest
  ) {
    throw invalid('Terminal Run identity differs from its Conversation Handoff.');
  }
  const stage = saga.stage;
  if (
    (stage.kind === 'agent_run_linked' || stage.kind === 'agent_result_projected')
    && (
      stage.runId !== run.runId
      || stage.admittedRunVersion > run.version
    )
  ) {
    throw invalid('Terminal Run version differs from its linked Conversation Handoff.');
  }
}

function terminalResult(run: AgentRun): {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly occurredAt: string;
} {
  switch (run.state.status) {
    case 'completed':
      return { status: 'completed', occurredAt: run.state.completedAt };
    case 'failed':
      return { status: 'failed', occurredAt: run.state.failedAt };
    case 'cancelled':
      return { status: 'cancelled', occurredAt: run.state.cancelledAt };
    default:
      throw invalid('Agent result projection requires a terminal Run.');
  }
}

function assertCanonicalId(value: string, field: string): void {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
  ) {
    throw invalid(`${field} is invalid.`);
  }
}

function invalid(message: string, cause?: unknown): ConversationAgentResultCoordinatorError {
  return new ConversationAgentResultCoordinatorError(
    'CONVERSATION_AGENT_RESULT_INVALID',
    cause instanceof Error ? `${message} ${cause.message}` : message
  );
}
