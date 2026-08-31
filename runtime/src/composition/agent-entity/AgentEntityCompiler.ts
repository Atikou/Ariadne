import {
  compileAgentPublicCommandOwnerTable,
  type AgentPublicCommandOwner,
  type AgentPublicCommandOwnerTable
} from './command-owners/AgentPublicCommandOwnerTable.js';

export interface AgentEntityCommandComponent {
  readonly componentId: string;
  readonly commandOwners: readonly AgentPublicCommandOwner[];
}

export interface AgentEntityCommandComponentSnapshot {
  readonly componentId: string;
  readonly ownerIds: readonly string[];
}

export interface AgentEntityCommandManifest {
  readonly ownerTable: AgentPublicCommandOwnerTable;
  readonly components: readonly AgentEntityCommandComponentSnapshot[];
}

/** Compiles component-local command contributions into one immutable Agent Entity manifest. */
export function compileAgentEntityCommandManifest(
  components: readonly AgentEntityCommandComponent[]
): AgentEntityCommandManifest {
  const componentIds = new Set<string>();
  const owners: AgentPublicCommandOwner[] = [];
  const snapshots: AgentEntityCommandComponentSnapshot[] = [];
  for (const component of [...components].sort((left, right) => (
    compare(left.componentId, right.componentId)
  ))) {
    assertComponentId(component.componentId);
    if (componentIds.has(component.componentId)) {
      throw new Error(`agent_entity_component_duplicate:${component.componentId}`);
    }
    if (component.commandOwners.length === 0) {
      throw new Error(`agent_entity_command_component_empty:${component.componentId}`);
    }
    componentIds.add(component.componentId);
    const ownerIds = component.commandOwners.map((owner) => owner.id).sort(compare);
    owners.push(...component.commandOwners);
    snapshots.push(Object.freeze({
      componentId: component.componentId,
      ownerIds: Object.freeze(ownerIds)
    }));
  }
  return Object.freeze({
    ownerTable: compileAgentPublicCommandOwnerTable(owners),
    components: Object.freeze(snapshots)
  });
}

export function agentEntityCommandComponent(
  componentId: string,
  commandOwners: readonly AgentPublicCommandOwner[]
): AgentEntityCommandComponent {
  return Object.freeze({ componentId, commandOwners: Object.freeze([...commandOwners]) });
}

function assertComponentId(componentId: string): void {
  if (!/^agent\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(componentId)) {
    throw new Error(`agent_entity_component_id_invalid:${componentId}`);
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
