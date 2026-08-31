import { serviceToken, type ServiceToken } from './service-token.js';
import type {
  ComponentDefinition,
  ComponentServiceProvision,
  ComponentServiceRequirement,
  EntityKind
} from './types.js';

export interface ComponentDefinitionInput {
  readonly id: string;
  readonly version: string;
  readonly entity: EntityKind;
  readonly required?: boolean;
  readonly dependsOn?: readonly string[];
  readonly consumes?: readonly ComponentServiceRequirement[];
  readonly provides?: readonly ComponentServiceProvision[];
  readonly configSchemaVersion?: number;
}

export function defineComponent(input: ComponentDefinitionInput): ComponentDefinition {
  return Object.freeze({
    id: input.id,
    version: input.version,
    entity: input.entity,
    required: input.required ?? false,
    dependsOn: Object.freeze([...(input.dependsOn ?? [])]),
    consumes: Object.freeze((input.consumes ?? []).map((item) => Object.freeze({
      service: serviceToken(item.service.id),
      optional: item.optional
    }))),
    provides: Object.freeze((input.provides ?? []).map((item) => Object.freeze({
      service: serviceToken(item.service.id),
      optional: item.optional
    }))),
    configSchemaVersion: input.configSchemaVersion ?? 1
  });
}

export function consumes<T>(
  service: ServiceToken<T>,
  options: { readonly optional?: boolean } = {}
): ComponentServiceRequirement {
  return Object.freeze({
    service: service as ServiceToken<unknown>,
    optional: options.optional ?? false
  });
}

export function provides<T>(
  service: ServiceToken<T>,
  options: { readonly optional?: boolean } = {}
): ComponentServiceProvision {
  return Object.freeze({
    service: service as ServiceToken<unknown>,
    optional: options.optional ?? false
  });
}
