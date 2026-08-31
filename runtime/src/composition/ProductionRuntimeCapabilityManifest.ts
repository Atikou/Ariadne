import type { RuntimeCapabilityManifest } from '../ingress/RuntimeCapabilityManifest.js';
import type { AgentControlRuntimeServices } from '../ingress/AgentControlLifecycle.js';
import {
  createProductionRuntimeCapabilityStartContext,
  type ProductionRuntimeCapabilityManifestInput
} from './runtime-capabilities/ProductionRuntimeCapabilityContext.js';
import {
  productionRuntimeCapabilityProviders
} from './runtime-capabilities/ProductionRuntimeCapabilityCatalog.generated.js';
import { AGENT_CONTROL_RUNTIME_SERVICES_ID } from './runtime-capabilities/AgentControlRuntimeServicesProvider.js';
import { compileRuntimeCapabilityManifest } from './runtime-capabilities/RuntimeCapabilityManifestCompiler.js';
import {
  agentCoreComponentDefinitions
} from './agent-entity/AgentCoreComponentCatalog.generated.js';

export type { ProductionRuntimeCapabilityManifestInput };
export { createProductionRuntimeCapabilityStartContext };
export { productionRuntimeCapabilityProviders };
export { compileRuntimeCapabilityManifest };
export type {
  RuntimeCapabilityHandle,
  RuntimeCapabilityProvider,
  RuntimeCapabilityStartContext
} from './runtime-capabilities/RuntimeCapabilityProvider.js';

/** Fixed, audited production composition; no runtime module discovery. */
export function compileProductionRuntimeCapabilityManifest(
  input: ProductionRuntimeCapabilityManifestInput
): Promise<RuntimeCapabilityManifest> {
  return compileRuntimeCapabilityManifest(
    createProductionRuntimeCapabilityStartContext(input),
    productionRuntimeCapabilityProviders(),
    agentCoreComponentDefinitions()
  );
}

/** Resolve the one terminal service bundle consumed by Agent Control composition. */
export function resolveAgentControlRuntimeServices(
  manifest: RuntimeCapabilityManifest
): AgentControlRuntimeServices {
  const services = manifest.service<AgentControlRuntimeServices>(
    AGENT_CONTROL_RUNTIME_SERVICES_ID
  );
  if (services === undefined) {
    throw new Error('agent_control_runtime_services_unavailable');
  }
  return services;
}
