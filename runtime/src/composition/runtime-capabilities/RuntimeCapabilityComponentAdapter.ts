import {
  defineComponent,
  serviceToken,
  type ComponentDefinition
} from '@ariadne/component-contracts';

import type { RuntimeCapabilityDefinitionSnapshot } from '../../ingress/RuntimeCapabilityManifest.js';

/** Adapt the legacy public snapshot shape to the shared Agent component contract. */
export function toAgentComponentDefinition(
  definition: RuntimeCapabilityDefinitionSnapshot
): ComponentDefinition {
  return defineComponent({
    id: definition.id,
    version: definition.contractVersion,
    entity: 'agent',
    required: true,
    dependsOn: definition.dependsOn,
    consumes: definition.consumes.map((dependency) => ({
      service: serviceToken(dependency.serviceId),
      optional: dependency.optional
    })),
    provides: definition.provides.map((provision) => ({
      service: serviceToken(provision.serviceId),
      optional: provision.optional
    })),
    configSchemaVersion: 1
  });
}
