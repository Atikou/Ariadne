import type { AriadneApi } from '@shared/contract';
import type { TypedEventBus } from '../events/typed-event-bus';
import type { AppEventMap } from '../events/app-events';
import type { MessageFeatureStore } from '../runtime/features/message-feature-store';
import type { RunFeatureStore } from '../runtime/features/run-feature-store';
import type { SessionFeatureStore } from '../runtime/features/session-feature-store';
import { SpeechAgentBridge, type SpeechAgentBridgePort } from './speech-agent-bridge';
import { SpeechCoordinator } from './speech-coordinator';

export interface RendererSpeechEntityDependencies {
  readonly speechApi: AriadneApi['speech'];
  readonly preferencesApi: AriadneApi['preferences'];
  readonly messages: MessageFeatureStore;
  readonly runs: RunFeatureStore;
  readonly sessions: SessionFeatureStore;
  readonly events: TypedEventBus<AppEventMap>;
  readonly storage: Storage;
}

/** Renderer composition entry for Speech UI and Agent bridge components. */
export function compileRendererSpeechEntity(
  dependencies: RendererSpeechEntityDependencies,
  componentIds: readonly string[]
): SpeechCoordinator {
  const agentBridge: SpeechAgentBridgePort = componentIds.includes('speech.bridge.agent')
    ? new SpeechAgentBridge(
        dependencies.speechApi,
        dependencies.messages,
        dependencies.runs,
        dependencies.sessions,
        dependencies.storage
      )
    : UNAVAILABLE_AGENT_BRIDGE;
  return new SpeechCoordinator(
    dependencies.speechApi,
    dependencies.preferencesApi,
    agentBridge,
    dependencies.events
  );
}

const UNAVAILABLE_AGENT_BRIDGE: SpeechAgentBridgePort = Object.freeze({
  initialize: () => undefined,
  dispose: () => undefined,
  onError: () => () => undefined,
  acceptVoiceText: () => undefined,
  cancelVoiceTurn: () => undefined
});
