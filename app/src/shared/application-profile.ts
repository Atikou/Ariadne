import type {
  ApplicationEntityKind,
  ApplicationEntityProfileView,
  ApplicationProfileView
} from './contract';

export interface ApplicationProfileDefinition {
  readonly id: string;
  readonly revision: number;
  readonly entities: readonly {
    readonly entity: ApplicationEntityKind;
    readonly componentIds: readonly string[];
  }[];
}

export async function compileApplicationProfile(
  definition: ApplicationProfileDefinition
): Promise<ApplicationProfileView> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(definition.id)) {
    throw new Error(`application_profile_id_invalid:${definition.id}`);
  }
  if (!Number.isSafeInteger(definition.revision) || definition.revision < 1) {
    throw new Error('application_profile_revision_invalid');
  }
  const byEntity = new Map<ApplicationEntityKind, ApplicationEntityProfileView>();
  for (const entry of definition.entities) {
    if (byEntity.has(entry.entity)) throw new Error(`application_profile_entity_duplicate:${entry.entity}`);
    if (entry.componentIds.length === 0 || new Set(entry.componentIds).size !== entry.componentIds.length) {
      throw new Error(`application_profile_components_invalid:${entry.entity}`);
    }
    if (entry.componentIds.includes('*') && entry.componentIds.length !== 1) {
      throw new Error(`application_profile_wildcard_invalid:${entry.entity}`);
    }
    for (const id of entry.componentIds) {
      if (id !== '*' && !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(id)) {
        throw new Error(`application_profile_component_id_invalid:${id}`);
      }
    }
    const componentIds = Object.freeze([...entry.componentIds].sort(compare));
    byEntity.set(entry.entity, Object.freeze({
      entity: entry.entity,
      componentIds,
      digest: await sha256(JSON.stringify({
        schemaVersion: 1,
        profileRevision: definition.revision,
        entity: entry.entity,
        componentIds
      }))
    }));
  }
  for (const entity of ['agent', 'ui', 'speech'] as const) {
    if (!byEntity.has(entity)) throw new Error(`application_profile_entity_missing:${entity}`);
  }
  const speechIds = new Set(byEntity.get('speech')!.componentIds);
  if (!speechIds.has('speech.core')) throw new Error('application_profile_speech_core_missing');
  if (speechIds.has('speech.bridge.agent') && !speechIds.has('speech.bridge.renderer')) {
    throw new Error('application_profile_cross_entity_missing:speech.bridge.renderer');
  }
  const entities = Object.freeze([...byEntity.values()].sort((left, right) => compare(left.entity, right.entity)));
  const canonical = JSON.stringify({
    schemaVersion: 1,
    id: definition.id,
    revision: definition.revision,
    entities
  });
  const digest = await sha256(canonical);
  return Object.freeze({
    schemaVersion: 1,
    id: definition.id,
    revision: definition.revision,
    entities,
    digest
  });
}

export function applicationProfileComponents(
  profile: { readonly entities: readonly {
    readonly entity: ApplicationEntityKind;
    readonly componentIds: readonly string[];
  }[] },
  entity: ApplicationEntityKind
): readonly string[] {
  const selection = profile.entities.find((entry) => entry.entity === entity);
  if (!selection) throw new Error(`application_profile_entity_missing:${entity}`);
  return selection.componentIds;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(bytes)]
    .map((item) => item.toString(16).padStart(2, '0')).join('')}`;
}
