import { defineCoreAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineCoreAgentComponent('agent.execution', [
  'agent.persistence', 'agent.projection', 'agent.subagent'
]);
