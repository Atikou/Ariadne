import { app, safeStorage, type BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { PERSONAL_ASSISTANT_WORKSPACE_ID, PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import { showSmokeWindow } from './window-visibility';

/** Actual Main IPC, OS cipher, Renderer DOM and Core journal in owned TEMP.
 * Programmatic fixture actions are not physical keyboard/IME acceptance. */
export async function verifyChatDraftWindow(window: BrowserWindow, outputRoot: string): Promise<boolean> {
  const root = realpathSync.native(app.getPath('userData')), scoped = relative(realpathSync.native(tmpdir()), root);
  if (!scoped || scoped.startsWith('..') || isAbsolute(scoped) || !basename(root).startsWith('AriadneChatDraft-')) throw new Error('draft_smoke_temp_scope');
  await mkdir(outputRoot, { recursive: true }); showSmokeWindow(window); window.setTitle('Ariadne · 草稿验收');
  const resumed = process.env.ARIADNE_SMOKE_DRAFT_PHASE === 'main-restart';
  const physicalTyping = process.env.ARIADNE_SMOKE_DRAFT_PHYSICAL_TYPING === '1';
  const checkpointPath = join(outputRoot, 'draft-checkpoint.json');
  let observations: unknown = null, fatalError: string | null = null;
  const wait = async <T>(probe: () => Promise<T | null>, label: string): Promise<T> => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) { const value = await probe(); if (value !== null) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`draft_smoke_timeout:${label}`);
  };
  const rendererReady = async (): Promise<void> => {
    if (window.webContents.isLoading()) await new Promise<void>(resolve => window.webContents.once('did-finish-load', resolve));
    await wait(() => window.webContents.executeJavaScript(`Boolean(globalThis.__ariadneRendererCompositionRootV1?.services.drafts.getSnapshot().ready) ? true : null`), 'draft_owner');
    await wait(() => window.webContents.executeJavaScript(`globalThis.__ariadneRendererCompositionRootV1?.services.diagnostics.view.getSnapshot().status.availability==='ready' ? true : null`), 'runtime_ready');
  };
  // Validated by Runtime's strict decoder as well as Chromium's image element.
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMwTpv5HwAENAIyeXoBdAAAAABJRU5ErkJggg==';
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('draft_smoke_os_cipher_unavailable');
    await rendererReady();
    if (!resumed) {
      if (physicalTyping) {
        await window.webContents.executeJavaScript(`(() => {const s=globalThis.__ariadneRendererCompositionRootV1.services;
          s.drafts.newDraft(${JSON.stringify(PERSONAL_ASSISTANT_WORKSPACE_ID)});s.sessions.clearSelection();s.conversationNavigation.selectAssistant();})()`);
        await wait(() => window.webContents.executeJavaScript(`document.querySelector('textarea[aria-label="消息输入框"]')?.value==='' ? true : null`), 'physical_empty_composer');
        // STARTUPINFO requests a hidden helper. Expose the finished fixture
        // explicitly, as in the native notification gate, before OS input.
        showSmokeWindow(window); window.setSkipTaskbar(false); window.show(); window.focus();
        await writeFile(join(outputRoot, 'physical-input-A-ready.json'), JSON.stringify({ mainPid: process.pid, phase: 'A', title: window.getTitle() }));
        await wait(() => window.webContents.executeJavaScript(`document.querySelector('textarea[aria-label="消息输入框"]')?.value==='DRAFT_A_FIXTURE_中文' ? true : null`), 'physical_A');
      }
      const checkpoint = await window.webContents.executeJavaScript(`(async () => {
        const s=globalThis.__ariadneRendererCompositionRootV1.services, api=window.ariadne;
        const owner=${physicalTyping ? `s.drafts.ownerFor(${JSON.stringify(PERSONAL_ASSISTANT_WORKSPACE_ID)},null)` : `s.drafts.newDraft(${JSON.stringify(PERSONAL_ASSISTANT_WORKSPACE_ID)})`};
        s.sessions.clearSelection(); s.conversationNavigation.selectAssistant();
        ${physicalTyping ? "if(s.drafts.draft(owner).editing.text!=='DRAFT_A_FIXTURE_中文') throw new Error('draft_smoke_physical_A_owner');" : "s.drafts.edit(owner,'DRAFT_A_FIXTURE_中文');"}
        const picture=()=>({clientId:crypto.randomUUID(),mediaType:'image/png',bytes:atob(${JSON.stringify(image)}).length,data:${JSON.stringify(image)},name:'owned-fixture.png'});
        s.drafts.appendImages(s.drafts.captureImageRead(owner),[picture()]);
        const token=await s.drafts.beginSubmission(owner), sessionId=crypto.randomUUID();
        const attachments=await Promise.all(token.attachments.map(reference=>s.drafts.attachment(owner,reference)));
        const commands=[{commandId:crypto.randomUUID(),draftSubmissionId:token.submissionId,command:{kind:'conversation.session.create',contractVersion:${JSON.stringify(PUBLIC_PROJECTION_CONTRACT_VERSION)},sessionId,workspaceId:owner.workspaceId,title:'Draft fixture'}},
          {commandId:crypto.randomUUID(),draftSubmissionId:token.submissionId,command:{kind:'conversation.message.accept',contractVersion:${JSON.stringify(PUBLIC_PROJECTION_CONTRACT_VERSION)},sessionId,workspaceId:owner.workspaceId,expectedSessionVersion:1,messageId:token.submissionId,content:token.text,attachments,execution:{mode:'chat'}}}];
        await api.inputDeliveryOutbox.stageBatch(commands);
        for(const row of commands) await s.drafts.attachCommand(token,row.commandId);
        // Apply through the actual Core journal but deliberately withhold
        // editing settlement. After reload the delivery owner must replay the
        // exact original IDs and recover their already committed outcomes.
        for(const row of commands){const result=await api.runtime.request(row.command,{commandId:row.commandId});
          if(!result.ok)throw new Error('draft_smoke_initial_core_rejected:'+result.error.code);
          if(row.command.kind==='conversation.message.accept' && (result.value.kind!=='conversation.message.accepted'||result.value.messageId!==token.submissionId)) throw new Error('draft_smoke_initial_acceptance_invalid');}
        ${physicalTyping ? '' : "s.drafts.edit(owner,'DRAFT_B_FIXTURE_中文');"} s.drafts.appendImages(s.drafts.captureImageRead(owner),[picture()]); s.drafts.fail(token,true); await s.drafts.flush();
        const metadata=await api.chatDrafts.list();
        if(JSON.stringify(metadata).includes(${JSON.stringify(image)})) throw new Error('draft_smoke_body_in_metadata');
        return {owner,submissionId:token.submissionId,sessionId,commandIds:commands.map(row=>row.commandId),initialMainPid:${process.pid},coreAcceptedBeforeRendererReload:true};
      })()`);
      if (physicalTyping) {
        await writeFile(join(outputRoot, 'physical-input-B-ready.json'), JSON.stringify({ mainPid: process.pid, phase: 'B', title: window.getTitle() }));
        await wait(() => window.webContents.executeJavaScript(`document.querySelector('textarea[aria-label="消息输入框"]')?.value==='DRAFT_B_FIXTURE_中文' ? true : null`), 'physical_B');
        await window.webContents.executeJavaScript(`globalThis.__ariadneRendererCompositionRootV1.services.drafts.flush()`);
      }
      await writeFile(checkpointPath, JSON.stringify(checkpoint));
      await writeFile(join(outputRoot, 'before-composer-wait.png'), (await window.webContents.capturePage()).toPNG());
      await wait(() => window.webContents.executeJavaScript(`document.querySelector('textarea[aria-label="消息输入框"]')?.value==='DRAFT_B_FIXTURE_中文' ? true : null`), 'initial_composer_B');
      await writeFile(join(outputRoot, 'initial.png'), (await window.webContents.capturePage()).toPNG());
      window.webContents.reload(); await rendererReady();
      await wait(() => window.webContents.executeJavaScript(`document.querySelector('textarea[aria-label="消息输入框"]')?.value==='DRAFT_B_FIXTURE_中文' && document.querySelector('.composer-image-draft img')?.naturalWidth===1 ? true : null`), 'renderer_reload_B_image');
      await window.webContents.executeJavaScript(`(() => {
        const s=globalThis.__ariadneRendererCompositionRootV1.services,c=${JSON.stringify(checkpoint)};
        const restored=s.drafts.draft(c.owner);
        if(restored.editing.text!=='DRAFT_B_FIXTURE_中文'||restored.submissions[0]?.text!=='DRAFT_A_FIXTURE_中文'||restored.submissions[0]?.status!=='reconcile') throw new Error('draft_smoke_reload_snapshot');
      })()`);
      if (physicalTyping) {
        showSmokeWindow(window); window.setSkipTaskbar(false); window.show(); window.focus();
        await writeFile(join(outputRoot, 'physical-reconciliation-ready.json'), JSON.stringify({ mainPid: process.pid, title: window.getTitle() }));
        await wait(() => window.webContents.executeJavaScript(`(async () => {const s=globalThis.__ariadneRendererCompositionRootV1.services,c=${JSON.stringify(checkpoint)};
          if(s.drafts.getSnapshot().drafts.some(row=>row.submissions.some(sub=>sub.submissionId===c.submissionId)))return null;
          return (await window.ariadne.inputDeliveryOutbox.list()).some(row=>row.draftSubmissionId===c.submissionId)?null:true;})()`), 'physical_original_reconciliation');
      } else await window.webContents.executeJavaScript(`globalThis.__ariadneRendererCompositionRootV1.services.draftDelivery.reconcile(${JSON.stringify(checkpoint.owner)},${JSON.stringify(checkpoint.submissionId)})`);
      const result = await window.webContents.executeJavaScript(`(async () => {
        const s=globalThis.__ariadneRendererCompositionRootV1.services,c=${JSON.stringify(checkpoint)};
        const owner={workspaceId:c.owner.workspaceId,target:{kind:'session',sessionId:c.sessionId}}, after=s.drafts.draft(owner);
        if(after.editing.text!=='DRAFT_B_FIXTURE_中文'||after.submissions.length) throw new Error('draft_smoke_reconcile_B');
        const outbox=await window.ariadne.inputDeliveryOutbox.list(); if(outbox.some(row=>row.draftSubmissionId===c.submissionId)) throw new Error('draft_smoke_outbox_unsettled');
        return {owner,submissionId:c.submissionId,sessionId:c.sessionId,initialMainPid:c.initialMainPid,rendererReloadRestored:true,originalCoreCommandReconciled:true,coreAcceptedBeforeRendererReload:c.coreAcceptedBeforeRendererReload};
      })()`);
      await writeFile(checkpointPath, JSON.stringify(result));
      const raw = await readFile(join(root, 'chat-drafts.json'), 'utf8');
      if (raw.includes('DRAFT_A_FIXTURE') || raw.includes('DRAFT_B_FIXTURE') || raw.includes(image)) throw new Error('draft_smoke_plaintext_file');
      await writeFile(join(outputRoot, 'restart-main-request.json'), JSON.stringify({ format: 'ariadne-chat-draft-main-cut.v1', mainPid: process.pid }));
      await new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('draft_smoke_main_cut_not_observed')), 120000));
    } else {
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
      if (checkpoint.initialMainPid === process.pid) throw new Error('draft_smoke_main_not_restarted');
      const result = await window.webContents.executeJavaScript(`(async () => {
        const s=globalThis.__ariadneRendererCompositionRootV1.services,c=${JSON.stringify(checkpoint)}, row=s.drafts.draft(c.owner);
        if(row.editing.text!=='DRAFT_B_FIXTURE_中文'||row.editing.attachments.length!==1||row.submissions.length) throw new Error('draft_smoke_main_restore');
        await s.sessions.select(c.sessionId); s.drafts.select(c.owner);
        const body=await s.drafts.attachment(c.owner,row.editing.attachments[0]); if(body.data!==${JSON.stringify(image)}) throw new Error('draft_smoke_body_restore');
        return {physicalMainRestart:true,mainPid:${process.pid},priorMainPid:c.initialMainPid,rendererReloadRestored:c.rendererReloadRestored,
          originalCoreCommandReconciled:c.originalCoreCommandReconciled,coreAcceptedBeforeRendererReload:c.coreAcceptedBeforeRendererReload,BAndImageRestored:true,publicDraftMetadataHasNoBody:true};
      })()`);
      await wait(() => window.webContents.executeJavaScript(`document.querySelector('textarea[aria-label="消息输入框"]')?.value==='DRAFT_B_FIXTURE_中文' && document.querySelector('.composer-image-draft img')?.naturalWidth===1 ? true : null`), 'main_restart_composer_B_image');
      await writeFile(join(outputRoot, 'main-restart.png'), (await window.webContents.capturePage()).toPNG()); observations = result;
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : 'draft_smoke_failed';
    if (!window.webContents.isDestroyed()) {
      const state = await window.webContents.executeJavaScript(`(() => { const s=globalThis.__ariadneRendererCompositionRootV1?.services;
        return {composerCount:document.querySelectorAll('textarea[aria-label="消息输入框"]').length,
          composerChecks:[...document.querySelectorAll('textarea[aria-label="消息输入框"]')].map(input=>({equalsB:input.value==='DRAFT_B_FIXTURE_中文',length:input.value.length})),
          moduleIds:[...document.querySelectorAll('[data-module-id]')].map(node=>node.dataset.moduleId),
          selectedSession:s?.sessions.view.getSnapshot().selectedSessionId, selectedWorkspace:s?.conversationNavigation.getSelectedWorkspaceId(),
          drafts:s?.drafts.getSnapshot().drafts.map(row=>({owner:row.owner,isB:row.editing.text==='DRAFT_B_FIXTURE_中文',submissions:row.submissions.length}))}; })()`).catch(() => null);
      await writeFile(join(outputRoot, 'failure-observation.json'), JSON.stringify(state, null, 2));
      await writeFile(join(outputRoot, 'failure.png'), (await window.webContents.capturePage()).toPNG());
    }
  }
  const passed = resumed && fatalError === null;
  await writeFile(join(outputRoot, 'chat-drafts.json'), JSON.stringify({ format: 'ariadne-electron-chat-drafts.v1', passed, fatalError,
    scope: 'Owned TEMP actual Electron/Main IPC/Windows safeStorage/Renderer DOM/image/physical Main cut. Core accepts original image command before Renderer reload; fixture deliberately withholds editing settlement; delivery owner replays original Core journal IDs. Images and submission are programmatic; IME, send-button and live Provider not asserted.',
    physicalTextInputObserved: physicalTyping, originalReconciliationUiObserved: physicalTyping, observations, completedAt: new Date().toISOString() }, null, 2));
  return passed;
}
