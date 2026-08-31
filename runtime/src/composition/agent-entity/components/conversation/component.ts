import { defineCoreAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineCoreAgentComponent('agent.conversation', [
  'agent.persistence', 'agent.execution'
]);
