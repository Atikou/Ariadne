import type { ProductivityCommand } from '@ariadne/protocol/public';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';
import {
  defineAgentPublicCommandOwner,
  type AgentPublicCommandOwner
} from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';

export const PRODUCTIVITY_COMMAND_KINDS = Object.freeze([
  'goal.put.v3', 'todo.snapshot.replace.v3', 'productivity.query.v3',
  'workflow.start.v3', 'workflow.advance.v3', 'workflow.cancel.v3',
  'schedule.create.v3', 'schedule.transition.v3', 'schedules.query.v3'
] as const);
const PRODUCTIVITY_COMMAND_KIND_SET = new Set<string>(PRODUCTIVITY_COMMAND_KINDS);

export function isProductivityCommand(
  command: RuntimeCommandEnvelope['command']
): command is ProductivityCommand {
  return PRODUCTIVITY_COMMAND_KIND_SET.has(command.kind);
}

export function isProductivityQuery(
  command: ProductivityCommand
): command is Extract<ProductivityCommand, { kind: 'productivity.query.v3' | 'schedules.query.v3' }> {
  return command.kind === 'productivity.query.v3' || command.kind === 'schedules.query.v3';
}

export function createProductivityCommandOwners(
  handler: ProductivityPublicCommandHandler | undefined
): readonly AgentPublicCommandOwner[] {
  return Object.freeze([
    defineAgentPublicCommandOwner('productivity', PRODUCTIVITY_COMMAND_KINDS,
      (envelope, command) => handler?.execute(envelope, command)
        ?? Promise.resolve(completedPublicError(
          envelope, 'productivity_unavailable',
          'Goal, Todo, Workflow and Schedule authority is unavailable.', false
        )), async (envelope, command) => {
        if (isProductivityQuery(command)) return { kind: 'not_committed' };
        const result = await handler?.reconcile(envelope);
        return result?.outcome.ok
          ? { kind: 'committed', outcome: result.outcome }
          : { kind: 'not_committed' };
      })
  ]);
}

export class ProductivityPublicCommandHandler {
  private readonly authorizedWorkspaces: ReadonlySet<string>;
  public constructor(
    private readonly store: SqliteProductivityStore,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    authorizedWorkspaceIds: readonly string[]
  ) { this.authorizedWorkspaces = new Set(authorizedWorkspaceIds); }

  public async execute(
    envelope: RuntimeCommandEnvelope,
    command: ProductivityCommand
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    if (this.authorizedWorkspaces.size > 0 && !this.authorizedWorkspaces.has(command.workspaceId)) {
      return completedPublicError(envelope, 'workspace_not_authorized', 'The Workspace is not authorized.', false);
    }
    const session = await this.conversation.readSession(command.sessionId);
    if (session === null || session.workspaceId !== command.workspaceId) {
      return completedPublicError(envelope, 'conversation_session_not_found', 'The Conversation session does not exist.', false);
    }
    try {
      const result = command.kind === 'productivity.query.v3'
        ? await this.store.query(command.workspaceId, command.sessionId)
        : command.kind === 'schedules.query.v3'
          ? await this.store.querySchedules(command.workspaceId, command.sessionId)
          : await this.store.execute(envelope.commandId, command);
      return { outcome: { ok: true, result }, settlement: 'completed' };
    } catch (error) {
      envelope.signal.throwIfAborted();
      const code = error instanceof Error ? error.message : 'productivity_command_failed';
      return completedPublicError(envelope, publicCode(code), 'The productivity command could not be committed.', false);
    }
  }

  public async reconcile(envelope: RuntimeCommandEnvelope): Promise<RuntimeApplicationCommandResult | null> {
    const command = envelope.command as ProductivityCommand;
    if (isProductivityQuery(command)) return null;
    envelope.signal.throwIfAborted();
    if (this.authorizedWorkspaces.size > 0 && !this.authorizedWorkspaces.has(command.workspaceId)) return null;
    const session = await this.conversation.readSession(command.sessionId);
    if (session === null || session.workspaceId !== command.workspaceId) return null;
    try {
      const result = await this.store.reconcile(envelope.commandId, command);
      return result === null ? null : { outcome: { ok: true, result }, settlement: 'completed' };
    } catch {
      envelope.signal.throwIfAborted();
      return null;
    }
  }
}

function publicCode(code: string): string {
  if (code.endsWith('_version_conflict') || code === 'productivity_command_conflict') {
    return 'productivity_version_conflict';
  }
  if (code.startsWith('workflow_')) return code;
  if (code.startsWith('schedule_')) return code;
  if (code.startsWith('goal_') || code.startsWith('todo_')) return code;
  return 'productivity_command_failed';
}
