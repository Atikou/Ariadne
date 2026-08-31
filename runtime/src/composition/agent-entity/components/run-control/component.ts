import { defineCoreAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineCoreAgentComponent('agent.run-control', [
  'agent.persistence', 'agent.execution'
]);
