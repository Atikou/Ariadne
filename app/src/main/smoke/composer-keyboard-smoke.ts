import { remoteProviderSettingsFixture } from './remote-provider-settings-fixture';
import { app, type BrowserWindow } from 'electron';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { installSmokeProjectionProbe } from './projection-probe';
import { showSmokeWindow } from './window-visibility';

/** Real trusted Windows composition and keys, production Chat/Core, local HTTPS fixture. */
export async function verifyComposerKeyboardWindow(window: BrowserWindow, outputRoot: string): Promise<boolean> {
  const root = realpathSync.native(app.getPath('userData')), scoped = relative(realpathSync.native(tmpdir()), root);
  if (!scoped || scoped.startsWith('..') || isAbsolute(scoped) || !basename(root).startsWith('AriadneComposerKeyboard-')) throw new Error('keyboard_smoke_temp_scope');
  const workspaceId = process.env.ARIADNE_SMOKE_WORKSPACE_ID, baseUrl = process.env.ARIADNE_SMOKE_PROVIDER_BASE_URL, model = process.env.ARIADNE_SMOKE_PROVIDER_MODEL;
  if (!workspaceId || !baseUrl || !model) throw new Error('keyboard_smoke_configuration_missing');
  await mkdir(outputRoot, { recursive: true });
  let fatalError: string | null = null, observations: unknown = null;
  const wait = async <T>(probe: () => Promise<T | null>, label: string, timeout = 60000): Promise<T> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await probe(); if (value !== null) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('keyboard_smoke_timeout:' + label);
  };
  const marker = (name: string) => wait(async () => { try { await access(join(outputRoot, name)); return true; }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; } }, name, 120000);
  try {
    if (window.webContents.isLoading()) await new Promise<void>(resolve => window.webContents.once('did-finish-load', resolve));
    await installSmokeProjectionProbe(window);
    await window.webContents.executeJavaScript(`(async () => {
      const api=window.ariadne;
      const wait=async(probe,label)=>{const end=Date.now()+60000;while(Date.now()<end){const v=await probe();if(v)return v;await new Promise(r=>setTimeout(r,100));}throw new Error('keyboard_prepare:'+label);};
      await wait(async()=> (await api.runtime.getStatus()).value?.availability==='ready','runtime');
      const settings=await api.agentSettings.load();
      const configured=await api.agentSettings.apply({expectedRevision:settings.revision,operations:[
        ${remoteProviderSettingsFixture(baseUrl, model)}]});
      if(!configured.ok)throw new Error('keyboard_settings_failed');
      await wait(async()=> (await api.runtime.getStatus()).value?.availability==='ready','configured_runtime');
      const q=await api.runtime.request({kind:'model.qualification.run',contractVersion:'5.0',modelId:${JSON.stringify(model)}});
      if(!q.ok||q.value.kind!=='model.qualification.completed'||!q.value.supportsAgent||!q.value.supportsTextChat)throw new Error('keyboard_model_unqualified');
      await wait(async()=> (await window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)})).models.some(m=>m.modelId===${JSON.stringify(model)}&&m.qualificationState==='qualified'),'projection');
      const s=await wait(()=>window.__ariadneRendererCompositionRootV1?.services,'root');
      await s.conversationNavigation.selectWorkspace(${JSON.stringify(workspaceId)});
      s.drafts.newDraft(${JSON.stringify(workspaceId)});s.sessions.clearSelection();
      await wait(()=>document.querySelector('.composer textarea'),'composer');
      window.__composerKeyboardTrace=[];
      for(const type of ['compositionstart','compositionupdate','compositionend','keydown','keyup','input'])document.addEventListener(type,event=>{
        if(!(event.target instanceof HTMLTextAreaElement)||!event.target.closest('.composer'))return;
        if(window.__composerKeyboardTrace.length>=256)throw new Error('keyboard_trace_limit');
        window.__composerKeyboardTrace.push({type,trusted:event.isTrusted,key:event.key??null,code:event.code??null,data:event.data??null,composing:event.isComposing??null,
          shift:event.shiftKey??false,ctrl:event.ctrlKey??false,repeat:event.repeat??false,value:event.target.value,
          sendEnabled:!document.querySelector('.send-button')?.disabled,at:performance.now()});
      },true);
      return true;
    })()`, true);
    showSmokeWindow(window); window.setSkipTaskbar(false); window.show(); window.focus(); window.setTitle('Ariadne · 中文输入法验收');
    await writeFile(join(outputRoot, 'keyboard-ready.json'), JSON.stringify({format:'ariadne-composer-keyboard-ready.v1', mainPid:process.pid, root, workspaceId}));
    await marker('confirm-candidate');
    // Windows IME reports Process with an empty code. The external operator
    // records its actual Return action; Main never injects or invents that key.
    const action = JSON.parse(await readFile(join(outputRoot, 'confirm-candidate'), 'utf8')) as { format?: string; key?: string; candidateObserved?: boolean };
    if (action.format !== 'ariadne-physical-ime-confirmation.v1' || action.key !== 'Return' || action.candidateObserved !== true) throw new Error('keyboard_physical_confirmation_missing');
    const candidate = await window.webContents.executeJavaScript(`(async()=>{
      const trace=window.__composerKeyboardTrace, input=document.querySelector('.composer textarea');
      const start=trace.findIndex(e=>e.type==='compositionstart'&&e.trusted);
      const end=trace.findLastIndex(e=>e.type==='compositionend');
      const confirm=trace.findLast((e,i)=>i>start&&i<end&&e.type==='keydown'&&e.composing&&e.trusted&&e.sendEnabled);
      const projection=await window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)});
      const outbox=await window.ariadne.inputDeliveryOutbox.list();
      if(start<0||end<0||!confirm||!/[\u3400-\u9fff]/u.test(input.value)||projection.sessions.length||projection.messages.length||outbox.length)throw new Error('keyboard_candidate_sent_or_unproven');
      return {value:input.value,trace:structuredClone(trace),coreSessions:projection.sessions.length,coreMessages:projection.messages.length,outbox:outbox.length};
    })()`, true);
    await writeFile(join(outputRoot,'candidate-confirmed.json'),JSON.stringify(candidate,null,2));
    await marker('confirm-newline');
    await window.webContents.executeJavaScript(`(async()=>{
      const input=document.querySelector('.composer textarea'),trace=window.__composerKeyboardTrace;
      const projection=await window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)});
      if(!input.value.includes('\\n')||!trace.some(e=>e.trusted&&e.type==='keydown'&&e.key==='Enter'&&e.shift&&!e.composing)||projection.sessions.length||projection.messages.length||(await window.ariadne.inputDeliveryOutbox.list()).length)throw new Error('keyboard_shift_enter_invalid');
      return true;
    })()`, true);
    await writeFile(join(outputRoot,'send-ready.json'),JSON.stringify({passed:true}));
    observations = await wait(() => window.webContents.executeJavaScript(`(async()=>{
      const p=await window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}),trace=window.__composerKeyboardTrace;
      const user=p.messages.find(m=>m.role==='user'&&m.content.startsWith('ariadne-smoke:direct')&&/[\u3400-\u9fff]/u.test(m.content)&&m.content.includes('\\n'));
      if(!user||!p.messages.some(m=>m.role==='assistant'&&m.content==='ARIADNE_SMOKE_DIRECT_OK'))return null;
      if(p.sessions.length!==1||p.messages.filter(m=>m.role==='user').length!==1||!trace.some(e=>e.trusted&&e.type==='keydown'&&e.key==='Enter'&&!e.shift&&!e.ctrl&&!e.composing)||document.querySelector('.composer textarea').value!=='')throw new Error('keyboard_send_identity_invalid');
      return {realImeCandidateDidNotSend:true,shiftEnterDidNotSend:true,ordinaryEnterAcceptedExactlyOnce:true,qualifiedLocalHttpsFixture:true,
        sessionId:user.sessionId,messageId:user.messageId,content:user.content,trace};
    })()`, true), 'ordinary_enter');
    await writeFile(join(outputRoot,'keyboard.png'),(await window.webContents.capturePage()).toPNG());
  } catch (error) { fatalError = error instanceof Error ? error.message : String(error);
    await window.webContents.executeJavaScript('window.__composerKeyboardTrace??[]',true).then(trace=>writeFile(join(outputRoot,'failed-keyboard-trace.json'),JSON.stringify(trace,null,2))).catch(()=>undefined);
  }
  await writeFile(join(outputRoot,'composer-keyboard.json'),JSON.stringify({format:'ariadne-composer-keyboard.v1',passed:fatalError===null,fatalError,observations,completedAt:new Date().toISOString()},null,2));
  return fatalError === null;
}
