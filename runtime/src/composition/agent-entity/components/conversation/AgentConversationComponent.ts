import type { RuntimeApplicationCommandResult } from '../../../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import type { RuntimeCommandReconciliation } from '../../../../control/ports/RuntimeCommandJournal.js';
import type { ConversationAttachmentStore } from '../../../../control/ports/ConversationAttachmentStore.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../../../../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { deriveConversationAuthorityId } from '../../../../conversation/ConversationRunHandoffIds.js';
import { ConversationAuthorityService } from '../../../../control/conversation/ConversationAuthorityService.js';
import { completedPublicError } from '../../../AgentPublicCommandFailures.js';
import { publicConversationFailure } from '../../../ConversationPublicCommandFailures.js';
import { ConversationSessionPublicCommandHandler } from '../../../ConversationSessionPublicCommandHandler.js';
import { ConversationNavigationPublicCommandHandler } from '../../../ConversationNavigationPublicCommandHandler.js';
import {
  type AgentControlExecutionPipeline
} from '../../../ProductionAgentControlExecutionPipelineFactory.js';
import {
  AgentControlConversationMessageAdmissionError
} from '../../AgentExecutionPipelineErrors.js';
import {
  defineAgentPublicCommandOwner,
  type AgentPublicCommandOwner
} from '../../command-owners/AgentPublicCommandOwnerTable.js';

type SessionCommand = Extract<RuntimeCommandEnvelope['command'], {
  readonly kind:
    | 'conversation.session.create.v3'
    | 'conversation.session.rename.v3'
    | 'conversation.session.archive.v3'
    | 'conversation.session.restore.v3';
}>;

type NavigationCommand = Extract<RuntimeCommandEnvelope['command'], {
  readonly kind:
    | 'conversation.session.fork.v3'
    | 'conversation.sessions.query.v3'
    | 'conversation.message.resolve.v3';
}>;

type AcceptMessageCommand = Extract<RuntimeCommandEnvelope['command'], {
  readonly kind: 'conversation.message.accept.v3';
}>;

export interface AgentConversationComponentOptions {
  readonly authorizedWorkspaceIds?: readonly string[];
  readonly commandNow?: () => Date;
  readonly attachmentStore?: ConversationAttachmentStore;
}

export interface AgentConversationComponentInput {
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly executionPipeline?: AgentControlExecutionPipeline;
  readonly wakeProjectionDrain: () => void;
  readonly options?: AgentConversationComponentOptions;
}

export interface AgentConversationComponentHandle {
  commandOwners(): readonly AgentPublicCommandOwner[];
  executeSession(
    envelope: RuntimeCommandEnvelope,
    command: SessionCommand
  ): Promise<RuntimeApplicationCommandResult>;
  executeNavigation(
    envelope: RuntimeCommandEnvelope,
    command: NavigationCommand
  ): Promise<RuntimeApplicationCommandResult>;
  executeAcceptMessage(
    envelope: RuntimeCommandEnvelope,
    command: AcceptMessageCommand
  ): Promise<RuntimeApplicationCommandResult>;
  reconcileCommitted(
    envelope: RuntimeCommandEnvelope,
    execute: () => Promise<RuntimeApplicationCommandResult | null>,
    invalidErrorCode: string
  ): Promise<RuntimeCommandReconciliation>;
}

export function createAgentConversationComponent(
  input: AgentConversationComponentInput
): AgentConversationComponentHandle {
  return new DefaultAgentConversationComponent(input);
}

class DefaultAgentConversationComponent implements AgentConversationComponentHandle {
  private readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  private readonly authority: ConversationAuthorityService;
  private readonly sessions: ConversationSessionPublicCommandHandler;
  private readonly navigation: ConversationNavigationPublicCommandHandler;
  private readonly commandNow: () => Date;
  private readonly attachmentStore: ConversationAttachmentStore | undefined;
  private readonly pipeline: AgentControlExecutionPipeline | undefined;
  private readonly wakeProjectionDrain: () => void;

  public constructor(input: AgentConversationComponentInput) {
    const options = input.options ?? {};
    this.conversation = input.conversation;
    this.authority = new ConversationAuthorityService(input.conversation);
    this.pipeline = input.executionPipeline;
    this.wakeProjectionDrain = input.wakeProjectionDrain;
    this.commandNow = options.commandNow ?? (() => new Date());
    this.attachmentStore = options.attachmentStore;
    const handlerCallbacks = {
      wakeProjectionDrain: input.wakeProjectionDrain,
      resolveCommandTime: (commandId: string) => this.resolveCommandTime(commandId)
    };
    this.sessions = new ConversationSessionPublicCommandHandler(
      input.conversation, handlerCallbacks, options.authorizedWorkspaceIds
    );
    this.navigation = new ConversationNavigationPublicCommandHandler(
      input.conversation, handlerCallbacks, options.authorizedWorkspaceIds
    );
  }

  public executeSession(
    envelope: RuntimeCommandEnvelope,
    command: SessionCommand
  ): Promise<RuntimeApplicationCommandResult> {
    return this.sessions.execute(envelope, command);
  }

  public commandOwners(): readonly AgentPublicCommandOwner[] {
    return Object.freeze([
      defineAgentPublicCommandOwner('conversation.sessions', [
        'conversation.session.create.v3', 'conversation.session.rename.v3',
        'conversation.session.archive.v3', 'conversation.session.restore.v3'
      ], (envelope, command) => this.executeSession(envelope, command),
      (envelope, command) => this.reconcileCommitted(
        envelope,
        () => this.executeSession(envelope, command),
        'conversation_command_reconciliation_invalid'
      )),
      defineAgentPublicCommandOwner('conversation.navigation', [
        'conversation.session.fork.v3', 'conversation.sessions.query.v3',
        'conversation.message.resolve.v3'
      ], (envelope, command) => this.executeNavigation(envelope, command),
      (envelope, command) => command.kind === 'conversation.session.fork.v3'
        ? this.reconcileCommitted(
            envelope,
            () => this.executeNavigation(envelope, command),
            'conversation_fork_reconciliation_invalid'
          )
        : Promise.resolve({ kind: 'not_committed' })),
      defineAgentPublicCommandOwner('conversation.message', [
        'conversation.message.accept.v3'
      ], (envelope, command) => this.executeAcceptMessage(envelope, command),
      (envelope, command) => this.reconcileCommitted(
        envelope,
        () => this.executeAcceptMessage(envelope, command),
        'conversation_command_reconciliation_invalid'
      ))
    ]);
  }

  public executeNavigation(
    envelope: RuntimeCommandEnvelope,
    command: NavigationCommand
  ): Promise<RuntimeApplicationCommandResult> {
    return this.navigation.execute(envelope, command);
  }

  public async reconcileCommitted(
    envelope: RuntimeCommandEnvelope,
    execute: () => Promise<RuntimeApplicationCommandResult | null>,
    invalidErrorCode: string
  ): Promise<RuntimeCommandReconciliation> {
    const committed = await this.conversation.readCommittedAuthorityCommand(envelope.commandId);
    if (committed === null) return { kind: 'not_committed' };
    const result = await execute();
    if (result === null || result.settlement !== 'completed') {
      throw new Error(invalidErrorCode);
    }
    return { kind: 'committed', outcome: result.outcome };
  }

  public async executeAcceptMessage(
    envelope: RuntimeCommandEnvelope,
    command: AcceptMessageCommand
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const committed = await this.conversation.readCommittedAuthorityCommand(envelope.commandId);
    if (committed === null) {
      const unavailable = this.assertMessageAdmission(envelope, command.workspaceId);
      if (unavailable !== null) return unavailable;
    }
    const [eventId, sagaId, handoffCommandId, handoffOutboxMessageId, occurredAt] = (
      await Promise.all([
        deriveConversationAuthorityId('message-accepted-event', envelope.commandId),
        deriveConversationAuthorityId('handoff-saga', envelope.commandId),
        deriveConversationAuthorityId('handoff-accept-command', envelope.commandId),
        deriveConversationAuthorityId('handoff-accept-outbox', envelope.commandId),
        this.resolveCommandTime(envelope.commandId)
      ])
    );
    envelope.signal.throwIfAborted();
    const attachments = await this.saveAttachments(envelope, command);
    if ('outcome' in attachments) return attachments;
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
      ...(attachments.value === undefined ? {} : { attachments: attachments.value }),
      execution: command.execution ?? { mode: 'agent' as const },
      sagaId,
      handoffCommandId,
      handoffOutboxMessageId,
      occurredAt
    } as const;
    let result;
    try {
      result = await this.authority.acceptUserMessage(authorityCommand);
    } catch (error) {
      envelope.signal.throwIfAborted();
      const replay = await this.conversation.readCommittedAuthorityCommand(envelope.commandId);
      if (replay !== null) result = await this.authority.acceptUserMessage(authorityCommand);
      else {
        const failure = publicConversationFailure(envelope, error);
        if (failure !== null) return failure;
        throw error;
      }
    }
    this.pipeline?.handoffProducer.wake();
    this.pipeline?.executionScheduler.wake();
    this.wakeProjectionDrain();
    return {
      outcome: { ok: true, result: {
        kind: 'conversation.message.accepted.v3',
        sessionId: result.session.sessionId,
        sessionVersion: result.session.version,
        messageId: result.messageVersion.messageId,
        messageVersion: 1,
        sagaId: result.saga.sagaId
      } },
      settlement: 'completed'
    };
  }

  private assertMessageAdmission(
    envelope: RuntimeCommandEnvelope,
    workspaceId: string
  ): RuntimeApplicationCommandResult | null {
    if (this.pipeline === undefined) {
      return completedPublicError(
        envelope, 'agent_execution_unavailable',
        'Agent execution is unavailable because its durable Handoff producer is not configured.',
        false
      );
    }
    this.pipeline.runWorkScheduler.assertHealthy();
    this.pipeline.executionScheduler.assertHealthy();
    this.pipeline.handoffProducer.assertHealthy();
    try {
      this.pipeline.assertConversationMessageAdmission(workspaceId);
      return null;
    } catch (error) {
      if (!(error instanceof AgentControlConversationMessageAdmissionError)) throw error;
      return completedPublicError(
        envelope, 'agent_execution_unavailable',
        'Agent execution is unavailable for this Workspace.', false
      );
    }
  }

  private async saveAttachments(
    envelope: RuntimeCommandEnvelope,
    command: AcceptMessageCommand
  ): Promise<
    | { readonly value: Awaited<ReturnType<ConversationAttachmentStore['saveImages']>> | undefined }
    | RuntimeApplicationCommandResult
  > {
    if (command.attachments === undefined) return { value: undefined };
    if (this.attachmentStore === undefined) {
      return completedPublicError(
        envelope, 'conversation_attachment_unavailable',
        'Image attachments are unavailable in this Runtime.', false
      );
    }
    try {
      return { value: await this.attachmentStore.saveImages(command.attachments, envelope.signal) };
    } catch {
      envelope.signal.throwIfAborted();
      return completedPublicError(
        envelope, 'conversation_attachment_invalid',
        'One or more image attachments could not be validated and stored.', false
      );
    }
  }

  private async resolveCommandTime(commandId: string): Promise<string> {
    const committed = await this.conversation.readCommittedAuthorityCommand(commandId);
    if (committed !== null) return committed.receipt.committedAt;
    const now = this.commandNow();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('conversation_command_clock_invalid');
    }
    return now.toISOString();
  }
}
