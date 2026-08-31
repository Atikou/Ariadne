import type { CapabilityStatus } from '@shared/contract';
import { uiComponentDefinitions } from './UiComponentCatalog.generated';
import { ModuleRegistry } from './module-registry';
import { selectUiComponentDefinitions } from './ui-profile-selection';

export function createUiModuleRegistry(
  capabilityStatuses: readonly CapabilityStatus[],
  componentIds: readonly string[] = ['*']
): ModuleRegistry {
  const definitions = uiComponentDefinitions();
  const selected = selectUiComponentDefinitions(definitions, componentIds);
  return new ModuleRegistry(selected, capabilityStatuses);
}
