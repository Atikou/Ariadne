import { defineCoreAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineCoreAgentComponent('agent.subagent-interrupt', [
  'agent.persistence', 'agent.execution'
]);
