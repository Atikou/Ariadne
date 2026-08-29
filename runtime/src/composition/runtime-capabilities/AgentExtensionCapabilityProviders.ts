import { TelemetryService } from '../../adapters/observability/ProductionTelemetryService.js';
import { createConfiguredAgentLifecycleHookService } from '../ProductionAgentLifecycleHookService.js';
import { createProductionSkillCatalog } from './ProductionSkillCatalog.js';
import { defineRuntimeCapabilityProvider, type RuntimeCapabilityProvider } from './RuntimeCapabilityProvider.js';

/** Skills, typed lifecycle Hooks, and observer-only diagnostics/telemetry. */
export function agentExtensionCapabilityProviders(): readonly RuntimeCapabilityProvider[] {
  return Object.freeze([
    defineRuntimeCapabilityProvider({
      id: 'skills.catalog',
      dependsOn: ['agent.control'],
      provides: [{ serviceId: 'agent.skills.catalog', optional: false }],
      publicCapabilities: ['skills.catalog'],
      start: (context) => {
        const catalog = createProductionSkillCatalog(context.bootstrap, context.workspaceBindings);
        return {
          publicCapabilities: context.bootstrap.runtimePolicy.skills.enabled.length > 0
            ? ['skills.catalog'] : [],
          tools: catalog.createToolRegistrations(),
          services: { 'agent.skills.catalog': catalog },
          close: async () => catalog.close()
        };
      }
    }),
    defineRuntimeCapabilityProvider({
      id: 'hooks.lifecycle',
      dependsOn: ['agent.control'],
      provides: [{ serviceId: 'agent.hooks.lifecycle', optional: false }],
      publicCapabilities: ['hooks.lifecycle'],
      start: (context) => {
        const service = createConfiguredAgentLifecycleHookService(
          context.bootstrap.runtimePolicy.hooks.definitions
        );
        return {
          publicCapabilities: context.bootstrap.runtimePolicy.hooks.definitions.length > 0
            ? ['hooks.lifecycle'] : [],
          services: { 'agent.hooks.lifecycle': service },
          close: async () => service.close()
        };
      }
    }),
    defineRuntimeCapabilityProvider({
      id: 'agent.observability',
      dependsOn: ['agent.control'],
      provides: [{ serviceId: 'agent.telemetry', optional: true }],
      publicCapabilities: ['observability.diagnostics', 'telemetry.export'],
      start: (context) => {
        let telemetry: TelemetryService | undefined;
        if (context.bootstrap.runtimePolicy.telemetry.enabled) {
          try {
            telemetry = new TelemetryService(
              context.bootstrap.runtimePolicy.telemetry,
              context.bootstrap.runtimeVersion
            );
          } catch {
            telemetry = undefined;
          }
        }
        return {
          publicCapabilities: [
            'observability.diagnostics',
            ...(telemetry === undefined ? [] : ['telemetry.export' as const])
          ],
          services: {
            ...(telemetry === undefined ? {} : { 'agent.telemetry': telemetry })
          },
          close: async () => {
            try { await telemetry?.shutdown(); } catch { /* exporter is isolated */ }
          }
        };
      }
    })
  ]);
}
