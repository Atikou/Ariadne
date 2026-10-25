import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Real shipped ModuleTab -> Dockview -> Main-authorized popout and Core file owner. */
export async function verifyFileDraftPopout(window:BrowserWindow,workspaceId:string,outputRoot:string):Promise<unknown> {
  const evaluate=(code:string)=>window.webContents.executeJavaScript(code);
  const context=`const s=globalThis.__ariadneRendererCompositionRootV1.services,d=s.documents,workspaceId=${JSON.stringify(workspaceId)},path='popout/shared.txt';
    const request=async command=>{const result=await window.ariadne.runtime.request(command);if(!result.ok)throw new Error('popout_fixture_core:'+result.error.code);return result.value;};
    const read=()=>request({kind:'workspace.document.read',contractVersion:'5.0',workspaceId,path});
    const wait=async probe=>{const end=Date.now()+60000;while(Date.now()<end){if(await probe())return;await new Promise(r=>setTimeout(r,50));}throw new Error('popout_fixture_ui_timeout');};`;
  await evaluate(`(async()=>{${context}
    await request({kind:'workspace.document.save',contractVersion:'5.0',workspaceId,path,expectedVersion:null,content:'POPOUT_DISK_BASELINE'});
    const disk=await read();d.rememberDraft(workspaceId,path,{content:'POPOUT_CAPTURED_A',originalContent:disk.content,version:disk.version,writable:true,exists:true});await d.flush();
    await s.conversationNavigation.listWorkspaces();await s.conversationNavigation.selectWorkspace(workspaceId);
    document.querySelector('.module-menu > button').click();
    await wait(()=>Array.from(document.querySelectorAll('.module-option')).some(e=>e.querySelector('strong')?.textContent==='文件'));
    Array.from(document.querySelectorAll('.module-option')).find(e=>e.querySelector('strong')?.textContent==='文件').click();
    await wait(()=>Array.from(document.querySelectorAll('.file-draft-list button')).some(e=>e.querySelector('span')?.textContent===path));
    Array.from(document.querySelectorAll('.file-draft-list button')).find(e=>e.querySelector('span')?.textContent===path).click();
    await wait(()=>document.querySelector('[aria-label=文件正文]')?.value==='POPOUT_CAPTURED_A');
    window.__popoutDraftId=d.draft(workspaceId,path).draftId;})();`);
  const spawned=new Promise<BrowserWindow>((resolve,reject)=>{
    const timer=setTimeout(()=>{window.webContents.removeListener('did-create-window',created);reject(new Error('popout_fixture_native_window_timeout'));},60000);
    const created=(child:BrowserWindow)=>{clearTimeout(timer);resolve(child);};window.webContents.once('did-create-window',created);
  });
  await evaluate(`(async()=>{${context}
    document.querySelector('[aria-label="文件 更多操作"]').click();
    await wait(()=>document.querySelector('[data-module-action=popout]'));
    document.querySelector('[data-module-action=popout]').click();})();`);
  const child=await spawned;
  try{
    const childContext=`const wait=async probe=>{const end=Date.now()+60000;while(Date.now()<end){if(await probe())return;await new Promise(r=>setTimeout(r,50));}throw new Error('popout_fixture_child_timeout');};`;
    const initial=await child.webContents.executeJavaScript(`(async()=>{${childContext}
      await wait(()=>document.querySelector('[aria-label=文件正文]')?.value==='POPOUT_CAPTURED_A');
      return {privilegedPrivateApiAvailable:Boolean(window.ariadne?.fileDrafts)};})();`);
    if(initial.privilegedPrivateApiAvailable)throw new Error('popout_fixture_child_has_private_catalog_api');
    await evaluate(`(()=>{${context}const original=d.gateway.execute.bind(d.gateway);
      d.gateway.execute=async(command,id)=>{const result=await original(command,id);if(command.kind==='workspace.document.save'&&command.path===path)
        return new Promise(resolve=>{window.__popoutRelease=()=>{d.gateway.execute=original;resolve(result);};});return result;};})();`);
    await child.webContents.executeJavaScript(`(async()=>{${childContext}
      await wait(()=>Array.from(document.querySelectorAll('.workspace-document-editor button')).some(e=>e.textContent==='保存文件'&&!e.disabled));
      Array.from(document.querySelectorAll('.workspace-document-editor button')).find(e=>e.textContent==='保存文件').click();})();`);
    await evaluate(`(async()=>{${context}await wait(()=>typeof window.__popoutRelease==='function');})();`);
    await child.webContents.executeJavaScript(`(()=>{const input=document.querySelector('[aria-label=文件正文]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'POPOUT_NEWER_B');
      input.dispatchEvent(new Event('input',{bubbles:true}));})();`);
    await evaluate(`(async()=>{${context}await wait(()=>d.draft(workspaceId,path).content==='POPOUT_NEWER_B');window.__popoutRelease();
      await wait(()=>!d.draft(workspaceId,path).pendingMutation&&d.draft(workspaceId,path).originalContent==='POPOUT_CAPTURED_A');
      if(d.draft(workspaceId,path).draftId!==window.__popoutDraftId||(await read()).content!=='POPOUT_CAPTURED_A')throw new Error('popout_fixture_shared_owner_invalid');
      await d.flush();})();`);
    await child.webContents.executeJavaScript(`(async()=>{${childContext}await wait(()=>document.querySelector('[aria-label=文件正文]')?.value==='POPOUT_NEWER_B');})();`);
    await writeFile(join(outputRoot,'file-draft-popout.png'),(await child.webContents.capturePage()).toPNG());
    child.close();
    await evaluate(`(async()=>{${context}await wait(()=>document.querySelector('[aria-label=文件正文]')?.value==='POPOUT_NEWER_B');
      if(d.draft(workspaceId,path).draftId!==window.__popoutDraftId)throw new Error('popout_fixture_close_replaced_owner');
      await d.prepareQuit('discard');if((await read()).content!=='POPOUT_CAPTURED_A')throw new Error('popout_fixture_discard_wrote_source');})();`);
    return {actualMainAuthorizedDockviewPopout:true,childHasNoPrivilegedPrivateCatalogApi:true,
      sameDraftIdentityAcrossWindows:true,actualCoreSaveAWithNewerBPreserved:true,popoutCloseRestoredParentWithB:true};
  }finally{if(!child.isDestroyed())child.destroy();}
}
