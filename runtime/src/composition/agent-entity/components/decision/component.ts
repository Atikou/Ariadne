import { defineFeatureAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineFeatureAgentComponent('agent.decision', [
  'agent.persistence', 'agent.scheduler'
]);
