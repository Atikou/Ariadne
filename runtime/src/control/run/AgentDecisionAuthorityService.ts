import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  AgentRunCommandService,
  AgentRunVersionConflictError,
  assertValidAgentRun,
  getActiveDecision,
  type AgentJsonValue,
  type AgentDecision,
  type AgentDecisionResolution,
  type AgentRun,
  type AgentRunCheckpoint,
  type AgentRunCommandReceipt,
  type AgentRunCommandReceiptReader,
  type AgentRunCommitArtifacts,
  type AgentRunEvent,
  type AgentRunRecoveryCursor,
  type AgentRunRecoveryPayloadReader,
  type AgentRunRecoveryQuery,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';
import type {
  RuntimeCommand,
  RuntimeResult
} from '@ariadne/protocol/public';
import {
  derivePublicDecisionActionDescriptorV1
} from '@ariadne/protocol/public';

export type ResolvePublicAgentDecisionCommand = Extract<
  RuntimeCommand,
  { readonly kind: 'agent.decision.resolve.v3' }
>;
export type ResolvePublicAgentDecisionResult = Extract<
  RuntimeResult,
  { readonly kind: 'agent.decision.resolved.v3' }
>;

export interface AgentDecisionAuthorityStore
extends AgentRunUnitOfWork, AgentRunCommandReceiptReader {
  loadRunVersion(runId: string, version: number): Promise<AgentRun | null>;
  listActiveRuns: AgentRunRecoveryQuery['listActiveRuns'];
  loadCheckpoint: AgentRunRecoveryPayloadReader['loadCheckpoint'];
}

export interface ResolvePublicAgentDecisionRequest {
  readonly commandId: string;
  readonly command: ResolvePublicAgentDecisionCommand;
  readonly signal: AbortSignal;
}

export class AgentDecisionAuthorityError extends Error {
  public constructor(
    public readonly code:
      | 'AGENT_DECISION_AUTHORITY_INVALID'
      | 'AGENT_DECISION_AUTHORITY_RUN_NOT_FOUND'
      | 'AGENT_DECISION_AUTHORITY_NOT_ACTIVE'
      | 'AGENT_DECISION_AUTHORITY_TOKEN_MISMATCH'
      | 'AGENT_DECISION_AUTHORITY_CHOICE_INVALID'
      | 'AGENT_DECISION_AUTHORITY_RECEIPT_INVALID',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AgentDecisionAuthorityError';
  }
}

interface InFlightDecisionCommand {
  readonly fingerprint: string;
  readonly operation: Promise<ResolvePublicAgentDecisionResult>;
}

/**
 * Public Decision mutation authority. The public action is never translated
 * directly: the active Agent-owned Decision is loaded first, its descriptor is
 * re-derived, and only that authoritative object can create the Core command.
 */
export class AgentDecisionAuthorityService {
  private readonly commands: AgentRunCommandService;
  private readonly inFlight = new Map<string, InFlightDecisionCommand>();

  public constructor(
    private readonly store: AgentDecisionAuthorityStore,
    private readonly now: () => Date = () => new Date()
  ) {
    this.commands = new AgentRunCommandService(store);
  }

  public execute(
    request: ResolvePublicAgentDecisionRequest
  ): Promise<ResolvePublicAgentDecisionResult> {
    request.signal.throwIfAborted();
    const fingerprint = publicCommandFingerprint(request.command);
    const existing = this.inFlight.get(request.commandId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(authorityError(
          'AGENT_DECISION_AUTHORITY_INVALID',
          'An in-flight command ID cannot identify a different Decision action.'
        ));
      }
      return existing.operation;
    }

    const operation = this.executeOnce(request).finally(() => {
      const current = this.inFlight.get(request.commandId);
      if (current?.operation === operation) this.inFlight.delete(request.commandId);
    });
    this.inFlight.set(request.commandId, { fingerprint, operation });
    return operation;
  }

  public async reconcile(
    request: ResolvePublicAgentDecisionRequest
  ): Promise<ResolvePublicAgentDecisionResult | null> {
    request.signal.throwIfAborted();
    const result = await this.loadExactReplay(request.commandId, request.command);
    request.signal.throwIfAborted();
    return result;
  }

  private async executeOnce(
    request: ResolvePublicAgentDecisionRequest
  ): Promise<ResolvePublicAgentDecisionResult> {
    const replay = await this.loadExactReplay(request.commandId, request.command);
    if (replay !== null) return replay;
    request.signal.throwIfAborted();

    const run = await this.store.transaction((transaction) => (
      transaction.loadRun(request.command.runId)
    ));
    request.signal.throwIfAborted();
    if (run === null) {
      throw authorityError(
        'AGENT_DECISION_AUTHORITY_RUN_NOT_FOUND',
        'The authoritative Agent Run does not exist.'
      );
    }
    assertValidAgentRun(run);
    const decision = await requireAuthorizedActiveDecision(run, request.command);
    const occurredAt = authoritativeCommandTime(this.now, run.updatedAt);
    const resolution = resolutionForChoice(
      decision,
      request.command.action.choice,
      occurredAt
    );
    const artifacts = await decisionResolutionArtifacts(
      this.store,
      run,
      decision,
      request.command.action.choice,
      occurredAt
    );
    request.signal.throwIfAborted();

    const committed = await this.commands.execute({
      kind: 'run.resolve_decision',
      commandId: request.commandId,
      runId: run.runId,
      expectedVersion: run.version,
      occurredAt,
      resolution
    }, artifacts);
    request.signal.throwIfAborted();
    assertExactResolutionResult(
      committed.run,
      committed.events,
      request.commandId,
      decision,
      resolution
    );
    return publicResult(decision, committed.run);
  }

  private async loadExactReplay(
    commandId: string,
    command: ResolvePublicAgentDecisionCommand
  ): Promise<ResolvePublicAgentDecisionResult | null> {
    const receipt = await this.store.loadCommittedCommandReceipt(commandId);
    if (receipt === null) return null;
    const mutation = exactReceiptMutation(receipt, commandId, command.runId);
    assertValidAgentRun(mutation.run);
    if (mutation.resultingVersion <= 1) {
      throw receiptInvalid('A Decision receipt has no previous Run version.');
    }
    const previous = await this.store.loadRunVersion(
      command.runId,
      mutation.resultingVersion - 1
    );
    if (previous === null) {
      throw receiptInvalid('The Decision receipt has no immutable previous Run.');
    }
    assertValidAgentRun(previous);
    if (
      previous.runId !== command.runId
      || previous.version !== mutation.resultingVersion - 1
      || previous.binding.sessionId !== mutation.run.binding.sessionId
    ) {
      throw receiptInvalid('The Decision receipt history identity drifted.');
    }
    const decision = await requireAuthorizedActiveDecision(previous, command);
    const resolutionEvent = exactResolutionEvent(
      mutation.events,
      commandId,
      mutation.run
    );
    const expectedResolution = resolutionForChoice(
      decision,
      command.action.choice,
      resolutionEvent.occurredAt
    );
    if (
      resolutionEvent.payload.decisionId !== decision.decisionId
      || !isDeepStrictEqual(resolutionEvent.payload.resolution, expectedResolution)
    ) {
      throw receiptInvalid('The committed Decision resolution differs from the public action.');
    }
    assertExactResolutionResult(
      mutation.run,
      mutation.events,
      commandId,
      decision,
      expectedResolution
    );
    return publicResult(decision, mutation.run);
  }
}

async function decisionResolutionArtifacts(
  store: AgentDecisionAuthorityStore,
  run: AgentRun,
  decision: AgentDecision,
  choice: ResolvePublicAgentDecisionCommand['action']['choice'],
  occurredAt: string
): Promise<AgentRunCommitArtifacts> {
  const effectPayloads: AgentRunCommitArtifacts['effectPayloads'] =
    decision.kind === 'recovery'
    && (choice === 'mark_succeeded' || choice === 'mark_failed')
      ? [recoveryResultArtifact(run, decision, choice, occurredAt)]
      : [];
  if (isTerminalResolution(decision, choice)) {
    return { turnInputPayloads: [], effectPayloads };
  }

  const previous = await loadExactActiveCheckpoint(store, run);
  return {
    turnInputPayloads: [],
    checkpoint: {
      checkpointVersion: run.state.checkpointVersion + 1,
      payload: {
        ...previous.payload,
        engineContinuation: {
          phase: 'decision_resolved',
          decision: {
            kind: decision.kind,
            decisionId: decision.decisionId,
            choice
          },
          previous: previous.payload.engineContinuation
        }
      },
      createdAt: occurredAt
    },
    effectPayloads
  };
}

async function loadExactActiveCheckpoint(
  store: AgentDecisionAuthorityStore,
  snapshot: AgentRun
): Promise<AgentRunCheckpoint> {
  let after: AgentRunRecoveryCursor | undefined;
  for (;;) {
    const page = await store.listActiveRuns({
      limit: 1_000,
      ...(after === undefined ? {} : { after })
    });
    const item = page.items.find((candidate) => candidate.run.runId === snapshot.runId);
    if (item !== undefined) {
      if (item.run.version !== snapshot.version) {
        throw new AgentRunVersionConflictError(
          snapshot.runId,
          snapshot.version,
          item.run.version
        );
      }
      if (
        !item.ready
        || item.phase !== 'resumable'
        || item.checkpoint.runId !== snapshot.runId
        || item.checkpoint.runVersion !== snapshot.version
        || item.checkpoint.checkpointVersion !== snapshot.state.checkpointVersion
      ) {
        throw authorityError(
          'AGENT_DECISION_AUTHORITY_INVALID',
          'The active Decision has no exact recoverable checkpoint authority.'
        );
      }
      const checkpoint = await store.loadCheckpoint(item.checkpoint);
      if (
        checkpoint.runId !== snapshot.runId
        || checkpoint.runVersion !== snapshot.version
        || checkpoint.checkpointVersion !== snapshot.state.checkpointVersion
        || checkpoint.createdAt !== item.checkpoint.createdAt
      ) {
        throw authorityError(
          'AGENT_DECISION_AUTHORITY_INVALID',
          'The active Decision checkpoint payload drifted from its metadata.'
        );
      }
      return checkpoint;
    }
    if (page.nextCursor === undefined) break;
    after = page.nextCursor;
  }

  const current = await store.transaction((transaction) => (
    transaction.loadRun(snapshot.runId)
  ));
  if (current !== null && current.version !== snapshot.version) {
    throw new AgentRunVersionConflictError(
      snapshot.runId,
      snapshot.version,
      current.version
    );
  }
  throw authorityError(
    'AGENT_DECISION_AUTHORITY_INVALID',
    'The active Decision Run is not present in authoritative recovery metadata.'
  );
}

function isTerminalResolution(
  decision: AgentDecision,
  choice: ResolvePublicAgentDecisionCommand['action']['choice']
): boolean {
  return (decision.kind === 'permission' && choice === 'deny')
    || (decision.kind === 'recovery' && choice === 'cancel_run');
}

function recoveryResultArtifact(
  run: AgentRun,
  decision: Extract<AgentDecision, { readonly kind: 'recovery' }>,
  outcome: 'mark_succeeded' | 'mark_failed',
  recordedAt: string
): AgentRunCommitArtifacts['effectPayloads'][number] {
  const effect = run.effects.find((candidate) => candidate.effectId === decision.effectId);
  if (effect === undefined || effect.state.status !== 'uncertain') {
    throw authorityError(
      'AGENT_DECISION_AUTHORITY_NOT_ACTIVE',
      'The recovery Decision no longer owns an uncertain effect.'
    );
  }
  const result: AgentJsonValue = {
    kind: 'ariadne.effect-recovery-resolution',
    schemaVersion: 1,
    outcome
  };
  return {
    kind: 'record_result',
    effectId: effect.effectId,
    inputDigest: effect.inputDigest,
    result,
    recordedAt
  };
}

async function requireAuthorizedActiveDecision(
  run: AgentRun,
  command: ResolvePublicAgentDecisionCommand
): Promise<AgentDecision> {
  const decision = getActiveDecision(run);
  if (
    decision === null
    || decision.runId !== command.runId
    || decision.decisionId !== command.decisionId
  ) {
    throw authorityError(
      'AGENT_DECISION_AUTHORITY_NOT_ACTIVE',
      'The requested Decision is not the authoritative active Decision.'
    );
  }
  const descriptor = await derivePublicDecisionActionDescriptorV1(
    decision,
    run.binding.sessionId
  );
  if (!actionTokenMatchesConstantTime(
    descriptor.actionToken,
    command.action.actionToken
  )) {
    throw authorityError(
      'AGENT_DECISION_AUTHORITY_TOKEN_MISMATCH',
      'The opaque Decision action token does not match current authority.'
    );
  }
  if (!descriptor.choices.includes(command.action.choice)) {
    throw authorityError(
      'AGENT_DECISION_AUTHORITY_CHOICE_INVALID',
      'The selected Decision choice is not authorized by the active Decision.'
    );
  }
  return decision;
}

function actionTokenMatchesConstantTime(
  expectedToken: string,
  candidateToken: string
): boolean {
  const expectedDigest = createHash('sha256').update(expectedToken, 'utf8').digest();
  const candidateDigest = createHash('sha256').update(candidateToken, 'utf8').digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function resolutionForChoice(
  decision: AgentDecision,
  choice: ResolvePublicAgentDecisionCommand['action']['choice'],
  resolvedAt: string
): AgentDecisionResolution {
  if (decision.kind === 'permission') {
    if (choice !== 'allow_once' && choice !== 'allow_run' && choice !== 'deny') {
      throw authorityError(
        'AGENT_DECISION_AUTHORITY_CHOICE_INVALID',
        'The active permission Decision does not authorize that choice.'
      );
    }
    return {
      kind: 'permission',
      decisionId: decision.decisionId,
      checkpoint: decision.checkpoint,
      resolvedAt,
      effectId: decision.effectId,
      outcome: choice,
      approvedCapabilityIds: choice === 'deny' ? [] : [...decision.capabilityIds]
    };
  }
  if (decision.kind === 'plan') {
    if (choice !== 'approve' && choice !== 'reject') {
      throw authorityError(
        'AGENT_DECISION_AUTHORITY_CHOICE_INVALID',
        'The active plan Decision does not authorize that choice.'
      );
    }
    return {
      kind: 'plan',
      decisionId: decision.decisionId,
      checkpoint: decision.checkpoint,
      resolvedAt,
      planId: decision.planId,
      planVersion: decision.planVersion,
      planHash: decision.planHash,
      outcome: choice
    };
  }
  if (
    choice !== 'retry'
    && choice !== 'mark_succeeded'
    && choice !== 'mark_failed'
    && choice !== 'cancel_run'
  ) {
    throw authorityError(
      'AGENT_DECISION_AUTHORITY_CHOICE_INVALID',
      'The active recovery Decision does not authorize that choice.'
    );
  }
  return {
    kind: 'recovery',
    decisionId: decision.decisionId,
    checkpoint: decision.checkpoint,
    resolvedAt,
    effectId: decision.effectId,
    outcome: choice
  };
}

function exactReceiptMutation(
  receipt: AgentRunCommandReceipt,
  commandId: string,
  runId: string
): AgentRunCommandReceipt['mutations'][number] {
  const mutation = receipt.mutations[0];
  if (
    receipt.commandId !== commandId
    || receipt.mutations.length !== 1
    || mutation === undefined
    || mutation.runId !== runId
    || mutation.run.runId !== runId
    || mutation.resultingVersion !== mutation.run.version
  ) {
    throw receiptInvalid('The command receipt is not one exact Decision mutation.');
  }
  return mutation;
}

type ResolutionEvent = AgentRunEvent & {
  readonly payload: Extract<
    AgentRunEvent['payload'],
    { readonly type: 'decision.resolved' }
  >;
};

function exactResolutionEvent(
  events: readonly AgentRunEvent[],
  commandId: string,
  run: AgentRun
): ResolutionEvent {
  const matches = events.filter((event): event is ResolutionEvent => (
    event.payload.type === 'decision.resolved'
  ));
  const event = matches[0];
  if (
    matches.length !== 1
    || event === undefined
    || event.commandId !== commandId
    || event.runId !== run.runId
    || event.runVersion !== run.version
    || event.occurredAt !== run.updatedAt
  ) {
    throw receiptInvalid('The command receipt has no exact Decision resolution event.');
  }
  return event;
}

function assertExactResolutionResult(
  run: AgentRun,
  events: readonly AgentRunEvent[],
  commandId: string,
  decision: AgentDecision,
  resolution: AgentDecisionResolution
): void {
  assertValidAgentRun(run);
  const event = exactResolutionEvent(events, commandId, run);
  if (
    getActiveDecision(run) !== null
    || event.payload.decisionId !== decision.decisionId
    || !isDeepStrictEqual(event.payload.resolution, resolution)
  ) {
    throw receiptInvalid('The resulting Run does not exactly resolve the authorized Decision.');
  }
}

function publicResult(
  decision: AgentDecision,
  run: AgentRun
): ResolvePublicAgentDecisionResult {
  return {
    kind: 'agent.decision.resolved.v3',
    runId: run.runId,
    decisionId: decision.decisionId,
    runVersion: run.version
  };
}

function authoritativeCommandTime(now: () => Date, runUpdatedAt: string): string {
  const current = now();
  const currentMs = current instanceof Date ? current.getTime() : Number.NaN;
  const updatedMs = Date.parse(runUpdatedAt);
  if (!Number.isFinite(currentMs) || !Number.isFinite(updatedMs)) {
    throw authorityError(
      'AGENT_DECISION_AUTHORITY_INVALID',
      'The Decision authority clock is invalid.'
    );
  }
  return new Date(Math.max(currentMs, updatedMs)).toISOString();
}

function publicCommandFingerprint(command: ResolvePublicAgentDecisionCommand): string {
  return JSON.stringify([
    command.kind,
    command.contractVersion,
    command.runId,
    command.decisionId,
    command.action.contractVersion,
    command.action.actionToken,
    command.action.choice
  ]);
}

function receiptInvalid(message: string): AgentDecisionAuthorityError {
  return authorityError('AGENT_DECISION_AUTHORITY_RECEIPT_INVALID', message);
}

function authorityError(
  code: AgentDecisionAuthorityError['code'],
  message: string,
  cause?: unknown
): AgentDecisionAuthorityError {
  return new AgentDecisionAuthorityError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}
