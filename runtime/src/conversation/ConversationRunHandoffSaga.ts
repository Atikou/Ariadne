export type ConversationRunResultStatus = 'completed' | 'failed' | 'cancelled';

export interface ConversationHandoffProcessedStep {
  readonly commandId: string;
  readonly inboxEventId: string;
  readonly outboxMessageId: string;
  readonly fingerprint: string;
  readonly resultingVersion: number;
}

interface ConversationHandoffIdentity {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly messageVersion: number;
  readonly objectiveDigest: string;
}

export type ConversationRunHandoffStage =
  | {
      readonly kind: 'message_accepted';
      readonly acceptedAt: string;
    }
  | {
      readonly kind: 'agent_run_requested';
      readonly acceptedAt: string;
      readonly runRequestId: string;
      readonly agentCommandId: string;
      readonly requestedAt: string;
    }
  | {
      readonly kind: 'agent_start_failed';
      readonly acceptedAt: string;
      readonly runRequestId: string;
      readonly agentCommandId: string;
      readonly requestedAt: string;
      readonly failureCode: string;
      readonly failedAt: string;
    }
  | {
      readonly kind: 'agent_run_linked';
      readonly acceptedAt: string;
      readonly runRequestId: string;
      readonly agentCommandId: string;
      readonly requestedAt: string;
      readonly runId: string;
      readonly admittedRunVersion: number;
      readonly linkedAt: string;
    }
  | {
      readonly kind: 'agent_result_projected';
      readonly acceptedAt: string;
      readonly runRequestId: string;
      readonly agentCommandId: string;
      readonly requestedAt: string;
      readonly runId: string;
      readonly admittedRunVersion: number;
      readonly linkedAt: string;
      readonly resultRunVersion: number;
      readonly resultStatus: ConversationRunResultStatus;
      readonly sourceRunEventId: string;
      readonly projectedAt: string;
    };

export interface ConversationRunHandoffSaga extends ConversationHandoffIdentity {
  readonly sagaId: string;
  readonly version: number;
  readonly stage: ConversationRunHandoffStage;
  readonly processedSteps: readonly ConversationHandoffProcessedStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ConversationHandoffCommandBase {
  readonly sagaId: string;
  readonly commandId: string;
  readonly expectedVersion: number | null;
  readonly inboxEventId: string;
  readonly outboxMessageId: string;
  readonly occurredAt: string;
}

export interface AcceptConversationMessageCommand
extends ConversationHandoffCommandBase, ConversationHandoffIdentity {
  readonly kind: 'handoff.accept_message';
  readonly expectedVersion: null;
}

export interface RequestAgentRunCommand
extends ConversationHandoffCommandBase, ConversationHandoffIdentity {
  readonly kind: 'handoff.request_agent_run';
  readonly expectedVersion: number;
  readonly runRequestId: string;
  readonly agentCommandId: string;
}

export interface LinkAgentRunCommand
extends ConversationHandoffCommandBase, ConversationHandoffIdentity {
  readonly kind: 'handoff.link_agent_run';
  readonly expectedVersion: number;
  readonly runRequestId: string;
  readonly agentCommandId: string;
  readonly runId: string;
  readonly admittedRunVersion: number;
}

export interface FailAgentStartCommand
extends ConversationHandoffCommandBase, ConversationHandoffIdentity {
  readonly kind: 'handoff.fail_agent_start';
  readonly expectedVersion: number;
  readonly runRequestId: string;
  readonly agentCommandId: string;
  readonly failureCode: string;
}

export interface ProjectAgentResultCommand
extends ConversationHandoffCommandBase, ConversationHandoffIdentity {
  readonly kind: 'handoff.project_agent_result';
  readonly expectedVersion: number;
  readonly runRequestId: string;
  readonly agentCommandId: string;
  readonly runId: string;
  readonly admittedRunVersion: number;
  readonly resultRunVersion: number;
  readonly resultStatus: ConversationRunResultStatus;
  readonly sourceRunEventId: string;
}

export type ConversationRunHandoffCommand =
  | AcceptConversationMessageCommand
  | RequestAgentRunCommand
  | FailAgentStartCommand
  | LinkAgentRunCommand
  | ProjectAgentResultCommand;

export type ConversationRunHandoffEvent =
  | { readonly type: 'handoff.message_accepted'; readonly sagaVersion: number }
  | {
      readonly type: 'handoff.agent_run_requested';
      readonly sagaVersion: number;
      readonly runRequestId: string;
      readonly agentCommandId: string;
    }
  | {
      readonly type: 'handoff.agent_run_linked';
      readonly sagaVersion: number;
      readonly runRequestId: string;
      readonly runId: string;
      readonly admittedRunVersion: number;
    }
  | {
      readonly type: 'handoff.agent_start_failed';
      readonly sagaVersion: number;
      readonly runRequestId: string;
      readonly failureCode: string;
    }
  | {
      readonly type: 'handoff.agent_result_projected';
      readonly sagaVersion: number;
      readonly runId: string;
      readonly resultRunVersion: number;
      readonly resultStatus: ConversationRunResultStatus;
      readonly sourceRunEventId: string;
    };

export type ConversationRunHandoffOutboxMessage =
  | {
      readonly messageId: string;
      readonly kind: 'conversation.message.accepted';
      readonly sagaId: string;
      readonly sagaVersion: number;
      readonly sessionId: string;
      readonly messageIdRef: string;
      readonly messageVersion: number;
      readonly objectiveDigest: string;
      readonly causationId: string;
      readonly occurredAt: string;
    }
  | {
      readonly messageId: string;
      readonly kind: 'agent.run.requested';
      readonly sagaId: string;
      readonly sagaVersion: number;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly objectiveMessageId: string;
      readonly objectiveMessageVersion: number;
      readonly objectiveDigest: string;
      readonly runRequestId: string;
      readonly agentCommandId: string;
      readonly causationId: string;
      readonly occurredAt: string;
    }
  | {
      readonly messageId: string;
      readonly kind: 'conversation.agent_run.linked';
      readonly sagaId: string;
      readonly sagaVersion: number;
      readonly sessionId: string;
      readonly objectiveMessageId: string;
      readonly runRequestId: string;
      readonly runId: string;
      readonly admittedRunVersion: number;
      readonly causationId: string;
      readonly occurredAt: string;
    }
  | {
      readonly messageId: string;
      readonly kind: 'conversation.agent_start.failed';
      readonly sagaId: string;
      readonly sagaVersion: number;
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly objectiveMessageId: string;
      readonly objectiveMessageVersion: number;
      readonly objectiveDigest: string;
      readonly runRequestId: string;
      readonly agentCommandId: string;
      readonly failureCode: string;
      readonly causationId: string;
      readonly occurredAt: string;
    }
  | {
      readonly messageId: string;
      readonly kind: 'conversation.agent_result.projected';
      readonly sagaId: string;
      readonly sagaVersion: number;
      readonly sessionId: string;
      readonly objectiveMessageId: string;
      readonly runId: string;
      readonly resultRunVersion: number;
      readonly resultStatus: ConversationRunResultStatus;
      readonly sourceRunEventId: string;
      readonly causationId: string;
      readonly occurredAt: string;
    };

export interface ConversationRunHandoffTransition {
  readonly saga: ConversationRunHandoffSaga;
  readonly event: ConversationRunHandoffEvent;
  readonly outbox: ConversationRunHandoffOutboxMessage;
}

export class ConversationRunHandoffError extends Error {
  public constructor(
    public readonly code:
      | 'HANDOFF_INVARIANT'
      | 'HANDOFF_ALREADY_EXISTS'
      | 'HANDOFF_NOT_FOUND'
      | 'HANDOFF_VERSION_CONFLICT'
      | 'HANDOFF_COMMAND_CONFLICT'
      | 'HANDOFF_INVALID_TRANSITION',
    message: string
  ) {
    super(message);
    this.name = 'ConversationRunHandoffError';
  }
}

export function transitionConversationRunHandoff(
  current: ConversationRunHandoffSaga | null,
  command: ConversationRunHandoffCommand,
  fingerprint: string
): ConversationRunHandoffTransition {
  assertValidConversationRunHandoffCommand(command);
  assertDigest(fingerprint, 'command fingerprint');
  if (current === null) {
    if (command.kind !== 'handoff.accept_message') {
      throw new ConversationRunHandoffError(
        'HANDOFF_NOT_FOUND',
        `Handoff saga "${command.sagaId}" does not exist.`
      );
    }
    const saga = createAcceptedSaga(command, fingerprint);
    return { saga, ...projectConversationRunHandoffArtifacts(saga) };
  }

  assertValidConversationRunHandoffSaga(current);
  if (command.kind === 'handoff.accept_message') {
    throw new ConversationRunHandoffError(
      'HANDOFF_ALREADY_EXISTS',
      `Handoff saga "${command.sagaId}" already exists.`
    );
  }
  if (command.sagaId !== current.sagaId) {
    throw invariant('Command saga identity differs from the loaded aggregate.');
  }
  if (command.expectedVersion !== current.version) {
    throw new ConversationRunHandoffError(
      'HANDOFF_VERSION_CONFLICT',
      `Expected saga version ${String(command.expectedVersion)}, found ${String(current.version)}.`
    );
  }
  assertExactConversationIdentity(current, command);
  assertStepIdentitiesUnused(current, command);
  if (Date.parse(command.occurredAt) < Date.parse(current.updatedAt)) {
    throw invariant('Handoff commands cannot move backwards in time.');
  }

  switch (command.kind) {
    case 'handoff.request_agent_run':
      return requestAgentRun(current, command, fingerprint);
    case 'handoff.fail_agent_start':
      return failAgentStart(current, command, fingerprint);
    case 'handoff.link_agent_run':
      return linkAgentRun(current, command, fingerprint);
    case 'handoff.project_agent_result':
      return projectAgentResult(current, command, fingerprint);
  }
}

export function assertValidConversationRunHandoffSaga(
  saga: ConversationRunHandoffSaga
): void {
  assertExactObjectKeys(saga, [
    'sagaId',
    'version',
    'sessionId',
    'workspaceId',
    'messageId',
    'messageVersion',
    'objectiveDigest',
    'stage',
    'processedSteps',
    'createdAt',
    'updatedAt'
  ], 'saga');
  assertCanonicalId(saga.sagaId, 'saga.sagaId');
  assertSafePositiveInteger(saga.version, 'saga.version');
  assertConversationIdentity(saga);
  assertTimestamp(saga.createdAt, 'saga.createdAt');
  assertTimestamp(saga.updatedAt, 'saga.updatedAt');
  if (Date.parse(saga.updatedAt) < Date.parse(saga.createdAt)) {
    throw invariant('Saga updatedAt cannot precede createdAt.');
  }
  if (
    saga.createdAt !== saga.stage.acceptedAt
    || saga.updatedAt !== stageUpdatedAt(saga.stage)
  ) {
    throw invariant('Saga timestamps must exactly match its durable stage boundaries.');
  }
  if (!Array.isArray(saga.processedSteps) || saga.processedSteps.length !== saga.version) {
    throw invariant('Saga processed steps must exactly match its version.');
  }
  const commandIds = new Set<string>();
  const inboxIds = new Set<string>();
  const outboxIds = new Set<string>();
  saga.processedSteps.forEach((step, index) => {
    assertExactObjectKeys(step, [
      'commandId',
      'inboxEventId',
      'outboxMessageId',
      'fingerprint',
      'resultingVersion'
    ], `saga.processedSteps[${String(index)}]`);
    assertCanonicalId(step.commandId, `saga.processedSteps[${String(index)}].commandId`);
    assertCanonicalId(step.inboxEventId, `saga.processedSteps[${String(index)}].inboxEventId`);
    assertCanonicalId(step.outboxMessageId, `saga.processedSteps[${String(index)}].outboxMessageId`);
    assertDigest(step.fingerprint, `saga.processedSteps[${String(index)}].fingerprint`);
    if (step.resultingVersion !== index + 1) {
      throw invariant('Saga processed step versions must be contiguous.');
    }
    if (
      commandIds.has(step.commandId)
      || inboxIds.has(step.inboxEventId)
      || outboxIds.has(step.outboxMessageId)
    ) {
      throw invariant('Saga command, inbox, and outbox identities must be unique.');
    }
    commandIds.add(step.commandId);
    inboxIds.add(step.inboxEventId);
    outboxIds.add(step.outboxMessageId);
  });
  assertValidStage(saga.stage, saga.version);
}

export async function fingerprintConversationRunHandoffCommand(
  command: ConversationRunHandoffCommand
): Promise<string> {
  assertValidConversationRunHandoffCommand(command);
  const canonical = canonicalize(command);
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw invariant('Handoff command identity requires the Web Crypto API.');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Sole pure mapping from one committed Saga version to its event and outbox. */
export function projectConversationRunHandoffArtifacts(
  saga: ConversationRunHandoffSaga
): Pick<ConversationRunHandoffTransition, 'event' | 'outbox'> {
  assertValidConversationRunHandoffSaga(saga);
  const step = saga.processedSteps[saga.version - 1];
  if (step === undefined) throw invariant('Saga artifact step is missing.');
  const common = {
    messageId: step.outboxMessageId,
    sagaId: saga.sagaId,
    sagaVersion: saga.version,
    sessionId: saga.sessionId,
    causationId: step.inboxEventId,
    occurredAt: saga.updatedAt
  };
  switch (saga.stage.kind) {
    case 'message_accepted':
      return {
        event: { type: 'handoff.message_accepted', sagaVersion: saga.version },
        outbox: {
          ...common,
          kind: 'conversation.message.accepted',
          messageIdRef: saga.messageId,
          messageVersion: saga.messageVersion,
          objectiveDigest: saga.objectiveDigest
        }
      };
    case 'agent_run_requested':
      return {
        event: {
          type: 'handoff.agent_run_requested',
          sagaVersion: saga.version,
          runRequestId: saga.stage.runRequestId,
          agentCommandId: saga.stage.agentCommandId
        },
        outbox: {
          ...common,
          kind: 'agent.run.requested',
          workspaceId: saga.workspaceId,
          objectiveMessageId: saga.messageId,
          objectiveMessageVersion: saga.messageVersion,
          objectiveDigest: saga.objectiveDigest,
          runRequestId: saga.stage.runRequestId,
          agentCommandId: saga.stage.agentCommandId
        }
      };
    case 'agent_start_failed':
      return {
        event: {
          type: 'handoff.agent_start_failed',
          sagaVersion: saga.version,
          runRequestId: saga.stage.runRequestId,
          failureCode: saga.stage.failureCode
        },
        outbox: {
          ...common,
          kind: 'conversation.agent_start.failed',
          workspaceId: saga.workspaceId,
          objectiveMessageId: saga.messageId,
          objectiveMessageVersion: saga.messageVersion,
          objectiveDigest: saga.objectiveDigest,
          runRequestId: saga.stage.runRequestId,
          agentCommandId: saga.stage.agentCommandId,
          failureCode: saga.stage.failureCode
        }
      };
    case 'agent_run_linked':
      return {
        event: {
          type: 'handoff.agent_run_linked',
          sagaVersion: saga.version,
          runRequestId: saga.stage.runRequestId,
          runId: saga.stage.runId,
          admittedRunVersion: saga.stage.admittedRunVersion
        },
        outbox: {
          ...common,
          kind: 'conversation.agent_run.linked',
          objectiveMessageId: saga.messageId,
          runRequestId: saga.stage.runRequestId,
          runId: saga.stage.runId,
          admittedRunVersion: saga.stage.admittedRunVersion
        }
      };
    case 'agent_result_projected':
      return {
        event: {
          type: 'handoff.agent_result_projected',
          sagaVersion: saga.version,
          runId: saga.stage.runId,
          resultRunVersion: saga.stage.resultRunVersion,
          resultStatus: saga.stage.resultStatus,
          sourceRunEventId: saga.stage.sourceRunEventId
        },
        outbox: {
          ...common,
          kind: 'conversation.agent_result.projected',
          objectiveMessageId: saga.messageId,
          runId: saga.stage.runId,
          resultRunVersion: saga.stage.resultRunVersion,
          resultStatus: saga.stage.resultStatus,
          sourceRunEventId: saga.stage.sourceRunEventId
        }
      };
  }
}

function createAcceptedSaga(
  command: AcceptConversationMessageCommand,
  fingerprint: string
): ConversationRunHandoffSaga {
  const saga: ConversationRunHandoffSaga = {
    sagaId: command.sagaId,
    version: 1,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    messageId: command.messageId,
    messageVersion: command.messageVersion,
    objectiveDigest: command.objectiveDigest,
    stage: { kind: 'message_accepted', acceptedAt: command.occurredAt },
    processedSteps: [processedStep(command, fingerprint, 1)],
    createdAt: command.occurredAt,
    updatedAt: command.occurredAt
  };
  assertValidConversationRunHandoffSaga(saga);
  return saga;
}

function requestAgentRun(
  current: ConversationRunHandoffSaga,
  command: RequestAgentRunCommand,
  fingerprint: string
): ConversationRunHandoffTransition {
  if (current.stage.kind !== 'message_accepted') {
    throw invalidTransition(current, command.kind);
  }
  const saga = nextSaga(current, command, fingerprint, {
    kind: 'agent_run_requested',
    acceptedAt: current.stage.acceptedAt,
    runRequestId: command.runRequestId,
    agentCommandId: command.agentCommandId,
    requestedAt: command.occurredAt
  });
  return { saga, ...projectConversationRunHandoffArtifacts(saga) };
}

function linkAgentRun(
  current: ConversationRunHandoffSaga,
  command: LinkAgentRunCommand,
  fingerprint: string
): ConversationRunHandoffTransition {
  if (
    current.stage.kind !== 'agent_run_requested'
    || current.stage.runRequestId !== command.runRequestId
    || current.stage.agentCommandId !== command.agentCommandId
  ) {
    throw invalidTransition(current, command.kind);
  }
  const saga = nextSaga(current, command, fingerprint, {
    ...current.stage,
    kind: 'agent_run_linked',
    runId: command.runId,
    admittedRunVersion: command.admittedRunVersion,
    linkedAt: command.occurredAt
  });
  return { saga, ...projectConversationRunHandoffArtifacts(saga) };
}

function failAgentStart(
  current: ConversationRunHandoffSaga,
  command: FailAgentStartCommand,
  fingerprint: string
): ConversationRunHandoffTransition {
  if (
    current.stage.kind !== 'agent_run_requested'
    || current.stage.runRequestId !== command.runRequestId
    || current.stage.agentCommandId !== command.agentCommandId
  ) {
    throw invalidTransition(current, command.kind);
  }
  const saga = nextSaga(current, command, fingerprint, {
    ...current.stage,
    kind: 'agent_start_failed',
    failureCode: command.failureCode,
    failedAt: command.occurredAt
  });
  return { saga, ...projectConversationRunHandoffArtifacts(saga) };
}

function projectAgentResult(
  current: ConversationRunHandoffSaga,
  command: ProjectAgentResultCommand,
  fingerprint: string
): ConversationRunHandoffTransition {
  if (
    current.stage.kind !== 'agent_run_linked'
    || current.stage.runRequestId !== command.runRequestId
    || current.stage.agentCommandId !== command.agentCommandId
    || current.stage.runId !== command.runId
    || current.stage.admittedRunVersion !== command.admittedRunVersion
    || command.resultRunVersion < current.stage.admittedRunVersion
  ) {
    throw invalidTransition(current, command.kind);
  }
  const saga = nextSaga(current, command, fingerprint, {
    ...current.stage,
    kind: 'agent_result_projected',
    resultRunVersion: command.resultRunVersion,
    resultStatus: command.resultStatus,
    sourceRunEventId: command.sourceRunEventId,
    projectedAt: command.occurredAt
  });
  return { saga, ...projectConversationRunHandoffArtifacts(saga) };
}

function nextSaga(
  current: ConversationRunHandoffSaga,
  command: Exclude<ConversationRunHandoffCommand, AcceptConversationMessageCommand>,
  fingerprint: string,
  stage: ConversationRunHandoffStage
): ConversationRunHandoffSaga {
  const version = current.version + 1;
  const saga: ConversationRunHandoffSaga = {
    ...current,
    version,
    stage,
    processedSteps: [
      ...current.processedSteps,
      processedStep(command, fingerprint, version)
    ],
    updatedAt: command.occurredAt
  };
  assertValidConversationRunHandoffSaga(saga);
  return saga;
}

function processedStep(
  command: ConversationRunHandoffCommand,
  fingerprint: string,
  resultingVersion: number
): ConversationHandoffProcessedStep {
  return {
    commandId: command.commandId,
    inboxEventId: command.inboxEventId,
    outboxMessageId: command.outboxMessageId,
    fingerprint,
    resultingVersion
  };
}

export function assertValidConversationRunHandoffCommand(
  command: ConversationRunHandoffCommand
): void {
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    throw invariant('Handoff command must be an object.');
  }
  const identityKeys = [
    'kind',
    'sagaId',
    'commandId',
    'expectedVersion',
    'inboxEventId',
    'outboxMessageId',
    'occurredAt',
    'sessionId',
    'workspaceId',
    'messageId',
    'messageVersion',
    'objectiveDigest'
  ];
  switch (command.kind) {
    case 'handoff.accept_message':
      assertExactObjectKeys(command, identityKeys, 'command');
      break;
    case 'handoff.request_agent_run':
      assertExactObjectKeys(
        command,
        [...identityKeys, 'runRequestId', 'agentCommandId'],
        'command'
      );
      break;
    case 'handoff.fail_agent_start':
      assertExactObjectKeys(
        command,
        [...identityKeys, 'runRequestId', 'agentCommandId', 'failureCode'],
        'command'
      );
      break;
    case 'handoff.link_agent_run':
      assertExactObjectKeys(command, [
        ...identityKeys,
        'runRequestId',
        'agentCommandId',
        'runId',
        'admittedRunVersion'
      ], 'command');
      break;
    case 'handoff.project_agent_result':
      assertExactObjectKeys(command, [
        ...identityKeys,
        'runRequestId',
        'agentCommandId',
        'runId',
        'admittedRunVersion',
        'resultRunVersion',
        'resultStatus',
        'sourceRunEventId'
      ], 'command');
      break;
    default:
      throw invariant('Handoff command kind is invalid.');
  }
  assertCanonicalId(command.sagaId, 'command.sagaId');
  assertCanonicalId(command.commandId, 'command.commandId');
  assertCanonicalId(command.inboxEventId, 'command.inboxEventId');
  assertCanonicalId(command.outboxMessageId, 'command.outboxMessageId');
  assertTimestamp(command.occurredAt, 'command.occurredAt');
  assertConversationIdentity(command);
  if (command.expectedVersion === null) {
    if (command.kind !== 'handoff.accept_message') {
      throw invariant('Only message acceptance may use a null expected version.');
    }
  } else {
    assertSafePositiveInteger(command.expectedVersion, 'command.expectedVersion');
  }
  if (command.kind !== 'handoff.accept_message') {
    assertCanonicalId(command.runRequestId, 'command.runRequestId');
    assertCanonicalId(command.agentCommandId, 'command.agentCommandId');
  }
  if (command.kind === 'handoff.fail_agent_start') {
    assertCanonicalId(command.failureCode, 'command.failureCode');
  }
  if (
    command.kind === 'handoff.link_agent_run'
    || command.kind === 'handoff.project_agent_result'
  ) {
    assertCanonicalId(command.runId, 'command.runId');
    assertSafePositiveInteger(command.admittedRunVersion, 'command.admittedRunVersion');
  }
  if (command.kind === 'handoff.project_agent_result') {
    assertSafePositiveInteger(command.resultRunVersion, 'command.resultRunVersion');
    assertCanonicalId(command.sourceRunEventId, 'command.sourceRunEventId');
    if (!['completed', 'failed', 'cancelled'].includes(command.resultStatus)) {
      throw invariant('Agent result status must be terminal.');
    }
  }
}

function assertConversationIdentity(value: ConversationHandoffIdentity): void {
  assertCanonicalId(value.sessionId, 'handoff.sessionId');
  assertCanonicalId(value.workspaceId, 'handoff.workspaceId');
  assertCanonicalId(value.messageId, 'handoff.messageId');
  assertSafePositiveInteger(value.messageVersion, 'handoff.messageVersion');
  assertDigest(value.objectiveDigest, 'handoff.objectiveDigest');
}

function assertExactConversationIdentity(
  saga: ConversationRunHandoffSaga,
  command: ConversationHandoffIdentity
): void {
  if (
    saga.sessionId !== command.sessionId
    || saga.workspaceId !== command.workspaceId
    || saga.messageId !== command.messageId
    || saga.messageVersion !== command.messageVersion
    || saga.objectiveDigest !== command.objectiveDigest
  ) {
    throw new ConversationRunHandoffError(
      'HANDOFF_COMMAND_CONFLICT',
      'Handoff command does not match the immutable message identity.'
    );
  }
}

function assertStepIdentitiesUnused(
  saga: ConversationRunHandoffSaga,
  command: ConversationRunHandoffCommand
): void {
  if (saga.processedSteps.some((step) => (
    step.commandId === command.commandId
    || step.inboxEventId === command.inboxEventId
    || step.outboxMessageId === command.outboxMessageId
  ))) {
    throw new ConversationRunHandoffError(
      'HANDOFF_COMMAND_CONFLICT',
      'Handoff command, inbox, and outbox identities cannot be reused.'
    );
  }
}

function assertValidStage(stage: ConversationRunHandoffStage, version: number): void {
  const expectedVersion = {
    message_accepted: 1,
    agent_run_requested: 2,
    agent_start_failed: 3,
    agent_run_linked: 3,
    agent_result_projected: 4
  }[stage.kind];
  if (version !== expectedVersion) throw invariant('Saga stage and version differ.');
  const acceptedKeys = ['kind', 'acceptedAt'];
  if (stage.kind === 'message_accepted') {
    assertExactObjectKeys(stage, acceptedKeys, 'saga.stage');
  } else if (stage.kind === 'agent_run_requested') {
    assertExactObjectKeys(stage, [
      ...acceptedKeys,
      'runRequestId',
      'agentCommandId',
      'requestedAt'
    ], 'saga.stage');
  } else if (stage.kind === 'agent_start_failed') {
    assertExactObjectKeys(stage, [
      ...acceptedKeys,
      'runRequestId',
      'agentCommandId',
      'requestedAt',
      'failureCode',
      'failedAt'
    ], 'saga.stage');
  } else if (stage.kind === 'agent_run_linked') {
    assertExactObjectKeys(stage, [
      ...acceptedKeys,
      'runRequestId',
      'agentCommandId',
      'requestedAt',
      'runId',
      'admittedRunVersion',
      'linkedAt'
    ], 'saga.stage');
  } else {
    assertExactObjectKeys(stage, [
      ...acceptedKeys,
      'runRequestId',
      'agentCommandId',
      'requestedAt',
      'runId',
      'admittedRunVersion',
      'linkedAt',
      'resultRunVersion',
      'resultStatus',
      'sourceRunEventId',
      'projectedAt'
    ], 'saga.stage');
  }
  assertTimestamp(stage.acceptedAt, 'saga.stage.acceptedAt');
  if (stage.kind === 'message_accepted') return;
  assertCanonicalId(stage.runRequestId, 'saga.stage.runRequestId');
  assertCanonicalId(stage.agentCommandId, 'saga.stage.agentCommandId');
  assertTimestamp(stage.requestedAt, 'saga.stage.requestedAt');
  if (Date.parse(stage.requestedAt) < Date.parse(stage.acceptedAt)) {
    throw invariant('Agent Run request cannot precede message acceptance.');
  }
  if (stage.kind === 'agent_run_requested') return;
  if (stage.kind === 'agent_start_failed') {
    assertCanonicalId(stage.failureCode, 'saga.stage.failureCode');
    assertTimestamp(stage.failedAt, 'saga.stage.failedAt');
    if (Date.parse(stage.failedAt) < Date.parse(stage.requestedAt)) {
      throw invariant('Agent start failure cannot precede its request.');
    }
    return;
  }
  assertCanonicalId(stage.runId, 'saga.stage.runId');
  assertSafePositiveInteger(stage.admittedRunVersion, 'saga.stage.admittedRunVersion');
  assertTimestamp(stage.linkedAt, 'saga.stage.linkedAt');
  if (Date.parse(stage.linkedAt) < Date.parse(stage.requestedAt)) {
    throw invariant('Agent Run link cannot precede its request.');
  }
  if (stage.kind === 'agent_run_linked') return;
  assertSafePositiveInteger(stage.resultRunVersion, 'saga.stage.resultRunVersion');
  assertCanonicalId(stage.sourceRunEventId, 'saga.stage.sourceRunEventId');
  assertTimestamp(stage.projectedAt, 'saga.stage.projectedAt');
  if (
    stage.resultRunVersion < stage.admittedRunVersion
    || Date.parse(stage.projectedAt) < Date.parse(stage.linkedAt)
  ) {
    throw invariant('Agent result must follow the exact admitted Run boundary.');
  }
  if (!['completed', 'failed', 'cancelled'].includes(stage.resultStatus)) {
    throw invariant('Saga result status must be terminal.');
  }
}

function stageUpdatedAt(stage: ConversationRunHandoffStage): string {
  switch (stage.kind) {
    case 'message_accepted':
      return stage.acceptedAt;
    case 'agent_run_requested':
      return stage.requestedAt;
    case 'agent_start_failed':
      return stage.failedAt;
    case 'agent_run_linked':
      return stage.linkedAt;
    case 'agent_result_projected':
      return stage.projectedAt;
  }
}

function assertCanonicalId(value: string, field: string): void {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
  ) {
    throw invariant(`${field} must be a canonical public ID.`);
  }
}

function assertDigest(value: string, field: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw invariant(`${field} must be a lowercase SHA-256 digest.`);
  }
}

function assertSafePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invariant(`${field} must be a positive safe integer.`);
  }
}

function assertTimestamp(value: string, field: string): void {
  if (!isCanonicalIsoTimestamp(value)) {
    throw invariant(`${field} must be an ISO timestamp with milliseconds and offset.`);
  }
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) return false;
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  const sign = match[9] === '-' ? -1 : 1;
  const offset = match[8] === 'Z'
    ? 0
    : sign * ((offsetHour * 60) + offsetMinute) * 60_000;
  return Date.parse(value) === local.getTime() - offset;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function assertExactObjectKeys(
  value: object,
  keys: readonly string[],
  field: string
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invariant(`${field} must be a plain object.`);
  }
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  const unexpected = actual.find((key) => !allowed.has(key));
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unexpected !== undefined || missing !== undefined) {
    throw invariant(`${field} must contain exactly its declared fields.`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      throw invariant(`${field}.${key} must not use accessors.`);
    }
  }
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalize(record[key])}`
  )).join(',')}}`;
}

function invalidTransition(
  saga: ConversationRunHandoffSaga,
  commandKind: ConversationRunHandoffCommand['kind']
): ConversationRunHandoffError {
  return new ConversationRunHandoffError(
    'HANDOFF_INVALID_TRANSITION',
    `Cannot apply "${commandKind}" while saga is "${saga.stage.kind}".`
  );
}

function invariant(message: string): ConversationRunHandoffError {
  return new ConversationRunHandoffError('HANDOFF_INVARIANT', message);
}
