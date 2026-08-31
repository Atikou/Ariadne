import { defineComponent, type ComponentDefinition } from '@ariadne/component-contracts';

export function defineCoreAgentComponent(
  id: string,
  dependsOn: readonly string[]
): ComponentDefinition {
  return defineComponent({
    id,
    version: '1.0',
    entity: 'agent',
    required: true,
    dependsOn,
    configSchemaVersion: 1
  });
}
