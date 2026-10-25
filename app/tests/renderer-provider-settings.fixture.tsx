import { useMemo } from 'react';
import { SettingsPanel } from '../src/renderer/src/modules/settings/SettingsPanel';
import { moduleId, type ModuleServices } from '../src/renderer/src/core/modules/module-contract';
import { AGENT_PROVIDER_IDS, type AgentSettingsView } from '../src/shared/contract';
import { fixtureProvider } from './support/remote-provider-fixture';

export function ProviderSettingsFixture({ services }: { services: ModuleServices }) {
  const scoped = useMemo(() => {
    let settings: AgentSettingsView;
    const fixture = { checks: [] as string[], writes: [] as unknown[], unavailable: [] as string[] };
    Object.assign(window, { __providerSettingsFixture: fixture });
    const load = async () => {
      if (!settings) {
        settings = await services.agentSettings.load();
        for (const id of AGENT_PROVIDER_IDS) settings.providers[id] = {
          ...fixtureProvider(id), modelId: `configured-${id}`, enabled: id === 'deepseek' || id === 'openai',
          model: `configured-${id}`, baseUrl: 'https://provider.example', apiKeyStatus: 'configured',
          contextWindowTokens: id === 'anthropic' ? 200_000 : 32_768, maxOutputTokens: 8193
        };
      }
      return structuredClone(settings);
    };
    return { ...services,
      models: { ...services.models, view: {
        getSnapshot: () => modelSnapshot, subscribe: () => () => {}
      }, checkAvailability: async (id: string) => {
        fixture.checks.push(id);
        if (!Object.values(settings.providers).some(provider => provider.modelId === id)) throw new Error('Unknown model ID');
        return { kind: 'model.availability.completed', modelId: id, available: !fixture.unavailable.includes(id) };
      } },
      agentSettings: { ...services.agentSettings, load,
        apply: async (request: Parameters<ModuleServices['agentSettings']['apply']>[0]) => {
          fixture.writes.push(request);
          for (const operation of request.operations) {
            if (operation.kind === 'provider.update') Object.assign(settings.providers[operation.providerId]!, operation.patch);
            if (operation.kind === 'provider.add') settings.providers[operation.providerId] = { ...operation.provider,
              apiKeyStatus: operation.apiKey ? 'configured' : 'missing' };
            if (operation.kind === 'provider.remove') delete settings.providers[operation.providerId];
          }
          settings.revision++;
          return { ok: true, effect: 'hot_applied', settings: structuredClone(settings) };
        }
      }
    } as unknown as ModuleServices;
  }, [services]);
  return <SettingsPanel moduleId={moduleId('settings.providers.fixture')} services={scoped} />;
}

const modelSnapshot = { modelsReadReady: true, models: [{ id: 'configured-deepseek', label: 'configured-deepseek',
  location: 'remote', enabled: true, availability: 'ready', supportsTextChat: true,
  supportsAgent: false, supportsPlan: false, supportsVision: false, inference: {} }] };
