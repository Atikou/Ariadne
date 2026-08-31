import type { RuntimeApplicationCommandResult } from '../../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../../ingress/RuntimeIngress.js';
import type { RuntimeCommandReconciliation } from '../../../control/ports/RuntimeCommandJournal.js';
import type { AgentInboxPublicCommandHandler } from '../../AgentInboxPublicCommandHandler.js';
import type { AgentSubagentInterruptPublicCommandHandler } from '../../AgentSubagentInterruptPublicCommandHandler.js';
import type { HumanSkillPublicCommandHandler } from '../../HumanSkillPublicCommandHandler.js';
import {
  completedPublicError
} from '../../AgentPublicCommandFailures.js';
import {
  isProductivityCommand,
  isProductivityQuery,
  PRODUCTIVITY_COMMAND_KINDS,
  type ProductivityPublicCommandHandler
} from '../../ProductivityPublicCommandHandler.js';
import type {
  AgentPublicCommandOwner,
  PublicCommandKind
} from './AgentPublicCommandOwnerTable.js';
import type {
  AgentConversationComponentHandle
} from '../components/conversation/AgentConversationComponent.js';
import type {
  AgentRunControlComponentHandle
} from '../components/run-control/AgentRunControlComponent.js';
import type {
  AgentToolResultDetailComponentHandle
} from '../components/tool-result-detail/AgentToolResultDetailComponent.js';

type OwnedPublicCommand<K extends PublicCommandKind> = Extract<
  RuntimeCommandEnvelope['command'],
  { readonly kind: K }
>;

export interface AgentPublicCommandOwnerInputs {
  readonly conversation: AgentConversationComponentHandle;
  readonly runControl: AgentRunControlComponentHandle;
  readonly toolResultDetail: AgentToolResultDetailComponentHandle;
  readonly agentInbox: AgentInboxPublicCommandHandler;
  readonly subagentInterrupt: AgentSubagentInterruptPublicCommandHandler;
  readonly humanSkills?: HumanSkillPublicCommandHandler;
  readonly productivity?: ProductivityPublicCommandHandler;
  readonly executeProjectionCommand: (envelope: RuntimeCommandEnvelope) => Promise<RuntimeApplicationCommandResult>;
  readonly reconcileConversation: (
    envelope: RuntimeCommandEnvelope,
    invalidErrorCode: string
  ) => Promise<RuntimeCommandReconciliation>;
  readonly reconcileByReplay: (
    envelope: RuntimeCommandEnvelope,
    invalidErrorCode: string
  ) => Promise<RuntimeCommandReconciliation>;
}

type CommandExecutor<K extends PublicCommandKind> = (
  envelope: RuntimeCommandEnvelope,
  command: OwnedPublicCommand<K>
) => Promise<RuntimeApplicationCommandResult>;

type CommandReconciler<K extends PublicCommandKind> = (
  envelope: RuntimeCommandEnvelope,
  command: OwnedPublicCommand<K>
) => Promise<RuntimeCommandReconciliation>;

/** Declares public command ownership without owning persistence or lifecycle resources. */
export function createAgentPublicCommandOwners(
  input: AgentPublicCommandOwnerInputs
): readonly AgentPublicCommandOwner[] {
  return Object.freeze([
    owner('conversation.sessions', [
      'conversation.session.create.v3', 'conversation.session.rename.v3',
      'conversation.session.archive.v3', 'conversation.session.restore.v3'
    ], (envelope, command) => input.conversation.executeSession(envelope, command),
    (envelope) => input.reconcileConversation(
      envelope, 'conversation_command_reconciliation_invalid'
    )),
    owner('conversation.navigation', [
      'conversation.session.fork.v3', 'conversation.sessions.query.v3',
      'conversation.message.resolve.v3'
    ], (envelope, command) => input.conversation.executeNavigation(envelope, command),
    (envelope) => isReadOnly(envelope.command.kind)
      ? Promise.resolve({ kind: 'not_committed' })
      : input.reconcileConversation(envelope, 'conversation_fork_reconciliation_invalid')),
    owner('conversation.message', ['conversation.message.accept.v3'],
      (envelope, command) => input.conversation.executeAcceptMessage(envelope, command),
      (envelope) => input.reconcileConversation(
        envelope, 'conversation_command_reconciliation_invalid'
      )),
    owner('agent.decision', ['agent.decision.resolve.v3'],
      (envelope, command) => input.runControl.executeDecision(envelope, command),
      (envelope, command) => input.runControl.reconcileDecision(envelope, command)),
    owner('agent.run', ['agent.run.cancel.v3'],
      (envelope, command) => input.runControl.executeCancellation(envelope, command),
      (envelope) => input.reconcileByReplay(
        envelope, 'agent_run_cancel_reconciliation_invalid'
      )),
    owner('agent.inbox', [
      'agent.inbox.enqueue.v3', 'agent.inbox.replace.v3',
      'agent.inbox.remove.v3', 'agent.subagent.send.v3'
    ], (envelope, command) => input.agentInbox.execute(envelope, command),
    (envelope) => input.reconcileByReplay(
      envelope, 'agent_inbox_command_reconciliation_invalid'
    )),
    owner('agent.subagent-interrupt', ['agent.subagent.interrupt.v3'],
      (envelope, command) => input.subagentInterrupt.execute(envelope, command),
      (envelope) => input.reconcileByReplay(
        envelope, 'agent_subagent_interrupt_reconciliation_invalid'
      )),
    owner('agent.tool-detail', ['agent.tool_result.detail.get.v3'],
      (envelope, command) => input.toolResultDetail.execute(envelope, command),
      notCommitted),
    owner('skills.human', [
      'skill.commands.query.v3', 'skill.command.load.v3', 'skill.command.resource.read.v3'
    ], (envelope, command) => input.humanSkills?.execute(envelope, command)
      ?? Promise.resolve(completedPublicError(
        envelope, 'skill_catalog_unavailable',
        'The human Skill command catalog is unavailable.', false
      )), notCommitted),
    owner('productivity', PRODUCTIVITY_COMMAND_KINDS,
      (envelope, command) => input.productivity?.execute(envelope, command)
        ?? Promise.resolve(completedPublicError(
          envelope, 'productivity_unavailable',
          'Goal, Todo, Workflow and Schedule authority is unavailable.', false
        )), async (envelope) => {
        if (isProductivityCommand(envelope.command) && isProductivityQuery(envelope.command)) {
          return { kind: 'not_committed' };
        }
        const result = await input.productivity?.reconcile(envelope);
        return result?.outcome.ok
          ? { kind: 'committed', outcome: result.outcome }
          : { kind: 'not_committed' };
      }),
    owner('projection.query', ['projection.snapshot.get', 'projection.commits.read'],
      (envelope) => input.executeProjectionCommand(envelope),
      notCommitted)
  ]);
}

function owner<K extends PublicCommandKind>(
  id: string,
  commandKinds: readonly K[],
  execute: CommandExecutor<K>,
  reconcile: CommandReconciler<K>
): AgentPublicCommandOwner {
  const frozenKinds = Object.freeze([...commandKinds]);
  return Object.freeze({
    id,
    commandKinds: frozenKinds,
    execute: (envelope: RuntimeCommandEnvelope) => execute(
      envelope, envelope.command as OwnedPublicCommand<K>
    ),
    reconcile: (envelope: RuntimeCommandEnvelope) => reconcile(
      envelope, envelope.command as OwnedPublicCommand<K>
    )
  });
}

function isReadOnly(kind: PublicCommandKind): boolean {
  return kind === 'conversation.sessions.query.v3'
    || kind === 'conversation.message.resolve.v3';
}

async function notCommitted(): Promise<RuntimeCommandReconciliation> {
  return { kind: 'not_committed' };
}
