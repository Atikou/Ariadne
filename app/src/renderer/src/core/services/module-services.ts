import type { AriadneApi } from '@shared/contract';
import type { AppEventMap } from '../events/app-events';
import { TypedEventBus } from '../events/typed-event-bus';
import { RuntimeStore } from '../runtime/runtime-store';
import type { ModuleServices } from '../modules/module-contract';
import { ConfiguredConversationNavigationService } from '../conversations/conversation-navigation-service';

export function createModuleServices(api: AriadneApi): ModuleServices {
  return {
    agentSettings: api.agentSettings,
    clipboard: api.clipboard,
    conversationNavigation: new ConfiguredConversationNavigationService(api.agentSettings, api.workspace, window.localStorage),
    events: new TypedEventBus<AppEventMap>(),
    runtime: new RuntimeStore(api.runtime),
    preferences: api.preferences,
    system: api.system,
    terminal: api.terminal,
    workspace: api.workspace
  };
}
