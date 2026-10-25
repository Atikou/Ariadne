import type { BrowserWindow } from 'electron';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Caller proves an owned AriadneFileDraft TEMP root. External changes here are
 * actual filesystem operations, separate from the production file Authority. */
export async function verifyExternalFileDraftRecovery(window:BrowserWindow,root:string,workspaceId:string):Promise<unknown> {
  const context=`const s=globalThis.__ariadneRendererCompositionRootV1.services,d=s.documents,workspaceId=${JSON.stringify(workspaceId)};
    const request=async command=>{const result=await window.ariadne.runtime.request(command);if(!result.ok)throw new Error('recovery_fixture_core:'+result.error.code);return result.value;};
    const read=path=>request({kind:'workspace.document.read',contractVersion:'5.0',workspaceId,path});
    const wait=async probe=>{const end=Date.now()+60000;while(Date.now()<end){const value=await probe();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw new Error('recovery_fixture_ui_timeout');};`;
  await window.webContents.executeJavaScript(`(async()=>{${context}
    for(const path of ['recovery/changed.txt','recovery/missing.txt']){
      await request({kind:'workspace.document.save',contractVersion:'5.0',workspaceId,path,expectedVersion:null,content:'ORIGINAL:'+path});
      const disk=await read(path);d.rememberDraft(workspaceId,path,{content:'RECOVERED:'+path,originalContent:disk.content,version:disk.version,writable:true,exists:true});
    }await d.flush();if((await window.ariadne.fileDrafts.list()).records.length!==2)throw new Error('recovery_fixture_durable_catalog');})();`);
  const changed=join(root,'workspace','recovery','changed.txt'),missing=join(root,'workspace','recovery','missing.txt');
  await writeFile(changed,'EXTERNAL_DISK_CONTENT','utf8');await unlink(missing);
  const loaded=new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{window.webContents.removeListener('did-finish-load',done);reject(new Error('recovery_fixture_reload_timeout'));},60000);
    const done=()=>{clearTimeout(timer);resolve();};window.webContents.once('did-finish-load',done);
  });window.webContents.reload();await loaded;
  const evidence=await window.webContents.executeJavaScript(`(async()=>{${context}
    await wait(()=>d.protectionState().ready);await s.conversationNavigation.listWorkspaces();await s.conversationNavigation.selectWorkspace(workspaceId);
    document.querySelector('.module-menu > button').click();
    (await wait(()=>Array.from(document.querySelectorAll('.module-option')).find(e=>e.querySelector('strong')?.textContent==='文件'))).click();
    await wait(()=>document.querySelector('.file-draft-list'));
    for(const [path,kind] of [['recovery/changed.txt','changed'],['recovery/missing.txt','missing']]){
      (await wait(()=>Array.from(document.querySelectorAll('.file-draft-list button')).find(e=>e.querySelector('span')?.textContent===path))).click();
      await wait(()=>d.recoveryState(workspaceId,path)?.kind===kind&&document.querySelector('[aria-label=文件正文]')?.value==='RECOVERED:'+path);
      const row=d.draft(workspaceId,path),editor=document.querySelector('.workspace-document-editor');
      if(row.originalContent!=='ORIGINAL:'+path||!Array.from(editor.querySelectorAll('button')).find(e=>e.textContent==='保存文件')?.disabled
        ||!Array.from(editor.querySelectorAll('button')).some(e=>e.textContent==='复制草稿'&&!e.disabled))throw new Error('recovery_fixture_unsafe_controls');
      if(kind==='changed'&&(!editor.textContent.includes('EXTERNAL_DISK_CONTENT')||!editor.textContent.includes('ORIGINAL:'+path)))throw new Error('recovery_fixture_three_way_missing');
      if(kind==='missing'&&Array.from(editor.querySelectorAll('button')).some(e=>e.textContent==='创建此草稿文件'))throw new Error('recovery_fixture_existing_source_recreation');
      let refused=false;try{await d.save(workspaceId,path,row.version,row.content);}catch(error){refused=error.message.includes('磁盘基线尚未确认');}
      if(!refused||d.draft(workspaceId,path).content!=='RECOVERED:'+path)throw new Error('recovery_fixture_conflict_not_retained');
    }
    if((await read('recovery/changed.txt')).content!=='EXTERNAL_DISK_CONTENT')throw new Error('recovery_fixture_external_overwritten');
    const absent=await window.ariadne.runtime.request({kind:'workspace.document.read',contractVersion:'5.0',workspaceId,path:'recovery/missing.txt'});
    if(absent.ok||absent.error.code!=='workspace_file_not_found')throw new Error('recovery_fixture_missing_recreated');
    if((await window.ariadne.fileDrafts.list()).records.length!==2)throw new Error('recovery_fixture_private_copy_lost');
    // Physical quit choices have their separate native gate. This scoped fixture
    // explicitly discards its copies after proving recovery; never writes sources.
    await d.prepareQuit('discard');
    return {actualExternalFilesystemWriteAndDelete:true,rendererReloadRecoveredBothCopies:true,threeWayComparisonVisible:true,
      missingSourceCopyControlsAvailable:true,noAutomaticRecreation:true,explicitSaveRejectedWithoutChangingSources:true,
      privateCopiesRetainedUntilExplicitFixtureDiscard:true};})();`);
  if(await readFile(changed,'utf8')!=='EXTERNAL_DISK_CONTENT')throw new Error('recovery_fixture_external_disk_changed');
  try{await readFile(missing);throw new Error('recovery_fixture_missing_disk_recreated');}
  catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ENOENT'))throw error;}
  return evidence;
}
