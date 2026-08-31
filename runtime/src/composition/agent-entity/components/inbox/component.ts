import { defineCoreAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineCoreAgentComponent('agent.inbox', [
  'agent.persistence', 'agent.execution'
]);
