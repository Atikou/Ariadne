import {
  defineComponent,
  type ComponentDefinition
} from '@ariadne/component-contracts';

const VERSION = '1.0';

/** Core Agent Entity definitions published into the same catalog as capability components. */
export function agentCoreComponentDefinitions(): readonly ComponentDefinition[] {
  return Object.freeze([
    core('agent.persistence', ['agent.control']),
    core('agent.projection', ['agent.persistence']),
    core('agent.execution', ['agent.persistence', 'agent.projection']),
    core('agent.conversation', ['agent.persistence', 'agent.execution']),
    core('agent.run-control', ['agent.persistence', 'agent.execution']),
    core('agent.tool-result-detail', ['agent.execution']),
    core('agent.inbox', ['agent.persistence', 'agent.execution']),
    core('agent.subagent-interrupt', ['agent.persistence', 'agent.execution']),
    core('agent.skills-human', ['skills.catalog']),
    core('agent.productivity', ['agent.persistence']),
    core('agent.command-entity', [
      'agent.conversation',
      'agent.run-control',
      'agent.tool-result-detail',
      'agent.inbox',
      'agent.subagent-interrupt',
      'agent.skills-human',
      'agent.productivity',
      'agent.projection'
    ])
  ]);
}

function core(id: string, dependsOn: readonly string[]): ComponentDefinition {
  return defineComponent({
    id,
    version: VERSION,
    entity: 'agent',
    required: true,
    dependsOn,
    configSchemaVersion: 1
  });
}
