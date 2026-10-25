import { assertAgentRunInboxOnlyMutation, deriveStableAgentId, type AgentRunCommandService } from '@ariadne/agent-core';
import type { AgentRunExecutionDispatchReceiptV1, AgentRunExecutionNotStartedEvidence } from '../../../../control/execution/AgentRunExecutionDispatchController.js';
import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import type { AgentInferenceCancellationEngines } from './AgentRunCancellationContracts.js';

type CancelCommand = Extract<RuntimeCommandEnvelope['command'], { readonly kind: 'agent.run.cancel' }>;

/** Joins the inference owner before resolving its exact durable uncertainty into cancellation. */
export async function cancelActiveAgentInference(
  unit: SqliteAgentRunUnitOfWork,
  commands: AgentRunCommandService,
  pipeline: AgentInferenceCancellationEngines | undefined,
  commandId: string,
  command: CancelCommand
): Promise<number | null> {
  if (pipeline === undefined) return null;
  const finalizeUnstarted = async (
    evidence: AgentRunExecutionNotStartedEvidence
  ): Promise<AgentRunExecutionDispatchReceiptV1> => {
    const committed = await unit.transaction(async transaction => {
      const snapshot = await transaction.loadRun(evidence.runId);
      const attempt = snapshot?.turns.find(turn => turn.turnId === evidence.turnId)
        ?.attempts.find(candidate => candidate.attemptId === evidence.attemptId);
      if (evidence.runId !== command.runId || snapshot === null
        || snapshot.version !== evidence.runVersion || snapshot.state.status !== 'running'
        || attempt?.state.status !== 'intended') {
        throw new Error('agent_run_unstarted_cancellation_authority_drifted');
      }
      return commands.executeInTransaction(transaction, {
        kind: 'run.cancel', commandId, runId: snapshot.runId,
        expectedVersion: snapshot.version,
        occurredAt: new Date(Math.max(Date.parse(command.occurredAt), Date.parse(snapshot.updatedAt))).toISOString(),
        reason: command.reason
      }, { turnInputPayloads: [], effectPayloads: [] });
    });
    const attempt = committed.run.turns.find(turn => turn.turnId === evidence.turnId)
      ?.attempts.find(candidate => candidate.attemptId === evidence.attemptId);
    if (committed.run.state.status !== 'cancelled' || attempt?.state.status !== 'cancelled'
      || attempt.state.cancellation.kind !== 'before_start') {
      throw new Error('agent_run_unstarted_cancellation_receipt_invalid');
    }
    return {
      receiptVersion: 1, executionIntentId: evidence.executionIntentId,
      dispatchAttemptId: evidence.dispatchAttemptId,
      // A logical dispatch settlement identity, never a Provider execution claim.
      externalDispatchId: await deriveStableAgentId('execution-unstarted-cancel',
        evidence.executionIntentId, evidence.dispatchAttemptId, commandId),
      runId: committed.run.runId, runVersion: committed.run.version,
      turnId: evidence.turnId, attemptId: evidence.attemptId,
      resultCommandId: commandId, inferenceStatus: 'cancelled',
      completedAt: attempt.state.cancelledAt
    };
  };
  const finalize = async (recovery: {
    readonly runId: string;
    readonly runVersion: number;
    readonly recoveryDecisionId: string;
  }) => {
    const snapshot = await unit.transaction(transaction => transaction.loadRun(recovery.runId));
    if (
      snapshot === null
      || snapshot.version !== recovery.runVersion
      || snapshot.state.status !== 'recovering'
      || snapshot.state.reason !== 'uncertain_inference'
    ) throw new Error('agent_run_active_cancellation_recovery_drifted');
    const committed = await commands.execute({
      kind: 'run.cancel', commandId, runId: recovery.runId,
      expectedVersion: recovery.runVersion,
      occurredAt: new Date(Math.max(Date.parse(command.occurredAt), Date.parse(snapshot.updatedAt))).toISOString(),
      reason: command.reason, recoveryDecisionId: recovery.recoveryDecisionId
    }, { turnInputPayloads: [], effectPayloads: [] });
    return { runId: committed.run.runId, runVersion: committed.run.version };
  };
  const authorizeVersion = (ownedVersion: number) => unit.transaction(async transaction => {
    const current = await transaction.loadRun(command.runId);
    const baseline = await transaction.loadRunVersion?.(command.runId, ownedVersion);
    if (current === null || baseline === null || baseline === undefined
      || current.version !== command.expectedVersion || current.state.status !== 'running'
      || baseline.state.status !== 'running') return false;
    const turn = current.turns.at(-1);
    const attempt = turn?.attempts.at(-1);
    const originalTurn = baseline.turns.at(-1);
    const originalAttempt = originalTurn?.attempts.at(-1);
    if (turn === undefined || (attempt?.state.status !== 'started' && attempt?.state.status !== 'intended')
      || originalAttempt?.state.status !== 'intended' || turn.turnId !== originalTurn?.turnId
      || attempt.attemptId !== originalAttempt.attemptId) return false;
    const normalized = { ...current, state: baseline.state, turns: current.turns.map(item => item.turnId !== turn.turnId ? item : {
      ...item, attempts: item.attempts.map(candidate => candidate.attemptId !== attempt.attemptId
        ? candidate : { ...candidate, state: originalAttempt.state })
    }) };
    try { assertAgentRunInboxOnlyMutation(baseline, normalized); return true; } catch { return false; }
  });
  const request = { commandId, runId: command.runId, expectedVersion: command.expectedVersion, finalize, finalizeUnstarted, authorizeVersion };
  const initial = await pipeline.executionScheduler.cancelActiveRun(request);
  if (initial.status === 'cancelled') return initial.runVersion;
  const continuation = await pipeline.runWorkScheduler.interruptActiveTurn(request);
  return continuation.status === 'interrupted' ? continuation.runVersion : null;
}
