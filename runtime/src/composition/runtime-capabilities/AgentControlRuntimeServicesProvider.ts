import type { AgentControlRuntimeServices } from '../../ingress/AgentControlLifecycle.js';
import {
  defineRuntimeCapabilityProvider,
  type RuntimeCapabilityProvider
} from './RuntimeCapabilityProvider.js';

export const AGENT_CONTROL_RUNTIME_SERVICES_ID = 'agent.control.runtime-services';

export function agentControlRuntimeServicesProvider(): RuntimeCapabilityProvider {
  return defineRuntimeCapabilityProvider({
    id: 'agent.control.runtime-services',
    consumes: [
      { serviceId: 'agent.instructions.assembly', optional: false },
      { serviceId: 'agent.hooks.lifecycle', optional: false },
      { serviceId: 'agent.live-work', optional: false },
      { serviceId: 'agent.telemetry', optional: true }
    ],
    provides: [{ serviceId: AGENT_CONTROL_RUNTIME_SERVICES_ID, optional: false }],
    start: (context) => {
      const telemetry = context.services.optional<
        NonNullable<AgentControlRuntimeServices['telemetry']>
      >('agent.telemetry');
      const services: AgentControlRuntimeServices = Object.freeze({
        instructionAssembly: context.services.required<
          AgentControlRuntimeServices['instructionAssembly']
        >('agent.instructions.assembly'),
        lifecycleHooks: context.services.required<
          AgentControlRuntimeServices['lifecycleHooks']
        >('agent.hooks.lifecycle'),
        liveWorkLifecycle: context.services.required<
          NonNullable<AgentControlRuntimeServices['liveWorkLifecycle']>
        >('agent.live-work'),
        ...(context.processSandboxFactory === undefined
          ? {}
          : { processSandboxForWorkspace: context.processSandboxFactory }),
        ...(telemetry === undefined ? {} : { telemetry })
      });
      return {
        publicCapabilities: [],
        services: { [AGENT_CONTROL_RUNTIME_SERVICES_ID]: services }
      };
    }
  });
}
