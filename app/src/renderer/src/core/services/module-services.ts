import type { AriadneApi } from '@shared/contract';
import type { AppEventMap } from '../events/app-events';
import { TypedEventBus } from '../events/typed-event-bus';
import { MockScenarioStore } from '../mock/mock-scenario';
import type { ModuleServices } from '../modules/module-contract';

export function createModuleServices(api: AriadneApi): ModuleServices {
  return {
    clipboard: api.clipboard,
    events: new TypedEventBus<AppEventMap>(),
    mock: new MockScenarioStore(),
    preferences: api.preferences,
    system: api.system,
    terminal: api.terminal,
    workspace: api.workspace
  };
}
