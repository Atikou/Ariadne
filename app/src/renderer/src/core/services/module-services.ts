import type { AriadneApi } from '@shared/contract';
import type { AppEventMap } from '../events/app-events';
import { TypedEventBus } from '../events/typed-event-bus';
import { RuntimeStore } from '../runtime/runtime-store';
import type { ModuleServices } from '../modules/module-contract';
import { ConfiguredConversationNavigationService } from '../conversations/conversation-navigation-service';
import { SpeechCoordinator } from '../speech/speech-coordinator';

export function createModuleServices(
  api: AriadneApi,
  storage: Storage = window.localStorage
): ModuleServices {
  const events = new TypedEventBus<AppEventMap>();
  const runtime = new RuntimeStore(api.runtime, api.agentInputDeliveryOutbox);
  return {
    agentSettings: api.agentSettings,
    clipboard: api.clipboard,
    conversationNavigation: new ConfiguredConversationNavigationService(api.agentSettings, api.workspace, storage),
    events,
    humanSkills: runtime.humanSkills,
    productivity: runtime.productivity,
    runtime,
    speech: new SpeechCoordinator(api.speech, api.preferences, runtime, events, storage),
    preferences: api.preferences,
    system: api.system,
    terminal: api.terminal,
    toolResults: runtime.toolResults,
    workspace: api.workspace
  };
}
