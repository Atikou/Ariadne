import { uiComponentDefinitions } from './UiComponentCatalog.generated';
import { ModuleRegistry } from './module-registry';

export const uiModuleRegistry = new ModuleRegistry(uiComponentDefinitions());
