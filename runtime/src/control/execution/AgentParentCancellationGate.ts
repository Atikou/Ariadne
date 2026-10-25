import { cancellingAgentRunAncestor, type AgentRun, type AgentRunUnitOfWork } from '@ariadne/agent-core';

/** Avoids claiming new work for descendants awaiting their cancellation owner. */
export class AgentParentCancellationGate {
  public constructor(private readonly unit: AgentRunUnitOfWork) {}
  public isSuppressed(run: AgentRun): Promise<boolean> {
    if (run.cancellationRequest !== undefined) return Promise.resolve(true);
    return this.unit.transaction(async transaction => (await cancellingAgentRunAncestor(transaction, run)) !== null);
  }
}
