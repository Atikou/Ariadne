import type { ApplicationProfileView, AriadneApi } from '@shared/contract';
import type { AppEventMap } from '../events/app-events';
import type { TypedEventBus } from '../events/typed-event-bus';
import type { RuntimeStore } from '../runtime/runtime-store';
import type { ConversationNavigationService } from '../conversations/conversation-navigation-service';
import type { SpeechCoordinator } from '../speech/speech-coordinator';
import type { ProductivityFeatureStore } from '../runtime/features/productivity-feature-store';
import type { HumanSkillFeatureStore } from '../runtime/features/human-skill-feature-store';
import type { ToolResultFeatureStore } from '../runtime/features/tool-result-feature-store';
import type { SessionFeatureStore } from '../runtime/features/session-feature-store';
import type { DecisionFeatureStore } from '../runtime/features/decision-feature-store';
import type { MessageFeatureStore } from '../runtime/features/message-feature-store';
import type { RunFeatureStore } from '../runtime/features/run-feature-store';
import type { ModelFeatureStore } from '../runtime/features/model-feature-store';
import type { DiagnosticsFeatureStore } from '../runtime/features/diagnostics-feature-store';

export interface ModuleServices {
  applicationProfile: ApplicationProfileView;
  agentSettings: AriadneApi['agentSettings'];
  clipboard: AriadneApi['clipboard'];
  conversationNavigation: ConversationNavigationService;
  decisions: DecisionFeatureStore;
  diagnostics: DiagnosticsFeatureStore;
  events: TypedEventBus<AppEventMap>;
  humanSkills: HumanSkillFeatureStore;
  messages: MessageFeatureStore;
  models: ModelFeatureStore;
  productivity: ProductivityFeatureStore;
  runtime: RuntimeStore;
  runs: RunFeatureStore;
  sessions: SessionFeatureStore;
  speech: SpeechCoordinator;
  preferences: AriadneApi['preferences'];
  system: AriadneApi['system'];
  terminal: AriadneApi['terminal'];
  toolResults: ToolResultFeatureStore;
  workspace: AriadneApi['workspace'];
}
