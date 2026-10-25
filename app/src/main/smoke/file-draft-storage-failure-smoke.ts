import type { BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** An external owned gate holds the sealed file without delete sharing. */
export async function verifyFileDraftStorageFailure(window:BrowserWindow,root:string,workspaceId:string,outputRoot:string,reopening:boolean):Promise<unknown> {
  const context=`const d=globalThis.__ariadneRendererCompositionRootV1.services.documents,workspaceId=${JSON.stringify(workspaceId)},path='failure/source.txt';
    const request=async command=>{const result=await window.ariadne.runtime.request(command);if(!result.ok)throw new Error('storage_fixture_core:'+result.error.code);return result.value;};
    const read=()=>request({kind:'workspace.document.read',contractVersion:'5.0',workspaceId,path});
    const wait=async probe=>{const end=Date.now()+60000;while(Date.now()<end){if(await probe())return;await new Promise(r=>setTimeout(r,50));}throw new Error('storage_fixture_ui_timeout');};`;
  if(reopening)return window.webContents.executeJavaScript(`(async()=>{${context}
    const row=d.draft(workspaceId,path),catalog=await window.ariadne.fileDrafts.list();
    if(catalog.records.length!==1||row.content!=='FAILURE_PROTECTED_A'||row.pendingMutation||(await read()).content!=='FAILURE_DISK_BASELINE')throw new Error('storage_fixture_protected_restart');
    await d.prepareQuit('discard');
    return {actualMainRestartRecoveredProtectedA:true,unprotectedBAbsent:true,workspaceFileNeverWritten:true};})();`);
  await window.webContents.executeJavaScript(`(async()=>{${context}
    await request({kind:'workspace.document.save',contractVersion:'5.0',workspaceId,path,expectedVersion:null,content:'FAILURE_DISK_BASELINE'});
    const disk=await read();d.rememberDraft(workspaceId,path,{content:'FAILURE_PROTECTED_A',originalContent:disk.content,version:disk.version,writable:true,exists:true});await d.flush();
    const navigation=globalThis.__ariadneRendererCompositionRootV1.services.conversationNavigation;
    await navigation.listWorkspaces();await navigation.selectWorkspace(workspaceId);
    document.querySelector('.module-menu > button').click();
    await wait(()=>Array.from(document.querySelectorAll('.module-option')).some(e=>e.querySelector('strong')?.textContent==='文件'));
    Array.from(document.querySelectorAll('.module-option')).find(e=>e.querySelector('strong')?.textContent==='文件').click();
    await wait(()=>Array.from(document.querySelectorAll('.file-draft-list button')).some(e=>e.querySelector('span')?.textContent===path));
    Array.from(document.querySelectorAll('.file-draft-list button')).find(e=>e.querySelector('span')?.textContent===path).click();
    await wait(()=>document.querySelector('[aria-label=文件正文]')?.value==='FAILURE_PROTECTED_A');})();`);
  await writeFile(join(root,'file-draft-checkpoint.json'),JSON.stringify({format:'ariadne-file-draft-failure-checkpoint.v1',workspaceId}));
  await writeFile(join(outputRoot,'lock-ready.json'),JSON.stringify({mainPid:process.pid}));
  const end=Date.now()+60000;
  for(;;){try{await readFile(join(outputRoot,'locked.json'));break;}catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ENOENT'))throw error;}
    if(Date.now()>=end)throw new Error('storage_fixture_lock_timeout');await new Promise(resolve=>setTimeout(resolve,50));}
  const before=await readFile(join(root,'file-drafts.json'),'utf8');
  const result=await window.webContents.executeJavaScript(`(async()=>{${context}
    const a=d.draft(workspaceId,path);d.rememberDraft(workspaceId,path,{...a,content:'FAILURE_UNPROTECTED_B'});let rejected=false;
    try{await d.flush();}catch{rejected=true;}
    const b=d.draft(workspaceId,path);
    if(!rejected||!d.protectionState().error||b.content!=='FAILURE_UNPROTECTED_B'||d.protectedRevision(b.draftId)===b.revision
      ||(await read()).content!=='FAILURE_DISK_BASELINE')throw new Error('storage_fixture_failure_not_retained');
    let mainDisabled=false;try{await window.ariadne.fileDrafts.list();}catch{mainDisabled=true;}
    if(!mainDisabled)throw new Error('storage_fixture_main_not_latched');
    let retainRejected=false;try{await d.prepareQuit('retain');}catch{retainRejected=true;}d.resumeAfterCancelledQuit();
    if(!retainRejected||d.draft(workspaceId,path).content!=='FAILURE_UNPROTECTED_B')throw new Error('storage_fixture_false_protection_claim');
    await wait(()=>document.querySelector('[aria-label=文件正文]')?.value==='FAILURE_UNPROTECTED_B'
      &&document.querySelector('.workspace-document-editor')?.textContent.includes('草稿尚未受到持久保护'));
    if(document.querySelector('.workspace-document-editor').textContent.includes('invoking remote method'))throw new Error('storage_fixture_raw_ipc_error_visible');
    if(!Array.from(document.querySelectorAll('.workspace-document-editor button')).some(e=>e.textContent==='复制草稿'&&!e.disabled))throw new Error('storage_fixture_copy_unavailable');
    return {actualWindowsFileSharingDeniedAtomicRename:true,mainStorageWritesDisabled:true,unprotectedBRetainedInWindow:true,copyControlAvailable:true,
      currentRevisionNotClaimedProtected:true,retainQuitPreparationRejected:true,workspaceFileNeverWritten:true};})();`);
  if(await readFile(join(root,'file-drafts.json'),'utf8')!==before)throw new Error('storage_fixture_previous_sealed_file_changed');
  await writeFile(join(outputRoot,'file-draft-storage-failure.png'),(await window.webContents.capturePage()).toPNG());
  return {...result,previousSealedFileBytesUnchanged:true};
}
