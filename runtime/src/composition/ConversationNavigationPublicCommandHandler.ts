import type {
  SqliteConversationRunHandoffUnitOfWork
} from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import {
  deriveConversationAuthorityId
} from '../conversation/ConversationRunHandoffIds.js';
import type {
  RuntimeApplicationCommandResult
} from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';

type ConversationNavigationCommand = Extract<
  RuntimeCommandEnvelope['command'],
  {
    readonly kind:
      | 'conversation.session.fork.v3'
      | 'conversation.sessions.query.v3'
      | 'conversation.message.resolve.v3';
  }
>;

export interface ConversationNavigationPublicCommandHandlerCallbacks {
  readonly wakeProjectionDrain: () => void;
  readonly resolveCommandTime: (commandId: string) => Promise<string>;
}

/** Public owner for immutable Conversation lineage, Session query, and stable references. */
export class ConversationNavigationPublicCommandHandler {
  private readonly authorizedWorkspaceIds: ReadonlySet<string>;

  public constructor(
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly callbacks: ConversationNavigationPublicCommandHandlerCallbacks,
    authorizedWorkspaceIds: readonly string[] = []
  ) {
    this.authorizedWorkspaceIds = new Set(authorizedWorkspaceIds);
  }

  public execute(
    envelope: RuntimeCommandEnvelope,
    command: ConversationNavigationCommand
  ): Promise<RuntimeApplicationCommandResult> {
    switch (command.kind) {
      case 'conversation.session.fork.v3':
        return this.fork(envelope, command);
      case 'conversation.sessions.query.v3':
        return this.query(envelope, command);
      case 'conversation.message.resolve.v3':
        return this.resolve(envelope, command);
    }
  }

  private async fork(
    envelope: RuntimeCommandEnvelope,
    command: Extract<ConversationNavigationCommand, {
      readonly kind: 'conversation.session.fork.v3';
    }>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const unauthorized = this.rejectUnauthorizedWorkspace(envelope, command.workspaceId);
    if (unauthorized !== null) return unauthorized;
    const [eventId, occurredAt] = await Promise.all([
      deriveConversationAuthorityId('session-forked-event', envelope.commandId),
      this.callbacks.resolveCommandTime(envelope.commandId)
    ]);
    try {
      const result = await this.conversation.forkSession({
        commandId: envelope.commandId,
        eventId,
        sessionId: command.sessionId,
        sourceSessionId: command.sourceSessionId,
        workspaceId: command.workspaceId,
        expectedSourceSessionVersion: command.expectedSourceSessionVersion,
        boundary: command.boundary,
        occurredAt
      });
      this.callbacks.wakeProjectionDrain();
      return {
        outcome: {
          ok: true,
          result: {
            kind: 'conversation.session.forked.v3',
            sessionId: result.session.sessionId,
            version: 1,
            sourceSessionId: result.lineage.sourceSessionId,
            boundary: result.lineage.boundary
          }
        },
        settlement: 'completed'
      };
    } catch (error) {
      return this.navigationFailure(envelope, error);
    }
  }

  private async query(
    envelope: RuntimeCommandEnvelope,
    command: Extract<ConversationNavigationCommand, {
      readonly kind: 'conversation.sessions.query.v3';
    }>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const unauthorized = this.rejectUnauthorizedWorkspace(envelope, command.workspaceId);
    if (unauthorized !== null) return unauthorized;
    const items = await this.conversation.querySessions(command);
    envelope.signal.throwIfAborted();
    return {
      outcome: {
        ok: true,
        result: {
          kind: 'conversation.sessions.query_result.v3',
          items: items.map(({ session, lineage, matches }) => ({
            sessionId: session.sessionId,
            workspaceId: session.workspaceId,
            version: session.version,
            title: session.title,
            status: session.status,
            updatedAt: session.updatedAt,
            lineage: lineage === null ? null : {
              sourceSessionId: lineage.sourceSessionId,
              boundary: lineage.boundary
            },
            matches: [...matches]
          }))
        }
      },
      settlement: 'completed'
    };
  }

  private async resolve(
    envelope: RuntimeCommandEnvelope,
    command: Extract<ConversationNavigationCommand, {
      readonly kind: 'conversation.message.resolve.v3';
    }>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    try {
      const resolved = await this.conversation.resolveMessageReference(command.reference);
      const unauthorized = this.rejectUnauthorizedWorkspace(envelope, resolved.workspaceId);
      if (unauthorized !== null) return unauthorized;
      return {
        outcome: {
          ok: true,
          result: { kind: 'conversation.message.resolved.v3', ...resolved }
        },
        settlement: 'completed'
      };
    } catch (error) {
      return this.navigationFailure(envelope, error);
    }
  }

  private navigationFailure(
    envelope: RuntimeCommandEnvelope,
    error: unknown
  ): RuntimeApplicationCommandResult {
    const code = error instanceof Error ? error.message : '';
    if (code === 'conversation_message_reference_not_found') {
      return completedPublicError(
        envelope,
        'conversation_message_reference_not_found',
        'The immutable Conversation message reference does not exist.',
        false
      );
    }
    if (
      code === 'conversation_fork_source_authority_changed'
      || code === 'conversation_fork_boundary_not_settled'
      || code === 'conversation_fork_session_already_exists'
    ) {
      return completedPublicError(
        envelope,
        'conversation_fork_conflict',
        'The Conversation changed before the fork could be committed.',
        false
      );
    }
    if (code === 'conversation_fork_command_conflict') {
      return completedPublicError(
        envelope,
        'conversation_command_conflict',
        'The Conversation command conflicts with an existing immutable fact.',
        false
      );
    }
    throw error;
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
