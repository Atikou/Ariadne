import { AGENT_PROVIDER_CATALOG, type AgentProviderPreset, type AgentSettingsOperation } from '../../src/shared/contract';

export function fixtureProvider(id: AgentProviderPreset = 'openai') {
  const preset = AGENT_PROVIDER_CATALOG[id];
  return { label: preset.label, modelId: preset.defaultModel, protocol: preset.protocol, inferenceDialect: id,
    enabled: true, baseUrl: preset.defaultBaseUrl, model: preset.defaultModel, supportsVision: preset.supportsVision,
    contextWindowTokens: preset.defaultContextWindowTokens, maxOutputTokens: preset.defaultMaxOutputTokens,
    inference: structuredClone(preset.defaultInference) };
}
export function addFixtureProvider(id: AgentProviderPreset = 'openai', apiKey?: string): AgentSettingsOperation {
  return { kind: 'provider.add', providerId: id, provider: fixtureProvider(id), ...(apiKey ? { apiKey } : {}) };
}
