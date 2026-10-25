import type { BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { showSmokeWindow } from './window-visibility';

/** Real Main/IPC/Runtime/SQLite/Renderer acceptance against named TEMP
 * faults. Remote transport uses an external HTTPS fixture; Runtime responses
 * and rendered application state are never replaced. */
export async function verifyDomainHealthWindow(window: BrowserWindow, outputRoot: string): Promise<boolean> {
  await mkdir(outputRoot, { recursive: true });
  const workspaceId = process.env.ARIADNE_SMOKE_WORKSPACE_ID;
  if (!workspaceId) throw new Error('domain_health_smoke_workspace_missing');
  const dataRoot = process.env.ARIADNE_SMOKE_USER_DATA;
  if (!dataRoot || !isAbsolute(dataRoot)) throw new Error('domain_health_smoke_data_root_missing');
  const canonicalDataRoot = realpathSync.native(dataRoot), canonicalTemporary = realpathSync.native(tmpdir());
  const temporaryRelative = relative(canonicalTemporary, canonicalDataRoot);
  if (!temporaryRelative || temporaryRelative.startsWith('..') || isAbsolute(temporaryRelative)
    || !basename(canonicalDataRoot).startsWith('AriadneDomainHealth-')) throw new Error('domain_health_smoke_temp_scope_invalid');
  const phase = process.env.ARIADNE_SMOKE_DOMAIN_PHASE;
  if (phase !== 'initial' && phase !== 'main-restart') throw new Error('domain_health_smoke_phase_invalid');
  if (process.env.ARIADNE_SMOKE_DOMAIN_SCENARIO === 'task' || process.env.ARIADNE_SMOKE_DOMAIN_SCENARIO === 'task-resume') {
    const { verifyTaskIsolationWindow } = await import('./task-isolation-smoke');
    return verifyTaskIsolationWindow(window, outputRoot, workspaceId, phase);
  }
  const consoleErrors: string[] = [];
  const sourceDomain = process.env.ARIADNE_SMOKE_DOMAIN_SCENARIO === 'memory' ? 'memory'
    : process.env.ARIADNE_SMOKE_DOMAIN_SCENARIO === 'inference' ? 'inference' : 'productivity';
  const onConsole = (_event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>, level: number, message: string) => {
    if (level === 3 && consoleErrors.length < 32) consoleErrors.push(message.slice(0, 512));
  };
  window.webContents.on('console-message', onConsole); showSmokeWindow(window);
  let observations: unknown = null, fatalError: string | null = null;
  try {
    if (window.webContents.isLoading()) await new Promise<void>(resolve => window.webContents.once('did-finish-load', () => resolve()));
    const scenario = process.env.ARIADNE_SMOKE_DOMAIN_SCENARIO;
    const startupSource = scenario === 'journal' || scenario === 'execution' || scenario === 'conversation' || scenario === 'projection' ? scenario : null;
    observations = scenario === 'inference-remote'
      ? await (await import('./remote-inference-health-smoke')).readRemoteInferenceHealthWindow(window, workspaceId, phase, canonicalDataRoot, outputRoot)
      : scenario === 'inference-local'
      ? await (await import('./local-inference-health-smoke')).readLocalInferenceHealthWindow(window, workspaceId, phase, canonicalDataRoot)
      : scenario === 'memory-model'
      ? await (await import('./memory-model-health-smoke')).readMemoryModelHealthWindow(window, workspaceId, phase, canonicalDataRoot)
      : startupSource !== null
      ? await (await import('./runtime-startup-health-smoke')).readStartupHealthWindow(window, workspaceId, phase, startupSource)
      : await window.webContents.executeJavaScript(`(async () => {
      const wait = async (probe, label) => {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) { const value = await probe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
        throw new Error('domain_health_smoke_timeout:' + label);
      };
      await wait(async () => (await window.ariadne.runtime.getStatus()).value?.availability === 'ready', 'runtime_ready');
      const query = () => window.ariadne.runtime.request({ kind: 'runtime.health.get' });
      const result = await query();
      if (!result.ok || result.value.kind !== 'runtime.health') throw new Error('domain_health_read_failed');
      const domains = result.value.health.domains;
      const sourceDomain = ${JSON.stringify(sourceDomain)};
      const source = domains.find(row => row.domain === sourceDomain);
      if (source?.availability !== 'unavailable' || source.code !== 'authority_unavailable') throw new Error('domain_health_source_fault_absent');
      for (const domain of ['execution','conversation','projection']) {
        if (domains.find(row => row.domain === domain)?.availability !== 'healthy') throw new Error('domain_health_unrelated_domain_failed:' + domain);
      }
      const create = await window.ariadne.runtime.request({ kind: 'conversation.session.create', contractVersion: '5.0',
        workspaceId: ${JSON.stringify(workspaceId)}, sessionId: ${JSON.stringify(`domain-health-independent-${phase}`)}, title: '独立会话验收' });
      if (!create.ok || create.value.kind !== 'conversation.session.created') throw new Error('domain_health_independent_write_failed');
      const services = await wait(async () => window.__ariadneRendererCompositionRootV1?.services, 'renderer_composition');
      await wait(async () => (await services.sessions.view.getSnapshot()).sessions.some(row => row.sessionId === ${JSON.stringify(`domain-health-independent-${phase}`)}),
        'independent_session_projection');
      const denied = await window.ariadne.runtime.request(sourceDomain === 'inference'
        ? { kind: 'model.qualification.run', contractVersion: '5.0', modelId: 'fixture-only' }
        : { kind: sourceDomain === 'memory' ? 'memory.read' : 'productivity.query', contractVersion: '5.0',
        workspaceId: ${JSON.stringify(workspaceId)}, sessionId: ${JSON.stringify(`domain-health-independent-${phase}`)},
        ...(sourceDomain === 'memory' ? { memoryId: 'domain-health-original-memory' } : {}) });
      if (denied.ok || denied.error.code !== 'runtime_' + sourceDomain + '_unavailable') throw new Error('domain_health_faulty_source_not_fenced');
      await wait(() => document.querySelector('[data-runtime-domain="' + sourceDomain + '"]')?.textContent.includes('不可用'), 'actual_health_warning');
      const warnings = [...document.querySelectorAll('[data-runtime-domain]')].map(node => ({ domain: node.getAttribute('data-runtime-domain'), text: node.textContent.trim(), title: node.title }));
      if (warnings.some(row => ['execution','conversation','projection'].includes(row.domain))) throw new Error('domain_health_unrelated_ui_warning');
      if (document.body.textContent.includes('PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER')) throw new Error('domain_health_private_source_rendered');
      const latest = await query();
      if (!latest.ok || latest.value.health.domains.find(row => row.domain === sourceDomain)?.availability !== 'unavailable')
        throw new Error('domain_health_timer_cleared_fault');
      return { runtimeReady: true, independentSessionCreated: true, independentSessionRendered: true, faultAdmissionRefused: true,
        independentHealthRead: true, privateSourceAbsent: true, domains, warnings };
    })()`, true);
  } catch (error) { fatalError = error instanceof Error ? error.message : String(error); }
  finally { window.webContents.removeListener('console-message', onConsole); }
  const screenshot = join(outputRoot, 'domain-health.png');
  await writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
  const passed = fatalError === null && consoleErrors.length === 0;
  await writeFile(join(outputRoot, 'domain-health.json'), JSON.stringify({ format: 'ariadne-electron-domain-health.v1', passed,
    phase, mainPid: process.pid, fatalError, consoleErrors, observations, screenshot, completedAt: new Date().toISOString() }, null, 2));
  return passed;
}
