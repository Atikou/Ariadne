import type { BrowserWindow } from 'electron';

/** The failed Runtime never became ready. These observations use the actual
 * Main-retained typed report and Renderer health reader, without a fake server. */
export async function readStartupHealthWindow(window: BrowserWindow, workspaceId: string, phase: string,
  expectedSource: 'journal' | 'execution' | 'conversation' | 'projection' | 'inference') {
  return window.webContents.executeJavaScript(`(async () => {
    const wait = async (probe, label) => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('startup_health_smoke_timeout:' + label);
    };
    await wait(async () => (await window.ariadne.runtime.getStatus()).value?.availability === 'disabled', 'runtime_disabled');
    const query = () => window.ariadne.runtime.request({ kind: 'runtime.health.get' });
    const health = await query();
    if (!health.ok || health.value.kind !== 'runtime.health' || health.value.health.domains.length !== 1)
      throw new Error('startup_health_minimal_read_failed');
    const source = health.value.health.domains[0];
    const expectedSource = ${JSON.stringify(expectedSource)};
    if (source.domain !== expectedSource || source.source !== expectedSource || source.availability !== 'unavailable' || source.code !== 'authority_unavailable')
      throw new Error('startup_health_source_missing');
    const warning = () => document.querySelector('[data-runtime-domain="' + expectedSource + '"]');
    await wait(() => warning()?.textContent.includes('不可用'), 'actual_startup_warning');
    if (document.body.textContent.includes('PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER')) throw new Error('startup_health_private_marker');
    const before = (await window.ariadne.runtime.getStatus()).value;
    const repeated = await query(); const after = (await window.ariadne.runtime.getStatus()).value;
    if (!repeated.ok || after?.availability !== 'disabled' || before?.observedAt !== after.observedAt)
      throw new Error('startup_health_read_restarted_runtime');
    const denied = await window.ariadne.runtime.request({ kind: 'conversation.session.create', contractVersion: '5.0',
      workspaceId: ${JSON.stringify(workspaceId)}, sessionId: ${JSON.stringify(`domain-health-startup-refused-${phase}`)}, title: '拒绝不可信写入' });
    if (denied.ok) throw new Error('startup_health_untrusted_write_accepted');
    if (denied.error.code !== 'runtime_startup_source_unavailable') throw new Error('startup_health_write_not_source_fenced');
    await wait(() => warning()?.textContent.includes('不可用'), 'final_startup_warning');
    if ((await window.ariadne.runtime.getStatus()).value?.availability !== 'disabled') throw new Error('startup_health_write_restarted_runtime');
    return { runtimeNeverReady: true, independentStartupHealthRead: true, healthReadDoesNotRestart: true,
      untrustedWriteRefused: true, privateSourceAbsent: true, source,
      warning: warning()?.textContent.trim() };
  })()`, true);
}
