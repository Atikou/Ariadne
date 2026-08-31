import type { CapabilityStatus } from '@shared/contract';
import { uiComponentDefinitions } from './UiComponentCatalog.generated';
import { ModuleRegistry } from './module-registry';

export function createUiModuleRegistry(
  capabilityStatuses: readonly CapabilityStatus[]
): ModuleRegistry {
  return new ModuleRegistry(uiComponentDefinitions(), capabilityStatuses);
}
