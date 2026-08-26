import type {
  AgentModelSelectionPreference,
  DispatchExactAgentModelInferenceRequest,
  ExactAgentModelInferenceRuntime,
  ExactAgentModelInferenceResult
} from '../control/ports/AgentModelInference.js';
import type { RuntimeBootstrap } from '@ariadne/protocol/host';
import type { LocalModelService } from '../model/local/LocalModelService.js';

export const LOCAL_AGENT_MODEL_PROVIDER_ID = 'ariadne.local' as const;

/**
 * One exact inference boundary for the production Runtime model domain.
 * Remote transport keeps its strict Provider binding while local bindings use
 * the already discovered embedded ModelClient owned by LocalModelService.
 */
export class RuntimeKernelModelInferenceGateway
implements ExactAgentModelInferenceRuntime {
  public constructor(
    private readonly remote: ExactAgentModelInferenceRuntime,
    private readonly localModels: LocalModelService,
    private readonly modelProviders: RuntimeBootstrap['modelProviders'],
    private readonly defaultRoutingStrategy: NonNullable<RuntimeBootstrap['routingStrategy']>
  ) {}

  public resolveBinding(
    settingsRevision: number,
    preference: AgentModelSelectionPreference = {}
  ): DispatchExactAgentModelInferenceRequest['binding'] | null {
    const local = this.localModels.clients().map((client) => ({
      providerId: LOCAL_AGENT_MODEL_PROVIDER_ID,
      modelId: client.name,
      settingsRevision
    }));
    const remote = (this.modelProviders ?? []).flatMap((provider) => (
      provider.enabled
      && Boolean(process.env[provider.credentialEnvironmentVariable]?.trim())
        ? [{
            providerId: provider.providerId,
            modelId: provider.model,
            settingsRevision
          }]
        : []
    ));
    if (preference.modelId !== undefined) {
      return [...local, ...remote].find(
        (candidate) => candidate.modelId === preference.modelId
      ) ?? null;
    }
    const strategy = preference.routingStrategy ?? this.defaultRoutingStrategy;
    const candidates = strategy === 'privacy-first'
      ? local
      : strategy === 'local-first'
        ? [...local, ...remote]
        : [...remote, ...local];
    return candidates[0] ?? null;
  }

  public hasExactBinding(
    binding: DispatchExactAgentModelInferenceRequest['binding']
  ): boolean {
    if (binding.providerId !== LOCAL_AGENT_MODEL_PROVIDER_ID) {
      return this.remote.hasExactBinding(binding);
    }
    return this.localModels.clients().some(
      (candidate) => candidate.name === binding.modelId
    );
  }

  public async inferExact(
    request: DispatchExactAgentModelInferenceRequest
  ): Promise<ExactAgentModelInferenceResult> {
    if (request.binding.providerId !== LOCAL_AGENT_MODEL_PROVIDER_ID) {
      return this.remote.inferExact(request);
    }
    const client = this.localModels.clients().find(
      (candidate) => candidate.name === request.binding.modelId
    );
    if (client === undefined) return { status: 'binding_unavailable' };
    const response = await client.chat({
      messages: request.messages.map((message) => ({ ...message })),
      ...(request.binding.inference === undefined
        ? {}
        : { inference: structuredClone(request.binding.inference) }),
      signal: request.signal
    });
    return {
      status: 'completed',
      content: response.content,
      nativeToolCallCount: response.toolCalls.length
    };
  }
}
