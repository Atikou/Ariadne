import type { RuntimeCommand, RuntimeHealthDomain } from '@ariadne/protocol/public';
import type { AgentPublicCommandOwnerSnapshot } from './command-owners/AgentPublicCommandOwnerTable.js';

// Compile from the existing sole-owner manifest, rather than maintain a second
// command-kind registry. An added owner needs an explicit dependency decision.
const ownerDomains: Readonly<Record<string, readonly RuntimeHealthDomain[]>> = Object.freeze({
  'conversation.sessions': ['conversation', 'projection'],
  'conversation.navigation': ['conversation'],
  'conversation.message': ['conversation', 'execution', 'projection'],
  'agent.run': ['execution', 'projection'],
  'agent.decision': ['execution', 'projection'],
  'agent.inbox': ['execution', 'projection'],
  'agent.subagent-interrupt': ['execution', 'projection'],
  'agent.tool-detail': ['execution'],
  'projection.query': ['execution', 'conversation', 'projection'],
  productivity: ['conversation', 'productivity'],
  'productivity.task-isolation': ['conversation', 'productivity'],
  'long-memory': ['conversation', 'memory'],
  'workspace-documents': [],
  'skills.human': [],
  'task-center.query': [], 'task-center.navigation': ['conversation'], 'task-center.relations': ['conversation']
});

export function compileAgentCommandHealthPolicy(owners: readonly AgentPublicCommandOwnerSnapshot[]):
  (command: RuntimeCommand) => readonly RuntimeHealthDomain[] {
  const domains = new Map<RuntimeCommand['kind'], readonly RuntimeHealthDomain[]>();
  for (const owner of owners) {
    const dependencies = ownerDomains[owner.id];
    if (dependencies === undefined) throw new Error(`agent_command_health_owner_unclassified:${owner.id}`);
    const frozen = Object.freeze([...dependencies]);
    for (const kind of owner.commandKinds) domains.set(kind, frozen);
  }
  return command => {
    const base = domains.get(command.kind) ?? [];
    if (command.kind === 'conversation.session.fork') return [...base, 'projection'];
    if (command.kind === 'productivity.task.reconcile' || command.kind === 'schedule.occurrences.query' || command.kind === 'schedule.create'
      || command.kind === 'schedule.occurrence.retry' || command.kind === 'goal.autonomy.start'
      || (command.kind === 'schedule.transition' && command.action === 'resume')
      || (command.kind === 'goal.autonomy.transition' && command.action === 'resume')
      || (command.kind === 'workflow.start' && command.executionMode === 'agent')) return [...base, 'execution'];
    return base;
  };
}
