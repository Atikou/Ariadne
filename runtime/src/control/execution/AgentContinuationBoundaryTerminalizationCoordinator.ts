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

export type AgentContinuationBoundaryTerminalWork = Extract<
  AgentRunWorkClassification,
  { readonly kind: 'fail_model_turn_budget' | 'fail_deadline_expired' }
>;

export type AgentContinuationBoundaryTerminalFailureReason =
  | 'model_turn_budget_exhausted'
  | 'deadline_expired';

export interface AgentContinuationBoundaryTerminalizationReceiptV1 {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly checkpointVersion: number;
  readonly status: 'failed';
  readonly reason: AgentContinuationBoundaryTerminalFailureReason;
  readonly errorCode:
    | 'agent_model_turn_budget_exhausted'
    | 'agent_run_deadline_expired';
  readonly replayed: boolean;
}

interface FailureSpec {
  readonly reason: AgentContinuationBoundaryTerminalFailureReason;
  readonly errorCode: AgentContinuationBoundaryTerminalizationReceiptV1['errorCode'];
  readonly message: string;
}

/**
 * Terminal owner for a settled Effect or inbox response boundary that cannot
 * legally introduce another model Turn. It performs no Provider or Tool I/O
 * and commits one stable `run.fail` command with bounded recovery evidence.
 */
export class AgentContinuationBoundaryTerminalizationCoordinator {
  private readonly commands: AgentRunCommandService;

  public constructor(private readonly runs: AgentRunUnitOfWork) {
    this.commands = new AgentRunCommandService(runs);
  }

  public async terminalize(
    work: AgentContinuationBoundaryTerminalWork,
    signal: AbortSignal
  ): Promise<AgentContinuationBoundaryTerminalizationReceiptV1> {
    signal.throwIfAborted();
    const run = await this.runs.transaction((transaction) => (
      transaction.loadRun(work.runId)
    ));
    if (run === null) {
      throw new AgentRunVersionConflictError(work.runId, work.expectedVersion, null);
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
      'continuation-boundary-failure',
      run.runId,
      ...boundaryIdentity(work),
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
        'Continuation-boundary terminalization returned a contradictory receipt.'
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
  work: AgentContinuationBoundaryTerminalWork
): void {
  const classified = classifyAgentRunWork(run);
  if (
    (classified.kind !== 'fail_model_turn_budget'
      && classified.kind !== 'fail_deadline_expired')
    || classified.kind !== work.kind
    || classified.runId !== work.runId
    || classified.expectedVersion !== work.expectedVersion
    || classified.checkpointVersion !== work.checkpointVersion
    || !sameBoundary(classified, work)
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
      'Continuation-boundary terminalization identity drifted from the aggregate.'
    );
  }
}

function failureSpec(work: AgentContinuationBoundaryTerminalWork): FailureSpec {
  const suffix = work.boundaryKind === 'effect_results'
    ? ' after the Effect batch settled.'
    : ' before queued inbox inputs could be claimed.';
  return work.kind === 'fail_model_turn_budget'
    ? {
        reason: 'model_turn_budget_exhausted',
        errorCode: 'agent_model_turn_budget_exhausted',
        message: `The immutable Agent Run model-turn budget was exhausted${suffix}`
      }
    : {
        reason: 'deadline_expired',
        errorCode: 'agent_run_deadline_expired',
        message: `The immutable Agent Run deadline expired${suffix}`
      };
}

function createTerminalCheckpoint(
  run: AgentRun,
  work: AgentContinuationBoundaryTerminalWork,
  failure: FailureSpec,
  occurredAt: string
): AgentRunCheckpointCommit {
  return {
    checkpointVersion: run.state.checkpointVersion + 1,
    createdAt: occurredAt,
    payload: {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: work.boundaryKind === 'effect_results'
        ? {
            phase: 'effect_results_terminalized',
            reason: failure.reason,
            sourceTurnId: work.sourceTurnId,
            sourceAttemptId: work.sourceAttemptId,
            sourceDirectiveDigest: work.sourceDirectiveDigest,
            effectIds: [...work.effectIds],
            toolCallIds: [...work.toolCallIds]
          }
        : {
            phase: 'inbox_inputs_terminalized',
            reason: failure.reason,
            sourceTurnId: work.sourceTurnId,
            sourceAttemptId: work.sourceAttemptId,
            sourceDirectiveDigest: work.sourceDirectiveDigest,
            inputIds: [...work.inputIds]
          },
      modelContext: null
    }
  };
}

function sameBoundary(
  left: AgentContinuationBoundaryTerminalWork,
  right: AgentContinuationBoundaryTerminalWork
): boolean {
  if (
    left.boundaryKind !== right.boundaryKind
    || left.sourceTurnId !== right.sourceTurnId
    || left.sourceAttemptId !== right.sourceAttemptId
    || left.sourceDirectiveDigest !== right.sourceDirectiveDigest
  ) return false;
  return left.boundaryKind === 'effect_results' && right.boundaryKind === 'effect_results'
    ? sameIds(left.effectIds, right.effectIds)
      && sameIds(left.toolCallIds, right.toolCallIds)
    : left.boundaryKind === 'inbox_inputs' && right.boundaryKind === 'inbox_inputs'
      && sameIds(left.inputIds, right.inputIds);
}

function boundaryIdentity(work: AgentContinuationBoundaryTerminalWork): readonly string[] {
  return work.boundaryKind === 'effect_results'
    ? [
        work.boundaryKind,
        work.sourceTurnId,
        work.sourceAttemptId,
        work.sourceDirectiveDigest,
        ...work.effectIds,
        ...work.toolCallIds
      ]
    : [
        work.boundaryKind,
        work.sourceTurnId,
        work.sourceAttemptId,
        work.sourceDirectiveDigest,
        ...work.inputIds
      ];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
