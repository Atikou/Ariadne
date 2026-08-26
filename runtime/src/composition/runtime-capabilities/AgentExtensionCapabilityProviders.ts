import { TelemetryService } from '../../adapters/observability/ProductionTelemetryService.js';
import { createProductionSkillCatalog } from './ProductionSkillCatalog.js';
import { defineRuntimeCapabilityProvider, type RuntimeCapabilityProvider } from './RuntimeCapabilityProvider.js';

/** Skills, typed lifecycle Hooks, and observer-only diagnostics/telemetry. */
export function agentExtensionCapabilityProviders(): readonly RuntimeCapabilityProvider[] {
  return Object.freeze([
    defineRuntimeCapabilityProvider(
      'skills.catalog', ['agent.control'], ['agent.skills.catalog'], ['skills.catalog'],
      (context) => {
        const catalog = createProductionSkillCatalog(context.bootstrap, context.workspaceBindings);
        return {
          publicCapabilities: context.bootstrap.runtimePolicy.skills.enabled.length > 0
            && catalog.available ? ['skills.catalog'] : [],
          tools: catalog.createToolRegistrations(),
          services: { 'agent.skills.catalog': catalog }
        };
      }
    ),
    defineRuntimeCapabilityProvider(
      'hooks.lifecycle', ['agent.control'], ['agent.hooks.lifecycle'], ['hooks.lifecycle'],
      (context) => ({
        publicCapabilities: context.bootstrap.runtimePolicy.hooks.definitions.length > 0
          ? ['hooks.lifecycle'] : []
      })
    ),
    defineRuntimeCapabilityProvider(
      'agent.observability', ['agent.control'], ['agent.observability', 'agent.telemetry'],
      ['observability.diagnostics', 'telemetry.export'],
      (context) => {
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
            'agent.observability': Object.freeze({ contractVersion: 1 }),
            ...(telemetry === undefined ? {} : { 'agent.telemetry': telemetry })
          },
          close: async () => {
            try { await telemetry?.shutdown(); } catch { /* exporter is isolated */ }
          }
        };
      }
    )
  ]);
}
