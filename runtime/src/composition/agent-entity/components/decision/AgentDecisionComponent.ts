import { AgentCoreError } from '@ariadne/agent-core';

import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  AgentDecisionAuthorityError,
  AgentDecisionAuthorityService
} from '../../../../control/run/AgentDecisionAuthorityService.js';
import type { RuntimeCommandReconciliation } from '../../../../control/ports/RuntimeCommandJournal.js';
import type { RuntimeApplicationCommandResult } from '../../../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import { completedPublicError } from '../../../AgentPublicCommandFailures.js';
import type { AgentControlExecutionPipeline } from '../../../ProductionAgentControlExecutionPipelineFactory.js';
import {
  defineAgentPublicCommandOwner,
  type AgentPublicCommandOwner
} from '../../command-owners/AgentPublicCommandOwnerTable.js';

type DecisionCommand = Extract<RuntimeCommandEnvelope['command'], {
  readonly kind: 'agent.decision.resolve.v3';
}>;

export interface AgentDecisionComponentInput {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly executionPipeline?: AgentControlExecutionPipeline;
  readonly wakeProjectionDrain: () => void;
  readonly commandNow?: () => Date;
}

export interface AgentDecisionComponentHandle {
  commandOwners(): readonly AgentPublicCommandOwner[];
}

/** Owns every public Plan, permission, question, and recovery Decision mutation. */
export function createAgentDecisionComponent(
  input: AgentDecisionComponentInput
): AgentDecisionComponentHandle {
  const decisions = new AgentDecisionAuthorityService(input.unitOfWork, input.commandNow);

  const reconcile = async (
    envelope: RuntimeCommandEnvelope,
    command: DecisionCommand
  ): Promise<RuntimeCommandReconciliation> => {
    const result = await decisions.reconcile({
      commandId: envelope.commandId,
      command,
      signal: envelope.signal
    });
    return result === null
      ? { kind: 'not_committed' }
      : { kind: 'committed', outcome: { ok: true, result } };
  };

  const execute = async (
    envelope: RuntimeCommandEnvelope,
    command: DecisionCommand
  ): Promise<RuntimeApplicationCommandResult> => {
    let result;
    try {
      result = await decisions.execute({
        commandId: envelope.commandId,
        command,
        signal: envelope.signal
      });
    } catch (error) {
      envelope.signal.throwIfAborted();
      const replay = await decisions.reconcile({
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
    input.executionPipeline?.runWorkScheduler.wake();
    input.wakeProjectionDrain();
    return { outcome: { ok: true, result }, settlement: 'completed' };
  };

  return Object.freeze({
    commandOwners: (): readonly AgentPublicCommandOwner[] => Object.freeze([
      defineAgentPublicCommandOwner('agent.decision', [
        'agent.decision.resolve.v3'
      ], execute, reconcile)
    ])
  });
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
