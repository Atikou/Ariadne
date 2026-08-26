import type { AgentRun } from '../domain/agent-run.js';
import type { AgentJsonValue } from '../domain/json-value.js';
import type { AgentEffect, AgentEffectState } from '../domain/effect.js';
import {
  AgentRunInvariantError,
  AgentRunNotFoundError,
  AgentRunTransitionError,
  AgentRunVersionConflictError
} from '../domain/errors.js';
import {
  assertCanonicalPublicId,
  assertPositiveInteger,
  assertTimestamp
} from '../domain/values.js';
import { AgentRunCommandService, type AgentRunCommandResult } from './agent-run-command-service.js';
import type { AgentEffectResult } from './commands.js';
import type {
  AgentRunCheckpointCommit,
  AgentRunCommitArtifacts
} from './recovery-persistence.js';
import type { AgentRunUnitOfWork } from './unit-of-work.js';
import { deriveStableAgentId } from './stable-id.js';

export interface AgentEffectExecutionInput {
  readonly runId: string;
  readonly effectId: string;
  readonly inputDigest: string;
  readonly input: AgentJsonValue;
}

export interface AgentEffectExecutionInputReader {
  loadEffectExecutionInput(
    runId: string,
    effectId: string
  ): Promise<AgentEffectExecutionInput>;
}

export type AgentEffectExecutionOutcome =
  | {
      readonly status: 'succeeded';
      readonly outputRef?: string;
      readonly result: AgentJsonValue;
    }
  | {
      readonly status: 'failed';
      readonly errorCode: string;
      readonly message: string;
      readonly result: AgentJsonValue;
    }
  | {
      /** The adapter cannot prove whether the external action happened. */
      readonly status: 'uncertain';
      readonly reason: string;
    }
  | {
      /** The adapter guarantees that no external side effect was started. */
      readonly status: 'cancelled';
      readonly reason: string;
    };

export interface AgentEffectExecutor {
  execute(
    request: {
      readonly runId: string;
      readonly effectId: string;
      readonly toolCallId: string;
      readonly tool: AgentEffect['tool'];
      readonly idempotencyKey: string;
      readonly capabilityIds: readonly string[];
      readonly scope: readonly string[];
      readonly input: AgentJsonValue;
    },
    signal: AbortSignal
  ): Promise<AgentEffectExecutionOutcome>;
}

export interface AgentEffectDispatchCheckpointFactory {
  create(input: {
    readonly run: AgentRun;
    readonly effect: AgentEffect;
    readonly checkpointVersion: number;
    readonly phase: 'effect_started' | 'effect_result';
    readonly occurredAt: string;
  }): AgentRunCheckpointCommit;
}

export interface AgentEffectDispatchClock {
  now(): string;
}

export interface DispatchAgentEffectRequest {
  /** Stable logical identity retained across transport retries. */
  readonly commandId: string;
  readonly runId: string;
  readonly effectId: string;
  readonly expectedVersion: number;
  readonly occurredAt: string;
}

export interface AgentEffectDispatchResult {
  readonly run: AgentRun;
  readonly effect: AgentEffect;
  readonly command: AgentRunCommandResult | null;
  readonly status: AgentEffectState['status'];
  readonly alreadySettled: boolean;
}

export class AgentEffectDispatchRecoveryRequiredError extends Error {
  public readonly code = 'AGENT_EFFECT_DISPATCH_RECOVERY_REQUIRED';

  public constructor(
    public readonly runId: string,
    public readonly effectId: string
  ) {
    super(
      `Effect "${effectId}" for Run "${runId}" was already started; `
        + 'its external outcome must be recovered before another dispatch.'
    );
    this.name = 'AgentEffectDispatchRecoveryRequiredError';
  }
}

interface InFlightDispatch {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly promise: Promise<AgentEffectDispatchResult>;
}

const SYSTEM_CLOCK: AgentEffectDispatchClock = {
  now: () => new Date().toISOString()
};

/**
 * Durable Effect dispatcher.
 *
 * `run.start_effect` is committed before the external adapter is called. A
 * replayed start is never executed again: after a process loss the recovery
 * coordinator must classify the already-started effect as uncertain.
 */
export class AgentEffectDispatchService {
  private readonly commands: AgentRunCommandService;
  private readonly inFlight = new Map<string, InFlightDispatch>();

  public constructor(
    private readonly unitOfWork: AgentRunUnitOfWork,
    private readonly inputReader: AgentEffectExecutionInputReader,
    private readonly executor: AgentEffectExecutor,
    private readonly checkpoints: AgentEffectDispatchCheckpointFactory,
    private readonly clock: AgentEffectDispatchClock = SYSTEM_CLOCK
  ) {
    this.commands = new AgentRunCommandService(unitOfWork);
  }

  public dispatch(
    request: DispatchAgentEffectRequest,
    signal: AbortSignal = new AbortController().signal
  ): Promise<AgentEffectDispatchResult> {
    assertDispatchRequest(request);
    const key = `${request.runId}\u0000${request.effectId}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      if (
        existing.commandId !== request.commandId
        || existing.expectedVersion !== request.expectedVersion
      ) {
        return Promise.reject(new AgentRunTransitionError(
          `Effect "${request.effectId}" already has a different in-flight dispatch identity.`
        ));
      }
      return existing.promise;
    }

    const operation = this.dispatchOnce(request, signal).finally(() => {
      if (this.inFlight.get(key)?.promise === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, {
      commandId: request.commandId,
      expectedVersion: request.expectedVersion,
      promise: operation
    });
    return operation;
  }

  private async dispatchOnce(
    request: DispatchAgentEffectRequest,
    signal: AbortSignal
  ): Promise<AgentEffectDispatchResult> {
    const current = await this.loadRun(request.runId);
    const currentEffect = requireEffect(current, request.effectId);
    if (isKnownTerminalEffect(currentEffect)) {
      return settledResult(current, currentEffect);
    }
    if (current.version !== request.expectedVersion) {
      throw new AgentRunVersionConflictError(
        current.runId,
        request.expectedVersion,
        current.version
      );
    }
    if (
      currentEffect.state.status === 'started'
      || currentEffect.state.status === 'uncertain'
    ) {
      throw new AgentEffectDispatchRecoveryRequiredError(
        request.runId,
        request.effectId
      );
    }
    if (current.state.status !== 'running' || currentEffect.state.status !== 'authorized') {
      throw new AgentRunTransitionError(
        `Effect "${request.effectId}" must be authorized on a running Run before dispatch.`
      );
    }

    const payload = await this.inputReader.loadEffectExecutionInput(
      request.runId,
      request.effectId
    );
    if (
      payload.runId !== current.runId
      || payload.effectId !== currentEffect.effectId
      || payload.inputDigest !== currentEffect.inputDigest
    ) {
      throw new AgentRunInvariantError(
        'The durable Effect input must match the exact Run, Effect, and input digest.'
      );
    }

    const startCommandId = await deriveStableAgentId(
      'effect-start',
      request.commandId,
      request.runId,
      request.effectId
    );
    const started = await this.commands.execute({
      kind: 'run.start_effect',
      commandId: startCommandId,
      runId: current.runId,
      expectedVersion: current.version,
      occurredAt: request.occurredAt,
      effectId: currentEffect.effectId
    }, checkpointArtifacts(this.checkpoints.create({
      run: current,
      effect: currentEffect,
      checkpointVersion: current.state.checkpointVersion + 1,
      phase: 'effect_started',
      occurredAt: request.occurredAt
    })));
    if (started.replayed) {
      throw new AgentEffectDispatchRecoveryRequiredError(
        request.runId,
        request.effectId
      );
    }

    const startedEffect = requireEffect(started.run, request.effectId);
    let outcome: AgentEffectExecutionOutcome;
    try {
      outcome = await this.executor.execute({
        runId: started.run.runId,
        effectId: startedEffect.effectId,
        toolCallId: startedEffect.toolCallId,
        tool: startedEffect.tool,
        idempotencyKey: startedEffect.idempotencyKey,
        capabilityIds: startedEffect.capabilityIds,
        scope: startedEffect.scope,
        input: payload.input
      }, signal);
    } catch {
      outcome = {
        status: 'uncertain',
        reason: 'effect_executor_terminated_without_durable_outcome'
      };
    }

    const finishedAt = this.clock.now();
    assertTimestamp(finishedAt, 'effectDispatchClock.now()');
    if (Date.parse(finishedAt) < Date.parse(request.occurredAt)) {
      throw new AgentRunInvariantError(
        'Effect completion cannot precede its durable start.'
      );
    }
    const result = await toAgentEffectResult(outcome, request);
    const artifacts = resultArtifacts(
      this.checkpoints,
      started.run,
      startedEffect,
      payload.inputDigest,
      outcome,
      finishedAt
    );
    const resultCommandId = await deriveStableAgentId(
      'effect-result',
      request.commandId,
      request.runId,
      request.effectId
    );
    const recorded = await this.commands.execute({
      kind: 'run.record_effect_result',
      commandId: resultCommandId,
      runId: started.run.runId,
      expectedVersion: started.run.version,
      occurredAt: finishedAt,
      effectId: startedEffect.effectId,
      result
    }, artifacts);
    const recordedEffect = requireEffect(recorded.run, request.effectId);
    return {
      run: recorded.run,
      effect: recordedEffect,
      command: recorded,
      status: recordedEffect.state.status,
      alreadySettled: false
    };
  }

  private async loadRun(runId: string): Promise<AgentRun> {
    const run = await this.unitOfWork.transaction((transaction) =>
      transaction.loadRun(runId)
    );
    if (run === null) throw new AgentRunNotFoundError(runId);
    return run;
  }
}

function checkpointArtifacts(
  checkpoint: AgentRunCheckpointCommit
): AgentRunCommitArtifacts {
  return { checkpoint, turnInputPayloads: [], effectPayloads: [] };
}

function resultArtifacts(
  checkpoints: AgentEffectDispatchCheckpointFactory,
  run: AgentRun,
  effect: AgentEffect,
  inputDigest: string,
  outcome: AgentEffectExecutionOutcome,
  occurredAt: string
): AgentRunCommitArtifacts {
  const checkpoint = checkpoints.create({
    run,
    effect,
    checkpointVersion: run.state.checkpointVersion + 1,
    phase: 'effect_result',
    occurredAt
  });
  if (outcome.status !== 'succeeded' && outcome.status !== 'failed') {
    return { checkpoint, turnInputPayloads: [], effectPayloads: [] };
  }
  return {
    checkpoint,
    turnInputPayloads: [],
    effectPayloads: [{
      kind: 'record_result',
      effectId: effect.effectId,
      inputDigest,
      result: outcome.result,
      recordedAt: occurredAt
    }]
  };
}

async function toAgentEffectResult(
  outcome: AgentEffectExecutionOutcome,
  request: DispatchAgentEffectRequest
): Promise<AgentEffectResult> {
  switch (outcome.status) {
    case 'succeeded':
      return outcome.outputRef === undefined
        ? { status: 'succeeded' }
        : { status: 'succeeded', outputRef: outcome.outputRef };
    case 'failed':
      return {
        status: 'failed',
        errorCode: outcome.errorCode,
        message: outcome.message
      };
    case 'cancelled':
      return { status: 'cancelled', reason: outcome.reason };
    case 'uncertain':
      return {
        status: 'uncertain',
        reason: outcome.reason,
        recoveryDecisionId: await deriveStableAgentId(
          'effect-recovery',
          request.commandId,
          request.runId,
          request.effectId
        ),
        allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
      };
  }
}

function settledResult(run: AgentRun, effect: AgentEffect): AgentEffectDispatchResult {
  return {
    run,
    effect,
    command: null,
    status: effect.state.status,
    alreadySettled: true
  };
}

function requireEffect(run: AgentRun, effectId: string): AgentEffect {
  const effect = run.effects.find((candidate) => candidate.effectId === effectId);
  if (effect === undefined) {
    throw new AgentRunTransitionError(
      `Effect "${effectId}" does not belong to Run "${run.runId}".`
    );
  }
  return effect;
}

function isKnownTerminalEffect(effect: AgentEffect): boolean {
  return effect.state.status === 'succeeded'
    || effect.state.status === 'failed'
    || effect.state.status === 'cancelled';
}

function assertDispatchRequest(request: DispatchAgentEffectRequest): void {
  assertCanonicalPublicId(request.commandId, 'dispatch.commandId');
  assertCanonicalPublicId(request.runId, 'dispatch.runId');
  assertCanonicalPublicId(request.effectId, 'dispatch.effectId');
  assertPositiveInteger(request.expectedVersion, 'dispatch.expectedVersion');
  assertTimestamp(request.occurredAt, 'dispatch.occurredAt');
}
