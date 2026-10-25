import type { BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Real production discovery, settings restart and native GGUF loader. The
 * parent validates this named TEMP fixture before any settings mutation. */
export async function readLocalInferenceHealthWindow(window: BrowserWindow, workspaceId: string,
  phase: 'initial' | 'main-restart', canonicalDataRoot: string): Promise<unknown> {
  const modelRoot = join(canonicalDataRoot, 'workspace', 'models');
  if (!existsSync(join(modelRoot, 'broken', 'broken.gguf'))) throw new Error('local_inference_smoke_model_missing');
  return window.webContents.executeJavaScript(`(async () => {
    const api = window.ariadne;
    const wait = async (probe, label) => { const deadline = Date.now() + 60000;
      while (Date.now() < deadline) { const value = await probe(); if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('local_inference_timeout:' + label); };
    await wait(async () => (await api.runtime.getStatus()).value?.availability === 'ready', 'runtime_ready');
    const settings = await api.agentSettings.load(), modelRoot = ${JSON.stringify(modelRoot)};
    if (settings.localModelRoots.length !== 1 || settings.localModelRoots[0] !== modelRoot) {
      const configured = await api.agentSettings.apply({ expectedRevision: settings.revision,
        operations: [{ kind: 'modelRoots.replace', roots: [modelRoot] }] });
      if (!configured.ok) throw new Error('local_inference_configuration_failed');
    }
    await wait(async () => (await api.runtime.getStatus()).value?.availability === 'ready', 'configured_runtime_ready');
    const qualification = await api.runtime.request({ kind: 'model.qualification.run', contractVersion: '5.0', modelId: 't03-broken-local' });
    if (!qualification.ok || qualification.value.kind !== 'model.qualification.completed' || qualification.value.supportsTextChat !== false)
      throw new Error('local_inference_bad_model_not_rejected');
    const read = async () => { const response = await api.runtime.request({ kind: 'runtime.health.get' });
      if (!response.ok || response.value.kind !== 'runtime.health') throw new Error('local_inference_health_failed'); return response.value.health; };
    const health = await read(), inference = health.domains.find(row => row.domain === 'inference');
    if (inference?.availability !== 'degraded' || inference.code !== 'external_unavailable') throw new Error('local_inference_degradation_absent');
    for (const domain of ['execution','conversation','projection','journal','productivity','memory']) {
      if (health.domains.find(row => row.domain === domain)?.availability !== 'healthy') throw new Error('local_inference_unrelated_fault:' + domain);
    }
    const sessionId = ${JSON.stringify(`domain-health-independent-${phase}`)}, workspaceId = ${JSON.stringify(workspaceId)};
    const created = await api.runtime.request({ kind: 'conversation.session.create', contractVersion: '5.0', workspaceId, sessionId, title: '本地模型降级验收' });
    if (!created.ok || created.value.kind !== 'conversation.session.created') throw new Error('local_inference_independent_session_failed');
    const services = await wait(() => window.__ariadneRendererCompositionRootV1?.services, 'composition');
    await wait(async () => (await services.sessions.view.getSnapshot()).sessions.some(row => row.sessionId === sessionId), 'independent_session_projection');
    await wait(() => { const warning = document.querySelector('[data-runtime-domain="inference"]');
      return warning?.textContent.includes('受限') && warning.title.includes('依赖服务暂不可用，当前能力已降级'); }, 'actual_warning');
    if ((await read()).domains.find(row => row.domain === 'inference')?.availability !== 'degraded') throw new Error('local_inference_independent_read_cleared_fault');
    if (document.body.textContent.includes(modelRoot)) throw new Error('local_inference_private_path_rendered');
    const warning = document.querySelector('[data-runtime-domain="inference"]');
    return { realNativeModelLoadRejected: true, qualificationRejected: true, runtimeReady: true,
      independentSessionCreated: true, independentSessionRendered: true, independentReadDidNotClearDegradation: true,
      privatePathAbsent: true, health, warning: { text: warning.textContent.trim(), title: warning.title } };
  })()`, true);
}
