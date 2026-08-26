import {
  AgentCoreError,
  AgentRunCommandService
} from '@ariadne/agent-core';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeResult
} from '@ariadne/protocol/public';

import type {
  SqliteAgentRunUnitOfWork
} from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type {
  SqliteConversationRunHandoffUnitOfWork
} from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type {
  SqlitePublicProjectionStore
} from '../adapters/persistence/SqlitePublicProjectionStore.js';
import {
  ConversationAuthorityError
} from '../conversation/ConversationAuthority.js';
import {
  deriveConversationAuthorityId
} from '../conversation/ConversationRunHandoffIds.js';
import {
  ConversationRunHandoffError
} from '../conversation/ConversationRunHandoffSaga.js';
import {
  ConversationAuthorityService
} from '../control/conversation/ConversationAuthorityService.js';
import {
  AgentDecisionAuthorityError,
  AgentDecisionAuthorityService
} from '../control/run/AgentDecisionAuthorityService.js';
import type {
  RuntimeApplicationCommandResult
} from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import type {
  RuntimeCommandReconciliation
} from '../control/ports/RuntimeCommandJournal.js';
import {
  AgentControlConversationMessageAdmissionError,
  type AgentControlExecutionPipeline
} from './ProductionAgentControlExecutionPipelineFactory.js';

export interface AgentControlPublicCommandRouterOptions {
  readonly authorizedWorkspaceIds?: readonly string[];
  readonly conversationCommandNow?: () => Date;
  readonly agentDecisionCommandNow?: () => Date;
}

export interface AgentControlPublicCommandRouterCallbacks {
  readonly wakeProjectionDrain: () => void;
  readonly executeProjectionQuery: (
    envelope: RuntimeCommandEnvelope,
    query: () => Promise<RuntimeResult>
  ) => Promise<RuntimeApplicationCommandResult>;
}

/**
 * Owns the public command surface and its domain-error translation.
 * Runtime lifecycle, projection scheduling and store ownership stay outside.
 */
export class AgentControlPublicCommandRouter {
  private readonly conversationAuthority: ConversationAuthorityService;
  private readonly agentDecisionAuthority: AgentDecisionAuthorityService;
  private readonly agentCommands: AgentRunCommandService;
  private readonly authorizedWorkspaceIds: ReadonlySet<string>;
  private readonly conversationCommandNow: () => Date;

  public constructor(
    private readonly unitOfWork: SqliteAgentRunUnitOfWork,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly publicProjection: SqlitePublicProjectionStore,
    private readonly executionPipeline: AgentControlExecutionPipeline | undefined,
    private readonly callbacks: AgentControlPublicCommandRouterCallbacks,
    options: AgentControlPublicCommandRouterOptions = {}
  ) {
    this.conversationAuthority = new ConversationAuthorityService(conversation);
    this.agentDecisionAuthority = new AgentDecisionAuthorityService(
      unitOfWork,
      options.agentDecisionCommandNow
    );
    this.agentCommands = new AgentRunCommandService(unitOfWork);
    this.authorizedWorkspaceIds = new Set(options.authorizedWorkspaceIds ?? []);
    this.conversationCommandNow = options.conversationCommandNow ?? (() => new Date());
  }

  public async executeOwnedCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult | null> {
    switch (envelope.command.kind) {
      case 'conversation.session.create.v3':
        return this.executeCreateConversationSession(envelope, envelope.command);
      case 'conversation.message.accept.v3':
        return this.executeAcceptConversationMessage(envelope, envelope.command);
      case 'agent.decision.resolve.v3':
        return this.executeResolveAgentDecision(envelope, envelope.command);
      case 'agent.run.cancel.v3':
        return this.executeCancelAgentRun(envelope, envelope.command);
      case 'projection.snapshot.get': {
        if (
          envelope.command.contractVersion
          !== PUBLIC_PROJECTION_CONTRACT_VERSION
        ) {
          throw new Error('public_projection_contract_version_mismatch');
        }
        return this.callbacks.executeProjectionQuery(envelope, async () => ({
          kind: 'projection.snapshot' as const,
          snapshot: await this.publicProjection.snapshot()
        }));
      }
      case 'projection.commits.read': {
        const request = envelope.command.request;
        return this.callbacks.executeProjectionQuery(envelope, async () => ({
          kind: 'projection.commits' as const,
          batch: await this.publicProjection.read(request)
        }));
      }
      default:
        return null;
    }
  }

  public async reconcileUncertainCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeCommandReconciliation | null> {
    switch (envelope.command.kind) {
      case 'projection.snapshot.get':
      case 'projection.commits.read':
        return { kind: 'not_committed' };
      case 'conversation.session.create.v3':
      case 'conversation.message.accept.v3': {
        const committed = await this.conversation.readCommittedAuthorityCommand(
          envelope.commandId
        );
        if (committed === null) return { kind: 'not_committed' };
        const result = await this.executeOwnedCommand(envelope);
        if (result === null || result.settlement !== 'completed') {
          throw new Error('conversation_command_reconciliation_invalid');
        }
        return { kind: 'committed', outcome: result.outcome };
      }
      case 'agent.decision.resolve.v3': {
        const result = await this.agentDecisionAuthority.reconcile({
          commandId: envelope.commandId,
          command: envelope.command,
          signal: envelope.signal
        });
        return result === null
          ? { kind: 'not_committed' }
          : { kind: 'committed', outcome: { ok: true, result } };
      }
      case 'agent.run.cancel.v3': {
        const result = await this.executeOwnedCommand(envelope);
        if (result === null || result.settlement !== 'completed') {
          throw new Error('agent_run_cancel_reconciliation_invalid');
        }
        return result.outcome.ok
          ? { kind: 'committed', outcome: result.outcome }
          : { kind: 'not_committed' };
      }
      default:
        return null;
    }
  }

  private async executeCreateConversationSession(
    envelope: RuntimeCommandEnvelope,
    command: Extract<
      RuntimeCommandEnvelope['command'],
      { readonly kind: 'conversation.session.create.v3' }
    >
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    if (
      this.authorizedWorkspaceIds.size > 0
      && !this.authorizedWorkspaceIds.has(command.workspaceId)
    ) {
      return completedPublicError(
        envelope,
        'workspace_not_authorized',
        'The Workspace is not authorized by this Runtime bootstrap.',
        false
      );
    }
    const [eventId, occurredAt] = await Promise.all([
      deriveConversationAuthorityId('session-created-event', envelope.commandId),
      this.resolveConversationCommandTime(envelope.commandId)
    ]);
    envelope.signal.throwIfAborted();
    const authorityCommand = {
      kind: 'conversation.create_session',
      commandId: envelope.commandId,
      eventId,
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      expectedVersion: null,
      occurredAt
    } as const;
    let result;
    try {
      result = await this.conversationAuthority.createSession(authorityCommand);
    } catch (error) {
      envelope.signal.throwIfAborted();
      const committed = await this.conversation.readCommittedAuthorityCommand(
        envelope.commandId
      );
      if (committed !== null) {
        result = await this.conversationAuthority.createSession(authorityCommand);
      } else {
        const failure = publicConversationFailure(envelope, error);
        if (failure !== null) return failure;
        throw error;
      }
    }
    this.callbacks.wakeProjectionDrain();
    return {
      outcome: {
        ok: true,
        result: {
          kind: 'conversation.session.created.v3',
          sessionId: result.session.sessionId,
          version: 1
        }
      },
      settlement: 'completed'
    };
  }

  private async executeAcceptConversationMessage(
    envelope: RuntimeCommandEnvelope,
    command: Extract<
      RuntimeCommandEnvelope['command'],
      { readonly kind: 'conversation.message.accept.v3' }
    >
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const committedBeforeExecution = await this.conversation
      .readCommittedAuthorityCommand(envelope.commandId);
    if (committedBeforeExecution === null) {
      if (this.executionPipeline === undefined) {
        return completedPublicError(
          envelope,
          'agent_execution_unavailable',
          'Agent execution is unavailable because its durable Handoff producer is not configured.',
          false
        );
      }
      this.executionPipeline.runWorkScheduler.assertHealthy();
      this.executionPipeline.executionScheduler.assertHealthy();
      this.executionPipeline.handoffProducer.assertHealthy();
      try {
        this.executionPipeline.assertConversationMessageAdmission(
          command.workspaceId
        );
      } catch (error) {
        if (!(error instanceof AgentControlConversationMessageAdmissionError)) {
          throw error;
        }
        return completedPublicError(
          envelope,
          'agent_execution_unavailable',
          'Agent execution is unavailable for this Workspace.',
          false
        );
      }
    }
    const [
      eventId,
      sagaId,
      handoffCommandId,
      handoffOutboxMessageId,
      occurredAt
    ] = await Promise.all([
      deriveConversationAuthorityId('message-accepted-event', envelope.commandId),
      deriveConversationAuthorityId('handoff-saga', envelope.commandId),
      deriveConversationAuthorityId('handoff-accept-command', envelope.commandId),
      deriveConversationAuthorityId('handoff-accept-outbox', envelope.commandId),
      this.resolveConversationCommandTime(envelope.commandId)
    ]);
    envelope.signal.throwIfAborted();
    const authorityCommand = {
      kind: 'conversation.accept_user_message',
      commandId: envelope.commandId,
      eventId,
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      expectedSessionVersion: command.expectedSessionVersion,
      messageId: command.messageId,
      expectedMessageVersion: null,
      content: command.content,
      execution: command.execution ?? { mode: 'agent' as const },
      sagaId,
      handoffCommandId,
      handoffOutboxMessageId,
      occurredAt
    } as const;
    let result;
    try {
      result = await this.conversationAuthority.acceptUserMessage(authorityCommand);
    } catch (error) {
      envelope.signal.throwIfAborted();
      const committed = await this.conversation.readCommittedAuthorityCommand(
        envelope.commandId
      );
      if (committed !== null) {
        result = await this.conversationAuthority.acceptUserMessage(authorityCommand);
      } else {
        const failure = publicConversationFailure(envelope, error);
        if (failure !== null) return failure;
        throw error;
      }
    }
    this.executionPipeline?.handoffProducer.wake();
    this.executionPipeline?.executionScheduler.wake();
    this.callbacks.wakeProjectionDrain();
    return {
      outcome: {
        ok: true,
        result: {
          kind: 'conversation.message.accepted.v3',
          sessionId: result.session.sessionId,
          sessionVersion: result.session.version,
          messageId: result.messageVersion.messageId,
          messageVersion: 1,
          sagaId: result.saga.sagaId
        }
      },
      settlement: 'completed'
    };
  }

  private async executeResolveAgentDecision(
    envelope: RuntimeCommandEnvelope,
    command: Extract<
      RuntimeCommandEnvelope['command'],
      { readonly kind: 'agent.decision.resolve.v3' }
    >
  ): Promise<RuntimeApplicationCommandResult> {
    let result;
    try {
      result = await this.agentDecisionAuthority.execute({
        commandId: envelope.commandId,
        command,
        signal: envelope.signal
      });
    } catch (error) {
      envelope.signal.throwIfAborted();
      const replay = await this.agentDecisionAuthority.reconcile({
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
    this.executionPipeline?.runWorkScheduler.wake();
    this.callbacks.wakeProjectionDrain();
    return {
      outcome: { ok: true, result },
      settlement: 'completed'
    };
  }

  private async executeCancelAgentRun(
    envelope: RuntimeCommandEnvelope,
    command: Extract<
      RuntimeCommandEnvelope['command'],
      { readonly kind: 'agent.run.cancel.v3' }
    >
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const replayed = await this.loadCommittedCancellation(
      envelope.commandId,
      command.runId
    );
    if (replayed !== null) {
      return {
        outcome: {
          ok: true,
          result: {
            kind: 'agent.run.cancelled.v3',
            runId: replayed.runId,
            runVersion: replayed.runVersion
          }
        },
        settlement: 'completed'
      };
    }

    const active = await this.executionPipeline?.executionScheduler.cancelActiveRun({
      commandId: envelope.commandId,
      runId: command.runId,
      expectedVersion: command.expectedVersion,
      finalize: async (recovery) => {
        const snapshot = await this.unitOfWork.transaction((transaction) => (
          transaction.loadRun(recovery.runId)
        ));
        if (
          snapshot === null
          || snapshot.version !== recovery.runVersion
          || snapshot.state.status !== 'recovering'
          || snapshot.state.reason !== 'uncertain_inference'
        ) {
          throw new Error('agent_run_active_cancellation_recovery_drifted');
        }
        const occurredAt = new Date(Math.max(
          Date.parse(command.occurredAt),
          Date.parse(snapshot.updatedAt)
        )).toISOString();
        const committed = await this.agentCommands.execute({
          kind: 'run.cancel',
          commandId: envelope.commandId,
          runId: recovery.runId,
          expectedVersion: recovery.runVersion,
          occurredAt,
          reason: command.reason,
          recoveryDecisionId: recovery.recoveryDecisionId
        }, { turnInputPayloads: [], effectPayloads: [] });
        return { runVersion: committed.run.version };
      }
    }) ?? { status: 'not_active' as const };
    if (active.status === 'cancelled') {
      this.executionPipeline?.runWorkScheduler.wake();
      this.callbacks.wakeProjectionDrain();
      return {
        outcome: {
          ok: true,
          result: {
            kind: 'agent.run.cancelled.v3',
            runId: command.runId,
            runVersion: active.runVersion
          }
        },
        settlement: 'completed'
      };
    }

    let result;
    try {
      result = await this.agentCommands.execute({
        kind: 'run.cancel',
        commandId: envelope.commandId,
        runId: command.runId,
        expectedVersion: command.expectedVersion,
        occurredAt: command.occurredAt,
        reason: command.reason
      }, { turnInputPayloads: [], effectPayloads: [] });
    } catch (error) {
      envelope.signal.throwIfAborted();
      const failure = publicRunMutationFailure(envelope, error);
      if (failure !== null) return failure;
      throw error;
    }
    this.executionPipeline?.runWorkScheduler.wake();
    this.callbacks.wakeProjectionDrain();
    return {
      outcome: {
        ok: true,
        result: {
          kind: 'agent.run.cancelled.v3',
          runId: result.run.runId,
          runVersion: result.run.version
        }
      },
      settlement: 'completed'
    };
  }

  private async loadCommittedCancellation(
    commandId: string,
    runId: string
  ): Promise<{ readonly runId: string; readonly runVersion: number } | null> {
    const receipt = await this.unitOfWork.loadCommittedCommandReceipt(commandId);
    if (receipt === null) return null;
    const mutation = receipt.mutations[0];
    const cancellation = mutation?.events.filter(
      (event) => event.payload.type === 'run.cancelled'
    );
    if (
      receipt.commandId !== commandId
      || receipt.mutations.length !== 1
      || mutation === undefined
      || mutation.runId !== runId
      || mutation.run.runId !== runId
      || mutation.resultingVersion !== mutation.run.version
      || mutation.run.state.status !== 'cancelled'
      || cancellation?.length !== 1
    ) {
      throw new Error('agent_run_cancel_receipt_invalid');
    }
    return { runId, runVersion: mutation.run.version };
  }

  private async resolveConversationCommandTime(commandId: string): Promise<string> {
    const committed = await this.conversation.readCommittedAuthorityCommand(commandId);
    if (committed !== null) return committed.receipt.committedAt;
    const now = this.conversationCommandNow();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('conversation_command_clock_invalid');
    }
    return now.toISOString();
  }
}

function publicConversationFailure(
  envelope: RuntimeCommandEnvelope,
  error: unknown
): RuntimeApplicationCommandResult | null {
  if (error instanceof ConversationAuthorityError) {
    switch (error.code) {
      case 'CONVERSATION_SESSION_ALREADY_EXISTS':
        return completedPublicError(
          envelope,
          'conversation_session_exists',
          'The Conversation session already exists.',
          false
        );
      case 'CONVERSATION_SESSION_NOT_FOUND':
        return completedPublicError(
          envelope,
          'conversation_session_not_found',
          'The Conversation session does not exist.',
          false
        );
      case 'CONVERSATION_SESSION_VERSION_CONFLICT':
        return completedPublicError(
          envelope,
          'conversation_version_conflict',
          'The Conversation changed before this command was applied.',
          false
        );
      case 'CONVERSATION_WORKSPACE_MISMATCH':
        return completedPublicError(
          envelope,
          'conversation_workspace_mismatch',
          'The Conversation does not belong to that Workspace.',
          false
        );
      case 'CONVERSATION_MESSAGE_ALREADY_EXISTS':
      case 'CONVERSATION_COMMAND_CONFLICT':
        return completedPublicError(
          envelope,
          'conversation_command_conflict',
          'The Conversation command conflicts with an existing immutable fact.',
          false
        );
      case 'CONVERSATION_INVARIANT':
      case 'CONVERSATION_STORAGE_CORRUPTION':
        return null;
    }
  }
  if (error instanceof ConversationRunHandoffError) {
    switch (error.code) {
      case 'HANDOFF_ALREADY_EXISTS':
      case 'HANDOFF_NOT_FOUND':
      case 'HANDOFF_VERSION_CONFLICT':
      case 'HANDOFF_COMMAND_CONFLICT':
      case 'HANDOFF_INVALID_TRANSITION':
        return completedPublicError(
          envelope,
          'conversation_handoff_conflict',
          'The Conversation handoff conflicts with an existing immutable fact.',
          false
        );
      case 'HANDOFF_INVARIANT':
        return null;
    }
  }
  return null;
}

function publicDecisionFailure(
  envelope: RuntimeCommandEnvelope,
  error: unknown
): RuntimeApplicationCommandResult | null {
  if (error instanceof AgentDecisionAuthorityError) {
    switch (error.code) {
      case 'AGENT_DECISION_AUTHORITY_RUN_NOT_FOUND':
        return completedPublicError(
          envelope,
          'agent_run_not_found',
          'The authoritative Agent Run does not exist.',
          false
        );
      case 'AGENT_DECISION_AUTHORITY_NOT_ACTIVE':
        return completedPublicError(
          envelope,
          'agent_decision_not_active',
          'The Decision is no longer active.',
          false
        );
      case 'AGENT_DECISION_AUTHORITY_TOKEN_MISMATCH':
      case 'AGENT_DECISION_AUTHORITY_CHOICE_INVALID':
      case 'AGENT_DECISION_AUTHORITY_INVALID':
        return completedPublicError(
          envelope,
          'agent_decision_action_invalid',
          'The Decision action is not authorized by the current projection.',
          false
        );
      case 'AGENT_DECISION_AUTHORITY_RECEIPT_INVALID':
        return null;
    }
  }
  if (error instanceof AgentCoreError) {
    if (error.code === 'AGENT_RUN_VERSION_CONFLICT') {
      return completedPublicError(
        envelope,
        'agent_run_version_conflict',
        'The Agent Run changed before this Decision was applied.',
        false
      );
    }
    if (error.code === 'AGENT_RUN_NOT_FOUND') {
      return completedPublicError(
        envelope,
        'agent_run_not_found',
        'The authoritative Agent Run does not exist.',
        false
      );
    }
  }
  return null;
}

function publicRunMutationFailure(
  envelope: RuntimeCommandEnvelope,
  error: unknown
): RuntimeApplicationCommandResult | null {
  if (!(error instanceof AgentCoreError)) return null;
  if (error.code === 'AGENT_RUN_VERSION_CONFLICT') {
    return completedPublicError(
      envelope,
      'agent_run_version_conflict',
      'The Agent Run changed before this command was applied.',
      false
    );
  }
  if (error.code === 'AGENT_RUN_NOT_FOUND') {
    return completedPublicError(
      envelope,
      'agent_run_not_found',
      'The authoritative Agent Run does not exist.',
      false
    );
  }
  if (error.code === 'AGENT_RUN_TRANSITION') {
    return completedPublicError(
      envelope,
      'agent_run_action_invalid',
      'The Agent Run cannot accept this action in its current state.',
      false
    );
  }
  return null;
}

function completedPublicError(
  envelope: RuntimeCommandEnvelope,
  code: string,
  message: string,
  retryable: boolean
): RuntimeApplicationCommandResult {
  return {
    outcome: {
      ok: false,
      error: {
        code,
        message,
        retryable,
        correlationId: envelope.correlationId
      }
    },
    settlement: 'completed'
  };
}
