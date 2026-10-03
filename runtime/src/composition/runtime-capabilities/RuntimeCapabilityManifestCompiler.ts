import {
  compileComponentCatalog,
  invokeComponentLifecycleReverse,
  type ComponentCatalog,
  type ComponentDefinition
} from '@ariadne/component-contracts';
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
import { toAgentComponentDefinition } from './RuntimeCapabilityComponentAdapter.js';
import { compileRuntimeCapabilityDefinitionGraph } from './RuntimeCapabilityDefinitionGraph.js';
import type {
  RuntimeCapabilityHandle,
  RuntimeCapabilityProvider,
  RuntimeCapabilityStartContext
} from './RuntimeCapabilityProvider.js';
import {
  createRuntimeCapabilityProviderStartContext,
  publishRuntimeCapabilityHandleServices
} from './RuntimeCapabilityServiceResolver.js';

interface StartedProvider {
  readonly definition: RuntimeCapabilityDefinitionSnapshot;
  readonly handle: RuntimeCapabilityHandle;
}

export async function compileRuntimeCapabilityManifest(
  context: RuntimeCapabilityStartContext,
  providers: readonly RuntimeCapabilityProvider[],
  additionalDefinitions: readonly ComponentDefinition[] = []
): Promise<RuntimeCapabilityManifest> {
  const ordered = compileRuntimeCapabilityDefinitionGraph(providers);
  const componentCatalog = await compileComponentCatalog(
    'agent',
    [
      ...ordered.map((provider) => toAgentComponentDefinition(provider.definition)),
      ...additionalDefinitions
    ]
  );
  const started: StartedProvider[] = [];
  const services = new Map<string, unknown>();
  try {
    for (const provider of ordered) {
      const handle = await provider.start(createRuntimeCapabilityProviderStartContext(
        context,
        provider.definition,
        services
      ));
      // A returned handle transfers resource ownership before output validation.
      // Invalid outputs must not leave an already-started Provider outside rollback.
      if (handle !== null && typeof handle === 'object') {
        started.push({ definition: provider.definition, handle });
      }
      publishRuntimeCapabilityHandleServices(provider.definition, handle, services);
    }
    return createManifest(started, services, componentCatalog);
  } catch (error) {
    const cleanupContext = createShutdownContext(Date.now() + 5_000);
    let cleanup: readonly unknown[];
    try {
      cleanup = await invokeComponentLifecycleReverse(
        started,
        cleanupContext,
        'close',
        (shutdown) => shutdown.throwIfExpired()
      );
    } finally {
      cleanupContext.dispose();
    }
    throw cleanup.length === 0
      ? error
      : new AggregateError([error, ...cleanup], 'runtime_capability_bootstrap_failed');
  }
}

function createManifest(
  started: readonly StartedProvider[],
  services: ReadonlyMap<string, unknown>,
  componentCatalog: ComponentCatalog
): RuntimeCapabilityManifest {
  const publicCapabilities: RuntimeCapability[] = [];
  const tools: TrustedAgentToolRegistrationV1[] = [];
  const publicOwners = new Map<RuntimeCapability, string>();
  for (const item of started) {
    for (const capability of item.handle.publicCapabilities) {
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
  ) throw new Error(
    `runtime_capability_tool_catalog_contract_drift:${catalog.catalogDigest}:${toolNames.join(',')}`
  );

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
    agentComponentCatalog: componentCatalog,
    publicCapabilities: Object.freeze([...publicCapabilities].sort(compareCodeUnits)),
    unwiredPublicCapabilities: Object.freeze(runtimeCapabilitySchema.options.filter(
      (capability) => !started.some(
        (item) => item.definition.publicCapabilities.includes(capability)
      )
    ).sort(compareCodeUnits)),
    agentToolCatalogSnapshots: Object.freeze([catalog]),
    service: <T>(serviceId: string): T | undefined => services.get(serviceId) as T | undefined,
    diagnosticSnapshot: () => diagnostics,
    prepareShutdown: async (shutdown) => {
      if (prepared || closed) {
        shutdown.throwIfExpired();
        return;
      }
      const failures = await invokeComponentLifecycleReverse(
        started,
        shutdown,
        'prepareShutdown',
        (context) => context.throwIfExpired()
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'runtime_capability_prepare_shutdown_failed');
      }
      prepared = true;
    },
    close: async (shutdown) => {
      if (closed) {
        shutdown.throwIfExpired();
        return;
      }
      const failures = await invokeComponentLifecycleReverse(
        started,
        shutdown,
        'close',
        (context) => context.throwIfExpired()
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'runtime_capability_shutdown_failed');
      }
      closed = true;
    }
  });
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
