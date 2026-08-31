import { defineCoreAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineCoreAgentComponent('agent.decision', [
  'agent.persistence', 'agent.scheduler'
]);
