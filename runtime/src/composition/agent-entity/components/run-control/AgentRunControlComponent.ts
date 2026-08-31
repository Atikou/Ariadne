import { AgentRunCommandService } from '@ariadne/agent-core';

import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { RuntimeApplicationCommandResult } from '../../../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import { publicRunMutationFailure } from '../../../AgentPublicCommandFailures.js';
import type { AgentControlExecutionPipeline } from '../../../ProductionAgentControlExecutionPipelineFactory.js';
import {
  defineAgentPublicCommandOwner,
  type AgentPublicCommandOwner
} from '../../command-owners/AgentPublicCommandOwnerTable.js';

type CancelCommand = Extract<RuntimeCommandEnvelope['command'], {
  readonly kind: 'agent.run.cancel.v3';
}>;

export interface AgentRunControlComponentInput {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly executionPipeline?: AgentControlExecutionPipeline;
  readonly wakeProjectionDrain: () => void;
}

export interface AgentRunControlComponentHandle {
  commandOwners(): readonly AgentPublicCommandOwner[];
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
  private readonly commands: AgentRunCommandService;

  public constructor(private readonly input: AgentRunControlComponentInput) {
    this.commands = new AgentRunCommandService(input.unitOfWork);
  }

  public commandOwners(): readonly AgentPublicCommandOwner[] {
    return Object.freeze([
      defineAgentPublicCommandOwner('agent.run', [
        'agent.run.cancel.v3'
      ], (envelope, command) => this.executeCancellation(envelope, command),
      async (envelope, command) => {
        const result = await this.executeCancellation(envelope, command);
        if (result.settlement !== 'completed') {
          throw new Error('agent_run_cancel_reconciliation_invalid');
        }
        return result.outcome.ok
          ? { kind: 'committed', outcome: result.outcome }
          : { kind: 'not_committed' };
      })
    ]);
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
