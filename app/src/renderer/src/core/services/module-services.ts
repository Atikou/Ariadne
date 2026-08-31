import type { AriadneApi } from '@shared/contract';
import type { AppEventMap } from '../events/app-events';
import { TypedEventBus } from '../events/typed-event-bus';
import { RuntimeStore } from '../runtime/runtime-store';
import type { ModuleServices } from '../modules/module-contract';
import { ConfiguredConversationNavigationService } from '../conversations/conversation-navigation-service';
import { compileRendererSpeechEntity } from '../speech/renderer-speech-entity';

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
    decisions: runtime.decisions,
    diagnostics: runtime.diagnostics,
    events,
    humanSkills: runtime.humanSkills,
    messages: runtime.messages,
    models: runtime.models,
    productivity: runtime.productivity,
    runtime,
    runs: runtime.runs,
    sessions: runtime.sessions,
    speech: compileRendererSpeechEntity({
      speechApi: api.speech,
      preferencesApi: api.preferences,
      messages: runtime.messages,
      runs: runtime.runs,
      sessions: runtime.sessions,
      events,
      storage
    }),
    preferences: api.preferences,
    system: api.system,
    terminal: api.terminal,
    toolResults: runtime.toolResults,
    workspace: api.workspace
  };
}
