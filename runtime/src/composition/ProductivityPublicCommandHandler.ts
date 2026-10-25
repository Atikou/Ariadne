import type { ProductivityCommand } from '@ariadne/protocol/public';
import type { AgentRun } from '@ariadne/agent-core';
import { ScheduleExecutionPublicQuery } from './ScheduleExecutionPublicQuery.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { ProductivityAuthority } from '../control/ports/ProductivityAuthority.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';
import { ProductivityCommandRejected } from '../adapters/persistence/ProductivityCommandRejected.js';
import { readOwnedAuthorityFault } from '../adapters/persistence/SqliteAuthorityHealth.js';
import {
  defineAgentPublicCommandOwner,
  type AgentPublicCommandOwner
} from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';

export const PRODUCTIVITY_COMMAND_KINDS = Object.freeze([
  'goal.put', 'todo.snapshot.replace', 'productivity.query',
  'workflow.start', 'workflow.advance', 'workflow.cancel',
  'schedule.create', 'schedule.transition', 'schedules.query',
  'schedule.occurrences.query', 'schedule.occurrence.retry',
  'goal.autonomy.start', 'goal.autonomy.transition'
] as const);
const PRODUCTIVITY_COMMAND_KIND_SET = new Set<string>(PRODUCTIVITY_COMMAND_KINDS);

export function isProductivityCommand(
  command: RuntimeCommandEnvelope['command']
): command is ProductivityCommand {
  return PRODUCTIVITY_COMMAND_KIND_SET.has(command.kind);
}

export function isProductivityQuery(
  command: ProductivityCommand
): command is Extract<ProductivityCommand, { kind: 'productivity.query' | 'schedules.query' | 'schedule.occurrences.query' }> {
  return command.kind === 'productivity.query' || command.kind === 'schedules.query'
    || command.kind === 'schedule.occurrences.query';
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
    private readonly store: ProductivityAuthority,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    authorizedWorkspaceIds: readonly string[],
    private readonly agentWorkflowAvailable = false,
    private readonly assertGoalAutonomyAdmission?: (workspaceId: string) => void,
    private readonly loadRun?: (runId: string) => Promise<AgentRun | null>
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
      if (command.kind === 'goal.autonomy.start' || (command.kind === 'goal.autonomy.transition' && command.action === 'resume')) {
        const committed = await this.store.reconcile(envelope.commandId, command);
        if (committed !== null) return { outcome: { ok: true, result: committed }, settlement: 'completed' };
        if (this.assertGoalAutonomyAdmission === undefined) return completedPublicError(envelope, 'goal_autonomy_unavailable', 'Autonomous Goal execution is unavailable.', false);
        this.assertGoalAutonomyAdmission(command.workspaceId);
        if (command.kind === 'goal.autonomy.transition') {
          const result = await this.store.execute(envelope.commandId, command);
          return { outcome: { ok: true, result }, settlement: 'completed' };
        }
        const context = await this.conversation.captureFrozenContext(command.sessionId, session.version);
        envelope.signal.throwIfAborted();
        const result = await this.store.execute(envelope.commandId, command, new Date(), context);
        return { outcome: { ok: true, result }, settlement: 'completed' };
      }
      if (command.kind === 'workflow.start' && command.executionMode === 'agent') {
        const committed = await this.store.reconcile(envelope.commandId, command);
        if (committed !== null) return { outcome: { ok: true, result: committed }, settlement: 'completed' };
        if (!this.agentWorkflowAvailable) return completedPublicError(envelope, 'workflow_execution_unavailable', 'Automatic Agent Workflow execution is unavailable.', false);
        const context = await this.conversation.captureFrozenContext(command.sessionId, session.version);
        envelope.signal.throwIfAborted();
        const result = await this.store.execute(envelope.commandId, command, new Date(), context);
        return { outcome: { ok: true, result }, settlement: 'completed' };
      }
      const result = command.kind === 'productivity.query'
        ? await this.store.query(command.workspaceId, command.sessionId)
        : command.kind === 'schedules.query'
          ? await this.store.querySchedules(command.workspaceId, command.sessionId)
          : command.kind === 'schedule.occurrences.query'
            ? this.loadRun === undefined ? await this.store.queryOccurrences(command)
              : await new ScheduleExecutionPublicQuery(this.store, this.conversation, this.loadRun)
                .project(command, await this.store.queryOccurrences(command), envelope.signal)
            : await this.store.execute(envelope.commandId, command);
      return { outcome: { ok: true, result }, settlement: 'completed' };
    } catch (error) {
      envelope.signal.throwIfAborted();
      if (readOwnedAuthorityFault(error) !== null || !(error instanceof ProductivityCommandRejected)) throw error;
      return completedPublicError(envelope, error.publicCode, 'The productivity command was rejected by its preconditions.', false);
    }
  }

  public async reconcile(envelope: RuntimeCommandEnvelope): Promise<RuntimeApplicationCommandResult | null> {
    const command = envelope.command as ProductivityCommand;
    if (isProductivityQuery(command)) return null;
    envelope.signal.throwIfAborted();
    if (this.authorizedWorkspaces.size > 0 && !this.authorizedWorkspaces.has(command.workspaceId)) return null;
    const session = await this.conversation.readSession(command.sessionId);
    if (session === null || session.workspaceId !== command.workspaceId) return null;
    const result = await this.store.reconcile(envelope.commandId, command);
    return result === null ? null : { outcome: { ok: true, result }, settlement: 'completed' };
  }
}
