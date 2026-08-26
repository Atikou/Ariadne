import {
  AgentRunCommandService,
  AgentRunInvariantError,
  AgentRunVersionConflictError,
  assertValidAgentRun,
  deriveStableAgentId,
  type AgentRun,
  type AgentRunCheckpointCommit,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';

import {
  classifyAgentRunWork,
  type AgentRunWorkClassification
} from './AgentRunWorkClassifier.js';

export type AgentSettledEffectBatchTerminalWork = Extract<
  AgentRunWorkClassification,
  { readonly kind: 'fail_model_turn_budget' | 'fail_deadline_expired' }
>;

export type AgentSettledEffectBatchTerminalFailureReason =
  | 'model_turn_budget_exhausted'
  | 'deadline_expired';

export interface AgentSettledEffectBatchTerminalizationReceiptV1 {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly checkpointVersion: number;
  readonly status: 'failed';
  readonly reason: AgentSettledEffectBatchTerminalFailureReason;
  readonly errorCode:
    | 'agent_model_turn_budget_exhausted'
    | 'agent_run_deadline_expired';
  readonly replayed: boolean;
}

interface FailureSpec {
  readonly reason: AgentSettledEffectBatchTerminalFailureReason;
  readonly errorCode: AgentSettledEffectBatchTerminalizationReceiptV1['errorCode'];
  readonly message: string;
}

/**
 * Terminal owner for a settled Effect batch that cannot legally introduce
 * another model Turn. It performs no provider or Tool I/O and commits one
 * stable `run.fail` command with a bounded v3 checkpoint.
 */
export class AgentSettledEffectBatchTerminalizationCoordinator {
  private readonly commands: AgentRunCommandService;

  public constructor(private readonly runs: AgentRunUnitOfWork) {
    this.commands = new AgentRunCommandService(runs);
  }

  public async terminalize(
    work: AgentSettledEffectBatchTerminalWork,
    signal: AbortSignal
  ): Promise<AgentSettledEffectBatchTerminalizationReceiptV1> {
    signal.throwIfAborted();
    const run = await this.runs.transaction((transaction) => (
      transaction.loadRun(work.runId)
    ));
    if (run === null) {
      throw new AgentRunVersionConflictError(
        work.runId,
        work.expectedVersion,
        null
      );
    }
    if (run.version !== work.expectedVersion) {
      throw new AgentRunVersionConflictError(
        run.runId,
        work.expectedVersion,
        run.version
      );
    }
    assertValidAgentRun(run);
    assertExactTerminalWork(run, work);

    const failure = failureSpec(work);
    const commandId = await deriveStableAgentId(
      'settled-effect-batch-failure',
      run.runId,
      work.sourceTurnId,
      work.sourceAttemptId,
      work.sourceDirectiveDigest,
      failure.reason
    );
    const occurredAt = run.updatedAt;
    const checkpoint = createTerminalCheckpoint(run, work, failure, occurredAt);

    signal.throwIfAborted();
    const committed = await this.commands.execute({
      kind: 'run.fail',
      commandId,
      runId: run.runId,
      expectedVersion: run.version,
      occurredAt,
      errorCode: failure.errorCode,
      message: failure.message
    }, {
      checkpoint,
      turnInputPayloads: [],
      effectPayloads: []
    });
    if (
      committed.run.state.status !== 'failed'
      || committed.run.state.errorCode !== failure.errorCode
      || committed.run.state.message !== failure.message
      || committed.run.state.checkpointVersion !== checkpoint.checkpointVersion
    ) {
      throw invariant(
        'Settled Effect-batch terminalization returned a contradictory receipt.'
      );
    }
    return {
      receiptVersion: 1,
      commandId,
      runId: committed.run.runId,
      runVersion: committed.run.version,
      checkpointVersion: committed.run.state.checkpointVersion,
      status: 'failed',
      reason: failure.reason,
      errorCode: failure.errorCode,
      replayed: committed.replayed
    };
  }
}

function assertExactTerminalWork(
  run: AgentRun,
  work: AgentSettledEffectBatchTerminalWork
): void {
  const classified = classifyAgentRunWork(run);
  if (
    classified.kind !== work.kind
    || classified.runId !== work.runId
    || classified.expectedVersion !== work.expectedVersion
    || classified.checkpointVersion !== work.checkpointVersion
    || classified.sourceTurnId !== work.sourceTurnId
    || classified.sourceAttemptId !== work.sourceAttemptId
    || classified.sourceDirectiveDigest !== work.sourceDirectiveDigest
    || !sameIds(classified.effectIds, work.effectIds)
    || !sameIds(classified.toolCallIds, work.toolCallIds)
    || (
      classified.kind === 'fail_model_turn_budget'
      && work.kind === 'fail_model_turn_budget'
      && (
        classified.observedModelTurns !== work.observedModelTurns
        || classified.modelTurnLimit !== work.modelTurnLimit
      )
    )
    || (
      classified.kind === 'fail_deadline_expired'
      && work.kind === 'fail_deadline_expired'
      && (
        classified.deadlineAt !== work.deadlineAt
        || classified.observedAt !== work.observedAt
      )
    )
  ) {
    throw invariant(
      'Settled Effect-batch terminalization identity drifted from the aggregate.'
    );
  }
}

function failureSpec(work: AgentSettledEffectBatchTerminalWork): FailureSpec {
  return work.kind === 'fail_model_turn_budget'
    ? {
        reason: 'model_turn_budget_exhausted',
        errorCode: 'agent_model_turn_budget_exhausted',
        message:
          'The immutable Agent Run model-turn budget was exhausted after the Effect batch settled.'
      }
    : {
        reason: 'deadline_expired',
        errorCode: 'agent_run_deadline_expired',
        message:
          'The immutable Agent Run deadline expired after the Effect batch settled.'
      };
}

function createTerminalCheckpoint(
  run: AgentRun,
  work: AgentSettledEffectBatchTerminalWork,
  failure: FailureSpec,
  occurredAt: string
): AgentRunCheckpointCommit {
  return {
    checkpointVersion: run.state.checkpointVersion + 1,
    createdAt: occurredAt,
    payload: {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: {
        phase: 'effect_results_terminalized',
        reason: failure.reason,
        sourceTurnId: work.sourceTurnId,
        sourceAttemptId: work.sourceAttemptId,
        sourceDirectiveDigest: work.sourceDirectiveDigest,
        effectIds: [...work.effectIds],
        toolCallIds: [...work.toolCallIds]
      },
      modelContext: null
    }
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
