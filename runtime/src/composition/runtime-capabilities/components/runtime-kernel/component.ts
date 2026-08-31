import { defineRuntimeCapabilityProvider } from '../../RuntimeCapabilityProvider.js';

export default Object.freeze([
  defineRuntimeCapabilityProvider({
    id: 'runtime.kernel',
    publicCapabilities: [
      'companion.chat', 'companion.agent-plan', 'companion.sessions',
      'models.local', 'models.remote'
    ],
    start: () => ({
      publicCapabilities: [
        'companion.chat', 'companion.agent-plan', 'companion.sessions',
        'models.local', 'models.remote'
      ]
    })
  })
]);
