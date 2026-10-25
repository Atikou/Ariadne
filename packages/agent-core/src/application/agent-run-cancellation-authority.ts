import type { AgentRun } from '../domain/agent-run.js';
import { AgentRunAncestorCancellationError, AgentRunInvariantError, AgentRunTransitionError } from '../domain/errors.js';
import type { AgentRunTransaction } from './unit-of-work.js';

/** Checks the required lineage in the same transaction as the external start commit. */
export async function cancellingAgentRunAncestor(transaction: AgentRunTransaction, run: AgentRun): Promise<string | null> {
  const seen = new Set<string>([run.runId]);
  let current = run;
  while (current.binding.objectiveRef.kind === 'parent_delegation') {
    const objective = current.binding.objectiveRef;
    const delegation = await transaction.loadDelegationByChild?.(current.runId);
    if (delegation === null || delegation === undefined || delegation.parentRunId !== objective.parentRunId
      || delegation.delegationId !== objective.delegationId) throw new AgentRunInvariantError('Cancellation lineage has no exact Delegation authority.');
    if (!delegation.required) return null;
    if (seen.has(objective.parentRunId) || seen.size > 256) throw new AgentRunInvariantError('Cancellation lineage is cyclic or exceeds its bound.');
    seen.add(objective.parentRunId);
    const parent = await transaction.loadRun(objective.parentRunId);
    if (parent === null) throw new AgentRunInvariantError('Cancellation lineage has no parent Run.');
    if (parent.state.status === 'cancelling' || parent.state.status === 'cancelled') return parent.runId;
    current = parent;
  }
  return null;
}

export async function assertAgentRunExternalStartAllowed(transaction: AgentRunTransaction, run: AgentRun): Promise<void> {
  if (run.cancellationRequest !== undefined) throw new AgentRunTransitionError('A Run with a durable cancellation request cannot start external work.');
  const ancestor = await cancellingAgentRunAncestor(transaction, run);
  if (ancestor !== null) throw new AgentRunAncestorCancellationError(run.runId, ancestor);
}
