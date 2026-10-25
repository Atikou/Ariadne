import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { FrozenConversationContext } from '../adapters/persistence/conversation/SqliteConversationNavigationStore.js';
import type { WorkflowAgentTask } from '../adapters/persistence/SqliteWorkflowExecution.js';
import { renderProductivityTaskPrompt } from '../conversation/ProductivityTaskPrompt.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { ProductivityTaskInvariantError } from '../control/ports/ProductivityTaskIsolationV1.js';

type Dispatch = (envelope: RuntimeCommandEnvelope) => Promise<RuntimeApplicationCommandResult | null>;
export async function sendProductivityTaskCommand(dispatch: Dispatch, commandId: string,
  command: RuntimeCommandEnvelope['command'], signal: AbortSignal): Promise<RuntimeApplicationCommandResult | null> {
  signal.throwIfAborted();
  return dispatch({ commandId, command, signal, correlationId: commandId,
    deadlineAt: new Date(Date.now() + 120_000).toISOString() });
}

/** Shared command ingress only; each durable owner settles its own accepted/uncertain/rejected intent. */
export async function submitProductivityTask(input: { readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly dispatch: Dispatch; readonly workspaceId: string; readonly context?: FrozenConversationContext;
  readonly task: WorkflowAgentTask; readonly signal: AbortSignal }): Promise<'accepted' | 'uncertain' | 'rejected'> {
  const { conversation, dispatch, workspaceId, context, task, signal } = input;
  const title = task.title.slice(0, 80).trim();
  const creation = await sendProductivityTaskCommand(dispatch, task.createCommandId, context?.boundary === undefined ? {
    kind: 'conversation.session.create', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    workspaceId, sessionId: task.sessionId, title
  } : {
    kind: 'conversation.session.fork', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    workspaceId, sessionId: task.sessionId, title, sourceSessionId: context.sourceSessionId,
    expectedSourceSessionVersion: context.sourceSessionVersion, sourceVersionMode: 'frozen', boundary: context.boundary
  }, signal);
  if (creation === null || creation.settlement !== 'completed') return 'uncertain';
  if (!creation.outcome.ok) {
    if (creation.outcome.error.retryable || /^runtime_[a-z]+_unavailable$/u.test(creation.outcome.error.code)) return 'uncertain';
    throw new ProductivityTaskInvariantError('submission_identity_conflict');
  }
  if ((creation.outcome.result.kind !== 'conversation.session.created' && creation.outcome.result.kind !== 'conversation.session.forked')
    || creation.outcome.result.sessionId !== task.sessionId) throw new ProductivityTaskInvariantError('submission_identity_conflict');
  const result = await sendProductivityTaskCommand(dispatch, task.submitCommandId, {
    kind: 'conversation.message.accept', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    workspaceId, sessionId: task.sessionId, messageId: task.messageId, expectedSessionVersion: 1,
    content: await renderProductivityTaskPrompt(conversation, workspaceId, task), execution: { mode: 'agent' }
  }, signal);
  if (result === null || result.settlement !== 'completed') return 'uncertain';
  if (!result.outcome.ok) {
    if (await conversation.readCommittedAuthorityCommand(task.submitCommandId) !== null) throw new ProductivityTaskInvariantError('submission_identity_conflict');
    if (result.outcome.error.retryable || /^runtime_[a-z]+_unavailable$/u.test(result.outcome.error.code)) return 'uncertain';
    return 'rejected';
  }
  if (result.outcome.result.kind !== 'conversation.message.accepted'
    || result.outcome.result.messageId !== task.messageId || result.outcome.result.sessionId !== task.sessionId) {
    throw new ProductivityTaskInvariantError('submission_identity_conflict');
  }
  return 'accepted';
}
