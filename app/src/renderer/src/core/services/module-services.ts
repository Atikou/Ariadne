import type { AriadneApi } from '@shared/contract';
import type { AppEventMap } from '../events/app-events';
import { TypedEventBus } from '../events/typed-event-bus';
import { RuntimeStore } from '../runtime/runtime-store';
import type { ModuleServices } from '../modules/module-contract';
import { ConfiguredConversationNavigationService } from '../conversations/conversation-navigation-service';
import { compileRendererSpeechEntity } from '../speech/renderer-speech-entity';
import type { ApplicationProfileView } from '@shared/contract';
import { applicationProfileComponents } from '@shared/application-profile';

export function createModuleServices(
  api: AriadneApi,
  storage: Storage = window.localStorage,
  applicationProfile: ApplicationProfileView
): ModuleServices {
  const events = new TypedEventBus<AppEventMap>();
  const runtime = new RuntimeStore(api.runtime, api.agentInputDeliveryOutbox);
  return {
    applicationProfile,
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
    }, applicationProfileComponents(applicationProfile, 'speech')),
    preferences: api.preferences,
    system: api.system,
    terminal: api.terminal,
    toolResults: runtime.toolResults,
    workspace: api.workspace
  };
}
