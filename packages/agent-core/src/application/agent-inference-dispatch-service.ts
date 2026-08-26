import type { AgentRun } from '../domain/agent-run.js';
import type { AgentDirective } from '../domain/directive.js';
import {
  AgentRunInvariantError,
  AgentRunNotFoundError,
  AgentRunTransitionError
} from '../domain/errors.js';
import type {
  AgentInferenceAttempt,
  AgentInferenceAttemptState,
  AgentTurn
} from '../domain/turn.js';
import {
  assertBoundedNonEmpty,
  assertCanonicalPublicId,
  assertPositiveInteger,
  assertTimestamp
} from '../domain/values.js';
import type { AgentEngine, AgentTurnInput } from './agent-engine.js';
import {
  AgentRunCommandService,
  type AgentRunCommandResult
} from './agent-run-command-service.js';
import type {
  AgentRunCheckpointCommit,
  AgentRunCommitArtifacts,
  AgentEffectPayloadCommit,
  AgentDirectivePayloadCommit
} from './recovery-persistence.js';
import {
  digestAgentTurnInput,
  modelDataFromAgentTurnInput,
  summarizeAgentTurnInput
} from './turn-input-digest.js';
import type { AgentRunUnitOfWork } from './unit-of-work.js';
import { deriveStableAgentId } from './stable-id.js';
import type {
  AgentInferenceDirectivePlanner
} from './agent-inference-directive-planner.js';
import type { AgentInferenceAttemptResult } from './commands.js';
import {
  EMPTY_AGENT_CONTROL_COMMIT_FACTS,
  type AgentPlanVersionCommit
} from '../domain/plan-budget-delegation.js';

const UNCERTAIN_REASON = 'inference_engine_terminated_without_durable_outcome';
const DIRECTIVE_PLANNING_UNCERTAIN_REASON =
  'inference_directive_planning_terminated_without_durable_outcome';

export interface AgentInferenceExecutionInput {
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly inputDigest: string;
  readonly input: AgentTurnInput;
}

export interface AgentInferenceExecutionInputReader {
  loadInferenceExecutionInput(
    runId: string,
    turnId: string,
    attemptId: string
  ): Promise<AgentInferenceExecutionInput>;
}

export type AgentInferenceDispatchCheckpointRequest =
  | {
      readonly run: AgentRun;
      readonly turn: AgentTurn;
      readonly attempt: AgentInferenceAttempt;
      readonly checkpointVersion: number;
      readonly phase: 'inference_started';
      readonly occurredAt: string;
    }
  | {
    readonly run: AgentRun;
    readonly turn: AgentTurn;
    readonly attempt: AgentInferenceAttempt;
    readonly checkpointVersion: number;
    readonly phase: 'inference_result';
    readonly occurredAt: string;
    /** Safe planned result only; raw Engine tool input is never checkpoint data. */
    readonly result: AgentInferenceAttemptResult;
  };

export interface AgentInferenceDispatchCheckpointFactory {
  create(input: AgentInferenceDispatchCheckpointRequest): AgentRunCheckpointCommit;
}

export interface AgentInferenceDispatchClock {
  now(): string;
}

export interface DispatchAgentInferenceRequest {
  readonly commandId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly occurredAt: string;
}

export interface AgentInferenceDispatchResult {
  readonly run: AgentRun;
  readonly turn: AgentTurn;
  readonly attempt: AgentInferenceAttempt;
  readonly command: AgentRunCommandResult | null;
  readonly status: AgentInferenceAttemptState['status'];
  readonly alreadySettled: boolean;
}

export class AgentInferenceDispatchRecoveryRequiredError extends Error {
  public readonly code = 'AGENT_INFERENCE_DISPATCH_RECOVERY_REQUIRED';

  public constructor(
    public readonly runId: string,
    public readonly turnId: string,
    public readonly attemptId: string
  ) {
    super(
      `Inference attempt "${attemptId}" for Turn "${turnId}" was already started `
        + `or became uncertain; its Provider outcome must be recovered before retry.`
    );
    this.name = 'AgentInferenceDispatchRecoveryRequiredError';
  }
}

/** Explicit, sanitized evidence that a Provider deterministically rejected inference. */
export class AgentInferenceDeterministicFailureError extends Error {
  public readonly code = 'AGENT_INFERENCE_DETERMINISTIC_FAILURE';

  public constructor(
    public readonly providerErrorCode: string,
    public readonly sanitizedMessage: string
  ) {
    super(sanitizedMessage);
    assertCanonicalPublicId(providerErrorCode, 'providerErrorCode');
    assertBoundedNonEmpty(sanitizedMessage, 'sanitizedMessage', 1_048_576);
    this.name = 'AgentInferenceDeterministicFailureError';
  }
}

/** Provider evidence that cancellation completed before inference execution. */
export class AgentInferenceCancellationAcknowledgedError extends Error {
  public readonly code = 'AGENT_INFERENCE_CANCELLATION_ACKNOWLEDGED';

  public constructor(
    public readonly acknowledgementId: string,
    public readonly sanitizedReason: string
  ) {
    super(sanitizedReason);
    assertCanonicalPublicId(acknowledgementId, 'acknowledgementId');
    assertBoundedNonEmpty(sanitizedReason, 'sanitizedReason', 1_048_576);
    this.name = 'AgentInferenceCancellationAcknowledgedError';
  }
}

interface InFlightDispatch {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly promise: Promise<AgentInferenceDispatchResult>;
}

const SYSTEM_CLOCK: AgentInferenceDispatchClock = {
  now: () => new Date().toISOString()
};

/** Commits `started` before Engine I/O and never blindly replays that I/O. */
export class AgentInferenceDispatchService {
  private readonly commands: AgentRunCommandService;
  private readonly inFlight = new Map<string, InFlightDispatch>();

  public constructor(
    private readonly unitOfWork: AgentRunUnitOfWork,
    private readonly inputReader: AgentInferenceExecutionInputReader,
    private readonly engine: AgentEngine,
    private readonly directivePlanner: AgentInferenceDirectivePlanner,
    private readonly checkpoints: AgentInferenceDispatchCheckpointFactory,
    private readonly clock: AgentInferenceDispatchClock = SYSTEM_CLOCK
  ) {
    this.commands = new AgentRunCommandService(unitOfWork);
  }

  public dispatch(
    request: DispatchAgentInferenceRequest,
    signal: AbortSignal = new AbortController().signal
  ): Promise<AgentInferenceDispatchResult> {
    assertDispatchRequest(request);
    const key = `${request.runId}\u0000${request.turnId}\u0000${request.attemptId}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      if (
        existing.commandId !== request.commandId
        || existing.expectedVersion !== request.expectedVersion
      ) {
        return Promise.reject(new AgentRunTransitionError(
          `Inference attempt "${request.attemptId}" has a different in-flight identity.`
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
    request: DispatchAgentInferenceRequest,
    signal: AbortSignal
  ): Promise<AgentInferenceDispatchResult> {
    const current = await this.loadRun(request.runId);
    const currentTurn = requireTurn(current, request.turnId);
    const currentAttempt = requireAttempt(currentTurn, request.attemptId);
    if (isKnownTerminalAttempt(currentAttempt)) {
      return settledResult(current, currentTurn, currentAttempt);
    }
    if (
      currentAttempt.state.status === 'started'
      || currentAttempt.state.status === 'uncertain'
    ) {
      throw recoveryRequired(request);
    }
    if (current.version !== request.expectedVersion) {
      throw new AgentRunTransitionError(
        `Inference dispatch expected Run version ${String(request.expectedVersion)}, `
          + `found ${String(current.version)}.`
      );
    }
    if (current.state.status !== 'running') {
      throw new AgentRunTransitionError(
        `Inference attempt "${request.attemptId}" requires a running Run.`
      );
    }

    // A caller that cancelled before the durable start boundary must not turn
    // a safely retryable intention into an uncertain Provider attempt.
    signal.throwIfAborted();
    const payload = await this.inputReader.loadInferenceExecutionInput(
      request.runId,
      request.turnId,
      request.attemptId
    );
    await assertExactExecutionInput(payload, current, currentTurn, currentAttempt);
    signal.throwIfAborted();

    const startCommandId = await deriveStableAgentId(
      'inference-start',
      request.commandId,
      request.runId,
      request.turnId,
      request.attemptId
    );
    const started = await this.commands.execute({
      kind: 'run.start_inference_attempt',
      commandId: startCommandId,
      runId: current.runId,
      expectedVersion: current.version,
      occurredAt: request.occurredAt,
      turnId: currentTurn.turnId,
      attemptId: currentAttempt.attemptId
    }, checkpointArtifacts(this.checkpoints.create({
      run: current,
      turn: currentTurn,
      attempt: currentAttempt,
      checkpointVersion: current.state.checkpointVersion + 1,
      phase: 'inference_started',
      occurredAt: request.occurredAt
    })));
    if (started.replayed) throw recoveryRequired(request);

    const startedTurn = requireTurn(started.run, request.turnId);
    const startedAttempt = requireAttempt(startedTurn, request.attemptId);
    let directive: AgentDirective | null = null;
    let result: AgentInferenceAttemptResult | undefined;
    let effectPayloads: readonly AgentEffectPayloadCommit[] = [];
    let directivePayloads: readonly AgentDirectivePayloadCommit[] = [];
    let planVersions: readonly AgentPlanVersionCommit[] = [];
    try {
      directive = await this.engine.decide(payload.input, signal);
    } catch (error) {
      if (error instanceof AgentInferenceDeterministicFailureError) {
        result = {
          status: 'failed',
          errorCode: error.providerErrorCode,
          message: error.sanitizedMessage
        };
      } else if (error instanceof AgentInferenceCancellationAcknowledgedError) {
        result = {
          status: 'cancelled',
          reason: error.sanitizedReason,
          providerCancellationAcknowledgementId: error.acknowledgementId
        };
      } else {
        result = await uncertainResult(request, UNCERTAIN_REASON);
      }
    }

    const finishedAt = this.clock.now();
    assertTimestamp(finishedAt, 'inferenceDispatchClock.now()');
    if (Date.parse(finishedAt) < Date.parse(request.occurredAt)) {
      throw new AgentRunInvariantError(
        'Inference completion cannot precede its durable start.'
      );
    }
    const resultCommandId = await deriveStableAgentId(
      'inference-result',
      request.commandId,
      request.runId,
      request.turnId,
      request.attemptId
    );
    if (directive !== null) {
      try {
        const plan = await this.directivePlanner.plan({
          resultCommandId,
          run: started.run,
          turn: startedTurn,
          attempt: startedAttempt,
          directive,
          availableTools: payload.input.availableTools,
          occurredAt: finishedAt
        });
        result = plan.result;
        effectPayloads = plan.effectPayloads;
        directivePayloads = plan.directivePayloads;
        planVersions = plan.planVersions;
      } catch {
        result = await uncertainResult(
          request,
          DIRECTIVE_PLANNING_UNCERTAIN_REASON
        );
        effectPayloads = [];
        directivePayloads = [];
        planVersions = [];
      }
    }
    if (result === undefined) {
      throw new AgentRunInvariantError(
        'Inference dispatch did not produce a durable result plan.'
      );
    }
    const recorded = await this.commands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId: resultCommandId,
      runId: started.run.runId,
      expectedVersion: started.run.version,
      occurredAt: finishedAt,
      turnId: startedTurn.turnId,
      attemptId: startedAttempt.attemptId,
      result
    }, checkpointArtifacts(this.checkpoints.create({
      run: started.run,
      turn: startedTurn,
      attempt: startedAttempt,
      checkpointVersion: started.run.state.checkpointVersion + 1,
      phase: 'inference_result',
      occurredAt: finishedAt,
      result
    }), effectPayloads, directivePayloads), {
      ...EMPTY_AGENT_CONTROL_COMMIT_FACTS,
      planVersions
    });
    const recordedTurn = requireTurn(recorded.run, request.turnId);
    const recordedAttempt = requireAttempt(recordedTurn, request.attemptId);
    return {
      run: recorded.run,
      turn: recordedTurn,
      attempt: recordedAttempt,
      command: recorded,
      status: recordedAttempt.state.status,
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

async function assertExactExecutionInput(
  payload: AgentInferenceExecutionInput,
  run: AgentRun,
  turn: AgentTurn,
  attempt: AgentInferenceAttempt
): Promise<void> {
  if (
    payload.runId !== run.runId
    || payload.turnId !== turn.turnId
    || payload.attemptId !== attempt.attemptId
    || payload.inputDigest !== turn.intention.inputDigest
    || payload.input.run.runId !== run.runId
    || payload.input.run.version !== run.version
  ) {
    throw new AgentRunInvariantError(
      'The durable inference input must match the exact Run, Turn, Attempt, and input digest.'
    );
  }
  const modelInput = modelDataFromAgentTurnInput(payload.input);
  const digest = await digestAgentTurnInput(modelInput);
  if (digest !== turn.intention.inputDigest) {
    throw new AgentRunInvariantError(
      'The inference input content does not match the committed Turn input digest.'
    );
  }
  const summary = summarizeAgentTurnInput(modelInput);
  if (
    summary.messageCount !== turn.intention.inputSummary.messageCount
    || summary.toolCount !== turn.intention.inputSummary.toolCount
    || summary.contentCharacterCount !== turn.intention.inputSummary.contentCharacterCount
  ) {
    throw new AgentRunInvariantError(
      'The inference input does not match the committed bounded Turn summary.'
    );
  }
}

function checkpointArtifacts(
  checkpoint: AgentRunCheckpointCommit,
  effectPayloads: readonly AgentEffectPayloadCommit[] = [],
  directivePayloads: readonly AgentDirectivePayloadCommit[] = []
): AgentRunCommitArtifacts {
  return { checkpoint, turnInputPayloads: [], effectPayloads, directivePayloads };
}

async function uncertainResult(
  request: DispatchAgentInferenceRequest,
  reason: string
): Promise<Extract<AgentInferenceAttemptResult, { readonly status: 'uncertain' }>> {
  return {
    status: 'uncertain',
    reason,
    recoveryDecisionId: await deriveStableAgentId(
      'inference-recovery',
      request.commandId,
      request.runId,
      request.turnId,
      request.attemptId
    ),
    allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
  };
}

function settledResult(
  run: AgentRun,
  turn: AgentTurn,
  attempt: AgentInferenceAttempt
): AgentInferenceDispatchResult {
  return {
    run,
    turn,
    attempt,
    command: null,
    status: attempt.state.status,
    alreadySettled: true
  };
}

function requireTurn(run: AgentRun, turnId: string): AgentTurn {
  const turn = run.turns.find((candidate) => candidate.turnId === turnId);
  if (turn === undefined) {
    throw new AgentRunTransitionError(
      `Turn "${turnId}" does not belong to Run "${run.runId}".`
    );
  }
  return turn;
}

function requireAttempt(turn: AgentTurn, attemptId: string): AgentInferenceAttempt {
  const attempt = turn.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (attempt === undefined) {
    throw new AgentRunTransitionError(
      `Inference attempt "${attemptId}" does not belong to Turn "${turn.turnId}".`
    );
  }
  return attempt;
}

function isKnownTerminalAttempt(attempt: AgentInferenceAttempt): boolean {
  return attempt.state.status === 'succeeded'
    || attempt.state.status === 'failed'
    || attempt.state.status === 'cancelled';
}

function recoveryRequired(
  request: DispatchAgentInferenceRequest
): AgentInferenceDispatchRecoveryRequiredError {
  return new AgentInferenceDispatchRecoveryRequiredError(
    request.runId,
    request.turnId,
    request.attemptId
  );
}

function assertDispatchRequest(request: DispatchAgentInferenceRequest): void {
  assertCanonicalPublicId(request.commandId, 'dispatch.commandId');
  assertCanonicalPublicId(request.runId, 'dispatch.runId');
  assertCanonicalPublicId(request.turnId, 'dispatch.turnId');
  assertCanonicalPublicId(request.attemptId, 'dispatch.attemptId');
  assertPositiveInteger(request.expectedVersion, 'dispatch.expectedVersion');
  assertTimestamp(request.occurredAt, 'dispatch.occurredAt');
}
