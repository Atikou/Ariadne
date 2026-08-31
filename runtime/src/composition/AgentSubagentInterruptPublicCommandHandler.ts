import { AgentRunCommandService } from '@ariadne/agent-core';

import type { SqliteAgentRunUnitOfWork } from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import type { AgentControlExecutionPipeline } from './ProductionAgentControlExecutionPipelineFactory.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';
import {
  defineAgentPublicCommandOwner,
  type AgentPublicCommandOwner
} from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';

type InterruptCommand = Extract<
  RuntimeCommandEnvelope['command'],
  { readonly kind: 'agent.subagent.interrupt.v3' }
>;

/** Owns direct-parent authorization and exact active-Turn interruption recovery. */
export class AgentSubagentInterruptPublicCommandHandler {
  private readonly commands: AgentRunCommandService;

  public constructor(
    private readonly unitOfWork: SqliteAgentRunUnitOfWork,
    private readonly executionPipeline: AgentControlExecutionPipeline | undefined,
    private readonly wakeProjectionDrain: () => void
  ) {
    this.commands = new AgentRunCommandService(unitOfWork);
  }

  public async execute(
    envelope: RuntimeCommandEnvelope,
    command: InterruptCommand
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const replayed = await this.loadCommitted(envelope.commandId, command.childRunId);
    if (replayed !== null) {
      return completed(command.parentRunId, replayed, 'active');
    }
    const authority = await this.unitOfWork.transaction(async (transaction) => ({
      parent: await transaction.loadRun(command.parentRunId),
      child: await transaction.loadRun(command.childRunId)
    }));
    const { parent, child } = authority;
    if (
      parent === null
      || child === null
      || parent.binding.sessionId !== command.sessionId
      || child.binding.sessionId !== command.sessionId
      || child.binding.objectiveRef.kind !== 'parent_delegation'
      || child.binding.objectiveRef.parentRunId !== parent.runId
    ) {
      return completedPublicError(
        envelope,
        'subagent_interrupt_not_authorized',
        'Only the direct parent may interrupt this SubAgent.',
        false
      );
    }
    if (child.binding.objectiveRef.mode !== 'continuable' || isTerminal(child.state.status)) {
      return completed(parent.runId, {
        runId: child.runId,
        runVersion: child.version
      }, 'inactive');
    }
    if (child.version !== command.expectedChildVersion) {
      return completedPublicError(
        envelope,
        'agent_run_version_conflict',
        'The SubAgent changed before the interruption was accepted.',
        true
      );
    }
    const finalize = async (recovery: {
      readonly runId: string;
      readonly runVersion: number;
      readonly turnId: string;
      readonly attemptId: string;
      readonly recoveryDecisionId: string;
    }) => {
      const snapshot = await this.unitOfWork.transaction((transaction) => (
        transaction.loadRun(recovery.runId)
      ));
      if (
        snapshot === null
        || snapshot.version !== recovery.runVersion
        || snapshot.state.status !== 'recovering'
        || snapshot.state.reason !== 'uncertain_inference'
        || snapshot.state.turnId !== recovery.turnId
        || snapshot.state.attemptId !== recovery.attemptId
      ) throw new Error('agent_subagent_interruption_recovery_drifted');
      const committed = await this.commands.execute({
        kind: 'run.interrupt_continuable_turn',
        commandId: envelope.commandId,
        runId: recovery.runId,
        expectedVersion: recovery.runVersion,
        occurredAt: new Date(Math.max(
          Date.parse(command.occurredAt),
          Date.parse(snapshot.updatedAt)
        )).toISOString(),
        reason: command.reason,
        recoveryDecisionId: recovery.recoveryDecisionId
      }, { turnInputPayloads: [], effectPayloads: [] });
      return { runId: committed.run.runId, runVersion: committed.run.version };
    };
    const active = await this.executionPipeline?.runWorkScheduler.interruptActiveTurn({
      commandId: envelope.commandId,
      runId: child.runId,
      expectedVersion: child.version,
      finalize
    }) ?? { status: 'not_active' as const };
    if (active.status === 'interrupted') {
      this.wakeProjectionDrain();
      return completed(parent.runId, {
        runId: child.runId,
        runVersion: active.runVersion
      }, 'active');
    }
    if (child.state.status === 'recovering' && child.state.reason === 'uncertain_inference') {
      const recoveryState = child.state;
      const recoveryAttempt = child.turns
        .find((turn) => turn.turnId === recoveryState.turnId)?.attempts
        .find((attempt) => attempt.attemptId === recoveryState.attemptId);
      if (
        recoveryAttempt?.state.status !== 'uncertain'
        || !recoveryAttempt.state.recovery.allowedActions.includes('interrupt_turn')
      ) throw new Error('agent_subagent_interruption_recovery_invalid');
      const settled = await finalize({
        runId: child.runId,
        runVersion: child.version,
        turnId: recoveryState.turnId,
        attemptId: recoveryState.attemptId,
        recoveryDecisionId: recoveryAttempt.state.recovery.decisionId
      });
      this.wakeProjectionDrain();
      return completed(parent.runId, settled, 'active');
    }
    const current = await this.unitOfWork.transaction((transaction) => (
      transaction.loadRun(child.runId)
    ));
    if (current === null) {
      return completed(parent.runId, {
        runId: child.runId,
        runVersion: child.version
      }, 'inactive');
    }
    return completed(parent.runId, {
      runId: current.runId,
      runVersion: current.version
    }, isTerminal(current.state.status) ? 'inactive' : 'idle');
  }

  public commandOwners(): readonly AgentPublicCommandOwner[] {
    return Object.freeze([
      defineAgentPublicCommandOwner('agent.subagent-interrupt', [
        'agent.subagent.interrupt.v3'
      ], (envelope, command) => this.execute(envelope, command),
      async (envelope, command) => {
        const result = await this.execute(envelope, command);
        if (result.settlement !== 'completed') {
          throw new Error('agent_subagent_interrupt_reconciliation_invalid');
        }
        return result.outcome.ok
          ? { kind: 'committed', outcome: result.outcome }
          : { kind: 'not_committed' };
      })
    ]);
  }

  private async loadCommitted(
    commandId: string,
    childRunId: string
  ): Promise<{ readonly runId: string; readonly runVersion: number } | null> {
    const receipt = await this.unitOfWork.loadCommittedCommandReceipt(commandId);
    if (receipt === null) return null;
    const mutation = receipt.mutations[0];
    const event = mutation?.events.find(
      (candidate) => candidate.payload.type === 'run.inference_turn_interrupted'
    );
    if (
      receipt.mutations.length !== 1
      || mutation === undefined
      || mutation.runId !== childRunId
      || event === undefined
    ) throw new Error('agent_subagent_interrupt_receipt_invalid');
    return { runId: childRunId, runVersion: mutation.run.version };
  }
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function completed(
  parentRunId: string,
  child: { readonly runId: string; readonly runVersion: number },
  previousStatus: 'active' | 'idle' | 'inactive'
): RuntimeApplicationCommandResult {
  return {
    outcome: {
      ok: true,
      result: {
        kind: 'agent.subagent.interrupted.v3',
        parentRunId,
        childRunId: child.runId,
        childRunVersion: child.runVersion,
        previousStatus
      }
    },
    settlement: 'completed'
  };
}
