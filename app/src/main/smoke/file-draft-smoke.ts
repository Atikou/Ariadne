import { app, safeStorage, type BrowserWindow } from 'electron';
import { realpathSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { showSmokeWindow } from './window-visibility';
import { verifyExternalFileDraftRecovery } from './file-draft-recovery-smoke';
import { verifyFileDraftStorageFailure } from './file-draft-storage-failure-smoke';
import { verifyFileDraftPopout } from './file-draft-popout-smoke';

/** Owned TEMP, actual private IPC/OS cipher/Core, programmatic transport faults.
 * Native quit choices are made externally in the displayed Electron dialog. */
export async function verifyFileDraftWindow(window:BrowserWindow,outputRoot:string):Promise<boolean> {
  const root=realpathSync.native(app.getPath('userData')),scoped=relative(realpathSync.native(tmpdir()),root);
  if(!scoped||scoped.startsWith('..')||isAbsolute(scoped)||!basename(root).startsWith('AriadneFileDraft-'))throw new Error('file_draft_smoke_temp_scope');
  const workspaceId=process.env.ARIADNE_SMOKE_WORKSPACE_ID,phase=process.env.ARIADNE_SMOKE_FILE_DRAFT_PHASE;
  if(!workspaceId||!['prepare','retain','save','discard','verify-discard','recovery','storage-failure','verify-storage-failure','popout'].includes(phase??''))throw new Error('file_draft_smoke_configuration');
  await mkdir(outputRoot,{recursive:true});showSmokeWindow(window);window.setTitle(`Ariadne · 文件草稿验收 · ${phase}`);
  const evaluate=(code:string)=>window.webContents.executeJavaScript(code);
  const wait=async<T>(probe:()=>Promise<T|null>,label:string,timeout=60000):Promise<T>=>{
    const end=Date.now()+timeout;while(Date.now()<end){const value=await probe();if(value!==null)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('file_draft_smoke_timeout:'+label);
  };
  const marker=(name:string)=>wait(async()=>{try{await access(join(outputRoot,name));return true;}catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')return null;throw error;}},name,120000);
  const context=`const workspaceId=${JSON.stringify(workspaceId)},s=globalThis.__ariadneRendererCompositionRootV1.services,d=s.documents,api=window.ariadne;
    const request=async command=>{const result=await api.runtime.request(command);if(!result.ok)throw new Error('file_fixture_core:'+result.error.code);return result.value;};
    const read=path=>request({kind:'workspace.document.read',contractVersion:'5.0',workspaceId,path});`;
  let fatalError:string|null=null,observations:unknown=null;
  try {
    if(!safeStorage.isEncryptionAvailable())throw new Error('file_draft_smoke_os_cipher_unavailable');
    if(window.webContents.isLoading())await new Promise<void>(resolve=>window.webContents.once('did-finish-load',resolve));
    await wait(()=>evaluate(`Boolean(globalThis.__ariadneRendererCompositionRootV1?.services.documents.protectionState().ready)&&globalThis.__ariadneRendererCompositionRootV1.services.diagnostics.view.getSnapshot().status.availability==='ready'?true:null`),'owners');
    window.setSkipTaskbar(false);window.show();window.focus();
    if(phase==='storage-failure'||phase==='verify-storage-failure'){
      observations=await verifyFileDraftStorageFailure(window,root,workspaceId,outputRoot,phase==='verify-storage-failure');
      if(phase==='storage-failure'){
        await writeFile(join(outputRoot,'file-drafts.json'),JSON.stringify({format:'ariadne-file-draft-native.v1',passed:true,fatalError:null,observations,phase,root,mainPid:process.pid},null,2));
        await writeFile(join(outputRoot,'cut-ready.json'),JSON.stringify({mainPid:process.pid}));
        await marker('unexpected-no-cut');throw new Error('storage_fixture_main_not_cut');
      }
    }else if(phase==='popout'){
      observations=await verifyFileDraftPopout(window,workspaceId,outputRoot);
    }else if(phase==='recovery'){
      observations=await verifyExternalFileDraftRecovery(window,root,workspaceId);
    }else if(phase==='prepare'){
      observations=await evaluate(`(async()=>{${context}
        const paths=[...Array.from({length:30},(_,i)=>'files/f-'+i+'.txt'),'Sensitive/Notes.txt','Sensitive/notes.txt'];
        for(const path of paths){await request({kind:'workspace.document.save',contractVersion:'5.0',workspaceId,path,expectedVersion:null,content:'BASE:'+path});const disk=await read(path);d.rememberDraft(workspaceId,path,{content:'DIRTY:'+path,originalContent:disk.content,version:disk.version,writable:true,exists:true});}
        await d.flush();if((await api.fileDrafts.list()).records.length!==32)throw new Error('file_fixture_capacity');
        const upper=await d.resolvePath(workspaceId,'FILES/F-0.TXT');if(upper!=='files/f-0.txt'||d.draft(workspaceId,upper).draftId!==d.draft(workspaceId,'files/f-0.txt').draftId)throw new Error('file_fixture_case_alias');
        if(d.draft(workspaceId,'Sensitive/Notes.txt').draftId===d.draft(workspaceId,'Sensitive/notes.txt').draftId)throw new Error('file_fixture_sensitive_alias');
        const started=performance.now();await d.prepareQuit('save',Date.now()+30000);const saveAllMs=performance.now()-started;d.resumeAfterCancelledQuit();
        if((await api.fileDrafts.list()).records.length||d.unsavedDrafts().length)throw new Error('file_fixture_save_all_pending');
        for(const path of paths)if((await read(path)).content!=='DIRTY:'+path)throw new Error('file_fixture_save_all_content');
        const path='files/f-0.txt',old=d.draft(workspaceId,path),original=d.gateway.execute.bind(d.gateway);let release;
        d.rememberDraft(workspaceId,path,{...old,content:'FILE_CAPTURED_A'});
        d.gateway.execute=async(command,id)=>{const result=await original(command,id);if(command.kind==='workspace.document.save'&&command.path===path){window.__fileDraftHeld={command,id,result};return new Promise(resolve=>{release=()=>resolve(result);});}return result;};
        const saving=d.save(workspaceId,path,old.version,'FILE_CAPTURED_A');let failure;
        void saving.catch(error=>{failure=error;});const holdDeadline=Date.now()+60000;
        while(!window.__fileDraftHeld){if(failure)throw failure;if(Date.now()>=holdDeadline)throw new Error('file_fixture_hold_timeout');await new Promise(resolve=>setTimeout(resolve,25));}
        d.rememberDraft(workspaceId,path,{...d.draft(workspaceId,path),content:'FILE_PROTECTED_B'});release();await saving;d.gateway.execute=original;
        const second='files/f-1.txt',row=d.draft(workspaceId,second);d.rememberDraft(workspaceId,second,{...row,content:'FILE_ORIGINAL_UNKNOWN_A'});
        d.gateway.execute=async(command,id)=>{const result=await original(command,id);if(command.kind==='workspace.document.save'&&command.path===second)throw new Error('【验收夹具】已提交响应丢失');return result;};
        try{await d.save(workspaceId,second,row.version,'FILE_ORIGINAL_UNKNOWN_A');throw new Error('file_fixture_expected_unknown');}catch(error){if(error.message!=='【验收夹具】已提交响应丢失')throw error;}
        d.gateway.execute=original;d.rememberDraft(workspaceId,second,{...d.draft(workspaceId,second),content:'FILE_SECOND_B'});await d.flush();
        const originalMutation=d.draft(workspaceId,second).pendingMutation;
        if(originalMutation.state!=='unknown')throw new Error('file_fixture_unknown_missing');
        return {paths,saveAllMs,actual32CoreSaves:true,actualWindowsCaseAliases:true,distinctCaseSensitiveFiles:true,lateASettledWithoutReplacingB:true,originalMutation};
      })()`);
      await writeFile(join(root,'file-draft-checkpoint.json'),JSON.stringify(observations));
      window.webContents.reload();
      await wait(()=>evaluate(`globalThis.__ariadneRendererCompositionRootV1?.services.documents.protectionState().ready?true:null`),'reload');
      await evaluate(`(async()=>{${context}const row=d.draft(workspaceId,'files/f-1.txt');if(row.content!=='FILE_SECOND_B'||row.pendingMutation.commandId!==${JSON.stringify((observations as {originalMutation:{commandId:string}}).originalMutation.commandId)})throw new Error('file_fixture_reload_identity');
        await d.reconcileMutation(workspaceId,'files/f-1.txt');if(d.draft(workspaceId,'files/f-1.txt').content!=='FILE_SECOND_B'||(await read('files/f-1.txt')).content!=='FILE_ORIGINAL_UNKNOWN_A')throw new Error('file_fixture_journal_replay');})();`);
      await evaluate(`(async()=>{${context}await s.conversationNavigation.listWorkspaces();await s.conversationNavigation.selectWorkspace(workspaceId);
        if(!document.querySelector('.file-explorer')){document.querySelector('.module-menu > button').click();
          const deadline=Date.now()+60000;let entry;while(!(entry=Array.from(document.querySelectorAll('.module-option')).find(e=>e.querySelector('strong')?.textContent==='文件'))){if(Date.now()>=deadline)throw new Error('file_fixture_module_menu_timeout');await new Promise(resolve=>setTimeout(resolve,25));}entry.click();}})()`);
      await wait(()=>evaluate(`document.querySelector('.file-draft-list')?true:null`),'file_panel');
      await evaluate(`Array.from(document.querySelectorAll('.file-draft-list button')).find(e=>e.querySelector('span')?.textContent==='files/f-0.txt').click()`);
      await wait(()=>evaluate(`document.querySelector('[aria-label=文件正文]')?.value==='FILE_PROTECTED_B'?true:null`),'editing_copy');
      await writeFile(join(outputRoot,'cancel-ready.json'),JSON.stringify({mainPid:process.pid,title:window.getTitle(),expectedChoice:'取消退出'}));
      app.quit();await marker('cancel-confirmed');
      if(window.isDestroyed())throw new Error('file_fixture_cancel_destroyed_window');
      await evaluate(`(async()=>{${context}if((await read('files/f-0.txt')).content!=='FILE_CAPTURED_A')throw new Error('file_fixture_cancel_changed_disk');
        d.rememberDraft(workspaceId,'files/f-0.txt',{...d.draft(workspaceId,'files/f-0.txt'),content:'FILE_B_AFTER_CANCEL'});await d.flush();
        const originalApi=d.protection.api;d.protection.api={...originalApi,replace:async()=>{window.__fileDraftWriteHeld=true;return new Promise(()=>{});}};
        d.rememberDraft(workspaceId,'files/f-0.txt',{...d.draft(workspaceId,'files/f-0.txt'),content:'FILE_C_NOT_PROTECTED'});})()`);
      await wait(()=>evaluate(`window.__fileDraftWriteHeld?true:null`),'held_before_main_ipc');
      const raw=await readFile(join(root,'file-drafts.json'),'utf8');if(raw.includes('FILE_B_AFTER_CANCEL')||raw.includes('FILE_SECOND_B')||!JSON.parse(raw).ciphertext)throw new Error('file_fixture_plaintext_leak');
      await writeFile(join(outputRoot,'file-drafts.json'),JSON.stringify({format:'ariadne-file-draft-native.v1',passed:true,fatalError:null,observations:{...observations as object,actualCoreJournalReload:true,nativeCancelKeptWindow:true,actualOsCipher:true,rendererWriteHeldBeforeMainIpc:true},phase,root,mainPid:process.pid},null,2));
      await writeFile(join(outputRoot,'cut-ready.json'),JSON.stringify({mainPid:process.pid,protected:'FILE_B_AFTER_CANCEL',unprotected:'FILE_C_NOT_PROTECTED'}));
      await marker('unexpected-no-cut');throw new Error('file_fixture_main_not_cut');
    }else{
      const expected=phase==='discard'||phase==='verify-discard'?'FILE_B_AFTER_CANCEL':'FILE_CAPTURED_A';
      const secondExpected=phase==='discard'||phase==='verify-discard'?'FILE_SECOND_B':'FILE_ORIGINAL_UNKNOWN_A';
      observations=await evaluate(`(async()=>{${context}const catalog=await api.fileDrafts.list(),disk=await read('files/f-0.txt'),secondDisk=await read('files/f-1.txt');
        if(disk.content!==${JSON.stringify(expected)})throw new Error('file_fixture_restart_disk:'+disk.content);
        if(secondDisk.content!==${JSON.stringify(secondExpected)})throw new Error('file_fixture_restart_second_disk:'+secondDisk.content);
        if(${JSON.stringify(phase)}==='retain'||${JSON.stringify(phase)}==='save'){
          if(catalog.records.length!==2||d.draft(workspaceId,'files/f-0.txt').content!=='FILE_B_AFTER_CANCEL'||d.draft(workspaceId,'files/f-1.txt').content!=='FILE_SECOND_B'||catalog.records.some(r=>r.content==='FILE_C_NOT_PROTECTED'))throw new Error('file_fixture_restart_durable_boundary');
        }else if(catalog.records.length)throw new Error('file_fixture_completed_quit_left_drafts');
        if(${JSON.stringify(phase)}==='discard'){const disk=await read('files/f-0.txt');d.rememberDraft(workspaceId,'files/f-0.txt',{content:'FILE_EXPLICIT_DISCARD',originalContent:disk.content,version:disk.version,writable:true,exists:true});await d.flush();}
        return {actualMainRestartRestoredProtectedB:true,unprotectedCAbsent:true,noAutomaticWorkspaceWrite:true,records:catalog.records.length,priorQuitVerified:true,bothFileContentsVerified:true};})();`);
      if(phase!=='verify-discard'){
        await writeFile(join(outputRoot,'quit-ready.json'),JSON.stringify({mainPid:process.pid,title:window.getTitle(),expectedChoice:phase==='retain'?'保留草稿并退出':phase==='save'?'保存全部并退出':'丢弃草稿并退出'}));
      }
    }
  }catch(error){fatalError=error instanceof Error?error.message:String(error);}
  await writeFile(join(outputRoot,'file-drafts.json'),JSON.stringify({format:'ariadne-file-draft-native.v1',passed:fatalError===null,fatalError,observations,phase,root,mainPid:process.pid},null,2));
  return fatalError===null;
}
