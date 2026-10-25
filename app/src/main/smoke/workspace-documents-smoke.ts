import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Shipped editor and actual Agent file Tools exercise the same versioned file owner. */
export async function verifyWorkspaceDocuments(window:BrowserWindow,workspaceId:string,outputRoot:string):Promise<void> {
  const evidence=await window.webContents.executeJavaScript(`(async()=>{
    const workspaceId=${JSON.stringify(workspaceId)};
    const request=async command=>{const result=await window.ariadne.runtime.request(command);
      if(!result.ok)throw new Error('document_smoke_request_failed:'+command.kind+':'+result.error.code);return result.value;};
    const snapshot = async (selection = {}) => window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}, selection);
    let phase='open';const waitFor=async predicate=>{const deadline=Date.now()+60_000;while(Date.now()<deadline){const value=await predicate();
      if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}
      throw new Error('document_smoke_timeout:'+phase+':'+document.querySelector('.file-explorer')?.textContent);};
    const editor=()=>document.querySelector('.workspace-document-editor');
    const button=text=>Array.from(document.querySelectorAll('.file-explorer button,.action-dialog button')).find(button=>button.textContent===text&&!button.disabled);
    const click=async text=>(await waitFor(()=>button(text))).click();
    const input=(selector,value)=>{const element=document.querySelector(selector);if(!element)throw new Error('document_smoke_input_missing:'+selector);
      const prototype=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));};
    const body=()=>document.querySelector('[aria-label=文件正文]');
    const read=path=>request({kind:'workspace.document.read',contractVersion:'5.0',workspaceId,path});
    const sessionId=crypto.randomUUID();const scope={contractVersion:'5.0',workspaceId,sessionId};
    await request({...scope,kind:'conversation.session.create',title:'【验收夹具】实际文件版本冲突'});
    await waitFor(async()=>(await snapshot()).sessions.some(session=>session.sessionId===sessionId));
    await window.__ariadneRendererCompositionRootV1.services.sessions.select(sessionId);
    document.querySelector('.module-menu > button').click();
    (await waitFor(()=>Array.from(document.querySelectorAll('.module-option')).find(item=>item.querySelector('strong')?.textContent==='文件'))).click();
    (await waitFor(()=>document.querySelector('li[title="fixtures"]'))).click();
    (await waitFor(()=>document.querySelector('li[title="fixtures/editor-crlf.txt"]'))).click();
    await waitFor(()=>body()?.value==='ARIADNE_SMOKE_EDITOR_ORIGINAL\\n第二行\\n'&&!body().readOnly);
    const original=await read('fixtures/editor-crlf.txt');
    phase='save';input('[aria-label=文件正文]','ARIADNE_SMOKE_EDITOR_EDITED\\n编辑中文\\n');await click('保存文件');
    await waitFor(()=>editor()?.textContent.includes('已保存。'));
    const edited=await read('fixtures/editor-crlf.txt');
    if(edited.content!=='ARIADNE_SMOKE_EDITOR_EDITED\\r\\n编辑中文\\r\\n'||edited.version===original.version)throw new Error('document_smoke_crlf_save_invalid');
    input('[aria-label=文件正文]','ARIADNE_SMOKE_EDITOR_UNSAVED');
    await waitFor(()=>editor()?.textContent.includes('有未保存修改'));
    const session=(await snapshot()).sessions.find(session=>session.sessionId===sessionId);
    await request({...scope,kind:'conversation.message.accept',expectedSessionVersion:session.version,messageId:crypto.randomUUID(),
      content:'ariadne-smoke:document_edit_conflict',execution:{mode:'agent'}});
    phase='actual_agent_replace';const allowed=new Set();
    const run=await waitFor(async()=>{const state=await snapshot();
      for(const decision of state.decisions)if(decision.sessionId===sessionId&&decision.kind==='permission'&&decision.status==='pending'&&decision.action&&!allowed.has(decision.decisionId)){
        allowed.add(decision.decisionId);await request({kind:'agent.decision.resolve',contractVersion:'5.0',runId:decision.runId,decisionId:decision.decisionId,
          action:{contractVersion:decision.action.contractVersion,actionToken:decision.action.actionToken,choice:'allow_once'}});}
      const answer=state.messages.find(message=>message.sessionId===sessionId&&message.role==='assistant'&&message.content==='ARIADNE_SMOKE_DOCUMENT_CONFLICT_WRITTEN');
      const run=answer&&state.runs.find(run=>run.runId===answer.runId);return run?.status==='completed'?run:null;});
    phase='stale_save';await click('保存文件');
    await waitFor(()=>editor()?.querySelector('[role=alert]')?.textContent.includes('文件已被其他操作更新'));
    const external=await read('fixtures/editor-crlf.txt');
    if(external.content!=='ARIADNE_SMOKE_EDITOR_EXTERNAL\\r\\nexternal中文\\r\\n'||external.version===edited.version
      ||body().value!=='ARIADNE_SMOKE_EDITOR_UNSAVED')throw new Error('document_smoke_conflict_overwrote_content');
    phase='reload';await click('重新读取');await click('确认重新读取');
    await waitFor(()=>body()?.value==='ARIADNE_SMOKE_EDITOR_EXTERNAL\\nexternal中文\\n'&&!editor().textContent.includes('有未保存修改'));
    phase='move';await click('重命名或移动');await waitFor(()=>document.querySelector('.action-dialog-field input'));
    input('.action-dialog-field input','editor/renamed.txt');await click('确认移动');
    await waitFor(()=>editor()?.querySelector('header strong')?.textContent==='editor/renamed.txt');
    const moved=await read('editor/renamed.txt');
    if(moved.content!==external.content)throw new Error('document_smoke_move_content_invalid');
    const old=await window.ariadne.runtime.request({kind:'workspace.document.read',contractVersion:'5.0',workspaceId,path:'fixtures/editor-crlf.txt'});
    if(old.ok||old.error.code!=='workspace_file_not_found')throw new Error('document_smoke_move_source_remains');
    phase='delete';await click('删除文件');await click('确认删除');await waitFor(()=>!editor());
    const deleted=await window.ariadne.runtime.request({kind:'workspace.document.read',contractVersion:'5.0',workspaceId,path:'editor/renamed.txt'});
    if(deleted.ok||deleted.error.code!=='workspace_file_not_found')throw new Error('document_smoke_delete_remains');
    phase='create';await click('新建文件');await waitFor(()=>document.querySelector('.action-dialog-field input'));
    input('.action-dialog-field input','editor/created.txt');await click('开始编辑');await waitFor(()=>body()?.value===''&&!body().readOnly);
    input('[aria-label=文件正文]','ARIADNE_SMOKE_EDITOR_NEW');await click('保存文件');await waitFor(()=>editor()?.textContent.includes('已保存。'));
    const created=await read('editor/created.txt');if(created.content!=='ARIADNE_SMOKE_EDITOR_NEW')throw new Error('document_smoke_create_invalid');
    return {passed:true,workspaceId,sessionId,runId:run.runId,originalVersion:original.version,editedVersion:edited.version,externalVersion:external.version,
      movedVersion:moved.version,createdVersion:created.version,explicitWritePermissions:allowed.size,productionEditorSavedMovedDeletedCreated:true,
      crlfPreserved:true,actualAgentReadThenVersionedReplace:true,staleEditorSaveRejectedWithoutLosingDraft:true,reloadedExternalChange:true,
      createdPath:'editor/created.txt',createdContent:created.content,deletedPaths:['fixtures/editor-crlf.txt','editor/renamed.txt']};
  })()`,true);
  await writeFile(join(outputRoot,'workspace-documents-execution.json'),JSON.stringify(evidence,null,2),'utf8');
}
