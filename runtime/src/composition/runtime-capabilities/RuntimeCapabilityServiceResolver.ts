import { runtimeCapabilitySchema } from '@ariadne/protocol/public';

import type { RuntimeCapabilityDefinitionSnapshot } from '../../ingress/RuntimeCapabilityManifest.js';
import type {
  RuntimeCapabilityHandle,
  RuntimeCapabilityServiceScope,
  RuntimeCapabilityStartContext
} from './RuntimeCapabilityProvider.js';

/** Bind one Provider to only its declared, already-started service dependencies. */
export function createRuntimeCapabilityProviderStartContext(
  base: RuntimeCapabilityStartContext,
  definition: RuntimeCapabilityDefinitionSnapshot,
  services: ReadonlyMap<string, unknown>
): RuntimeCapabilityStartContext {
  for (const dependency of definition.consumes) {
    if (!dependency.optional && !services.has(dependency.serviceId)) {
      throw new Error(
        `runtime_capability_required_service_unavailable:${definition.id}:${dependency.serviceId}`
      );
    }
  }
  const declared = new Map(definition.consumes.map((dependency) => [
    dependency.serviceId,
    dependency
  ]));
  const scope: RuntimeCapabilityServiceScope = Object.freeze({
    required: <T>(serviceId: string): T => {
      const dependency = declared.get(serviceId);
      if (dependency === undefined || dependency.optional) {
        throw accessError(definition.id, serviceId);
      }
      const service = services.get(serviceId);
      if (service === undefined) {
        throw new Error(
          `runtime_capability_required_service_unavailable:${definition.id}:${serviceId}`
        );
      }
      return service as T;
    },
    optional: <T>(serviceId: string): T | undefined => {
      const dependency = declared.get(serviceId);
      if (dependency === undefined || !dependency.optional) {
        throw accessError(definition.id, serviceId);
      }
      return services.get(serviceId) as T | undefined;
    }
  });
  return Object.freeze({ ...base, services: scope });
}

/** Validate and atomically publish one Provider's actual service outputs. */
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
  const declared = new Set(definition.provides.map((provision) => provision.serviceId));
  const pending: Array<readonly [string, unknown]> = [];
  for (const [serviceId, service] of Object.entries(handle.services ?? {})) {
    if (!declared.has(serviceId)) {
      throw new Error(`runtime_capability_service_not_declared:${id}:${serviceId}`);
    }
    if (service === undefined) {
      throw new Error(`runtime_capability_service_undefined:${id}:${serviceId}`);
    }
    if (services.has(serviceId)) {
      throw new Error(`runtime_capability_service_duplicate:${serviceId}`);
    }
    pending.push([serviceId, service]);
  }
  const outputIds = new Set(pending.map(([serviceId]) => serviceId));
  for (const provision of definition.provides) {
    if (!provision.optional && !outputIds.has(provision.serviceId)) {
      throw new Error(
        `runtime_capability_required_service_not_provided:${id}:${provision.serviceId}`
      );
    }
  }
  for (const [serviceId, service] of pending) services.set(serviceId, service);
}

function accessError(providerId: string, serviceId: string): Error {
  return new Error(`runtime_capability_service_access_not_declared:${providerId}:${serviceId}`);
}
