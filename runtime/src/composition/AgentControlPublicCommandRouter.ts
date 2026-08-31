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
  deriveConversationAuthorityId
} from '../conversation/ConversationRunHandoffIds.js';
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
import type { ConversationAttachmentStore } from '../control/ports/ConversationAttachmentStore.js';
import {
  AgentControlConversationMessageAdmissionError,
  type AgentControlExecutionPipeline
} from './ProductionAgentControlExecutionPipelineFactory.js';
import { AgentInboxPublicCommandHandler } from './AgentInboxPublicCommandHandler.js';
import { AgentSubagentInterruptPublicCommandHandler } from './AgentSubagentInterruptPublicCommandHandler.js';
import { publicConversationFailure } from './ConversationPublicCommandFailures.js';
import { ConversationSessionPublicCommandHandler } from './ConversationSessionPublicCommandHandler.js';
import { ConversationNavigationPublicCommandHandler } from './ConversationNavigationPublicCommandHandler.js';
import {
  completedPublicError,
  publicRunMutationFailure
} from './AgentPublicCommandFailures.js';

export interface AgentControlPublicCommandRouterOptions {
  readonly authorizedWorkspaceIds?: readonly string[];
  readonly conversationCommandNow?: () => Date;
  readonly agentDecisionCommandNow?: () => Date;
  readonly agentInboxCommandNow?: () => Date;
  readonly attachmentStore?: ConversationAttachmentStore;
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
  private readonly agentInbox: AgentInboxPublicCommandHandler;
  private readonly subagentInterrupt: AgentSubagentInterruptPublicCommandHandler;
  private readonly conversationSessions: ConversationSessionPublicCommandHandler;
  private readonly conversationNavigation: ConversationNavigationPublicCommandHandler;
  private readonly conversationCommandNow: () => Date;
  private readonly attachmentStore: ConversationAttachmentStore | undefined;
  private readonly authorizedWorkspaceIds: ReadonlySet<string>;

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
    this.agentInbox = new AgentInboxPublicCommandHandler(unitOfWork, {
      wakeWorkScheduler: () => this.executionPipeline?.runWorkScheduler.wake(),
      wakeProjectionDrain: callbacks.wakeProjectionDrain
    }, options.agentInboxCommandNow);
    this.subagentInterrupt = new AgentSubagentInterruptPublicCommandHandler(
      unitOfWork,
      executionPipeline,
      callbacks.wakeProjectionDrain
    );
    this.conversationCommandNow = options.conversationCommandNow ?? (() => new Date());
    this.conversationSessions = new ConversationSessionPublicCommandHandler(
      conversation,
      {
        wakeProjectionDrain: callbacks.wakeProjectionDrain,
        resolveCommandTime: (commandId) => this.resolveConversationCommandTime(commandId)
      },
      options.authorizedWorkspaceIds
    );
    this.conversationNavigation = new ConversationNavigationPublicCommandHandler(
      conversation,
      {
        wakeProjectionDrain: callbacks.wakeProjectionDrain,
        resolveCommandTime: (commandId) => this.resolveConversationCommandTime(commandId)
      },
      options.authorizedWorkspaceIds
    );
    this.attachmentStore = options.attachmentStore;
    this.authorizedWorkspaceIds = new Set(options.authorizedWorkspaceIds ?? []);
  }

  public async executeOwnedCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult | null> {
    switch (envelope.command.kind) {
      case 'conversation.session.create.v3':
      case 'conversation.session.rename.v3':
      case 'conversation.session.archive.v3':
      case 'conversation.session.restore.v3':
        return this.conversationSessions.execute(envelope, envelope.command);
      case 'conversation.session.fork.v3':
      case 'conversation.sessions.query.v3':
      case 'conversation.message.resolve.v3':
        return this.conversationNavigation.execute(envelope, envelope.command);
      case 'agent.tool_result.detail.get.v3':
        return this.executeToolResultDetail(envelope, envelope.command);
      case 'conversation.message.accept.v3':
        return this.executeAcceptConversationMessage(envelope, envelope.command);
      case 'agent.decision.resolve.v3':
        return this.executeResolveAgentDecision(envelope, envelope.command);
      case 'agent.run.cancel.v3':
        return this.executeCancelAgentRun(envelope, envelope.command);
      case 'agent.inbox.enqueue.v3':
      case 'agent.inbox.replace.v3':
      case 'agent.inbox.remove.v3':
      case 'agent.subagent.send.v3':
        return this.agentInbox.execute(envelope, envelope.command);
      case 'agent.subagent.interrupt.v3':
        return this.subagentInterrupt.execute(envelope, envelope.command);
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
      case 'conversation.sessions.query.v3':
      case 'conversation.message.resolve.v3':
      case 'agent.tool_result.detail.get.v3':
        return { kind: 'not_committed' };
      case 'conversation.session.create.v3':
      case 'conversation.session.rename.v3':
      case 'conversation.session.archive.v3':
      case 'conversation.session.restore.v3':
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
      case 'conversation.session.fork.v3': {
        const committed = await this.conversation.readCommittedAuthorityCommand(
          envelope.commandId
        );
        if (committed === null) return { kind: 'not_committed' };
        const result = await this.executeOwnedCommand(envelope);
        if (result === null || result.settlement !== 'completed') {
          throw new Error('conversation_fork_reconciliation_invalid');
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
      case 'agent.inbox.enqueue.v3':
      case 'agent.inbox.replace.v3':
      case 'agent.inbox.remove.v3':
      case 'agent.subagent.send.v3': {
        const result = await this.executeOwnedCommand(envelope);
        if (result === null || result.settlement !== 'completed') {
          throw new Error('agent_inbox_command_reconciliation_invalid');
        }
        return result.outcome.ok
          ? { kind: 'committed', outcome: result.outcome }
          : { kind: 'not_committed' };
      }
      case 'agent.subagent.interrupt.v3': {
        const result = await this.executeOwnedCommand(envelope);
        if (result === null || result.settlement !== 'completed') {
          throw new Error('agent_subagent_interrupt_reconciliation_invalid');
        }
        return result.outcome.ok
          ? { kind: 'committed', outcome: result.outcome }
          : { kind: 'not_committed' };
      }
      default:
        return null;
    }
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
    let attachments;
    if (command.attachments !== undefined) {
      if (this.attachmentStore === undefined) {
        return completedPublicError(
          envelope,
          'conversation_attachment_unavailable',
          'Image attachments are unavailable in this Runtime.',
          false
        );
      }
      try {
        attachments = await this.attachmentStore.saveImages(
          command.attachments,
          envelope.signal
        );
      } catch {
        envelope.signal.throwIfAborted();
        return completedPublicError(
          envelope,
          'conversation_attachment_invalid',
          'One or more image attachments could not be validated and stored.',
          false
        );
      }
    }
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
      ...(attachments === undefined ? {} : { attachments }),
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

  private async executeToolResultDetail(
    envelope: RuntimeCommandEnvelope,
    command: Extract<RuntimeCommandEnvelope['command'], {
      readonly kind: 'agent.tool_result.detail.get.v3';
    }>
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
    const pipeline = this.executionPipeline;
    if (pipeline?.protectedEffectResultReader === undefined) {
      return completedPublicError(
        envelope,
        'agent_tool_result_unavailable',
        'The protected Tool result reader is unavailable.',
        false
      );
    }
    try {
      const detail = await pipeline.protectedEffectResultReader.read(command);
      const presentation = pipeline.toolPresentationResolver.resolveToolPresentation(detail.tool);
      if (presentation === null || detail.workspaceId !== command.workspaceId) {
        throw new Error('agent_protected_effect_result_presentation_unavailable');
      }
      return {
        outcome: {
          ok: true,
          result: {
            kind: 'agent.tool_result.detail.v3',
            runId: command.runId,
            workspaceId: detail.workspaceId,
            effectId: detail.effectId,
            toolCallId: detail.toolCallId,
            presentation,
            status: detail.status,
            digest: detail.digest,
            totalBytes: detail.totalBytes,
            cursor: detail.cursor,
            nextCursor: detail.nextCursor,
            content: detail.content,
            complete: detail.complete
          }
        },
        settlement: 'completed'
      };
    } catch (error) {
      envelope.signal.throwIfAborted();
      if (error instanceof Error && error.message.startsWith('agent_protected_effect_result_')) {
        return completedPublicError(
          envelope,
          'agent_tool_result_unavailable',
          'The protected Tool result is unavailable for this Run and Workspace.',
          false
        );
      }
      throw error;
    }
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
