import type { BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The enclosing smoke validates the named TEMP root before entering here.
 * Configure the production settings API and exercise the real missing file
 * load. No embedding factory, health response or Renderer state is replaced. */
export async function readMemoryModelHealthWindow(window: BrowserWindow, workspaceId: string,
  phase: 'initial' | 'main-restart', canonicalDataRoot: string): Promise<unknown> {
  const modelPath = join(canonicalDataRoot, 'workspace', 'missing-t03-embedding.gguf');
  if (existsSync(modelPath)) throw new Error('memory_model_smoke_missing_file_exists');
  return window.webContents.executeJavaScript(`(async () => {
    const api = window.ariadne;
    const wait = async (probe, label) => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) { const value = await probe(); if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('memory_model_smoke_timeout:' + label);
    };
    await wait(async () => (await api.runtime.getStatus()).value?.availability === 'ready', 'runtime_ready');
    const settings = await api.agentSettings.load();
    const embedding = { provider: 'local-gguf', modelId: 't03-missing-embedding', modelPath: ${JSON.stringify(modelPath)},
      sha256: ${JSON.stringify('a'.repeat(64))}, dimension: 256 };
    if (JSON.stringify(settings.runtimePolicy.embedding) !== JSON.stringify(embedding)) {
      const configured = await api.agentSettings.apply({ expectedRevision: settings.revision,
        operations: [{ kind: 'runtimePolicy.replace', policy: { ...settings.runtimePolicy, embedding } }] });
      if (!configured.ok) throw new Error('memory_model_smoke_settings_failed');
    }
    await wait(async () => (await api.runtime.getStatus()).value?.availability === 'ready', 'configured_runtime_ready');
    const loaded = await api.agentSettings.load();
    if (loaded.runtimePolicy.embedding.provider !== 'local-gguf' || loaded.runtimePolicy.embedding.modelPath !== embedding.modelPath)
      throw new Error('memory_model_smoke_configuration_not_retained');
    const scope = { contractVersion: '5.0', workspaceId: ${JSON.stringify(workspaceId)},
      sessionId: ${JSON.stringify(`domain-health-independent-${phase}`)} };
    const create = await api.runtime.request({ kind: 'conversation.session.create', ...scope, title: '记忆模型降级验收' });
    if (!create.ok || create.value.kind !== 'conversation.session.created') throw new Error('memory_model_independent_session_failed');
    const recall = await api.runtime.request({ kind: 'memory.recall', ...scope, query: 'PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER', limit: 20 });
    if (!recall.ok || recall.value.kind !== 'memory.recall_result') throw new Error('memory_model_recall_failed');
    const result = recall.value;
    if (result.complete !== false || result.embedding.provider !== 'local-gguf' || result.embedding.capability !== 'semantic'
      || result.embedding.degraded !== true || result.embedding.reason !== 'model_unavailable') throw new Error('memory_model_degradation_absent');
    if (result.hits.length !== 1 || result.hits[0].memory.memoryId !== 'domain-health-original-memory'
      || result.hits[0].memory.version !== 1 || result.hits[0].reason !== 'lexical') throw new Error('memory_model_lexical_evidence_missing');
    const health = await api.runtime.request({ kind: 'runtime.health.get' });
    if (!health.ok || health.value.kind !== 'runtime.health') throw new Error('memory_model_health_failed');
    const domains = health.value.health.domains;
    const memory = domains.find(row => row.domain === 'memory');
    if (memory?.availability !== 'degraded' || memory.code !== 'external_unavailable') throw new Error('memory_model_health_not_external');
    for (const domain of ['execution','conversation','projection','journal','productivity','inference']) {
      if (domains.find(row => row.domain === domain)?.availability !== 'healthy') throw new Error('memory_model_unrelated_domain_failed:' + domain);
    }
    const read = await api.runtime.request({ kind: 'memory.read', ...scope, memoryId: 'domain-health-original-memory' });
    if (!read.ok || read.value.kind !== 'memory.read_result' || read.value.memory?.version !== 1)
      throw new Error('memory_model_source_read_failed');
    const afterRead = await api.runtime.request({ kind: 'runtime.health.get' });
    if (!afterRead.ok || afterRead.value.health.domains.find(row => row.domain === 'memory')?.availability !== 'degraded')
      throw new Error('memory_model_read_cleared_degradation');
    await wait(() => { const warning = document.querySelector('[data-runtime-domain="memory"]');
      return warning?.textContent.includes('受限') && warning.title.includes('依赖服务暂不可用，当前能力已降级'); }, 'actual_warning');
    const warnings = [...document.querySelectorAll('[data-runtime-domain]')].map(node => ({ domain: node.getAttribute('data-runtime-domain'),
      text: node.textContent.trim(), title: node.title }));
    if (warnings.some(row => row.domain !== 'memory')) throw new Error('memory_model_unrelated_ui_warning');
    if (document.body.textContent.includes('PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER') || document.body.textContent.includes(embedding.modelPath))
      throw new Error('memory_model_private_data_rendered');
    return { actualMissingModelConfigured: true, runtimeReady: true, independentSessionCreated: true, originalMemoryReadable: true,
      lexicalEvidenceRetained: true, recallIncomplete: true, readDidNotClearDegradation: true, privateSourceAbsent: true,
      embedding: result.embedding, domains, warnings };
  })()`, true);
}
