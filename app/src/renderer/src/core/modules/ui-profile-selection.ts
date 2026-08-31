import type { FeatureModuleDefinition } from './module-contract';

export function selectUiComponentDefinitions(
  definitions: readonly FeatureModuleDefinition[],
  componentIds: readonly string[]
): readonly FeatureModuleDefinition[] {
  if (componentIds.length === 1 && componentIds[0] === '*') return definitions;
  return componentIds.map((id) => {
    const definition = definitions.find((item) => item.id === id);
    if (!definition) throw new Error(`ui_profile_component_unknown:${id}`);
    return definition;
  });
}
