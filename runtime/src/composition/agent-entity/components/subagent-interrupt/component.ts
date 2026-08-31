import { defineFeatureAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineFeatureAgentComponent('agent.subagent-interrupt', [
  'agent.persistence', 'agent.execution'
]);
