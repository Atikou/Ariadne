import { agentControlRuntimeServicesProvider } from './AgentControlRuntimeServicesProvider.js';
import { agentExtensionCapabilityProviders } from './AgentExtensionCapabilityProviders.js';
import { agentInstructionCapabilityProviders } from './AgentInstructionCapabilityProviders.js';
import { firstPartyAgentCapabilityProviders } from './FirstPartyAgentCapabilityProviders.js';
import {
  defineRuntimeCapabilityProvider,
  type RuntimeCapabilityProvider
} from './RuntimeCapabilityProvider.js';

export { AGENT_CONTROL_RUNTIME_SERVICES_ID } from './AgentControlRuntimeServicesProvider.js';

export function productionRuntimeCapabilityProviders(): readonly RuntimeCapabilityProvider[] {
  return Object.freeze([
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
    }),
    defineRuntimeCapabilityProvider({
      id: 'agent.control',
      dependsOn: ['runtime.kernel'],
      publicCapabilities: ['agent.runs', 'agent.inbox', 'agent.permissions', 'agent.plans'],
      start: () => ({
        publicCapabilities: ['agent.runs', 'agent.inbox', 'agent.permissions', 'agent.plans']
      })
    }),
    ...firstPartyAgentCapabilityProviders(),
    ...agentExtensionCapabilityProviders(),
    ...agentInstructionCapabilityProviders(),
    agentControlRuntimeServicesProvider()
  ]);
}
