import { defineCoreAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineCoreAgentComponent('agent.scheduler', [
  'agent.inference-loop', 'agent.persistence', 'agent.subagent', 'agent.tool-execution'
]);
