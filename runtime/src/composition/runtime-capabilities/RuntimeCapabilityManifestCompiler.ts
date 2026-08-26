import {
  FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST,
  FIRST_PARTY_AGENT_TOOL_CATALOG_ID,
  FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION,
  FIRST_PARTY_AGENT_TOOL_NAMES
} from '@ariadne/protocol/host';
import { runtimeCapabilitySchema, type RuntimeCapability } from '@ariadne/protocol/public';
import {
  compileTrustedAgentToolCatalog,
  type TrustedAgentToolRegistrationV1
} from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type {
  RuntimeCapabilityDefinitionSnapshot,
  RuntimeCapabilityManifest
} from '../../ingress/RuntimeCapabilityManifest.js';
import { createShutdownContext, type ShutdownContext } from '../../ingress/ShutdownContext.js';
import type {
  RuntimeCapabilityHandle,
  RuntimeCapabilityProvider,
  RuntimeCapabilityStartContext
} from './RuntimeCapabilityProvider.js';

interface StartedProvider {
  readonly definition: RuntimeCapabilityDefinitionSnapshot;
  readonly handle: RuntimeCapabilityHandle;
}

export async function compileRuntimeCapabilityManifest(
  context: RuntimeCapabilityStartContext,
  providers: readonly RuntimeCapabilityProvider[]
): Promise<RuntimeCapabilityManifest> {
  const providerSnapshots = snapshotProviders(providers);
  validateDefinitions(providerSnapshots);
  const ordered = topologicallyOrder(providerSnapshots);
  const started: StartedProvider[] = [];
  try {
    for (const provider of ordered) {
      const handle = await provider.start(context);
      validateHandle(provider.definition.id, handle);
      started.push({ definition: provider.definition, handle });
    }
    return createManifest(started);
  } catch (error) {
    const cleanupContext = createShutdownContext(Date.now() + 5_000);
    let cleanup: readonly unknown[];
    try {
      cleanup = await invokeReverse(started, cleanupContext, 'close');
    } finally {
      cleanupContext.dispose();
    }
    throw cleanup.length === 0
      ? error
      : new AggregateError([error, ...cleanup], 'runtime_capability_bootstrap_failed');
  }
}

function createManifest(started: readonly StartedProvider[]): RuntimeCapabilityManifest {
  const publicCapabilities: RuntimeCapability[] = [];
  const tools: TrustedAgentToolRegistrationV1[] = [];
  const publicOwners = new Map<RuntimeCapability, string>();
  for (const item of started) {
    for (const capability of item.handle.publicCapabilities) {
      runtimeCapabilitySchema.parse(capability);
      if (!item.definition.publicCapabilities.includes(capability)) {
        throw new Error(`runtime_capability_public_not_declared:${item.definition.id}:${capability}`);
      }
      const owner = publicOwners.get(capability);
      if (owner !== undefined) {
        throw new Error(`runtime_capability_public_duplicate:${capability}:${owner}`);
      }
      publicOwners.set(capability, item.definition.id);
      publicCapabilities.push(capability);
    }
    tools.push(...(item.handle.tools ?? []));
  }
  const catalog = compileTrustedAgentToolCatalog({
    catalogId: FIRST_PARTY_AGENT_TOOL_CATALOG_ID,
    revision: FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION,
    tools
  });
  const toolNames = catalog.entries.map((entry) => entry.document.toolName);
  if (
    catalog.catalogDigest !== FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST
    || !sameValues(toolNames, FIRST_PARTY_AGENT_TOOL_NAMES)
  ) throw new Error('runtime_capability_tool_catalog_contract_drift');

  const diagnostics = Object.freeze(started.map((item) => Object.freeze({
    definition: item.definition,
    status: 'started' as const,
    publicCapabilities: Object.freeze([...item.handle.publicCapabilities]),
    toolNames: Object.freeze((item.handle.tools ?? [])
      .map((registration) => registration.document.toolName)
      .sort(compareCodeUnits))
  })));
  let prepared = false;
  let closed = false;
  return Object.freeze<RuntimeCapabilityManifest>({
    publicCapabilities: Object.freeze([...publicCapabilities].sort(compareCodeUnits)),
    unwiredPublicCapabilities: Object.freeze(runtimeCapabilitySchema.options.filter(
      (capability) => !started.some(
        (item) => item.definition.publicCapabilities.includes(capability)
      )
    ).sort(compareCodeUnits)),
    agentToolCatalogSnapshots: Object.freeze([catalog]),
    diagnosticSnapshot: () => diagnostics,
    prepareShutdown: async (context) => {
      if (prepared || closed) {
        context.throwIfExpired();
        return;
      }
      const failures = await invokeReverse(started, context, 'prepareShutdown');
      if (failures.length > 0) {
        throw new AggregateError(failures, 'runtime_capability_prepare_shutdown_failed');
      }
      prepared = true;
    },
    close: async (context) => {
      if (closed) {
        context.throwIfExpired();
        return;
      }
      const failures = await invokeReverse(started, context, 'close');
      if (failures.length > 0) {
        throw new AggregateError(failures, 'runtime_capability_shutdown_failed');
      }
      closed = true;
    }
  });
}

function validateDefinitions(providers: readonly RuntimeCapabilityProvider[]): void {
  const ids = new Set<string>();
  const services = new Set<string>();
  const publicOwners = new Map<RuntimeCapability, string>();
  for (const provider of providers) {
    const definition = provider.definition;
    if (!canonicalId(definition.id) || !/^\d+\.\d+$/u.test(definition.contractVersion)) {
      throw new Error('runtime_capability_definition_invalid');
    }
    if (ids.has(definition.id)) throw new Error(`runtime_capability_duplicate:${definition.id}`);
    ids.add(definition.id);
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
    for (const service of definition.provides) {
      if (!canonicalId(service) || services.has(service)) {
        throw new Error(`runtime_capability_service_invalid:${service}`);
      }
      services.add(service);
    }
  }
  for (const provider of providers) {
    for (const required of provider.definition.requires) {
      if (!ids.has(required)) throw new Error(`runtime_capability_requirement_missing:${required}`);
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
      requires: Object.freeze([...provider.definition.requires]),
      provides: Object.freeze([...provider.definition.provides]),
      publicCapabilities: Object.freeze([...provider.definition.publicCapabilities])
    }),
    start: provider.start
  })));
}

function topologicallyOrder(
  providers: readonly RuntimeCapabilityProvider[]
): readonly RuntimeCapabilityProvider[] {
  const remaining = new Map(providers.map((provider) => [provider.definition.id, provider]));
  const resolved = new Set<string>();
  const ordered: RuntimeCapabilityProvider[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((provider) => provider.definition.requires.every((id) => resolved.has(id)))
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

function validateHandle(id: string, handle: RuntimeCapabilityHandle): void {
  if (handle === null || typeof handle !== 'object' || !Array.isArray(handle.publicCapabilities)) {
    throw new Error(`runtime_capability_handle_invalid:${id}`);
  }
}

async function invokeReverse(
  started: readonly StartedProvider[],
  context: ShutdownContext,
  method: 'prepareShutdown' | 'close'
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const item of [...started].reverse()) {
    try {
      context.throwIfExpired();
      await item.handle[method]?.(context);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function canonicalId(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value);
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
