import { defineCoreAgentComponent } from '../../CoreAgentComponentDefinition.js';

export default defineCoreAgentComponent('agent.execution', [
  'agent.inference-loop', 'agent.persistence', 'agent.projection', 'agent.subagent',
  'agent.tool-execution'
]);
