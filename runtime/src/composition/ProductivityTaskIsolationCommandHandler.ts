import type { AgentRun } from '@ariadne/agent-core';
import type { RuntimeCommand } from '@ariadne/protocol/public';
import type { SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';
import { defineAgentPublicCommandOwner } from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';
import { ProductivityTaskRecovery } from './ProductivityTaskRecovery.js';

type Command = Extract<RuntimeCommand, { kind: 'productivity.task_faults.query' | 'productivity.task.reconcile' | 'productivity.task_recovery.claims.query' }>;
export function createProductivityTaskIsolationCommandOwners(store: SqliteProductivityStore | undefined,
  conversation: SqliteConversationRunHandoffUnitOfWork, authorizedWorkspaces: readonly string[],
  loadRun: (runId: string) => Promise<AgentRun | null>) {
  const recovery = store === undefined ? undefined : new ProductivityTaskRecovery(store, conversation, loadRun);
  const allowed = new Set(authorizedWorkspaces);
  const authorize = async (envelope: RuntimeCommandEnvelope, command: Command) => {
    envelope.signal.throwIfAborted();
    if (allowed.size > 0 && !allowed.has(command.workspaceId))
      return completedPublicError(envelope, 'workspace_not_authorized', 'The Workspace is not authorized.', false);
    const session = await conversation.readSession(command.sessionId);
    if (session === null || session.workspaceId !== command.workspaceId)
      return completedPublicError(envelope, 'conversation_session_not_found', 'The Conversation session does not exist.', false);
    if (store === undefined || recovery === undefined)
      return completedPublicError(envelope, 'productivity_unavailable', 'The task authority is unavailable.', false);
    return null;
  };
  return [defineAgentPublicCommandOwner('productivity.task-isolation',
    ['productivity.task_faults.query', 'productivity.task.reconcile', 'productivity.task_recovery.claims.query'], async (envelope, command) => {
      const denied = await authorize(envelope, command); if (denied !== null) return denied;
      if (command.kind === 'productivity.task_recovery.claims.query') {
        const references = await store!.queryTaskRecoveryClaims(command.workspaceId, command.sessionId, command.claims);
        return { outcome: { ok: true, result: { kind: 'productivity.task_recovery.claims_result', contractVersion: '1.0',
          workspaceId: command.workspaceId, sessionId: command.sessionId, references: [...references] } }, settlement: 'completed' };
      }
      if (command.kind === 'productivity.task_faults.query') {
        const page = await store!.queryTaskFaults(command.workspaceId, command.sessionId, command.limit, command.afterFaultId);
        return { outcome: { ok: true, result: { kind: 'productivity.task_faults.query_result', contractVersion: '1.0',
          workspaceId: command.workspaceId, sessionId: command.sessionId, ...page, faults: [...page.faults] } }, settlement: 'completed' };
      }
      try {
        const result = await recovery!.reconcile(envelope.commandId, command);
        return { outcome: { ok: true, result }, settlement: 'completed' };
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['productivity_task_fault_not_found', 'productivity_task_fault_recovery_conflict',
          'productivity_task_fault_terminal_reconciliation_required', 'productivity_command_conflict'].includes(code))
          return completedPublicError(envelope, code, 'The task changed or requires further reconciliation. Refresh its status.', false);
        throw error; // Storage/COMMIT/observation failures remain uncertain.
      }
    }, async (envelope, command) => {
      if (command.kind !== 'productivity.task.reconcile') return { kind: 'not_committed' };
      const denied = await authorize(envelope, command); if (denied !== null) return null;
      const receipt = await store!.readTaskRecoveryCommand(envelope.commandId, command);
      if (receipt === null) return { kind: 'not_committed' };
      const result = receipt.phase === 'completed' ? receipt.result : await recovery!.reconcile(envelope.commandId, command);
      return { kind: 'committed', outcome: { ok: true, result } };
    })];
}
