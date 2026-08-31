import type { ServiceToken } from './service-token.js';
import type {
  ComponentDefinition,
  ComponentKernelOptions,
  ComponentServiceBinding,
  ComponentServiceScope
} from './types.js';

/** Restrict one component to the services declared in its immutable definition. */
export function createDeclaredServiceScope(
  definition: ComponentDefinition,
  services: ReadonlyMap<string, unknown>,
  options: ComponentKernelOptions = {}
): ComponentServiceScope {
  const namespace = options.errorNamespace ?? 'component';
  for (const dependency of definition.consumes) {
    if (!dependency.optional && !services.has(dependency.service.id)) {
      throw new Error(
        `${namespace}_required_service_unavailable:${definition.id}:${dependency.service.id}`
      );
    }
  }
  const declared = new Map(definition.consumes.map((dependency) => [
    dependency.service.id,
    dependency
  ]));
  return Object.freeze({
    required: <T>(service: ServiceToken<T>): T => {
      const dependency = declared.get(service.id);
      if (dependency === undefined || dependency.optional) {
        throw accessError(namespace, definition.id, service.id);
      }
      if (!services.has(service.id)) {
        throw new Error(
          `${namespace}_required_service_unavailable:${definition.id}:${service.id}`
        );
      }
      return services.get(service.id) as T;
    },
    optional: <T>(service: ServiceToken<T>): T | undefined => {
      const dependency = declared.get(service.id);
      if (dependency === undefined || !dependency.optional) {
        throw accessError(namespace, definition.id, service.id);
      }
      return services.get(service.id) as T | undefined;
    }
  });
}

/** Validate all outputs before publishing any of them. */
export function publishComponentServices(
  definition: ComponentDefinition,
  outputs: readonly ComponentServiceBinding[],
  services: Map<string, unknown>,
  options: ComponentKernelOptions = {}
): void {
  const namespace = options.errorNamespace ?? 'component';
  const declared = new Set(definition.provides.map((provision) => provision.service.id));
  const pending = new Map<string, unknown>();
  for (const output of outputs) {
    const serviceId = output.service.id;
    if (!declared.has(serviceId)) {
      throw new Error(`${namespace}_service_not_declared:${definition.id}:${serviceId}`);
    }
    if (output.value === undefined) {
      throw new Error(`${namespace}_service_undefined:${definition.id}:${serviceId}`);
    }
    if (services.has(serviceId) || pending.has(serviceId)) {
      throw new Error(`${namespace}_service_duplicate:${serviceId}`);
    }
    pending.set(serviceId, output.value);
  }
  for (const provision of definition.provides) {
    if (!provision.optional && !pending.has(provision.service.id)) {
      throw new Error(
        `${namespace}_required_service_not_provided:${definition.id}:${provision.service.id}`
      );
    }
  }
  for (const [serviceId, service] of pending) services.set(serviceId, service);
}

function accessError(namespace: string, componentId: string, serviceId: string): Error {
  return new Error(`${namespace}_service_access_not_declared:${componentId}:${serviceId}`);
}
