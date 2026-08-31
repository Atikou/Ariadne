import { defineCoreAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineCoreAgentComponent('agent.inference-loop', [
  'agent.persistence', 'agent.subagent', 'agent.tool-execution'
]);
