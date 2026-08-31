import { compileComponentDefinitionGraph } from './graph.js';
import type { ComponentDefinition, EntityKind } from './types.js';

export interface ComponentCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly required: boolean;
  readonly dependsOn: readonly string[];
  readonly consumes: readonly { readonly serviceId: string; readonly optional: boolean }[];
  readonly provides: readonly { readonly serviceId: string; readonly optional: boolean }[];
  readonly configSchemaVersion: number;
}

export interface ComponentCatalog {
  readonly schemaVersion: 1;
  readonly entity: EntityKind;
  readonly entries: readonly ComponentCatalogEntry[];
  readonly digest: string;
}

/** Build a canonical, immutable catalog whose digest is stable across input order. */
export async function compileComponentCatalog(
  entity: EntityKind,
  definitions: readonly ComponentDefinition[]
): Promise<ComponentCatalog> {
  const ordered = compileComponentDefinitionGraph(entity, definitions);
  const entries = Object.freeze(ordered.map((definition) => Object.freeze({
    id: definition.id,
    version: definition.version,
    required: definition.required,
    dependsOn: Object.freeze([...definition.dependsOn].sort(compareCodeUnits)),
    consumes: Object.freeze(definition.consumes
      .map((item) => Object.freeze({ serviceId: item.service.id, optional: item.optional }))
      .sort((left, right) => compareCodeUnits(left.serviceId, right.serviceId))),
    provides: Object.freeze(definition.provides
      .map((item) => Object.freeze({ serviceId: item.service.id, optional: item.optional }))
      .sort((left, right) => compareCodeUnits(left.serviceId, right.serviceId))),
    configSchemaVersion: definition.configSchemaVersion
  })));
  const canonical = JSON.stringify({ schemaVersion: 1, entity, entries });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Object.freeze({
    schemaVersion: 1,
    entity,
    entries,
    digest: [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
