import { defineFeatureAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineFeatureAgentComponent('agent.inbox', [
  'agent.persistence', 'agent.execution'
]);
