import {
  deriveStableAgentId
} from '@ariadne/agent-core';

import {
  assertValidConversationRunHandoffSaga,
  type ConversationRunHandoffCommand,
  type ConversationRunHandoffOutboxMessage,
  type ConversationRunHandoffSaga
} from '../conversation/ConversationRunHandoffSaga.js';
import {
  deriveConversationAuthorityId,
  deriveConversationRunHandoffStepId
} from '../conversation/ConversationRunHandoffIds.js';
import type {
  ProjectConversationAgentStartFailureInput,
  ProjectConversationAgentStartFailureResult
} from '../control/conversation/ConversationAgentStartFailureProjectionService.js';
import {
  ConversationRunHandoffSagaService,
  type ConversationRunHandoffCommandResult
} from '../control/conversation/ConversationRunHandoffSagaService.js';
import type {
  AgentRunExecutionIntent,
  AgentRunExecutionIntentReceipt,
  AgentRunExecutionStarter
} from '../control/ports/AgentRunExecutionStarter.js';
import type {
  ClaimedConversationOutboxMessage,
  ConversationRunHandoffOutboxPort
} from '../control/ports/ConversationRunHandoffOutbox.js';
import { ModelExecutionQualificationError } from '../control/ports/AgentModelInference.js';
import {
  AgentRunAdmissionController,
  AgentRunAdmissionControlError,
  deriveAgentAdmissionCommandId,
  type AgentRunAdmissionControlResult,
  type AgentRunRequestedHandoffMessage
} from '../control/run/AgentRunAdmissionController.js';
import { ProductionAgentRunAdmissionSnapshotError } from './ProductionAgentRunAdmissionSnapshotReader.js';

type AcceptedMessage = Extract<
  ConversationRunHandoffOutboxMessage,
  { readonly kind: 'conversation.message.accepted' }
>;

type LinkedMessage = Extract<
  ConversationRunHandoffOutboxMessage,
  { readonly kind: 'conversation.agent_run.linked' }
>;

type ProjectedMessage = Extract<
  ConversationRunHandoffOutboxMessage,
  { readonly kind: 'conversation.agent_result.projected' }
>;

type StartFailedMessage = Extract<ConversationRunHandoffOutboxMessage, {
  readonly kind: 'conversation.agent_start.failed';
}>;

export interface ConversationAgentStartFailureProjector {
  project(input: ProjectConversationAgentStartFailureInput):
    Promise<ProjectConversationAgentStartFailureResult>;
}

type HandoffMessage = ConversationRunHandoffOutboxMessage;

export interface ConversationAgentHandoffDispatchRequest {
  readonly claimId: string;
  readonly limit: number;
  readonly leaseMs: number;
  readonly signal?: AbortSignal;
}

export interface ConversationAgentHandoffDrainRequest {
  readonly drainId: string;
  readonly limit: number;
  readonly leaseMs: number;
  readonly signal?: AbortSignal;
}

export interface ConversationAgentHandoffDrainResult {
  readonly batches: number;
  readonly acknowledgedMessages: number;
  readonly pendingMessages: 0;
}

export interface ConversationAgentHandoffBoundary {
  readonly kind: HandoffMessage['kind'];
  readonly cursor: number;
  readonly messageId: string;
}

export interface ConversationAgentHandoffFaultInjector {
  afterAgentAdmissionBeforeLink?(
    boundary: ConversationAgentHandoffBoundary
  ): void | Promise<void>;

  afterDurableBoundaryBeforeAcknowledge?(
    boundary: ConversationAgentHandoffBoundary
  ): void | Promise<void>;
}

export interface ConversationAgentHandoffDispatchOutcome {
  readonly status: 'acknowledged';
  readonly kind: HandoffMessage['kind'];
  readonly cursor: number;
  readonly messageId: string;
  readonly downstreamReplayed: boolean;
}

export class ConversationAgentHandoffCoordinatorError extends Error {
  public constructor(
    public readonly code:
      | 'CONVERSATION_AGENT_HANDOFF_CLAIM_INVALID'
      | 'CONVERSATION_AGENT_HANDOFF_EXECUTION_STARTER_REQUIRED'
      | 'CONVERSATION_AGENT_HANDOFF_FIXED_POINT_BLOCKED'
      | 'CONVERSATION_AGENT_HANDOFF_CORRUPTION'
      | 'CONVERSATION_AGENT_HANDOFF_SOURCE_INVALID'
      | 'CONVERSATION_AGENT_HANDOFF_SAGA_NOT_FOUND'
      | 'CONVERSATION_AGENT_HANDOFF_DOWNSTREAM_INVALID',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ConversationAgentHandoffCoordinatorError';
  }
}

/**
 * Replayable cross-store coordinator. It owns no prompt, message body, or
 * mutable workflow state; durable Conversation and Agent receipts are the
 * recovery boundary.
 */
export class ConversationAgentHandoffCoordinator {
  private nextDrainGeneration = 0;

  public constructor(
    private readonly conversationOutbox: ConversationRunHandoffOutboxPort,
    private readonly handoffs: ConversationRunHandoffSagaService,
    private readonly admissions: AgentRunAdmissionController,
    private readonly executionStarter: AgentRunExecutionStarter,
    private readonly faultInjector: ConversationAgentHandoffFaultInjector = {},
    private readonly startFailures?: ConversationAgentStartFailureProjector
  ) {
    if (
      executionStarter === null
      || typeof executionStarter !== 'object'
      || typeof executionStarter.startExecutionIntent !== 'function'
    ) {
      throw new ConversationAgentHandoffCoordinatorError(
        'CONVERSATION_AGENT_HANDOFF_EXECUTION_STARTER_REQUIRED',
        'Conversation handoff requires a durable Agent execution starter.'
      );
    }
  }

  public async drainToFixedPoint(
    request: ConversationAgentHandoffDrainRequest
  ): Promise<ConversationAgentHandoffDrainResult> {
    assertDrainRequest(request);
    const signal = request.signal ?? new AbortController().signal;
    if (this.nextDrainGeneration === Number.MAX_SAFE_INTEGER) {
      throw new ConversationAgentHandoffCoordinatorError(
        'CONVERSATION_AGENT_HANDOFF_CLAIM_INVALID',
        'Conversation handoff drain generation is exhausted.'
      );
    }
    const drainGeneration = ++this.nextDrainGeneration;
    let batches = 0;
    let acknowledgedMessages = 0;
    while (true) {
      signal.throwIfAborted();
      const pending = await this.conversationOutbox.countPendingHandoffOutbox();
      signal.throwIfAborted();
      assertPendingCount(pending);
      if (pending === 0) {
        return { batches, acknowledgedMessages, pendingMessages: 0 };
      }

      const claimId = await deriveStableAgentId(
        'conversation-handoff-claim',
        request.drainId,
        String(drainGeneration),
        String(batches + 1)
      );
      const outcomes = await this.dispatch({
        claimId,
        limit: request.limit,
        leaseMs: request.leaseMs,
        signal
      });
      batches += 1;
      acknowledgedMessages += outcomes.length;

      const remaining = await this.conversationOutbox.countPendingHandoffOutbox();
      signal.throwIfAborted();
      assertPendingCount(remaining);
      if (remaining === 0) {
        return { batches, acknowledgedMessages, pendingMessages: 0 };
      }
      if (outcomes.length === 0) {
        throw new ConversationAgentHandoffCoordinatorError(
          'CONVERSATION_AGENT_HANDOFF_FIXED_POINT_BLOCKED',
          'Conversation handoff still has pending messages but no claimable work.'
        );
      }
      await Promise.resolve();
    }
  }

  public async dispatch(
    request: ConversationAgentHandoffDispatchRequest
  ): Promise<readonly ConversationAgentHandoffDispatchOutcome[]> {
    assertDispatchRequest(request);
    const signal = request.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const claimed = await this.conversationOutbox.claimPending({
      claimId: request.claimId,
      limit: request.limit,
      leaseMs: request.leaseMs
    });
    const outcomes: ConversationAgentHandoffDispatchOutcome[] = [];
    for (const entry of claimed) {
      signal.throwIfAborted();
      assertClaim(entry, request.claimId);
      const message = entry.message;
      switch (message.kind) {
        case 'conversation.message.accepted': {
          const result = await this.requestAgentRun(message, signal);
          await this.afterDurableBoundary(entry, message);
          await this.acknowledge(request.claimId, entry);
          outcomes.push(acknowledged(entry, message, result.replayed));
          break;
        }
        case 'agent.run.requested': {
          const result = await this.admitAndLinkAgentRun(message, entry, signal);
          await this.afterDurableBoundary(entry, message);
          await this.acknowledge(request.claimId, entry);
          outcomes.push(acknowledged(
            entry,
            message,
            result.replayed
          ));
          break;
        }
        case 'conversation.agent_start.failed': {
          await this.validateStartFailure(message, signal);
          await this.afterDurableBoundary(entry, message);
          await this.acknowledge(request.claimId, entry);
          outcomes.push(acknowledged(entry, message, false));
          break;
        }
        case 'conversation.agent_run.linked': {
          const receipt = await this.startLinkedAgentRun(message, signal);
          await this.afterDurableBoundary(entry, message);
          await this.acknowledge(request.claimId, entry);
          outcomes.push(acknowledged(entry, message, receipt.replayed));
          break;
        }
        case 'conversation.agent_result.projected': {
          await this.validateProjectedTerminalFact(message, signal);
          await this.afterDurableBoundary(entry, message);
          await this.acknowledge(request.claimId, entry);
          outcomes.push(acknowledged(entry, message, false));
          break;
        }
        default:
          throw corruption('Conversation outbox message kind is not declared.');
      }
    }
    return outcomes;
  }

  private async requestAgentRun(
    message: AcceptedMessage,
    signal: AbortSignal
  ): Promise<ConversationRunHandoffCommandResult> {
    assertAcceptedMessage(message);
    const saga = await this.loadSourceSaga(message.sagaId, signal);
    assertAcceptedSource(saga, message);
    const [runRequestId, commandId, inboxEventId, outboxMessageId] = await Promise.all([
      deriveConversationRunHandoffStepId('run-request', message.messageId),
      deriveConversationRunHandoffStepId('request-command', message.messageId),
      deriveConversationRunHandoffStepId('request-inbox', message.messageId),
      deriveConversationRunHandoffStepId('request-outbox', message.messageId)
    ]);
    const agentCommandId = await deriveAgentAdmissionCommandId({
      sagaId: message.sagaId,
      runRequestId,
      sessionId: message.sessionId,
      workspaceId: saga.workspaceId,
      objectiveMessageId: message.messageIdRef,
      objectiveMessageVersion: message.messageVersion,
      objectiveDigest: message.objectiveDigest
    });
    signal.throwIfAborted();
    const command: Extract<
      ConversationRunHandoffCommand,
      { readonly kind: 'handoff.request_agent_run' }
    > = {
      kind: 'handoff.request_agent_run',
      sagaId: message.sagaId,
      commandId,
      expectedVersion: message.sagaVersion,
      inboxEventId,
      outboxMessageId,
      occurredAt: message.occurredAt,
      sessionId: saga.sessionId,
      workspaceId: saga.workspaceId,
      messageId: saga.messageId,
      messageVersion: saga.messageVersion,
      objectiveDigest: saga.objectiveDigest,
      runRequestId,
      agentCommandId
    };
    return this.handoffs.execute(command);
  }

  private async admitAndLinkAgentRun(
    message: AgentRunRequestedHandoffMessage,
    entry: ClaimedConversationOutboxMessage,
    signal: AbortSignal
  ): Promise<{
    readonly replayed: boolean;
  }> {
    const saga = await this.loadSourceSaga(message.sagaId, signal);
    assertRequestedSource(saga, message);
    let admission: AgentRunAdmissionControlResult;
    try {
      admission = await this.admissions.admit(message, signal);
    } catch (error) {
      const failureCode = deterministicAdmissionFailureCode(error);
      if (failureCode === null || this.startFailures === undefined) throw error;
      const projected = await this.projectStartFailure(message, failureCode, signal);
      return { replayed: projected.replayed };
    }
    assertExactAdmission(message, admission);
    await this.faultInjector.afterAgentAdmissionBeforeLink?.({
      kind: message.kind,
      cursor: entry.cursor,
      messageId: message.messageId
    });
    signal.throwIfAborted();
    const [commandId, outboxMessageId] = await Promise.all([
      deriveConversationRunHandoffStepId('link-command', message.messageId),
      deriveConversationRunHandoffStepId('link-outbox', message.messageId)
    ]);
    const command: Extract<
      ConversationRunHandoffCommand,
      { readonly kind: 'handoff.link_agent_run' }
    > = {
      kind: 'handoff.link_agent_run',
      sagaId: message.sagaId,
      commandId,
      expectedVersion: message.sagaVersion,
      inboxEventId: admission.admissionEventId,
      outboxMessageId,
      occurredAt: message.occurredAt,
      sessionId: message.sessionId,
      workspaceId: message.workspaceId,
      messageId: message.objectiveMessageId,
      messageVersion: message.objectiveMessageVersion,
      objectiveDigest: message.objectiveDigest,
      runRequestId: message.runRequestId,
      agentCommandId: message.agentCommandId,
      runId: admission.runId,
      admittedRunVersion: admission.admittedRunVersion
    };
    const link = await this.handoffs.execute(command);
    return { replayed: admission.replayed && link.replayed };
  }

  private async projectStartFailure(
    message: AgentRunRequestedHandoffMessage,
    failureCode: string,
    signal: AbortSignal
  ): Promise<ProjectConversationAgentStartFailureResult> {
    if (this.startFailures === undefined) throw new Error('start_failure_projector_missing');
    const [commandId, eventId, assistantMessageId, handoffCommandId,
      handoffInboxEventId, handoffOutboxMessageId] = await Promise.all([
      deriveConversationAuthorityId('agent-start-failure-command', message.messageId),
      deriveConversationAuthorityId('agent-start-failure-event', message.messageId),
      deriveConversationAuthorityId('agent-start-failure-message', message.messageId),
      deriveConversationRunHandoffStepId('start-failure-command', message.messageId),
      deriveConversationRunHandoffStepId('start-failure-inbox', message.messageId),
      deriveConversationRunHandoffStepId('start-failure-outbox', message.messageId)
    ]);
    signal.throwIfAborted();
    return this.startFailures.project({
      kind: 'conversation.project_agent_start_failure',
      commandId,
      eventId,
      sessionId: message.sessionId,
      workspaceId: message.workspaceId,
      messageId: assistantMessageId,
      assistantContent: `任务无法启动（${failureCode}）。`,
      sagaId: message.sagaId,
      expectedSagaVersion: message.sagaVersion,
      handoffCommandId,
      handoffInboxEventId,
      handoffOutboxMessageId,
      objectiveMessageId: message.objectiveMessageId,
      objectiveMessageVersion: message.objectiveMessageVersion,
      objectiveDigest: message.objectiveDigest,
      runRequestId: message.runRequestId,
      agentCommandId: message.agentCommandId,
      failureCode,
      occurredAt: message.occurredAt
    });
  }

  private async startLinkedAgentRun(
    message: LinkedMessage,
    signal: AbortSignal
  ): Promise<AgentRunExecutionIntentReceipt> {
    const saga = await this.loadSourceSaga(message.sagaId, signal);
    assertLinkedSource(saga, message);
    const executionIntentId = await deriveStableAgentId(
      'agent-execution-intent',
      message.messageId,
      message.runId
    );
    const intent: AgentRunExecutionIntent = {
      kind: 'agent.execution.start',
      executionIntentId,
      sourceOutboxMessageId: message.messageId,
      sagaId: saga.sagaId,
      sessionId: saga.sessionId,
      workspaceId: saga.workspaceId,
      objectiveMessageId: saga.messageId,
      objectiveMessageVersion: saga.messageVersion,
      objectiveDigest: saga.objectiveDigest,
      runRequestId: message.runRequestId,
      runId: message.runId,
      admittedRunVersion: message.admittedRunVersion,
      occurredAt: message.occurredAt
    };
    signal.throwIfAborted();
    const receipt = await this.executionStarter.startExecutionIntent(intent, signal);
    signal.throwIfAborted();
    assertExecutionIntentReceipt(intent, receipt);
    return receipt;
  }

  private async validateProjectedTerminalFact(
    message: ProjectedMessage,
    signal: AbortSignal
  ): Promise<void> {
    const saga = await this.loadSourceSaga(message.sagaId, signal);
    assertProjectedSource(saga, message);
  }

  private async validateStartFailure(
    message: StartFailedMessage,
    signal: AbortSignal
  ): Promise<void> {
    const saga = await this.loadSourceSaga(message.sagaId, signal);
    const step = saga.processedSteps[2];
    const stage = saga.stage;
    if (
      message.kind !== 'conversation.agent_start.failed'
      || message.sagaVersion !== 3
      || saga.version !== 3
      || stage.kind !== 'agent_start_failed'
      || stage.runRequestId !== message.runRequestId
      || stage.agentCommandId !== message.agentCommandId
      || stage.failureCode !== message.failureCode
      || step?.outboxMessageId !== message.messageId
      || step.inboxEventId !== message.causationId
    ) throw corruption('Agent start failure differs from its authoritative durable saga.');
  }

  private async loadSourceSaga(
    sagaId: string,
    signal: AbortSignal
  ): Promise<ConversationRunHandoffSaga> {
    signal.throwIfAborted();
    const saga = await this.conversationOutbox.readSaga(sagaId);
    signal.throwIfAborted();
    if (saga === null) {
      throw new ConversationAgentHandoffCoordinatorError(
        'CONVERSATION_AGENT_HANDOFF_SAGA_NOT_FOUND',
        'Conversation outbox source saga does not exist.'
      );
    }
    try {
      assertValidConversationRunHandoffSaga(saga);
    } catch (error) {
      throw corruption('Conversation outbox source saga is invalid.', error);
    }
    return saga;
  }

  private async afterDurableBoundary(
    entry: ClaimedConversationOutboxMessage,
    message: HandoffMessage
  ): Promise<void> {
    await this.faultInjector.afterDurableBoundaryBeforeAcknowledge?.({
      kind: message.kind,
      cursor: entry.cursor,
      messageId: message.messageId
    });
  }

  private acknowledge(
    claimId: string,
    entry: ClaimedConversationOutboxMessage
  ): Promise<void> {
    return this.conversationOutbox.acknowledgePublished({
      claimId,
      messages: [{ cursor: entry.cursor, messageId: entry.message.messageId }]
    });
  }
}

function assertAcceptedMessage(message: AcceptedMessage): void {
  if (
    !hasExactDataKeys(message, [
      'messageId',
      'kind',
      'sagaId',
      'sagaVersion',
      'sessionId',
      'messageIdRef',
      'messageVersion',
      'objectiveDigest',
      'causationId',
      'occurredAt'
    ])
    || message.kind !== 'conversation.message.accepted'
    || message.sagaVersion !== 1
  ) {
    throw sourceInvalid('Conversation message acceptance payload is invalid.');
  }
}

function assertAcceptedSource(
  saga: ConversationRunHandoffSaga,
  message: AcceptedMessage
): void {
  const firstStep = saga.processedSteps[0];
  if (
    saga.sagaId !== message.sagaId
    || saga.sessionId !== message.sessionId
    || saga.messageId !== message.messageIdRef
    || saga.messageVersion !== message.messageVersion
    || saga.objectiveDigest !== message.objectiveDigest
    || saga.createdAt !== message.occurredAt
    || saga.stage.acceptedAt !== message.occurredAt
    || firstStep?.outboxMessageId !== message.messageId
    || firstStep.inboxEventId !== message.causationId
    || firstStep.resultingVersion !== message.sagaVersion
  ) {
    throw corruption('Conversation message acceptance differs from its durable saga.');
  }
}

function assertRequestedSource(
  saga: ConversationRunHandoffSaga,
  message: AgentRunRequestedHandoffMessage
): void {
  const requestStep = saga.processedSteps[1];
  const stage = saga.stage;
  if (
    !hasExactDataKeys(message, [
      'messageId',
      'kind',
      'sagaId',
      'sagaVersion',
      'sessionId',
      'workspaceId',
      'objectiveMessageId',
      'objectiveMessageVersion',
      'objectiveDigest',
      'runRequestId',
      'agentCommandId',
      'causationId',
      'occurredAt'
    ])
    || message.kind !== 'agent.run.requested'
    || message.sagaVersion !== 2
    || saga.sagaId !== message.sagaId
    || saga.sessionId !== message.sessionId
    || saga.workspaceId !== message.workspaceId
    || saga.messageId !== message.objectiveMessageId
    || saga.messageVersion !== message.objectiveMessageVersion
    || saga.objectiveDigest !== message.objectiveDigest
    || requestStep?.outboxMessageId !== message.messageId
    || requestStep.inboxEventId !== message.causationId
    || requestStep.resultingVersion !== message.sagaVersion
    || stage.kind === 'message_accepted'
    || stage.runRequestId !== message.runRequestId
    || stage.agentCommandId !== message.agentCommandId
    || stage.requestedAt !== message.occurredAt
  ) {
    throw corruption('Agent Run request differs from its durable saga.');
  }
}

function assertLinkedSource(
  saga: ConversationRunHandoffSaga,
  message: LinkedMessage
): void {
  const linkStep = saga.processedSteps[2];
  const stage = saga.stage;
  if (
    !hasExactDataKeys(message, [
      'messageId',
      'kind',
      'sagaId',
      'sagaVersion',
      'sessionId',
      'objectiveMessageId',
      'runRequestId',
      'runId',
      'admittedRunVersion',
      'causationId',
      'occurredAt'
    ])
    || message.kind !== 'conversation.agent_run.linked'
    || message.sagaVersion !== 3
    || saga.version < message.sagaVersion
    || saga.sagaId !== message.sagaId
    || saga.sessionId !== message.sessionId
    || saga.messageId !== message.objectiveMessageId
    || linkStep?.outboxMessageId !== message.messageId
    || linkStep.inboxEventId !== message.causationId
    || linkStep.resultingVersion !== message.sagaVersion
    || stage.kind === 'message_accepted'
    || stage.kind === 'agent_run_requested'
    || stage.kind === 'agent_start_failed'
    || stage.runRequestId !== message.runRequestId
    || stage.runId !== message.runId
    || stage.admittedRunVersion !== message.admittedRunVersion
    || stage.linkedAt !== message.occurredAt
  ) {
    throw corruption('Agent Run link differs from its authoritative durable saga.');
  }
}

function assertProjectedSource(
  saga: ConversationRunHandoffSaga,
  message: ProjectedMessage
): void {
  const projectedStep = saga.processedSteps[3];
  const stage = saga.stage;
  if (
    !hasExactDataKeys(message, [
      'messageId',
      'kind',
      'sagaId',
      'sagaVersion',
      'sessionId',
      'objectiveMessageId',
      'runId',
      'resultRunVersion',
      'resultStatus',
      'sourceRunEventId',
      'causationId',
      'occurredAt'
    ])
    || message.kind !== 'conversation.agent_result.projected'
    || message.sagaVersion !== 4
    || saga.version !== message.sagaVersion
    || saga.sagaId !== message.sagaId
    || saga.sessionId !== message.sessionId
    || saga.messageId !== message.objectiveMessageId
    || projectedStep?.outboxMessageId !== message.messageId
    || projectedStep.inboxEventId !== message.causationId
    || projectedStep.resultingVersion !== message.sagaVersion
    || stage.kind !== 'agent_result_projected'
    || stage.runId !== message.runId
    || stage.resultRunVersion !== message.resultRunVersion
    || stage.resultStatus !== message.resultStatus
    || stage.sourceRunEventId !== message.sourceRunEventId
    || stage.projectedAt !== message.occurredAt
  ) {
    throw corruption('Projected Agent result differs from its authoritative durable saga.');
  }
}

function assertExecutionIntentReceipt(
  intent: AgentRunExecutionIntent,
  receipt: AgentRunExecutionIntentReceipt
): void {
  if (
    !hasExactDataKeys(receipt, [
      'executionIntentId',
      'sourceOutboxMessageId',
      'runId',
      'admittedRunVersion',
      'replayed'
    ])
    || receipt.executionIntentId !== intent.executionIntentId
    || receipt.sourceOutboxMessageId !== intent.sourceOutboxMessageId
    || receipt.runId !== intent.runId
    || receipt.admittedRunVersion !== intent.admittedRunVersion
    || typeof receipt.replayed !== 'boolean'
  ) {
    throw new ConversationAgentHandoffCoordinatorError(
      'CONVERSATION_AGENT_HANDOFF_DOWNSTREAM_INVALID',
      'Agent execution intent receipt differs from the exact linked Run.'
    );
  }
}

function assertExactAdmission(
  message: AgentRunRequestedHandoffMessage,
  admission: AgentRunAdmissionControlResult
): void {
  const run = admission.run;
  if (
    admission.runId !== run.runId
    || admission.admittedRunVersion !== 1
    || run.version !== admission.admittedRunVersion
    || run.updatedAt !== message.occurredAt
    || run.binding.sessionId !== message.sessionId
    || run.binding.workspace.workspaceId !== message.workspaceId
    || run.binding.objectiveRef.kind !== 'conversation_message'
    || run.binding.objectiveRef.messageId !== message.objectiveMessageId
    || !isCanonicalId(admission.admissionEventId)
  ) {
    throw new ConversationAgentHandoffCoordinatorError(
      'CONVERSATION_AGENT_HANDOFF_DOWNSTREAM_INVALID',
      'Agent admission result differs from the exact Conversation request.'
    );
  }
}

function assertDispatchRequest(request: ConversationAgentHandoffDispatchRequest): void {
  const exactKeys = Object.prototype.hasOwnProperty.call(request, 'signal')
    ? ['claimId', 'limit', 'leaseMs', 'signal']
    : ['claimId', 'limit', 'leaseMs'];
  if (
    !hasExactDataKeys(request, exactKeys)
    || !isCanonicalId(request.claimId)
    || !Number.isSafeInteger(request.limit)
    || request.limit < 1
    || request.limit > 100
    || !Number.isSafeInteger(request.leaseMs)
    || request.leaseMs < 1
    || request.leaseMs > 5 * 60 * 1000
    || (request.signal !== undefined && !(request.signal instanceof AbortSignal))
  ) {
    throw new ConversationAgentHandoffCoordinatorError(
      'CONVERSATION_AGENT_HANDOFF_CLAIM_INVALID',
      'Conversation outbox dispatch claim is invalid.'
    );
  }
}

function assertDrainRequest(request: ConversationAgentHandoffDrainRequest): void {
  const exactKeys = Object.prototype.hasOwnProperty.call(request, 'signal')
    ? ['drainId', 'limit', 'leaseMs', 'signal']
    : ['drainId', 'limit', 'leaseMs'];
  if (
    !hasExactDataKeys(request, exactKeys)
    || !isCanonicalId(request.drainId)
    || !Number.isSafeInteger(request.limit)
    || request.limit < 1
    || request.limit > 100
    || !Number.isSafeInteger(request.leaseMs)
    || request.leaseMs < 1
    || request.leaseMs > 5 * 60 * 1000
    || (request.signal !== undefined && !(request.signal instanceof AbortSignal))
  ) {
    throw new ConversationAgentHandoffCoordinatorError(
      'CONVERSATION_AGENT_HANDOFF_CLAIM_INVALID',
      'Conversation outbox fixed-point drain request is invalid.'
    );
  }
}

function assertPendingCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw corruption('Conversation outbox pending count is invalid.');
  }
}

function assertClaim(
  entry: ClaimedConversationOutboxMessage,
  expectedClaimId: string
): void {
  if (
    entry.claimId !== expectedClaimId
    || !Number.isSafeInteger(entry.cursor)
    || entry.cursor < 1
    || !Number.isSafeInteger(entry.claimAttempts)
    || entry.claimAttempts < 1
    || !isCanonicalId(entry.message.messageId)
  ) {
    throw sourceInvalid('Conversation outbox claim metadata is invalid.');
  }
}

function acknowledged(
  entry: ClaimedConversationOutboxMessage,
  message: HandoffMessage,
  downstreamReplayed: boolean
): ConversationAgentHandoffDispatchOutcome {
  return {
    status: 'acknowledged',
    kind: message.kind,
    cursor: entry.cursor,
    messageId: message.messageId,
    downstreamReplayed
  };
}

function hasExactDataKeys(value: unknown, keys: readonly string[]): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value);
  const expected = new Set(keys);
  if (
    actual.length !== keys.length
    || actual.some((key) => !expected.has(key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) return false;
  return actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.get === undefined
      && descriptor.set === undefined;
  });
}

function isCanonicalId(value: string): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value.trim() === value;
}

function sourceInvalid(
  message: string,
  cause?: unknown
): ConversationAgentHandoffCoordinatorError {
  return new ConversationAgentHandoffCoordinatorError(
    'CONVERSATION_AGENT_HANDOFF_SOURCE_INVALID',
    message,
    { cause }
  );
}

function corruption(
  message: string,
  cause?: unknown
): ConversationAgentHandoffCoordinatorError {
  return new ConversationAgentHandoffCoordinatorError(
    'CONVERSATION_AGENT_HANDOFF_CORRUPTION',
    message,
    { cause }
  );
}

function deterministicAdmissionFailureCode(error: unknown): string | null {
  if (error instanceof ModelExecutionQualificationError) return error.code;
  if (error instanceof ProductionAgentRunAdmissionSnapshotError) {
    return error.code.toLowerCase();
  }
  if (
    error instanceof AgentRunAdmissionControlError
    && error.code === 'AGENT_ADMISSION_SNAPSHOT_MISMATCH'
  ) return error.code.toLowerCase();
  return null;
}
