import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { showSmokeWindow } from './window-visibility';

/** Real Runtime/SQLite and production UI, against a persisted isolated task.
 * No model or external effects are supplied: missing evidence stays unresolved. */
export async function verifyTaskIsolationWindow(window: BrowserWindow, outputRoot: string, workspaceId: string, phase: string) {
  const consoleErrors: string[] = [];
  const onConsole = (_event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>, level: number, message: string) => {
    if (level === 3 && consoleErrors.length < 32) consoleErrors.push(message.slice(0, 512));
  };
  window.webContents.on('console-message', onConsole); showSmokeWindow(window);
  let fatalError: string | null = null, observations: unknown = null;
  try {
    if (window.webContents.isLoading()) await new Promise<void>(resolve => window.webContents.once('did-finish-load', () => resolve()));
    observations = await window.webContents.executeJavaScript(`(async () => {
      const wait = async (probe, label) => { const deadline = Date.now() + 60000;
        while (Date.now() < deadline) { const value = await probe(); if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('task_isolation_timeout:' + label); };
      const request = async (command, commandId) => {
        const response = await window.ariadne.runtime.request(command, commandId ? { commandId } : undefined);
        if (!response.ok) throw new Error('task_isolation_request:' + command.kind + ':' + response.error.code); return response.value;
      };
      await wait(async () => (await window.ariadne.runtime.getStatus()).value?.availability === 'ready', 'ready');
      const health = await request({ kind: 'runtime.health.get' });
      for (const domain of ['execution','conversation','projection','productivity']) {
        if (health.health.domains.find(row => row.domain === domain)?.availability !== 'healthy') throw new Error('task_isolation_source_unhealthy:' + domain);
      }
      const workflow = health.health.domains.find(row => row.domain === 'workflow');
      if (workflow?.availability !== 'degraded' || workflow.code !== 'task_quarantined') throw new Error('task_isolation_degradation_missing');
      const workspaceId = ${JSON.stringify(workspaceId)}, sessionId = 'domain-health-task-parent';
      const query = () => request({ kind: 'productivity.task_faults.query', contractVersion: '1.0', workspaceId, sessionId, limit: 32 });
      const before = await query(), fault = before.faults[0];
      if (before.faults.length !== 1 || !['quarantined','reconciling'].includes(fault.state) || Object.hasOwn(fault, 'prompt')) throw new Error('task_isolation_fault_missing');
      const services = await wait(() => window.__ariadneRendererCompositionRootV1?.services, 'composition');
      await wait(async () => (await services.sessions.view.getSnapshot()).sessions.some(row => row.sessionId === sessionId), 'parent_projection');
      await services.sessions.select(sessionId);
      if (!document.querySelector('.productivity-panel')) {
        document.querySelector('.module-menu > button').click();
        (await wait(() => Array.from(document.querySelectorAll('.module-option')).find(row => row.querySelector('strong')?.textContent === '目标与工作流'), 'module')).click();
      }
      const row = await wait(() => document.querySelector('[data-task-fault-id="' + fault.faultId + '"]'), 'fault_row');
      if (!row.textContent.includes(fault.state === 'reconciling' ? '核对中' : '已隔离')) throw new Error('task_isolation_ui_wrong_state');
      const recover = [...row.querySelectorAll('button')].find(button => button.textContent === '核对并恢复');
      if (!recover || recover.disabled) throw new Error('task_isolation_recovery_missing');
      recover.click(); recover.click();
      await wait(() => document.querySelector('.productivity-task-faults [role=status]')?.textContent.includes('证据尚不完整'), 'unresolved_feedback');
      const replay = await services.productivity.taskFaults.reconcile(fault);
      if (replay.outcome !== 'unresolved' || replay.fault.revision !== fault.revision + (fault.state === 'reconciling' ? 1 : 2)) throw new Error('task_isolation_replay_wrong');
      const after = await query();
      if (after.faults[0].revision !== replay.fault.revision || after.faults[0].state !== 'quarantined') throw new Error('task_isolation_duplicate_recovery');
      await request({ kind: 'conversation.session.create', contractVersion: '5.0', workspaceId,
        sessionId: ${JSON.stringify(`task-health-independent-${phase}`)}, title: '任务隔离后的独立会话' });
      const latest = await request({ kind: 'runtime.health.get' });
      if (latest.health.domains.find(row => row.domain === 'workflow')?.code !== 'task_quarantined') throw new Error('task_isolation_fault_cleared');
      return { health, beforeRevision: fault.revision, afterRevision: replay.fault.revision, resumedPendingClaim: fault.state === 'reconciling', unresolvedUI: true,
        duplicateClickFenced: true, originalCommandReplayed: true, independentSessionCreated: true, faultRetained: true };
    })()`, true);
  } catch (error) { fatalError = error instanceof Error ? error.message : String(error); }
  finally { window.webContents.removeListener('console-message', onConsole); }
  const screenshot = join(outputRoot, 'task-isolation.png');
  await writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
  const passed = fatalError === null && consoleErrors.length === 0;
  await writeFile(join(outputRoot, 'domain-health.json'), JSON.stringify({ format: 'ariadne-electron-domain-health.v1', scenario: 'task',
    passed, phase, mainPid: process.pid, fatalError, consoleErrors, observations, screenshot, completedAt: new Date().toISOString() }, null, 2));
  return passed;
}
