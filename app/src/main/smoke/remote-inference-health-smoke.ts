import { remoteProviderSettingsFixture } from './remote-provider-settings-fixture';
import type { BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A loopback HTTPS Provider fixture exercises production Main settings, TLS,
 * Runtime transport and rendered health. It is not a live Provider acceptance. */
export async function readRemoteInferenceHealthWindow(window: BrowserWindow, workspaceId: string,
  phase: 'initial' | 'main-restart', canonicalDataRoot: string, outputRoot: string): Promise<unknown> {
  const model = 't03-remote-health-fixture';
  const ready = JSON.parse(readFileSync(join(canonicalDataRoot, 'provider-ready.json'), 'utf8')) as { baseUrl: string };
  const endpoint = new URL(ready.baseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/v1'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('remote_health_fixture_address');
  const baseUrl = endpoint.toString();
  const control = join(canonicalDataRoot, 'provider-control.json'), tracePath = join(canonicalDataRoot, 'provider-trace.json');
  const readTrace = () => JSON.parse(readFileSync(tracePath, 'utf8')) as { phase: 'failure' | 'success'; status: number; validProbe: boolean }[];
  const initialTraceLength = readTrace().length;
  await writeFile(control, JSON.stringify({ available: false }));
    const failure = await window.webContents.executeJavaScript(`(async () => {
      const api = window.ariadne;
      const wait = async (probe, label) => { const deadline = Date.now() + 60000;
        while (Date.now() < deadline) { const value = await probe(); if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('remote_health_timeout:' + label); };
      await wait(async () => (await api.runtime.getStatus()).value?.availability === 'ready', 'ready');
      const settings = await api.agentSettings.load();
      const policy = { ...settings.runtimePolicy, providerResilience: { ...settings.runtimePolicy.providerResilience,
        maxAttempts: 1, circuitFailureThreshold: 10 } };
      const configured = await api.agentSettings.apply({ expectedRevision: settings.revision, operations: [
        ${remoteProviderSettingsFixture(baseUrl, model)},
        { kind: 'runtimePolicy.replace', policy }
      ] });
      if (!configured.ok) throw new Error('remote_health_configuration_failed');
      await wait(async () => (await api.runtime.getStatus()).value?.availability === 'ready', 'configured_ready');
      const probe = await api.runtime.request({ kind: 'model.availability.check', contractVersion: '5.0', modelId: ${JSON.stringify(model)} });
      if (!probe.ok || probe.value.kind !== 'model.availability.completed' || probe.value.available !== false)
        throw new Error('remote_health_failure_not_observed');
      const read = async () => { const result = await api.runtime.request({ kind: 'runtime.health.get' });
        if (!result.ok || result.value.kind !== 'runtime.health') throw new Error('remote_health_read_failed'); return result.value.health; };
      const health = await read(), inference = health.domains.find(row => row.domain === 'inference');
      if (inference?.availability !== 'degraded' || inference.code !== 'external_unavailable') throw new Error('remote_health_degradation_absent');
      for (const domain of ['execution','conversation','projection','journal','productivity','memory'])
        if (health.domains.find(row => row.domain === domain)?.availability !== 'healthy') throw new Error('remote_health_unrelated_fault:' + domain);
      const sessionId = ${JSON.stringify(`remote-health-independent-${phase}`)}, workspaceId = ${JSON.stringify(workspaceId)};
      const created = await api.runtime.request({ kind: 'conversation.session.create', contractVersion: '5.0', workspaceId, sessionId, title: '远程模型降级验收' });
      if (!created.ok || created.value.kind !== 'conversation.session.created') throw new Error('remote_health_independent_session_failed');
      const services = await wait(() => window.__ariadneRendererCompositionRootV1?.services, 'composition');
      await wait(async () => (await services.sessions.view.getSnapshot()).sessions.some(row => row.sessionId === sessionId), 'session_projection');
      await wait(() => { const warning = document.querySelector('[data-runtime-domain="inference"]');
        return warning?.textContent.includes('受限') && warning.title.includes('依赖服务暂不可用，当前能力已降级'); }, 'degraded_warning');
      if ((await read()).domains.find(row => row.domain === 'inference')?.availability !== 'degraded') throw new Error('remote_health_read_cleared_fault');
      if (document.body.textContent.includes(${JSON.stringify(baseUrl)}) || document.body.textContent.includes('ariadne-electron-smoke-key'))
        throw new Error('remote_health_private_binding_rendered');
      return { health, settingsRevision: (await api.agentSettings.load()).revision,
        independentSessionCreated: true, independentSessionRendered: true, independentReadDidNotClearDegradation: true,
        warning: { text: document.querySelector('[data-runtime-domain="inference"]').textContent.trim(),
          title: document.querySelector('[data-runtime-domain="inference"]').title } };
    })()`, true) as { settingsRevision: number };
    if (!readTrace().slice(initialTraceLength).some(row => row.status === 503 && row.validProbe)) throw new Error('remote_health_no_actual_https_failure');
    const failureScreenshot = join(outputRoot, 'remote-health-degraded.png');
    await writeFile(failureScreenshot, (await window.webContents.capturePage()).toPNG());
    // Only the fixture's HTTP response changes. Exact production settings,
    // process, model binding and health owner remain in place during recovery.
    await writeFile(control, JSON.stringify({ available: true }));
    const recovery = await window.webContents.executeJavaScript(`(async () => {
      const api = window.ariadne, before = (await api.runtime.getStatus()).value;
      const result = await api.runtime.request({ kind: 'model.availability.check', contractVersion: '5.0', modelId: ${JSON.stringify(model)} });
      if (!result.ok || result.value.kind !== 'model.availability.completed' || result.value.available !== true)
        throw new Error('remote_health_successful_response_absent');
      const health = await api.runtime.request({ kind: 'runtime.health.get' });
      if (!health.ok || health.value.kind !== 'runtime.health' || health.value.health.domains.find(row => row.domain === 'inference')?.availability !== 'healthy')
        throw new Error('remote_health_same_binding_not_recovered');
      const deadline = Date.now() + 60000;
      while (document.querySelector('[data-runtime-domain="inference"]') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (document.querySelector('[data-runtime-domain="inference"]')) throw new Error('remote_health_warning_not_cleared');
      const after = (await api.runtime.getStatus()).value;
      if (before.availability !== 'ready' || after.availability !== 'ready' || typeof before.observedAt !== 'string'
        || before.observedAt !== after.observedAt) throw new Error('remote_health_recovery_changed_runtime_lifecycle');
      if ((await api.agentSettings.load()).revision !== ${JSON.stringify(failure.settingsRevision)}) throw new Error('remote_health_recovery_changed_binding');
      return { health: health.value.health, warningClearedAfterResponse: true, stableReadyStatus: true, settingsRevisionRetained: true };
    })()`, true);
    const trace = readTrace().slice(initialTraceLength);
    if (!trace.some(row => row.status === 200 && row.validProbe) || trace.some(row => !row.validProbe)) throw new Error('remote_health_provider_trace_invalid');
    return { realHttpsFailureObserved: true, sameBindingResponseRecovered: true, warningClearedAfterResponse: true,
      fixtureProvider: true, failure, recovery, trace, failureScreenshot };
}
