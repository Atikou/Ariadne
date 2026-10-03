import type {
  SqliteConversationRunHandoffUnitOfWork
} from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import {
  deriveConversationAuthorityId
} from '../conversation/ConversationRunHandoffIds.js';
import {
  ConversationAuthorityService
} from '../control/conversation/ConversationAuthorityService.js';
import type {
  RuntimeApplicationCommandResult
} from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';
import { publicConversationFailure } from './ConversationPublicCommandFailures.js';

type ConversationSessionCommand = Extract<
  RuntimeCommandEnvelope['command'],
  {
    readonly kind:
      | 'conversation.session.create.v3'
      | 'conversation.session.rename.v3'
      | 'conversation.session.archive.v3'
      | 'conversation.session.restore.v3';
  }
>;

export interface ConversationSessionPublicCommandHandlerCallbacks {
  readonly wakeProjectionDrain: () => void;
  readonly resolveCommandTime: (commandId: string) => Promise<string>;
}

/** Owns public Conversation session lifecycle commands and their exact replay. */
export class ConversationSessionPublicCommandHandler {
  private readonly authority: ConversationAuthorityService;
  private readonly authorizedWorkspaceIds: ReadonlySet<string>;

  public constructor(
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly callbacks: ConversationSessionPublicCommandHandlerCallbacks,
    authorizedWorkspaceIds: readonly string[] = []
  ) {
    this.authority = new ConversationAuthorityService(conversation);
    this.authorizedWorkspaceIds = new Set(authorizedWorkspaceIds);
  }

  public execute(
    envelope: RuntimeCommandEnvelope,
    command: ConversationSessionCommand
  ): Promise<RuntimeApplicationCommandResult> {
    return command.kind === 'conversation.session.create.v3'
      ? this.create(envelope, command)
      : this.mutate(envelope, command);
  }

  private async create(
    envelope: RuntimeCommandEnvelope,
    command: Extract<ConversationSessionCommand, {
      readonly kind: 'conversation.session.create.v3';
    }>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const unauthorized = this.rejectUnauthorizedWorkspace(envelope, command.workspaceId);
    if (unauthorized !== null) return unauthorized;
    const [eventId, occurredAt] = await Promise.all([
      deriveConversationAuthorityId('session-created-event', envelope.commandId),
      this.callbacks.resolveCommandTime(envelope.commandId)
    ]);
    envelope.signal.throwIfAborted();
    const authorityCommand = {
      kind: 'conversation.create_session',
      commandId: envelope.commandId,
      eventId,
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      ...(command.title === undefined ? {} : { title: command.title }),
      expectedVersion: null,
      occurredAt
    } as const;
    let result;
    try {
      result = await this.authority.createSession(authorityCommand);
    } catch (error) {
      envelope.signal.throwIfAborted();
      const committed = await this.conversation.readCommittedAuthorityCommand(
        envelope.commandId
      );
      if (committed !== null) {
        result = await this.authority.createSession(authorityCommand);
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

  private async mutate(
    envelope: RuntimeCommandEnvelope,
    command: Exclude<ConversationSessionCommand, {
      readonly kind: 'conversation.session.create.v3';
    }>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const unauthorized = this.rejectUnauthorizedWorkspace(envelope, command.workspaceId);
    if (unauthorized !== null) return unauthorized;
    const [eventId, occurredAt] = await Promise.all([
      deriveConversationAuthorityId('session-updated-event', envelope.commandId),
      this.callbacks.resolveCommandTime(envelope.commandId)
    ]);
    const mutation = command.kind === 'conversation.session.rename.v3'
      ? { kind: 'rename' as const, title: command.title }
      : {
          kind: 'set_status' as const,
          status: command.kind === 'conversation.session.archive.v3'
            ? 'archived' as const
            : 'active' as const
        };
    const authorityCommand = {
      kind: 'conversation.mutate_session' as const,
      commandId: envelope.commandId,
      eventId,
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      expectedSessionVersion: command.expectedSessionVersion,
      mutation,
      occurredAt
    };
    let result;
    try {
      result = await this.authority.mutateSession(authorityCommand);
    } catch (error) {
      envelope.signal.throwIfAborted();
      const committed = await this.conversation.readCommittedAuthorityCommand(
        envelope.commandId
      );
      if (committed !== null) {
        result = await this.authority.mutateSession(authorityCommand);
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
          kind: 'conversation.session.updated.v3',
          sessionId: command.sessionId,
          version: result.resultingSessionVersion
        }
      },
      settlement: 'completed'
    };
  }

  private rejectUnauthorizedWorkspace(
    envelope: RuntimeCommandEnvelope,
    workspaceId: string
  ): RuntimeApplicationCommandResult | null {
    return this.authorizedWorkspaceIds.size > 0
      && !this.authorizedWorkspaceIds.has(workspaceId)
      ? completedPublicError(
          envelope,
          'workspace_not_authorized',
          'The Workspace is not authorized by this Runtime bootstrap.',
          false
        )
      : null;
  }
}
