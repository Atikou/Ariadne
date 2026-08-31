import { defineCoreAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineCoreAgentComponent('agent.command-entity', [
  'agent.conversation',
  'agent.run-control',
  'agent.tool-result-detail',
  'agent.inbox',
  'agent.subagent-interrupt',
  'agent.skills-human',
  'agent.productivity',
  'agent.projection'
]);
