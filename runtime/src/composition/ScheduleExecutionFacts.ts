import type { AgentRun } from '@ariadne/agent-core';
import type { ConversationMessageReference } from '@ariadne/protocol/public';
import type { ProductivityAuthority } from '../control/ports/ProductivityAuthority.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { deriveConversationAuthorityId } from '../conversation/ConversationRunHandoffIds.js';
import { digestConversationMessagePayload } from '../conversation/ConversationAuthority.js';

export interface ScheduleExecutionFact {
  readonly status: AgentRun['state']['status'] | 'cancelling' | 'handoff_pending' | 'start_failed' | 'starting';
  readonly runId: string | null;
  readonly runVersion: number | null;
  readonly resultPending: boolean;
  readonly resultReference: ConversationMessageReference | null;
}
/** Shared source join for the original occurrence page and the read-only task center. */
export class ScheduleExecutionFacts {
  constructor(private readonly store: ProductivityAuthority,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly loadRun: (runId: string) => Promise<AgentRun | null>) {}

  async read(occurrenceId: string, workspaceId: string, sessionId: string,
    submitted: boolean, signal: AbortSignal): Promise<ScheduleExecutionFact | null> {
    signal.throwIfAborted();
    const identity = await this.store.readOccurrenceIdentity(occurrenceId, workspaceId, sessionId);
    if (identity === null) throw new Error('schedule_execution_owner_conflict');
    const committed = await this.conversation.readCommittedAuthorityCommand(identity.commandId);
    signal.throwIfAborted();
    if (committed === null) {
      if (submitted) throw new Error('schedule_execution_receipt_missing');
      return null;
    }
    const receipt = committed.receipt;
    if (receipt.kind !== 'conversation.accept_user_message' || receipt.sessionId !== sessionId
      || receipt.workspaceId !== workspaceId || receipt.messageId !== identity.messageId || receipt.messageVersion !== 1)
      throw new Error('schedule_execution_receipt_conflict');
    const saga = await this.conversation.readSagaByMessage(identity.messageId, receipt.messageVersion);
    const objective = await this.conversation.readMessageIdentity(identity.messageId, receipt.messageVersion);
    const expectedDigest = await digestConversationMessagePayload({ content: identity.prompt, execution: { mode: 'agent' } });
    if (saga === null || objective === null || saga.sagaId !== receipt.sagaId || saga.sessionId !== sessionId
      || saga.workspaceId !== workspaceId || objective.reference.sessionId !== sessionId || objective.workspaceId !== workspaceId
      || objective.role !== 'user' || objective.executionMode !== 'agent'
      || objective.reference.contentDigest !== saga.objectiveDigest || objective.reference.contentDigest !== expectedDigest)
      throw new Error('schedule_execution_objective_conflict');
    let fact: ScheduleExecutionFact = { status: saga.stage.kind === 'message_accepted' ? 'handoff_pending'
      : saga.stage.kind === 'agent_start_failed' ? 'start_failed' : 'starting', runId: null, runVersion: null,
      resultPending: false, resultReference: null };
    if (saga.stage.kind === 'agent_run_linked' || saga.stage.kind === 'agent_result_projected') {
      const run = await this.loadRun(saga.stage.runId);
      if (run === null || run.runId !== saga.stage.runId || run.binding.sessionId !== sessionId
        || run.binding.workspace.workspaceId !== workspaceId || run.binding.objectiveRef.kind !== 'conversation_message'
        || run.binding.objectiveRef.messageId !== identity.messageId || run.binding.objectiveRef.messageVersion !== 1
        || run.binding.objectiveRef.contentDigest !== saga.objectiveDigest) throw new Error('schedule_execution_run_conflict');
      const terminal = ['completed', 'failed', 'cancelled'].includes(run.state.status);
      fact = { status: run.cancellationRequest !== undefined && run.state.status === 'running' ? 'cancelling' : run.state.status,
        runId: run.runId, runVersion: run.version, resultPending: terminal, resultReference: null };
      if (saga.stage.kind === 'agent_result_projected') {
        if (saga.stage.resultStatus !== run.state.status || saga.stage.resultRunVersion !== run.version)
          throw new Error('schedule_execution_result_conflict');
        const resultId = await deriveConversationAuthorityId('agent-result-message', saga.stage.sourceRunEventId);
        const result = await this.conversation.readMessageIdentity(resultId, 1);
        if (result === null || result.role !== 'assistant' || result.workspaceId !== workspaceId || result.reference.sessionId !== sessionId)
          throw new Error('schedule_execution_result_conflict');
        fact = { ...fact, resultPending: false, resultReference: result.reference };
      }
    }
    signal.throwIfAborted(); return fact;
  }
}
