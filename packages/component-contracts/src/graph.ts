import { defineComponent } from './definition.js';
import { isCanonicalComponentId } from './service-token.js';
import type {
  ComponentDefinition,
  ComponentKernelOptions,
  EntityKind
} from './types.js';

interface ServiceOwner {
  readonly componentId: string;
  readonly optional: boolean;
}

/** Freeze, validate, and deterministically order one entity's component graph. */
export function compileComponentDefinitionGraph(
  entity: EntityKind,
  definitions: readonly ComponentDefinition[],
  options: ComponentKernelOptions = {}
): readonly ComponentDefinition[] {
  const namespace = options.errorNamespace ?? 'component';
  const snapshots = Object.freeze(definitions.map((definition) => defineComponent(definition)));
  const ids = new Set<string>();
  const serviceOwners = new Map<string, ServiceOwner>();

  for (const definition of snapshots) {
    if (
      definition.entity !== entity
      || !isCanonicalComponentId(definition.id)
      || !/^\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.-]+)?$/u.test(definition.version)
      || !Number.isSafeInteger(definition.configSchemaVersion)
      || definition.configSchemaVersion < 1
    ) throw new Error(`${namespace}_definition_invalid`);
    if (ids.has(definition.id)) throw new Error(`${namespace}_duplicate:${definition.id}`);
    ids.add(definition.id);
    assertUniqueCanonicalIds(
      definition.dependsOn,
      `${namespace}_dependency_invalid:${definition.id}`
    );
    const provided = new Set<string>();
    for (const provision of definition.provides) {
      const serviceId = provision.service.id;
      if (
        !isCanonicalComponentId(serviceId)
        || provided.has(serviceId)
        || serviceOwners.has(serviceId)
      ) throw new Error(`${namespace}_service_invalid:${serviceId}`);
      provided.add(serviceId);
      serviceOwners.set(serviceId, {
        componentId: definition.id,
        optional: provision.optional
      });
    }
    const consumed = new Set<string>();
    for (const dependency of definition.consumes) {
      const serviceId = dependency.service.id;
      if (!isCanonicalComponentId(serviceId) || consumed.has(serviceId)) {
        throw new Error(`${namespace}_service_dependency_invalid:${serviceId}`);
      }
      consumed.add(serviceId);
    }
  }

  for (const definition of snapshots) {
    for (const dependency of definition.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`${namespace}_dependency_missing:${dependency}`);
    }
    for (const dependency of definition.consumes) {
      const serviceId = dependency.service.id;
      const owner = serviceOwners.get(serviceId);
      if (owner === undefined) {
        throw new Error(`${namespace}_service_dependency_missing:${serviceId}`);
      }
      if (owner.componentId === definition.id) {
        throw new Error(`${namespace}_service_dependency_self:${serviceId}`);
      }
      if (!dependency.optional && owner.optional) {
        throw new Error(`${namespace}_required_service_declared_optional:${serviceId}`);
      }
    }
  }

  return topologicallyOrder(snapshots, serviceOwners, namespace);
}

function topologicallyOrder(
  definitions: readonly ComponentDefinition[],
  serviceOwners: ReadonlyMap<string, ServiceOwner>,
  namespace: string
): readonly ComponentDefinition[] {
  const remaining = new Map(definitions.map((definition) => [definition.id, definition]));
  const resolved = new Set<string>();
  const ordered: ComponentDefinition[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((definition) => dependencies(definition, serviceOwners)
        .every((dependency) => resolved.has(dependency)))
      .sort((left, right) => compareCodeUnits(left.id, right.id));
    if (ready.length === 0) throw new Error(`${namespace}_dependency_cycle`);
    for (const definition of ready) {
      remaining.delete(definition.id);
      resolved.add(definition.id);
      ordered.push(definition);
    }
  }
  return Object.freeze(ordered);
}

function dependencies(
  definition: ComponentDefinition,
  serviceOwners: ReadonlyMap<string, ServiceOwner>
): readonly string[] {
  return [
    ...definition.dependsOn,
    ...definition.consumes.map((dependency) => {
      const owner = serviceOwners.get(dependency.service.id);
      if (owner === undefined) throw new Error('component_graph_invariant_broken');
      return owner.componentId;
    })
  ];
}

function assertUniqueCanonicalIds(values: readonly string[], errorCode: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!isCanonicalComponentId(value) || seen.has(value)) {
      throw new Error(`${errorCode}:${value}`);
    }
    seen.add(value);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
