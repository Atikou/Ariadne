import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { RuntimeApplicationCommandResult } from '../../../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import { publicRunMutationFailure } from '../../../AgentPublicCommandFailures.js';
import type { AgentControlExecutionPipeline } from '../../../ProductionAgentControlExecutionPipelineFactory.js';
import { AgentRunCancellationService } from './AgentRunCancellationService.js';
import type { AgentRunCancellationOwner, AgentRunCancellationReceipt } from './AgentRunCancellationContracts.js';
import {
  defineAgentPublicCommandOwner,
  type AgentPublicCommandOwner
} from '../../command-owners/AgentPublicCommandOwnerTable.js';

type CancelCommand = Extract<RuntimeCommandEnvelope['command'], {
  readonly kind: 'agent.run.cancel';
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
  private readonly cancellations: AgentRunCancellationOwner;

  public constructor(private readonly input: AgentRunControlComponentInput) {
    this.cancellations = input.executionPipeline?.cancellations
      ?? new AgentRunCancellationService(input.unitOfWork, input.executionPipeline);
  }

  public commandOwners(): readonly AgentPublicCommandOwner[] {
    return Object.freeze([
      defineAgentPublicCommandOwner('agent.run', [
        'agent.run.cancel'
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
    let result;
    try {
      result = await this.cancellations.cancel(envelope.commandId, command);
    } catch (error) {
      envelope.signal.throwIfAborted();
      const failure = publicRunMutationFailure(envelope, error);
      if (failure !== null) return failure;
      throw error;
    }
    this.wakeRunAndProjection();
    return cancellationResult(result);
  }

  private wakeRunAndProjection(): void {
    this.input.executionPipeline?.runWorkScheduler.wake();
    this.cancellations.wake();
    this.input.wakeProjectionDrain();
  }
}

function cancellationResult(
  receipt: AgentRunCancellationReceipt
): RuntimeApplicationCommandResult {
  return {
    outcome: { ok: true, result: { kind: receipt.status === 'cancelled'
      ? 'agent.run.cancelled' : 'agent.run.cancellation.requested', runId: receipt.runId, runVersion: receipt.runVersion } },
    settlement: 'completed'
  };
}
