import { runtimeCapabilitySchema, type RuntimeCapability } from '@ariadne/protocol/public';

import type { RuntimeCapabilityProvider } from './RuntimeCapabilityProvider.js';

interface ServiceOwner {
  readonly providerId: string;
  readonly optional: boolean;
}

/** Freeze, validate and order one static Provider graph before any Provider starts. */
export function compileRuntimeCapabilityDefinitionGraph(
  providers: readonly RuntimeCapabilityProvider[]
): readonly RuntimeCapabilityProvider[] {
  const snapshots = snapshotProviders(providers);
  validateDefinitions(snapshots);
  return topologicallyOrder(snapshots);
}

function validateDefinitions(providers: readonly RuntimeCapabilityProvider[]): void {
  const ids = new Set<string>();
  const serviceOwners = new Map<string, ServiceOwner>();
  const publicOwners = new Map<RuntimeCapability, string>();
  for (const provider of providers) {
    const definition = provider.definition;
    if (!canonicalId(definition.id) || !/^\d+\.\d+$/u.test(definition.contractVersion)) {
      throw new Error('runtime_capability_definition_invalid');
    }
    if (ids.has(definition.id)) throw new Error(`runtime_capability_duplicate:${definition.id}`);
    ids.add(definition.id);
    assertUniqueCanonicalIds(
      definition.dependsOn,
      `runtime_capability_dependency_invalid:${definition.id}`
    );
    const declaredPublic = new Set<RuntimeCapability>();
    for (const capability of definition.publicCapabilities) {
      runtimeCapabilitySchema.parse(capability);
      if (declaredPublic.has(capability)) {
        throw new Error(`runtime_capability_public_declaration_duplicate:${capability}`);
      }
      declaredPublic.add(capability);
      const owner = publicOwners.get(capability);
      if (owner !== undefined) {
        throw new Error(`runtime_capability_public_owner_duplicate:${capability}:${owner}`);
      }
      publicOwners.set(capability, definition.id);
    }
    const provided = new Set<string>();
    for (const provision of definition.provides) {
      if (
        !canonicalId(provision.serviceId)
        || provided.has(provision.serviceId)
        || serviceOwners.has(provision.serviceId)
      ) {
        throw new Error(`runtime_capability_service_invalid:${provision.serviceId}`);
      }
      provided.add(provision.serviceId);
      serviceOwners.set(provision.serviceId, {
        providerId: definition.id,
        optional: provision.optional
      });
    }
    const consumed = new Set<string>();
    for (const dependency of definition.consumes) {
      if (!canonicalId(dependency.serviceId) || consumed.has(dependency.serviceId)) {
        throw new Error(`runtime_capability_service_dependency_invalid:${dependency.serviceId}`);
      }
      consumed.add(dependency.serviceId);
    }
  }
  for (const provider of providers) validateDependencies(provider, ids, serviceOwners);
}

function validateDependencies(
  provider: RuntimeCapabilityProvider,
  providerIds: ReadonlySet<string>,
  serviceOwners: ReadonlyMap<string, ServiceOwner>
): void {
  for (const dependency of provider.definition.dependsOn) {
    if (!providerIds.has(dependency)) {
      throw new Error(`runtime_capability_dependency_missing:${dependency}`);
    }
  }
  for (const dependency of provider.definition.consumes) {
    const owner = serviceOwners.get(dependency.serviceId);
    if (owner === undefined) {
      throw new Error(`runtime_capability_service_dependency_missing:${dependency.serviceId}`);
    }
    if (owner.providerId === provider.definition.id) {
      throw new Error(`runtime_capability_service_dependency_self:${dependency.serviceId}`);
    }
    if (!dependency.optional && owner.optional) {
      throw new Error(`runtime_capability_required_service_declared_optional:${dependency.serviceId}`);
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

function topologicallyOrder(
  providers: readonly RuntimeCapabilityProvider[]
): readonly RuntimeCapabilityProvider[] {
  const remaining = new Map(providers.map((provider) => [provider.definition.id, provider]));
  const serviceOwners = new Map<string, string>();
  for (const provider of providers) {
    for (const provision of provider.definition.provides) {
      serviceOwners.set(provision.serviceId, provider.definition.id);
    }
  }
  const resolved = new Set<string>();
  const ordered: RuntimeCapabilityProvider[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((provider) => dependencies(provider, serviceOwners)
        .every((id) => resolved.has(id)))
      .sort((left, right) => compareCodeUnits(left.definition.id, right.definition.id));
    if (ready.length === 0) throw new Error('runtime_capability_dependency_cycle');
    for (const provider of ready) {
      remaining.delete(provider.definition.id);
      resolved.add(provider.definition.id);
      ordered.push(provider);
    }
  }
  return ordered;
}

function dependencies(
  provider: RuntimeCapabilityProvider,
  serviceOwners: ReadonlyMap<string, string>
): readonly string[] {
  return [
    ...provider.definition.dependsOn,
    ...provider.definition.consumes.map((dependency) => {
      const owner = serviceOwners.get(dependency.serviceId);
      if (owner === undefined) {
        throw new Error(`runtime_capability_service_dependency_missing:${dependency.serviceId}`);
      }
      return owner;
    })
  ];
}

function assertUniqueCanonicalIds(values: readonly string[], errorCode: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!canonicalId(value) || seen.has(value)) throw new Error(`${errorCode}:${value}`);
    seen.add(value);
  }
}

function canonicalId(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
