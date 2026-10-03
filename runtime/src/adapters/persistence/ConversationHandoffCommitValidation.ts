import {
  ConversationAuthorityError,
  assertValidConversationAuthorityEvent,
  assertValidConversationAuthorityReceipt,
  assertValidConversationMessageHead,
  assertValidConversationMessageVersion,
  assertValidConversationSession
} from '../../conversation/ConversationAuthority.js';
import {
  ConversationRunHandoffError,
  assertValidConversationRunHandoffSaga,
  projectConversationRunHandoffArtifacts,
  type ConversationRunHandoffEvent,
  type ConversationRunHandoffOutboxMessage,
  type ConversationRunHandoffSaga
} from '../../conversation/ConversationRunHandoffSaga.js';
import type {
  AcceptConversationUserMessageCommit,
  ProjectConversationAgentStartFailureCommit,
  ProjectConversationAgentResultCommit
} from '../../control/ports/ConversationAuthorityPersistence.js';
import type { ConversationRunHandoffCommit } from '../../control/ports/ConversationRunHandoffPersistence.js';
import { assertMessageContentDigest } from './conversation/rows/ConversationAuthorityRowMapper.js';
import {
  assertCanonicalId,
  assertDigest,
  authorityStorageCorruption,
  canonicalize,
  storageInvariant
} from './ConversationHandoffStorageValidation.js';

export function assertAcceptedMessageCommit(commit: AcceptConversationUserMessageCommit): void {
  try {
    assertValidConversationSession(commit.session);
    assertValidConversationMessageHead(commit.messageHead);
    assertValidConversationMessageVersion(commit.messageVersion);
    assertMessageContentDigest(commit.messageVersion, 'accept-message-commit');
    assertValidConversationAuthorityReceipt(commit.receipt);
    assertValidConversationAuthorityEvent(commit.event);
    assertCommitArtifacts(commit.handoff);
  } catch (error) {
    if (
      error instanceof ConversationAuthorityError
      || error instanceof ConversationRunHandoffError
    ) throw error;
    throw authorityStorageCorruption('accept_message_commit_invalid', error);
  }
  const saga = commit.handoff.saga;
  const step = saga.processedSteps[0];
  if (
    !Number.isSafeInteger(commit.expectedSessionVersion)
    || commit.expectedSessionVersion < 1
    || commit.session.version !== commit.expectedSessionVersion + 1
    || commit.receipt.kind !== 'conversation.accept_user_message'
    || commit.event.type !== 'conversation.user_message.accepted'
    || commit.receipt.resultingSessionVersion !== commit.session.version
    || commit.receipt.eventId !== commit.event.eventId
    || commit.receipt.sessionId !== commit.session.sessionId
    || commit.receipt.workspaceId !== commit.session.workspaceId
    || commit.receipt.messageId !== commit.messageVersion.messageId
    || commit.receipt.messageVersion !== commit.messageVersion.version
    || commit.receipt.sagaId !== saga.sagaId
    || commit.receipt.committedAt !== commit.session.updatedAt
    || commit.messageHead.messageId !== commit.messageVersion.messageId
    || commit.messageHead.sessionId !== commit.messageVersion.sessionId
    || commit.messageHead.workspaceId !== commit.messageVersion.workspaceId
    || commit.messageHead.latestVersion !== commit.messageVersion.version
    || commit.messageHead.createdAt !== commit.messageVersion.createdAt
    || commit.messageHead.updatedAt !== commit.messageVersion.createdAt
    || commit.messageVersion.version !== 1
    || commit.event.sessionVersion !== commit.session.version
    || commit.event.messageId !== commit.messageVersion.messageId
    || commit.event.messageVersion !== commit.messageVersion.version
    || commit.event.contentDigest !== commit.messageVersion.contentDigest
    || saga.version !== 1
    || saga.stage.kind !== 'message_accepted'
    || saga.sessionId !== commit.messageVersion.sessionId
    || saga.workspaceId !== commit.messageVersion.workspaceId
    || saga.messageId !== commit.messageVersion.messageId
    || saga.messageVersion !== commit.messageVersion.version
    || saga.objectiveDigest !== commit.messageVersion.contentDigest
    || saga.createdAt !== commit.messageVersion.createdAt
    || step?.inboxEventId !== commit.event.eventId
  ) throw authorityStorageCorruption('accept_message_commit_binding_invalid');
}

export function assertProjectedAssistantTerminalCommit(
  commit: ProjectConversationAgentResultCommit | ProjectConversationAgentStartFailureCommit
): void {
  if (commit.receipt.kind === 'conversation.project_agent_start_failure') {
    assertProjectedAgentStartFailureCommit(
      commit as ProjectConversationAgentStartFailureCommit
    );
    return;
  }
  assertProjectedAgentResultCommit(commit as ProjectConversationAgentResultCommit);
}

function assertProjectedAgentResultCommit(
  commit: ProjectConversationAgentResultCommit
): void {
  try {
    assertValidConversationSession(commit.session);
    assertValidConversationMessageHead(commit.messageHead);
    assertValidConversationMessageVersion(commit.messageVersion);
    assertMessageContentDigest(commit.messageVersion, 'project-agent-result-commit');
    assertValidConversationAuthorityReceipt(commit.receipt);
    assertValidConversationAuthorityEvent(commit.event);
    assertCommitArtifacts(commit.handoff);
  } catch (error) {
    if (
      error instanceof ConversationAuthorityError
      || error instanceof ConversationRunHandoffError
    ) throw error;
    throw authorityStorageCorruption('project_agent_result_commit_invalid', error);
  }
  const receipt = commit.receipt;
  const event = commit.event;
  const saga = commit.handoff.saga;
  const stage = saga.stage;
  const step = saga.processedSteps[saga.version - 1];
  if (
    !Number.isSafeInteger(commit.expectedSessionVersion)
    || commit.expectedSessionVersion < 1
    || commit.session.version !== commit.expectedSessionVersion + 1
    || receipt.kind !== 'conversation.project_agent_result'
    || event.type !== 'conversation.agent_result.projected'
    || commit.messageVersion.role !== 'assistant'
    || commit.messageVersion.version !== 1
    || commit.messageHead.messageId !== commit.messageVersion.messageId
    || commit.messageHead.sessionId !== commit.messageVersion.sessionId
    || commit.messageHead.workspaceId !== commit.messageVersion.workspaceId
    || commit.messageHead.latestVersion !== commit.messageVersion.version
    || commit.messageHead.createdAt !== commit.messageVersion.createdAt
    || commit.messageHead.updatedAt !== commit.messageVersion.createdAt
    || commit.session.sessionId !== commit.messageVersion.sessionId
    || commit.session.workspaceId !== commit.messageVersion.workspaceId
    || commit.session.updatedAt !== commit.messageVersion.createdAt
    || receipt.resultingSessionVersion !== commit.session.version
    || receipt.eventId !== event.eventId
    || receipt.sessionId !== commit.session.sessionId
    || receipt.workspaceId !== commit.session.workspaceId
    || receipt.messageId !== commit.messageVersion.messageId
    || receipt.messageVersion !== commit.messageVersion.version
    || receipt.committedAt !== commit.session.updatedAt
    || event.commandId !== receipt.commandId
    || event.sessionId !== receipt.sessionId
    || event.workspaceId !== receipt.workspaceId
    || event.sessionVersion !== receipt.resultingSessionVersion
    || event.messageId !== receipt.messageId
    || event.messageVersion !== receipt.messageVersion
    || event.contentDigest !== commit.messageVersion.contentDigest
    || event.sagaId !== receipt.sagaId
    || event.sagaVersion !== receipt.sagaVersion
    || event.runId !== receipt.runId
    || event.resultRunVersion !== receipt.resultRunVersion
    || event.resultStatus !== receipt.resultStatus
    || event.sourceRunEventId !== receipt.sourceRunEventId
    || event.occurredAt !== receipt.committedAt
    || commit.handoff.commandId !== receipt.handoffCommandId
    || commit.handoff.sagaId !== receipt.sagaId
    || commit.handoff.resultingVersion !== receipt.sagaVersion
    || commit.handoff.expectedVersion !== receipt.sagaVersion - 1
    || saga.version !== receipt.sagaVersion
    || saga.sessionId !== receipt.sessionId
    || saga.workspaceId !== receipt.workspaceId
    || stage.kind !== 'agent_result_projected'
    || stage.runId !== receipt.runId
    || stage.resultRunVersion !== receipt.resultRunVersion
    || stage.resultStatus !== receipt.resultStatus
    || stage.sourceRunEventId !== receipt.sourceRunEventId
    || step === undefined
    || step.commandId !== receipt.handoffCommandId
    || step.inboxEventId !== receipt.handoffInboxEventId
    || step.outboxMessageId !== receipt.handoffOutboxMessageId
  ) throw authorityStorageCorruption('project_agent_result_commit_binding_invalid');
}

function assertProjectedAgentStartFailureCommit(
  commit: ProjectConversationAgentStartFailureCommit
): void {
  try {
    assertValidConversationSession(commit.session);
    assertValidConversationMessageHead(commit.messageHead);
    assertValidConversationMessageVersion(commit.messageVersion);
    assertMessageContentDigest(commit.messageVersion, 'project-agent-start-failure-commit');
    assertValidConversationAuthorityReceipt(commit.receipt);
    assertValidConversationAuthorityEvent(commit.event);
    assertCommitArtifacts(commit.handoff);
  } catch (error) {
    if (error instanceof ConversationAuthorityError || error instanceof ConversationRunHandoffError) {
      throw error;
    }
    throw authorityStorageCorruption('project_agent_start_failure_commit_invalid', error);
  }
  const { receipt, event } = commit;
  const { saga } = commit.handoff;
  const stage = saga.stage;
  const step = saga.processedSteps[saga.version - 1];
  if (
    !Number.isSafeInteger(commit.expectedSessionVersion)
    || commit.expectedSessionVersion < 1
    || commit.session.version !== commit.expectedSessionVersion + 1
    || commit.messageVersion.role !== 'assistant'
    || commit.messageVersion.version !== 1
    || commit.messageHead.messageId !== commit.messageVersion.messageId
    || commit.messageHead.sessionId !== commit.messageVersion.sessionId
    || commit.messageHead.workspaceId !== commit.messageVersion.workspaceId
    || commit.session.sessionId !== commit.messageVersion.sessionId
    || commit.session.workspaceId !== commit.messageVersion.workspaceId
    || receipt.resultingSessionVersion !== commit.session.version
    || receipt.eventId !== event.eventId
    || receipt.messageId !== commit.messageVersion.messageId
    || receipt.messageVersion !== commit.messageVersion.version
    || event.type !== 'conversation.agent_start.failed'
    || event.sessionVersion !== receipt.resultingSessionVersion
    || event.messageId !== receipt.messageId
    || event.messageVersion !== receipt.messageVersion
    || event.contentDigest !== commit.messageVersion.contentDigest
    || event.sagaId !== receipt.sagaId
    || event.sagaVersion !== receipt.sagaVersion
    || event.runRequestId !== receipt.runRequestId
    || event.failureCode !== receipt.failureCode
    || commit.handoff.commandId !== receipt.handoffCommandId
    || commit.handoff.sagaId !== receipt.sagaId
    || saga.version !== receipt.sagaVersion
    || stage.kind !== 'agent_start_failed'
    || stage.runRequestId !== receipt.runRequestId
    || stage.failureCode !== receipt.failureCode
    || step?.commandId !== receipt.handoffCommandId
    || step.inboxEventId !== receipt.handoffInboxEventId
    || step.outboxMessageId !== receipt.handoffOutboxMessageId
  ) throw authorityStorageCorruption('project_agent_start_failure_commit_binding_invalid');
}

export function assertCommitArtifacts(commit: ConversationRunHandoffCommit): void {
  assertCanonicalId(commit.commandId, 'commit.commandId');
  assertDigest(commit.commandFingerprint, 'commit.commandFingerprint');
  assertCanonicalId(commit.sagaId, 'commit.sagaId');
  try {
    assertValidConversationRunHandoffSaga(commit.saga);
  } catch (error) {
    if (error instanceof ConversationRunHandoffError) throw error;
    throw storageInvariant('commit_saga_invalid', error);
  }
  if (
    commit.saga.sagaId !== commit.sagaId
    || commit.saga.version !== commit.resultingVersion
    || commit.resultingVersion !== (commit.expectedVersion === null
      ? 1
      : commit.expectedVersion + 1)
  ) {
    throw storageInvariant('commit_version_identity_invalid');
  }
  const step = commit.saga.processedSteps[commit.saga.version - 1];
  if (
    step === undefined
    || step.commandId !== commit.commandId
    || step.fingerprint !== commit.commandFingerprint
    || step.outboxMessageId !== commit.outbox.messageId
  ) {
    throw storageInvariant('commit_step_identity_invalid');
  }
  assertExpectedArtifacts(commit.saga, commit.event, commit.outbox);
}

export function assertExpectedArtifacts(
  saga: ConversationRunHandoffSaga,
  event: ConversationRunHandoffEvent,
  outbox: ConversationRunHandoffOutboxMessage
): void {
  const expected = projectConversationRunHandoffArtifacts(saga);
  if (
    canonicalize(event) !== canonicalize(expected.event)
    || canonicalize(outbox) !== canonicalize(expected.outbox)
  ) {
    throw storageInvariant(`saga:${saga.sagaId}:artifact_payload_mismatch`);
  }
}

export function assertImmutableIdentity(
  current: ConversationRunHandoffSaga,
  next: ConversationRunHandoffSaga
): void {
  if (
    current.sagaId !== next.sagaId
    || current.sessionId !== next.sessionId
    || current.workspaceId !== next.workspaceId
    || current.messageId !== next.messageId
    || current.messageVersion !== next.messageVersion
    || current.objectiveDigest !== next.objectiveDigest
    || current.createdAt !== next.createdAt
  ) {
    throw new ConversationRunHandoffError(
      'HANDOFF_COMMAND_CONFLICT',
      'Conversation handoff immutable identity changed during CAS.'
    );
  }
}
