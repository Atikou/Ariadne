import {
  createDeclaredServiceScope,
  publishComponentServices,
  serviceToken
} from '@ariadne/component-contracts';
import { runtimeCapabilitySchema } from '@ariadne/protocol/public';

import type { RuntimeCapabilityDefinitionSnapshot } from '../../ingress/RuntimeCapabilityManifest.js';
import { toAgentComponentDefinition } from './RuntimeCapabilityComponentAdapter.js';
import type {
  RuntimeCapabilityHandle,
  RuntimeCapabilityServiceScope,
  RuntimeCapabilityStartContext
} from './RuntimeCapabilityProvider.js';

const kernelOptions = Object.freeze({ errorNamespace: 'runtime_capability' });

/** Bind one Provider to only its declared, already-started service dependencies. */
export function createRuntimeCapabilityProviderStartContext(
  base: RuntimeCapabilityStartContext,
  definition: RuntimeCapabilityDefinitionSnapshot,
  services: ReadonlyMap<string, unknown>
): RuntimeCapabilityStartContext {
  const componentDefinition = toAgentComponentDefinition(definition);
  const componentScope = createDeclaredServiceScope(
    componentDefinition,
    services,
    kernelOptions
  );
  const scope: RuntimeCapabilityServiceScope = Object.freeze({
    required: <T>(serviceId: string): T => componentScope.required(serviceToken<T>(serviceId)),
    optional: <T>(serviceId: string): T | undefined => (
      componentScope.optional(serviceToken<T>(serviceId))
    )
  });
  return Object.freeze({ ...base, services: scope });
}

/** Validate Provider-specific output, then atomically publish through the shared Kernel. */
export function publishRuntimeCapabilityHandleServices(
  definition: RuntimeCapabilityDefinitionSnapshot,
  handle: RuntimeCapabilityHandle,
  services: Map<string, unknown>
): void {
  const id = definition.id;
  if (handle === null || typeof handle !== 'object' || !Array.isArray(handle.publicCapabilities)) {
    throw new Error(`runtime_capability_handle_invalid:${id}`);
  }
  for (const capability of handle.publicCapabilities) {
    runtimeCapabilitySchema.parse(capability);
    if (!definition.publicCapabilities.includes(capability)) {
      throw new Error(`runtime_capability_public_not_declared:${id}:${capability}`);
    }
  }
  if (
    handle.services !== undefined
    && (
      handle.services === null
      || typeof handle.services !== 'object'
      || Array.isArray(handle.services)
    )
  ) throw new Error(`runtime_capability_services_invalid:${id}`);

  publishComponentServices(
    toAgentComponentDefinition(definition),
    Object.entries(handle.services ?? {}).map(([serviceId, value]) => ({
      service: serviceToken(serviceId),
      value
    })),
    services,
    kernelOptions
  );
}
