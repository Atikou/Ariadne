import { defineRuntimeCapabilityProvider } from '../../RuntimeCapabilityProvider.js';

export default Object.freeze([
  defineRuntimeCapabilityProvider({
    id: 'agent.control',
    dependsOn: ['runtime.kernel'],
    publicCapabilities: [
      'agent.runs', 'agent.inbox', 'agent.permissions', 'agent.plans',
      'scheduler', 'productivity.workflow'
    ],
    start: () => ({
      publicCapabilities: [
        'agent.runs', 'agent.inbox', 'agent.permissions', 'agent.plans',
        'scheduler', 'productivity.workflow'
      ]
    })
  })
]);
