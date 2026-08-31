import { AgentCoreError, AgentRunCommandService } from '@ariadne/agent-core';

import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  AgentDecisionAuthorityError,
  AgentDecisionAuthorityService
} from '../../../../control/run/AgentDecisionAuthorityService.js';
import type { RuntimeCommandReconciliation } from '../../../../control/ports/RuntimeCommandJournal.js';
import type { RuntimeApplicationCommandResult } from '../../../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import { completedPublicError, publicRunMutationFailure } from '../../../AgentPublicCommandFailures.js';
import type { AgentControlExecutionPipeline } from '../../../ProductionAgentControlExecutionPipelineFactory.js';

type DecisionCommand = Extract<RuntimeCommandEnvelope['command'], {
  readonly kind: 'agent.decision.resolve.v3';
}>;

type CancelCommand = Extract<RuntimeCommandEnvelope['command'], {
  readonly kind: 'agent.run.cancel.v3';
}>;

export interface AgentRunControlComponentInput {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly executionPipeline?: AgentControlExecutionPipeline;
  readonly wakeProjectionDrain: () => void;
  readonly decisionCommandNow?: () => Date;
}

export interface AgentRunControlComponentHandle {
  executeDecision(
    envelope: RuntimeCommandEnvelope,
    command: DecisionCommand
  ): Promise<RuntimeApplicationCommandResult>;
  reconcileDecision(
    envelope: RuntimeCommandEnvelope,
    command: DecisionCommand
  ): Promise<RuntimeCommandReconciliation>;
  executeCancellation(
    envelope: RuntimeCommandEnvelope,
    command: CancelCommand
  ): Promise<RuntimeApplicationCommandResult>;
}

export function createAgentRunControlComponent(
  input: AgentRunControlComponentInput
): AgentRunControlComponentHandle {
  return new DefaultAgentRunControlComponent(input);
}

class DefaultAgentRunControlComponent implements AgentRunControlComponentHandle {
  private readonly decisions: AgentDecisionAuthorityService;
  private readonly commands: AgentRunCommandService;

  public constructor(private readonly input: AgentRunControlComponentInput) {
    this.decisions = new AgentDecisionAuthorityService(
      input.unitOfWork,
      input.decisionCommandNow
    );
    this.commands = new AgentRunCommandService(input.unitOfWork);
  }

  public async reconcileDecision(
    envelope: RuntimeCommandEnvelope,
    command: DecisionCommand
  ): Promise<RuntimeCommandReconciliation> {
    const result = await this.decisions.reconcile({
      commandId: envelope.commandId,
      command,
      signal: envelope.signal
    });
    return result === null
      ? { kind: 'not_committed' }
      : { kind: 'committed', outcome: { ok: true, result } };
  }

  public async executeDecision(
    envelope: RuntimeCommandEnvelope,
    command: DecisionCommand
  ): Promise<RuntimeApplicationCommandResult> {
    let result;
    try {
      result = await this.decisions.execute({
        commandId: envelope.commandId,
        command,
        signal: envelope.signal
      });
    } catch (error) {
      envelope.signal.throwIfAborted();
      const replay = await this.decisions.reconcile({
        commandId: envelope.commandId,
        command,
        signal: envelope.signal
      });
      if (replay !== null) result = replay;
      else {
        const failure = publicDecisionFailure(envelope, error);
        if (failure !== null) return failure;
        throw error;
      }
    }
    this.input.executionPipeline?.runWorkScheduler.wake();
    this.input.wakeProjectionDrain();
    return { outcome: { ok: true, result }, settlement: 'completed' };
  }

  public async executeCancellation(
    envelope: RuntimeCommandEnvelope,
    command: CancelCommand
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const replayed = await this.loadCommittedCancellation(envelope.commandId, command.runId);
    if (replayed !== null) return cancellationResult(replayed.runId, replayed.runVersion);

    const active = await this.input.executionPipeline?.executionScheduler.cancelActiveRun({
      commandId: envelope.commandId,
      runId: command.runId,
      expectedVersion: command.expectedVersion,
      finalize: async (recovery) => {
        const snapshot = await this.input.unitOfWork.transaction((transaction) => (
          transaction.loadRun(recovery.runId)
        ));
        if (
          snapshot === null
          || snapshot.version !== recovery.runVersion
          || snapshot.state.status !== 'recovering'
          || snapshot.state.reason !== 'uncertain_inference'
        ) {
          throw new Error('agent_run_active_cancellation_recovery_drifted');
        }
        const occurredAt = new Date(Math.max(
          Date.parse(command.occurredAt), Date.parse(snapshot.updatedAt)
        )).toISOString();
        const committed = await this.commands.execute({
          kind: 'run.cancel',
          commandId: envelope.commandId,
          runId: recovery.runId,
          expectedVersion: recovery.runVersion,
          occurredAt,
          reason: command.reason,
          recoveryDecisionId: recovery.recoveryDecisionId
        }, { turnInputPayloads: [], effectPayloads: [] });
        return { runVersion: committed.run.version };
      }
    }) ?? { status: 'not_active' as const };
    if (active.status === 'cancelled') {
      this.wakeRunAndProjection();
      return cancellationResult(command.runId, active.runVersion);
    }

    let result;
    try {
      result = await this.commands.execute({
        kind: 'run.cancel',
        commandId: envelope.commandId,
        runId: command.runId,
        expectedVersion: command.expectedVersion,
        occurredAt: command.occurredAt,
        reason: command.reason
      }, { turnInputPayloads: [], effectPayloads: [] });
    } catch (error) {
      envelope.signal.throwIfAborted();
      const failure = publicRunMutationFailure(envelope, error);
      if (failure !== null) return failure;
      throw error;
    }
    this.wakeRunAndProjection();
    return cancellationResult(result.run.runId, result.run.version);
  }

  private wakeRunAndProjection(): void {
    this.input.executionPipeline?.runWorkScheduler.wake();
    this.input.wakeProjectionDrain();
  }

  private async loadCommittedCancellation(
    commandId: string,
    runId: string
  ): Promise<{ readonly runId: string; readonly runVersion: number } | null> {
    const receipt = await this.input.unitOfWork.loadCommittedCommandReceipt(commandId);
    if (receipt === null) return null;
    const mutation = receipt.mutations[0];
    const cancellation = mutation?.events.filter(
      (event) => event.payload.type === 'run.cancelled'
    );
    if (
      receipt.commandId !== commandId
      || receipt.mutations.length !== 1
      || mutation === undefined
      || mutation.runId !== runId
      || mutation.run.runId !== runId
      || mutation.resultingVersion !== mutation.run.version
      || mutation.run.state.status !== 'cancelled'
      || cancellation?.length !== 1
    ) {
      throw new Error('agent_run_cancel_receipt_invalid');
    }
    return { runId, runVersion: mutation.run.version };
  }
}

function cancellationResult(
  runId: string,
  runVersion: number
): RuntimeApplicationCommandResult {
  return {
    outcome: { ok: true, result: { kind: 'agent.run.cancelled.v3', runId, runVersion } },
    settlement: 'completed'
  };
}

function publicDecisionFailure(
  envelope: RuntimeCommandEnvelope,
  error: unknown
): RuntimeApplicationCommandResult | null {
  if (error instanceof AgentDecisionAuthorityError) {
    if (error.code === 'AGENT_DECISION_AUTHORITY_RUN_NOT_FOUND') {
      return completedPublicError(
        envelope, 'agent_run_not_found', 'The authoritative Agent Run does not exist.', false
      );
    }
    if (error.code === 'AGENT_DECISION_AUTHORITY_NOT_ACTIVE') {
      return completedPublicError(
        envelope, 'agent_decision_not_active', 'The Decision is no longer active.', false
      );
    }
    if (
      error.code === 'AGENT_DECISION_AUTHORITY_TOKEN_MISMATCH'
      || error.code === 'AGENT_DECISION_AUTHORITY_CHOICE_INVALID'
      || error.code === 'AGENT_DECISION_AUTHORITY_INVALID'
    ) {
      return completedPublicError(
        envelope, 'agent_decision_action_invalid',
        'The Decision action is not authorized by the current projection.', false
      );
    }
    return null;
  }
  if (error instanceof AgentCoreError && error.code === 'AGENT_RUN_VERSION_CONFLICT') {
    return completedPublicError(
      envelope, 'agent_run_version_conflict',
      'The Agent Run changed before this Decision was applied.', false
    );
  }
  if (error instanceof AgentCoreError && error.code === 'AGENT_RUN_NOT_FOUND') {
    return completedPublicError(
      envelope, 'agent_run_not_found', 'The authoritative Agent Run does not exist.', false
    );
  }
  return null;
}
