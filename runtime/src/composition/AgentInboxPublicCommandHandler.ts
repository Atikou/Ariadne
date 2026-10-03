import type { SqliteAgentRunUnitOfWork } from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { defineAgentPublicCommandOwner, type AgentPublicCommandOwner } from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';
import { AgentInboxMutationScope, type AgentInboxCommand } from './AgentInboxMutationScope.js';

export interface AgentInboxPublicCommandHandlerCallbacks {
  readonly wakeWorkScheduler: () => void;
  readonly wakeProjectionDrain: () => void;
}

/** Owns the atomic inbox command boundary and post-commit notifications. */
export class AgentInboxPublicCommandHandler {
  constructor(
    private readonly unitOfWork: SqliteAgentRunUnitOfWork,
    private readonly callbacks: AgentInboxPublicCommandHandlerCallbacks,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async execute(envelope: RuntimeCommandEnvelope, command: AgentInboxCommand): Promise<RuntimeApplicationCommandResult> {
    const result = await this.unitOfWork.transaction(transaction =>
      new AgentInboxMutationScope(transaction, this.now).execute(envelope, command));
    if (result.outcome.ok) {
      if (command.kind === 'agent.inbox.enqueue.v3' || command.kind === 'agent.subagent.send.v3') {
        this.callbacks.wakeWorkScheduler();
      }
      this.callbacks.wakeProjectionDrain();
    }
    return result;
  }

  public commandOwners(): readonly AgentPublicCommandOwner[] {
    return Object.freeze([
      defineAgentPublicCommandOwner('agent.inbox', [
        'agent.inbox.enqueue.v3', 'agent.inbox.replace.v3',
        'agent.inbox.remove.v3', 'agent.subagent.send.v3'
      ], (envelope, command) => this.execute(envelope, command),
      async (envelope, command) => {
        const result = await this.execute(envelope, command);
        if (result.settlement !== 'completed') {
          throw new Error('agent_inbox_command_reconciliation_invalid');
        }
        return result.outcome.ok
          ? { kind: 'committed', outcome: result.outcome }
          : { kind: 'not_committed' };
      })
    ]);
  }

}
