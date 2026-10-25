import { app, shell, type BrowserWindow } from 'electron';
import { readFile, mkdir, writeFile, access, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { showSmokeWindow } from './window-visibility';

/** Actual production Decision, native display receipt and externally clicked
 * Windows toast. No fake Notification handle or emitted click event. */
export async function verifyDecisionNotificationWindow(window: BrowserWindow, outputRoot: string): Promise<boolean> {
  await mkdir(outputRoot, { recursive: true });
  const root = realpathSync.native(process.env.ARIADNE_SMOKE_USER_DATA!);
  const scoped = relative(realpathSync.native(tmpdir()), root);
  if (!scoped || scoped.startsWith('..') || isAbsolute(scoped) || !basename(root).startsWith('AriadneDomainHealth-')) throw new Error('notification_smoke_temp_scope');
  const workspaceId = process.env.ARIADNE_SMOKE_WORKSPACE_ID, baseUrl = process.env.ARIADNE_SMOKE_PROVIDER_BASE_URL,
    model = process.env.ARIADNE_SMOKE_PROVIDER_MODEL;
  if (!workspaceId || !baseUrl || !model) throw new Error('notification_smoke_configuration_missing');
  const resumed = process.env.ARIADNE_SMOKE_NOTIFICATION_MAIN_RESTART === '1'
    ? await readFile(join(outputRoot, 'main-restart-checkpoint.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error;
    }) : null;
  const sessionId = resumed?.items?.[0]?.sessionId ?? `notification-session-${randomUUID()}`, messageId = `notification-message-${randomUUID()}`;
  const programs = realpathSync.native(join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  const shortcut = join(programs, `Ariadne Notification Acceptance - ${randomUUID()}.lnk`);
  let shortcutCreated = false;
  showSmokeWindow(window); window.setSkipTaskbar(false);
  let observations: unknown = null, fatalError: string | null = null;
  const wait = async <T>(probe: () => Promise<T | null>, label: string, timeoutMs = 60000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { const value = await probe(); if (value !== null) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`notification_smoke_timeout:${label}`);
  };
  try {
    if (resumed) {
      const previous = JSON.parse(await readFile(join(outputRoot, 'ready-to-arm.json'), 'utf8'));
      const prior = previous.fixtureShortcut;
      if (typeof prior !== 'string' || relative(programs, prior) !== basename(prior)
        || !/^Ariadne Notification Acceptance - [a-f0-9-]+\.lnk$/u.test(basename(prior))) throw new Error('notification_previous_shortcut_scope');
      const registered = shell.readShortcutLink(prior);
      if (registered.target !== process.execPath || registered.appUserModelId !== 'com.ariadne.desktop') throw new Error('notification_previous_shortcut_owner');
      await unlink(prior);
    }
    // Development Electron has no installer-owned shortcut. Register only this
    // uniquely named fixture with the real application identity and activator.
    try { await access(shortcut); throw new Error('notification_fixture_shortcut_exists'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (!shell.writeShortcutLink(shortcut, 'create', { target: process.execPath, args: `"${app.getAppPath()}"`,
      cwd: app.getAppPath(), appUserModelId: 'com.ariadne.desktop', toastActivatorClsid: app.toastActivatorCLSID,
      description: 'Ariadne temporary native notification acceptance' })) throw new Error('notification_fixture_shortcut_create_failed');
    shortcutCreated = true;
    const registration = shell.readShortcutLink(shortcut);
    if (registration.target !== process.execPath || registration.appUserModelId !== 'com.ariadne.desktop'
      || registration.toastActivatorClsid?.toLowerCase() !== app.toastActivatorCLSID.toLowerCase())
      throw new Error('notification_fixture_shortcut_identity_invalid');
    if (window.webContents.isLoading()) await new Promise<void>(resolve => window.webContents.once('did-finish-load', resolve));
    window.setTitle('Ariadne · 通知验收');
    const prepared = await window.webContents.executeJavaScript(`(async () => {
      const api = window.ariadne;
      const wait = async (probe, label) => { const deadline = Date.now()+60000; while(Date.now()<deadline) {
        const value = await probe(); if(value) return value; await new Promise(resolve=>setTimeout(resolve,100)); } throw new Error('notification_prepare_timeout:'+label); };
      await wait(async () => (await api.runtime.getStatus()).value?.availability === 'ready','ready');
      if(${JSON.stringify(Boolean(resumed))}) {
        window.__notificationSmokeNavigation=[];
        api.system.onApprovalNavigation(value=>window.__notificationSmokeNavigation.push(value));
        return {sessionVersion:0};
      }
      const settings = await api.agentSettings.load();
      const configured = await api.agentSettings.apply({expectedRevision:settings.revision, operations:[
        {kind:'provider.update',providerId:'openai',patch:{enabled:true,baseUrl:${JSON.stringify(baseUrl)},model:${JSON.stringify(model)},apiKey:'ariadne-electron-smoke-key'}},
        ...['deepseek','kimi','anthropic'].map(providerId=>({kind:'provider.update',providerId,patch:{enabled:false}}))]});
      if(!configured.ok) throw new Error('notification_settings_failed');
      await wait(async () => (await api.runtime.getStatus()).value?.availability==='ready','configured_ready');
      const qualification=await api.runtime.request({kind:'model.qualification.run',contractVersion:'5.0',modelId:${JSON.stringify(model)}});
      if(!qualification.ok || qualification.value.kind!=='model.qualification.completed' || !qualification.value.supportsAgent)
        throw new Error('notification_model_not_qualified');
      const created=await api.runtime.request({kind:'conversation.session.create',contractVersion:'5.0',workspaceId:${JSON.stringify(workspaceId)},
        sessionId:${JSON.stringify(sessionId)},title:'【验收夹具】真实决策通知'});
      if(!created.ok || created.value.kind!=='conversation.session.created') throw new Error('notification_session_failed');
      const services=await wait(()=>window.__ariadneRendererCompositionRootV1?.services,'composition');
      await services.sessions.select(${JSON.stringify(sessionId)});
      window.__notificationSmokeNavigation=[];
      api.system.onApprovalNavigation(value=>window.__notificationSmokeNavigation.push(value));
      return {sessionVersion:created.value.version};
    })()`, true) as { sessionVersion: number };
    // Native validation requires the finished window to be visible, including
    // when STARTUPINFO initially requested a hidden helper process.
    showSmokeWindow(window); window.setSkipTaskbar(false); window.show(); window.focus();
    await writeFile(join(outputRoot, 'ready-to-arm.json'), JSON.stringify({ root, sessionId, workspaceId, mainPid: process.pid,
      windowVisible: window.isVisible(), windowBounds: window.getBounds(), registration,
      fixtureShortcut: shortcut, applicationName: app.getName(), electronVersion: process.versions.electron }));
    if (process.env.ARIADNE_SMOKE_NOTIFICATION_LIFECYCLE === '1') {
      const { verifyDecisionNotificationLifecycle } = await import('./decision-notification-lifecycle-smoke');
      observations = await verifyDecisionNotificationLifecycle(window, root, outputRoot, workspaceId, model, sessionId, prepared.sessionVersion);
    } else {
    await wait(async () => { try { await access(join(outputRoot, 'arm-native-notification')); return true; } catch { return null; } }, 'external_arm', 120000);
    window.hide();
    const accepted = await window.webContents.executeJavaScript(`window.ariadne.runtime.request({kind:'conversation.message.accept',contractVersion:'5.0',
      workspaceId:${JSON.stringify(workspaceId)},sessionId:${JSON.stringify(sessionId)},expectedSessionVersion:${prepared.sessionVersion},
      messageId:${JSON.stringify(messageId)},content:'ariadne-smoke:question',execution:{mode:'agent',modelId:${JSON.stringify(model)}}})`, true);
    if (!accepted.ok || accepted.value.kind !== 'conversation.message.accepted') throw new Error('notification_message_not_accepted');
    const receipt = await wait(async () => {
      try {
        const file = JSON.parse(await readFile(join(root, 'decision-notifications.json'), 'utf8')) as {
          receipts: { decisionId: string; sessionId: string; runId: string; version: number; shownAt: string }[] };
        return file.receipts.find(row => row.sessionId === sessionId) ?? null;
      } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
    }, 'native_show_receipt');
    if (Object.keys(receipt).sort().join(',') !== 'decisionId,runId,sessionId,shownAt,version') throw new Error('notification_receipt_not_minimal');
    await writeFile(join(outputRoot, 'native-notification-visible.json'), JSON.stringify(receipt));
    const navigation = await wait(async () => {
      const values = await window.webContents.executeJavaScript('window.__notificationSmokeNavigation', true) as { sessionId: string; decisionId: string }[];
      return values.find(row => row.sessionId === sessionId && row.decisionId === receipt.decisionId) ?? null;
    }, 'actual_windows_click', 120000);
    if (!window.isVisible()) throw new Error('notification_click_did_not_show_application');
    const rendered = await window.webContents.executeJavaScript(`(async()=>{
      const services=window.__ariadneRendererCompositionRootV1.services, deadline=Date.now()+60000;
      while(Date.now()<deadline){
        const state=services.runtime.getSnapshot(), card=[...document.querySelectorAll('[data-decision-id]')].find(row=>row.dataset.decisionId===${JSON.stringify(receipt.decisionId)});
        if(state.selectedSessionId===${JSON.stringify(sessionId)} && card?.textContent.includes('Which execution path'))
          return {exactSessionSelected:true,exactDecisionRendered:true,pendingBeforeApproval:true};
        await new Promise(resolve=>setTimeout(resolve,100)); }
      throw new Error('notification_exact_card_not_rendered');
    })()`, true);
    await writeFile(join(outputRoot, 'notification-click.png'), (await window.webContents.capturePage()).toPNG());
    observations = { realProductionDecision: true, nativeShownReceipt: receipt, actualWindowsClickObserved: true, navigation, rendered,
      protectedPayloadAbsentFromReceipt: true, sessionId, messageId };
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    try {
      const failure = await window.webContents.executeJavaScript(`(async()=>({
        status:await window.ariadne.runtime.getStatus(),health:await window.ariadne.runtime.request({kind:'runtime.health.get'})
      }))()`, true);
      await writeFile(join(outputRoot, 'failure-health.json'), JSON.stringify(failure, null, 2));
    } catch { /* Diagnostic transport can itself be unavailable; keep the failed gate. */ }
  }
  finally {
    if (shortcutCreated) {
      try {
        const registered = shell.readShortcutLink(shortcut);
        if (relative(programs, shortcut) !== basename(shortcut) || registered.target !== process.execPath
          || registered.appUserModelId !== 'com.ariadne.desktop') throw new Error('notification_fixture_shortcut_cleanup_identity_invalid');
        await unlink(shortcut);
      } catch { fatalError ??= 'notification_fixture_shortcut_cleanup_failed'; }
    }
  }
  const passed = fatalError === null;
  await writeFile(join(outputRoot, 'decision-notification.json'), JSON.stringify({ format: process.env.ARIADNE_SMOKE_NOTIFICATION_LIFECYCLE === '1'
    ? 'ariadne-native-display-lifecycle.v1' : 'ariadne-native-decision-notification.v1', passed,
    fatalError, observations, completedAt: new Date().toISOString() }, null, 2));
  return passed;
}
