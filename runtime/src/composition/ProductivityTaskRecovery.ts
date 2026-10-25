import type { AgentRun } from '@ariadne/agent-core';
import type { ProductivityTaskRecoveryAuthorityV1 } from '../control/ports/ProductivityTaskRecoveryAuthorityV1.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { ProductivityTaskRecoveryClaimV1 } from '../control/ports/ProductivityTaskIsolationV1.js';
import { digestConversationMessagePayload, fingerprintConversationAuthorityCommand } from '../conversation/ConversationAuthority.js';
import { fingerprintConversationForkRequest } from '../adapters/persistence/conversation/SqliteConversationNavigationStore.js';
import { renderProductivityTaskPrompt } from '../conversation/ProductivityTaskPrompt.js';
import { deriveConversationAuthorityId } from '../conversation/ConversationRunHandoffIds.js';
import type { ProductivityTaskRecoveryCommand, ProductivityTaskRecoveryResult } from '@ariadne/protocol/public';

/** Reconciles existing durable effects. It has no dispatch, execution or retry
 * function, and cannot create another session, message, Saga or Run. */
export class ProductivityTaskRecovery {
  public constructor(private readonly store: ProductivityTaskRecoveryAuthorityV1,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly loadRun: (runId: string) => Promise<AgentRun | null>) {}

  public async reconcile(commandId: string, request: ProductivityTaskRecoveryCommand): Promise<ProductivityTaskRecoveryResult> {
    const admission = await this.store.beginTaskRecoveryCommand(commandId, request);
    if (admission.kind === 'completed') return admission.result;
    const { claim } = admission;
    let verified: boolean;
    try { verified = await this.verify(claim); }
    catch (error) {
      try { await this.store.finishTaskRecoveryCommand(commandId, request, claim, false); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'productivity_task_recovery_and_fence_failed'); }
      throw error;
    }
    return this.store.finishTaskRecoveryCommand(commandId, request, claim, verified);
  }

  private async verify(claim: ProductivityTaskRecoveryClaimV1): Promise<boolean> {
    const { fault } = claim;
    if (claim.terminal?.status === 'unknown') return false;
    if (claim.createCommandId !== undefined) {
      const creation = await this.conversation.readCommittedAuthorityCommand(claim.createCommandId);
      if (creation === null || creation.receipt.kind !== 'conversation.create_session'
        || creation.receipt.sessionId !== fault.sessionId || creation.receipt.workspaceId !== fault.workspaceId
        || creation.receipt.resultingSessionVersion !== 1) return false;
      const receipt = creation.receipt;
      const context = claim.context;
      const expected = context?.boundary === undefined
        ? await fingerprintConversationAuthorityCommand({ kind: 'conversation.create_session', commandId: claim.createCommandId,
          eventId: await deriveConversationAuthorityId('session-created-event', claim.createCommandId), sessionId: fault.sessionId,
          workspaceId: fault.workspaceId, expectedVersion: null, occurredAt: receipt.committedAt })
        : fingerprintConversationForkRequest({ commandId: claim.createCommandId,
          eventId: await deriveConversationAuthorityId('session-forked-event', claim.createCommandId), sessionId: fault.sessionId,
          sourceSessionId: context.sourceSessionId, workspaceId: fault.workspaceId, expectedSourceSessionVersion: context.sourceSessionVersion,
          boundary: context.boundary, sourceVersionMode: 'frozen', title: claim.title!.slice(0, 80).trim(), occurredAt: receipt.committedAt });
      if (receipt.commandFingerprint !== expected) return false;
    }
    const accepted = await this.conversation.readCommittedAuthorityCommand(claim.submitCommandId);
    if (accepted === null || accepted.receipt.kind !== 'conversation.accept_user_message') return false;
    const receipt = accepted.receipt;
    if (receipt.sessionId !== fault.sessionId || receipt.workspaceId !== fault.workspaceId
      || receipt.messageId !== claim.messageId || receipt.messageVersion !== 1) return false;
    const original = await this.conversation.readMessageVersion(claim.messageId, 1);
    const prompt = await renderProductivityTaskPrompt(this.conversation, fault.workspaceId, claim);
    const digest = await digestConversationMessagePayload({ content: prompt, execution: { mode: 'agent' } });
    if (original === null || original.role !== 'user' || original.sessionId !== fault.sessionId
      || original.workspaceId !== fault.workspaceId || original.contentDigest !== digest) return false;
    const saga = await this.conversation.readSagaByMessage(claim.messageId, 1);
    if (saga === null || saga.sagaId !== receipt.sagaId || saga.sessionId !== fault.sessionId
      || saga.workspaceId !== fault.workspaceId || saga.objectiveDigest !== digest) return false;
    if (claim.terminal?.kind === 'submission') return claim.terminal.status === 'submitted';
    if (saga.stage.kind === 'agent_start_failed') return fault.code !== 'result_authority_conflict' && claim.runId === undefined
      && (claim.terminal === undefined || claim.terminal.status === 'failed');
    if (saga.stage.kind !== 'agent_run_linked' && saga.stage.kind !== 'agent_result_projected') return false;
    if (claim.runId !== undefined && claim.runId !== saga.stage.runId) return false;
    const run = await this.loadRun(saga.stage.runId);
    if (run === null || run.runId !== saga.stage.runId || run.version < saga.stage.admittedRunVersion
      || run.binding.workspace.workspaceId !== fault.workspaceId || run.binding.sessionId !== fault.sessionId
      || run.binding.objectiveRef.kind !== 'conversation_message' || run.binding.objectiveRef.messageId !== claim.messageId
      || run.binding.objectiveRef.messageVersion !== 1 || run.binding.objectiveRef.contentDigest !== digest) return false;
    if (saga.stage.kind !== 'agent_result_projected') {
      return fault.code !== 'result_authority_conflict'
        && fault.code !== 'cancellation_rejected'
        && claim.terminal === undefined
        && !['completed','failed','cancelled'].includes(run.state.status);
    }
    if (saga.stage.resultStatus !== run.state.status || saga.stage.resultRunVersion !== run.version) return false;
    const messageId = await deriveConversationAuthorityId('agent-result-message', saga.stage.sourceRunEventId);
    const result = await this.conversation.readMessageVersion(messageId, 1);
    if (claim.terminal !== undefined && (claim.terminal.status !== run.state.status
      || (claim.terminal.runVersion !== undefined && claim.terminal.runVersion !== run.version)
      || (claim.terminal.resultMessage !== undefined && (claim.terminal.resultMessage.sessionId !== fault.sessionId
        || claim.terminal.resultMessage.messageId !== messageId || claim.terminal.resultMessage.messageVersion !== 1)))) return false;
    return result !== null && result.sessionId === fault.sessionId && result.workspaceId === fault.workspaceId && result.role === 'assistant'
      && (claim.terminal?.resultMessage === undefined || claim.terminal.resultMessage.contentDigest === result.contentDigest);
  }
}
