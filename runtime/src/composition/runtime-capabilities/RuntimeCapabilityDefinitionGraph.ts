import { compileComponentDefinitionGraph } from '@ariadne/component-contracts';
import { runtimeCapabilitySchema, type RuntimeCapability } from '@ariadne/protocol/public';

import { toAgentComponentDefinition } from './RuntimeCapabilityComponentAdapter.js';
import type { RuntimeCapabilityProvider } from './RuntimeCapabilityProvider.js';

/** Freeze, validate, and order the Agent capability graph through the shared Component Kernel. */
export function compileRuntimeCapabilityDefinitionGraph(
  providers: readonly RuntimeCapabilityProvider[]
): readonly RuntimeCapabilityProvider[] {
  const snapshots = snapshotProviders(providers);
  validatePublicCapabilityOwnership(snapshots);
  const ordered = compileComponentDefinitionGraph(
    'agent',
    snapshots.map((provider) => toAgentComponentDefinition(provider.definition)),
    { errorNamespace: 'runtime_capability' }
  );
  const providersById = new Map(snapshots.map((provider) => [provider.definition.id, provider]));
  return Object.freeze(ordered.map((definition) => {
    const provider = providersById.get(definition.id);
    if (provider === undefined) throw new Error('runtime_capability_graph_invariant_broken');
    return provider;
  }));
}

function validatePublicCapabilityOwnership(providers: readonly RuntimeCapabilityProvider[]): void {
  const owners = new Map<RuntimeCapability, string>();
  for (const provider of providers) {
    const declared = new Set<RuntimeCapability>();
    for (const capability of provider.definition.publicCapabilities) {
      runtimeCapabilitySchema.parse(capability);
      if (declared.has(capability)) {
        throw new Error(`runtime_capability_public_declaration_duplicate:${capability}`);
      }
      declared.add(capability);
      const owner = owners.get(capability);
      if (owner !== undefined) {
        throw new Error(`runtime_capability_public_owner_duplicate:${capability}:${owner}`);
      }
      owners.set(capability, provider.definition.id);
    }
  }
}

function snapshotProviders(
  providers: readonly RuntimeCapabilityProvider[]
): readonly RuntimeCapabilityProvider[] {
  return Object.freeze(providers.map((provider) => Object.freeze({
    definition: Object.freeze({
      id: provider.definition.id,
      contractVersion: provider.definition.contractVersion,
      dependsOn: Object.freeze([...provider.definition.dependsOn]),
      consumes: Object.freeze(provider.definition.consumes.map((dependency) => Object.freeze({
        serviceId: dependency.serviceId,
        optional: dependency.optional
      }))),
      provides: Object.freeze(provider.definition.provides.map((provision) => Object.freeze({
        serviceId: provision.serviceId,
        optional: provision.optional
      }))),
      publicCapabilities: Object.freeze([...provider.definition.publicCapabilities])
    }),
    start: provider.start
  })));
}
