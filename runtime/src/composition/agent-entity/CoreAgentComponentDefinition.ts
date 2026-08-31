import { defineComponent, type ComponentDefinition } from '@ariadne/component-contracts';

export function defineCoreAgentComponent(
  id: string,
  dependsOn: readonly string[]
): ComponentDefinition {
  return defineAgentComponent(id, dependsOn, true);
}

export function defineFeatureAgentComponent(
  id: string,
  dependsOn: readonly string[]
): ComponentDefinition {
  return defineAgentComponent(id, dependsOn, false);
}

function defineAgentComponent(
  id: string,
  dependsOn: readonly string[],
  required: boolean
): ComponentDefinition {
  return defineComponent({
    id,
    version: '1.0',
    entity: 'agent',
    required,
    dependsOn,
    configSchemaVersion: 1
  });
}
