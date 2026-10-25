import { createHash } from 'node:crypto';
import { AGENT_PROVIDER_CATALOG } from '../../shared/contract';

/** Settings operations evaluated only inside an isolated smoke renderer. */
export function remoteProviderSettingsFixture(baseUrl: string, model: string): string {
  const preset = AGENT_PROVIDER_CATALOG.openai;
  const id = `smoke-${createHash('sha256').update(model).digest('hex').slice(0, 16)}`;
  const provider = { label: 'Smoke fixture', modelId: model, protocol: preset.protocol, inferenceDialect: 'openai',
    enabled: true, baseUrl, model, supportsVision: preset.supportsVision,
    contextWindowTokens: preset.defaultContextWindowTokens, maxOutputTokens: preset.defaultMaxOutputTokens,
    inference: preset.defaultInference };
  return `...(() => {
    const id=${JSON.stringify(id)}, provider=${JSON.stringify(provider)};
    const {modelId, ...patch}=provider;
    return [settings.providers[id]
      ? {kind:'provider.update',providerId:id,patch:{...patch,apiKey:'ariadne-electron-smoke-key'}}
      : {kind:'provider.add',providerId:id,provider,apiKey:'ariadne-electron-smoke-key'},
      {kind:'modelSelection.set',selection:{modelId:provider.modelId,localFallbackModelId:''}},
      ...Object.keys(settings.providers).filter(key=>key!==id).map(providerId=>({kind:'provider.update',providerId,patch:{enabled:false}}))];
  })()`;
}
