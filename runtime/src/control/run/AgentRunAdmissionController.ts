import {
  AgentRunAdmissionService,
  assertValidAgentRun,
  assertValidAgentRunBinding,
  cloneAgentAvailableTool,
  deriveStableAgentId,
  digestAgentTurnInput,
  isCanonicalIsoTimestamp,
  summarizeAgentTurnInput,
  type AgentRun,
  type AgentRunBinding,
  type AgentRunCommandReceipt,
  type AgentRunCommandReceiptReader,
  type AgentRunRecoveryPayloadReader,
  type AgentRunUnitOfWork,
  type AgentTurnCause,
  type AgentTurnInputSnapshotV1,
  type AgentJsonValue,
  type AgentTurnInputModelData
} from '@ariadne/agent-core';

import type { ConversationRunHandoffOutboxMessage } from '../../conversation/ConversationRunHandoffSaga.js';

export type AgentRunRequestedHandoffMessage = Extract<
  ConversationRunHandoffOutboxMessage,
  { readonly kind: 'agent.run.requested' }
>;

export interface AgentRunAdmissionSnapshot {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly messageVersion: number;
  readonly objectiveDigest: string;
  readonly binding: AgentRunBinding;
  readonly input: AgentTurnInputModelData;
}

export interface AgentRunAdmissionSnapshotReader {
  readAdmissionSnapshot(
    request: AgentRunRequestedHandoffMessage,
    signal: AbortSignal
  ): Promise<AgentRunAdmissionSnapshot>;
}

/** One owner for admission writes, immutable receipts, and recovery payloads. */
export interface AgentRunAdmissionStore
extends AgentRunUnitOfWork,
AgentRunCommandReceiptReader,
AgentRunRecoveryPayloadReader {}

export interface AgentRunAdmissionControlResult {
  readonly run: AgentRun;
  readonly runId: string;
  readonly admittedRunVersion: 1;
  readonly admissionEventId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly replayed: boolean;
}

interface AdmissionIdentity {
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly providerIdempotencyKey: string;
}

interface InFlightAdmission {
  readonly fingerprint: string;
  readonly promise: Promise<AgentRunAdmissionControlResult>;
}

export class AgentRunAdmissionControlError extends Error {
  public constructor(
    public readonly code:
      | 'AGENT_ADMISSION_REQUEST_INVALID'
      | 'AGENT_ADMISSION_COMMAND_ID_MISMATCH'
      | 'AGENT_ADMISSION_SNAPSHOT_MISMATCH'
      | 'AGENT_ADMISSION_RECEIPT_CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'AgentRunAdmissionControlError';
  }
}

/**
 * Consumes one durable Conversation outbox request and performs one atomic
 * Agent admission. Exact receipt replay never rereads message/catalog inputs.
 */
export class AgentRunAdmissionController {
  private readonly admissions: AgentRunAdmissionService;
  private readonly inFlight = new Map<string, InFlightAdmission>();

  public constructor(
    private readonly store: AgentRunAdmissionStore,
    private readonly snapshots: AgentRunAdmissionSnapshotReader
  ) {
    this.admissions = new AgentRunAdmissionService(store);
  }

  public async admit(
    request: AgentRunRequestedHandoffMessage,
    signal: AbortSignal = new AbortController().signal
  ): Promise<AgentRunAdmissionControlResult> {
    assertRequest(request);
    const expectedCommandId = await deriveAgentAdmissionCommandId(request);
    if (request.agentCommandId !== expectedCommandId) {
      throw new AgentRunAdmissionControlError(
        'AGENT_ADMISSION_COMMAND_ID_MISMATCH',
        'Agent admission command identity does not match its immutable handoff request.'
      );
    }
    const fingerprint = requestFingerprint(request);
    const active = this.inFlight.get(request.agentCommandId);
    if (active !== undefined) {
      if (active.fingerprint !== fingerprint) {
        throw new AgentRunAdmissionControlError(
          'AGENT_ADMISSION_REQUEST_INVALID',
          'An in-flight admission command has a different request payload.'
        );
      }
      return active.promise;
    }
    const operation = this.admitOnce(request, signal).finally(() => {
      if (this.inFlight.get(request.agentCommandId)?.promise === operation) {
        this.inFlight.delete(request.agentCommandId);
      }
    });
    this.inFlight.set(request.agentCommandId, { fingerprint, promise: operation });
    return operation;
  }

  private async admitOnce(
    request: AgentRunRequestedHandoffMessage,
    signal: AbortSignal
  ): Promise<AgentRunAdmissionControlResult> {
    const identity = await deriveAdmissionIdentity(request);
    const receipt = await this.store.loadCommittedCommandReceipt(
      request.agentCommandId
    );
    if (receipt !== null) {
      return this.replayReceipt(request, identity, receipt);
    }

    signal.throwIfAborted();
    const snapshot = await this.snapshots.readAdmissionSnapshot(request, signal);
    signal.throwIfAborted();
    assertExactSnapshot(request, snapshot, identity.runId);
    const inputDigest = await digestAgentTurnInput(snapshot.input);
    const cause = turnCauseFromBinding(snapshot.binding);
    const turnInput = createTurnInputSnapshot(identity, snapshot, cause);
    const result = await this.admissions.admit({
      command: {
        kind: 'run.admit',
        commandId: request.agentCommandId,
        runId: identity.runId,
        occurredAt: request.occurredAt,
        binding: snapshot.binding,
        turn: {
          cause,
          turnId: identity.turnId,
          attemptId: identity.attemptId,
          providerIdempotencyKey: identity.providerIdempotencyKey,
          inputDigest,
          inputSummary: summarizeAgentTurnInput(snapshot.input)
        }
      },
      checkpoint: admissionCheckpoint(request),
      turnInput
    });
    return {
      run: result.run,
      runId: identity.runId,
      admittedRunVersion: 1,
      admissionEventId: admissionEventId(result.events),
      turnId: identity.turnId,
      attemptId: identity.attemptId,
      replayed: result.replayed
    };
  }

  private async replayReceipt(
    request: AgentRunRequestedHandoffMessage,
    identity: AdmissionIdentity,
    receipt: AgentRunCommandReceipt
  ): Promise<AgentRunAdmissionControlResult> {
    const mutation = receipt.mutations[0];
    if (receipt.mutations.length !== 1 || mutation === undefined) {
      throw receiptConflict();
    }
    const run = mutation.run;
    assertValidAgentRun(run);
    const turn = run.turns[0];
    const attempt = turn?.attempts[0];
    const expectedEventTypes = [
      'run.admitted',
      'run.state_changed',
      'turn.registered',
      'inference_attempt.registered'
    ];
    if (
      receipt.commandId !== request.agentCommandId
      || mutation.runId !== identity.runId
      || mutation.resultingVersion !== 1
      || run.runId !== identity.runId
      || run.version !== 1
      || run.createdAt !== request.occurredAt
      || run.updatedAt !== request.occurredAt
      || run.state.status !== 'running'
      || run.state.checkpointVersion !== 1
      || run.state.enteredAt !== request.occurredAt
      || run.binding.sessionId !== request.sessionId
      || run.binding.workspace.workspaceId !== request.workspaceId
      || run.binding.objectiveRef.kind !== 'conversation_message'
      || run.binding.objectiveRef.messageId !== request.objectiveMessageId
      || run.binding.objectiveRef.messageVersion !== request.objectiveMessageVersion
      || run.binding.objectiveRef.contentDigest !== request.objectiveDigest
      || run.binding.budget.runId !== identity.runId
      || run.turns.length !== 1
      || run.effects.length !== 0
      || turn?.turnId !== identity.turnId
      || turn.runId !== identity.runId
      || turn.createdAt !== request.occurredAt
      || turn.intention.expectedRunVersion !== null
      || turn.intention.checkpointVersion !== 1
      || turn.intention.cause.kind !== 'conversation_objective'
      || turn.intention.cause.messageId !== request.objectiveMessageId
      || turn.intention.cause.messageVersion !== request.objectiveMessageVersion
      || turn.intention.cause.contentDigest !== request.objectiveDigest
      || turn.attempts.length !== 1
      || attempt?.attemptId !== identity.attemptId
      || attempt.providerIdempotencyKey !== identity.providerIdempotencyKey
      || attempt.state.status !== 'intended'
      || attempt.state.intendedAt !== request.occurredAt
      || mutation.events.length !== expectedEventTypes.length
      || mutation.events.some((event, index) => (
        event.commandId !== request.agentCommandId
        || event.runId !== identity.runId
        || event.runVersion !== 1
        || event.sequence !== index + 1
        || event.occurredAt !== request.occurredAt
        || event.payload.type !== expectedEventTypes[index]
      ))
    ) {
      throw receiptConflict();
    }
    const checkpoint = await this.store.loadCheckpoint({
      runId: run.runId,
      runVersion: run.version,
      checkpointVersion: run.state.checkpointVersion,
      commandId: receipt.commandId,
      createdAt: run.updatedAt
    });
    if (!isExactAdmissionCheckpoint(checkpoint, request, run)) {
      throw receiptConflict();
    }
    const protectedInput = await this.store.loadTurnInputPayload({
      runId: run.runId,
      turnId: turn.turnId,
      inputDigest: turn.intention.inputDigest
    });
    const replay = await this.admissions.admit({
      command: {
        kind: 'run.admit',
        commandId: request.agentCommandId,
        runId: identity.runId,
        occurredAt: request.occurredAt,
        binding: run.binding,
        turn: {
          cause: turnCauseFromBinding(run.binding),
          turnId: identity.turnId,
          attemptId: identity.attemptId,
          providerIdempotencyKey: identity.providerIdempotencyKey,
          inputDigest: turn.intention.inputDigest,
          inputSummary: turn.intention.inputSummary
        }
      },
      checkpoint: checkpoint.payload,
      turnInput: protectedInput
    });
    if (!replay.replayed || replay.run.version !== 1) throw receiptConflict();
    return {
      run: replay.run,
      runId: identity.runId,
      admittedRunVersion: 1,
      admissionEventId: admissionEventId(replay.events),
      turnId: identity.turnId,
      attemptId: identity.attemptId,
      replayed: true
    };
  }
}

function turnCauseFromBinding(
  binding: AgentRunBinding
): Exclude<AgentTurnCause, { readonly kind: 'effect_results' }> {
  const objective = binding.objectiveRef;
  return objective.kind === 'conversation_message'
    ? {
        kind: 'conversation_objective',
        messageId: objective.messageId,
        messageVersion: objective.messageVersion,
        contentDigest: objective.contentDigest
      }
    : {
        kind: 'delegation_objective',
        parentRunId: objective.parentRunId,
        delegationId: objective.delegationId,
        objectiveDigest: objective.objectiveDigest
      };
}

function createTurnInputSnapshot(
  identity: AdmissionIdentity,
  snapshot: AgentRunAdmissionSnapshot,
  cause: Exclude<AgentTurnCause, { readonly kind: 'effect_results' }>
): AgentTurnInputSnapshotV1 {
  const objective = snapshot.binding.objectiveRef;
  const protectedSnapshot: AgentTurnInputSnapshotV1 = {
    format: 'ariadne.agent-turn-input',
    schemaVersion: 1,
    runId: identity.runId,
    turnId: identity.turnId,
    cause: { ...cause },
    authorityRef: objective.kind === 'conversation_message'
      ? {
          kind: 'conversation_message',
          sessionId: snapshot.binding.sessionId,
          workspaceId: snapshot.binding.workspace.workspaceId,
          messageId: objective.messageId,
          messageVersion: objective.messageVersion,
          contentDigest: objective.contentDigest
        }
      : {
          kind: 'parent_delegation',
          parentRunId: objective.parentRunId,
          delegationId: objective.delegationId,
          objectiveDigest: objective.objectiveDigest
        },
    messages: snapshot.input.messages.map((message) => message.kind === 'text'
      ? { kind: 'text', role: message.role, content: message.content }
      : {
          kind: 'effect_result',
          effectId: message.effectId,
          toolCallId: message.toolCallId,
          status: message.status,
          result: cloneJsonValue(message.result)
        }),
    availableTools: snapshot.input.availableTools.map((available, index) => (
      cloneAgentAvailableTool(available, `admission.turnInput.availableTools[${String(index)}]`)
    ))
  };
  return deepFreeze(protectedSnapshot);
}

function cloneJsonValue(value: AgentJsonValue): AgentJsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)])
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function deriveAgentAdmissionCommandId(
  request: Pick<
    AgentRunRequestedHandoffMessage,
    | 'sagaId'
    | 'runRequestId'
    | 'sessionId'
    | 'workspaceId'
    | 'objectiveMessageId'
    | 'objectiveMessageVersion'
    | 'objectiveDigest'
  >
): Promise<string> {
  return deriveStableAgentId(
    'agent-admission',
    request.sagaId,
    request.runRequestId,
    request.sessionId,
    request.workspaceId,
    request.objectiveMessageId,
    String(request.objectiveMessageVersion),
    request.objectiveDigest
  );
}

async function deriveAdmissionIdentity(
  request: AgentRunRequestedHandoffMessage
): Promise<AdmissionIdentity> {
  const [runId, turnId, attemptId, providerIdempotencyKey] = await Promise.all([
    deriveAgentAdmissionRunId(request),
    deriveStableAgentId('agent-turn', request.agentCommandId, request.runRequestId),
    deriveStableAgentId('inference-attempt', request.agentCommandId, request.runRequestId),
    deriveStableAgentId('provider-inference', request.agentCommandId, request.runRequestId)
  ]);
  return { runId, turnId, attemptId, providerIdempotencyKey };
}

/**
 * The sole production derivation for the Run identity owned by one immutable
 * Conversation handoff. Snapshot readers use this export instead of copying
 * the identity recipe.
 */
export function deriveAgentAdmissionRunId(
  request: Pick<AgentRunRequestedHandoffMessage, 'agentCommandId' | 'runRequestId'>
): Promise<string> {
  return deriveStableAgentId(
    'agent-run',
    request.agentCommandId,
    request.runRequestId
  );
}

function admissionCheckpoint(
  request: AgentRunRequestedHandoffMessage
) {
  return {
    format: 'ariadne.agent-checkpoint' as const,
    schemaVersion: 1 as const,
    engineContinuation: {
      phase: 'turn_intended',
      sagaId: request.sagaId,
      runRequestId: request.runRequestId,
      sessionId: request.sessionId,
      workspaceId: request.workspaceId,
      objectiveRef: {
        kind: 'conversation_message',
        messageId: request.objectiveMessageId,
        messageVersion: request.objectiveMessageVersion,
        contentDigest: request.objectiveDigest
      }
    },
    modelContext: null
  };
}

function isExactAdmissionCheckpoint(
  checkpoint: Awaited<ReturnType<AgentRunRecoveryPayloadReader['loadCheckpoint']>>,
  request: AgentRunRequestedHandoffMessage,
  run: AgentRun
): boolean {
  const payload = checkpoint.payload;
  const value = payload.engineContinuation;
  if (!isPlainObject(value) || !isPlainObject(value.objectiveRef)) return false;
  return checkpoint.runId === run.runId
    && checkpoint.runVersion === 1
    && checkpoint.checkpointVersion === 1
    && checkpoint.createdAt === request.occurredAt
    && hasExactDataKeys(payload, [
      'format',
      'schemaVersion',
      'engineContinuation',
      'modelContext'
    ])
    && payload.format === 'ariadne.agent-checkpoint'
    && payload.schemaVersion === 1
    && payload.modelContext === null
    && hasExactDataKeys(value, [
      'phase',
      'sagaId',
      'runRequestId',
      'sessionId',
      'workspaceId',
      'objectiveRef'
    ])
    && hasExactDataKeys(value.objectiveRef, [
      'kind',
      'messageId',
      'messageVersion',
      'contentDigest'
    ])
    && value.phase === 'turn_intended'
    && value.sagaId === request.sagaId
    && value.runRequestId === request.runRequestId
    && value.sessionId === request.sessionId
    && value.workspaceId === request.workspaceId
    && value.objectiveRef.kind === 'conversation_message'
    && value.objectiveRef.messageId === request.objectiveMessageId
    && value.objectiveRef.messageVersion === request.objectiveMessageVersion
    && value.objectiveRef.contentDigest === request.objectiveDigest;
}

function assertExactSnapshot(
  request: AgentRunRequestedHandoffMessage,
  snapshot: AgentRunAdmissionSnapshot,
  runId: string
): void {
  if (!hasExactDataKeys(snapshot, [
    'sessionId',
    'workspaceId',
    'messageId',
    'messageVersion',
    'objectiveDigest',
    'binding',
    'input'
  ])) {
    throw snapshotMismatch();
  }
  const binding = snapshot.binding;
  try {
    assertValidAgentRunBinding(binding);
  } catch {
    throw snapshotMismatch();
  }
  if (
    snapshot.sessionId !== request.sessionId
    || snapshot.workspaceId !== request.workspaceId
    || snapshot.messageId !== request.objectiveMessageId
    || snapshot.messageVersion !== request.objectiveMessageVersion
    || snapshot.objectiveDigest !== request.objectiveDigest
    || binding.sessionId !== request.sessionId
    || binding.workspace.workspaceId !== request.workspaceId
    || binding.objectiveRef.kind !== 'conversation_message'
    || binding.objectiveRef.messageId !== request.objectiveMessageId
    || binding.objectiveRef.messageVersion !== request.objectiveMessageVersion
    || binding.objectiveRef.contentDigest !== request.objectiveDigest
    || binding.budget.runId !== runId
    || !snapshotToolsMatchBinding(snapshot, binding)
  ) {
    throw snapshotMismatch();
  }
}

function snapshotToolsMatchBinding(
  snapshot: AgentRunAdmissionSnapshot,
  binding: AgentRunBinding
): boolean {
  const grantedCapabilityIds = new Set(
    binding.capabilities.map((capability) => capability.capabilityId)
  );
  return snapshot.input.availableTools.length === binding.toolCatalog.allowedToolNames.length
    && snapshot.input.availableTools.every((available, index) => (
    available.tool.catalogId === binding.toolCatalog.catalogId
    && available.tool.revision === binding.toolCatalog.revision
    && available.tool.digest === binding.toolCatalog.digest
    && binding.toolCatalog.allowedToolNames.includes(available.tool.toolName)
    && available.tool.toolName === binding.toolCatalog.allowedToolNames[index]
    && available.capabilityIds.every((capabilityId) => (
      grantedCapabilityIds.has(capabilityId)
    ))
    ));
}

function assertRequest(request: AgentRunRequestedHandoffMessage): void {
  const exactKeys = [
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
  ];
  if (
    !hasExactDataKeys(request, exactKeys)
    || request.kind !== 'agent.run.requested'
    || request.sagaVersion !== 2
    || !Number.isSafeInteger(request.objectiveMessageVersion)
    || request.objectiveMessageVersion <= 0
    || !/^sha256:[a-f0-9]{64}$/u.test(request.objectiveDigest)
    || !isCanonicalIsoTimestamp(request.occurredAt)
    || ![
      request.messageId,
      request.sagaId,
      request.sessionId,
      request.workspaceId,
      request.objectiveMessageId,
      request.runRequestId,
      request.agentCommandId,
      request.causationId
    ].every(isCanonicalId)
  ) {
    throw new AgentRunAdmissionControlError(
      'AGENT_ADMISSION_REQUEST_INVALID',
      'Agent admission handoff request is invalid.'
    );
  }
}

function requestFingerprint(request: AgentRunRequestedHandoffMessage): string {
  return JSON.stringify([
    request.messageId,
    request.kind,
    request.sagaId,
    request.sagaVersion,
    request.sessionId,
    request.workspaceId,
    request.objectiveMessageId,
    request.objectiveMessageVersion,
    request.objectiveDigest,
    request.runRequestId,
    request.agentCommandId,
    request.causationId,
    request.occurredAt
  ]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(value: object, keys: readonly string[]): boolean {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  if (
    actual.length !== keys.length
    || actual.some((key) => !allowed.has(key))
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

function snapshotMismatch(): AgentRunAdmissionControlError {
  return new AgentRunAdmissionControlError(
    'AGENT_ADMISSION_SNAPSHOT_MISMATCH',
    'Admission snapshot does not match the immutable Conversation request.'
  );
}

function receiptConflict(): AgentRunAdmissionControlError {
  return new AgentRunAdmissionControlError(
    'AGENT_ADMISSION_RECEIPT_CONFLICT',
    'Committed Agent admission receipt does not match the handoff request.'
  );
}

function admissionEventId(
  events: AgentRunCommandReceipt['mutations'][number]['events']
): string {
  const event = events[0];
  if (event?.payload.type !== 'run.admitted') throw receiptConflict();
  return event.eventId;
}
