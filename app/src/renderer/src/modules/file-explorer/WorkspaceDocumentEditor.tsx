import { useEffect,useRef,useState,useSyncExternalStore } from 'react';
import { workspaceDocumentPathSchema,WORKSPACE_DOCUMENT_MAX_BYTES } from '@ariadne/protocol/public';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import type { WorkspaceDocumentDraft } from '@renderer/core/runtime/features/workspace-document-feature-store';
import { fileDraftProtectionMessage } from '@renderer/core/runtime/features/file-draft-protection';
import { ConfirmDialog,TextPromptDialog } from '@renderer/shared/ui/ActionDialog';
import './workspace-document-editor.css';

type Intent='reload'|'close'|'delete'|'create'|null;
export function WorkspaceDocumentEditor({workspaceId,path,create,services,onClose,onMoved,onChanged}:{
  workspaceId:string;path:string;create:boolean;services:ModuleServices;onClose():void;onMoved(path:string):void;onChanged():void;
}):React.JSX.Element {
  const [draft,setDraft]=useState<WorkspaceDocumentDraft|null>(null);const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [notice,setNotice]=useState<string|null>(null);
  const [confirm,setConfirm]=useState<Intent>(null);const [rename,setRename]=useState(false);
  const owner=JSON.stringify([workspaceId,path]);const current=useRef(owner);current.current=owner;
  const mounted=useRef(true);const pending=useRef(false);const readGeneration=useRef(0);
  const storeRevision=useSyncExternalStore(services.documents.subscribe,services.documents.getSnapshot,services.documents.getSnapshot);
  const ownerPending=services.documents.isPending(workspaceId,path);const working=busy||ownerPending;
  const protectedDraft=services.documents.draft(workspaceId,path),protection=services.documents.protectionState();
  const recovered=services.documents.isRecovered(workspaceId,path),recovery=services.documents.recoveryState(workspaceId,path);
  const recoveryBlocked=recovered&&(recovery?.kind!=='matched'||!recovery.disk.writable);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;readGeneration.current++;};},[]);
  const apply=(next:WorkspaceDocumentDraft,baseline:'edit'|'disk'='edit'):void=>{services.documents.rememberDraft(workspaceId,path,next,baseline);setDraft(next);};
  const read=async():Promise<void>=>{
    const generation=++readGeneration.current;setLoading(true);setError(null);setNotice(null);
    try {const result=await services.documents.read(workspaceId,path);
      if(!mounted.current||current.current!==owner||generation!==readGeneration.current)return;
      apply({content:result.content,originalContent:result.content,version:result.version,writable:result.writable,exists:true},'disk');
    }catch(error){if(mounted.current&&current.current===owner&&generation===readGeneration.current)setError(message(error));}
    finally{if(mounted.current&&current.current===owner&&generation===readGeneration.current)setLoading(false);}
  };
  useEffect(()=>{
    setDraft(null);setConfirm(null);setRename(false);setError(null);setNotice(null);setLoading(false);
    const cached=services.documents.draft(workspaceId,path);
    if(cached)setDraft(cached);
    else if(create){try{apply({content:'',originalContent:'',version:null,writable:true,exists:false});}catch(error){setError(message(error));}}
    else void read();
    return()=>{readGeneration.current++;};
  },[owner,create,services]);
  useEffect(()=>{const cached=services.documents.draft(workspaceId,path);if(cached)setDraft(cached);else if(!loading)setDraft(null);},[storeRevision,owner,services]);
  useEffect(()=>{if(recovered)void services.documents.inspectRecovery(workspaceId,path);},[owner,recovered,services]);
  const dirty=draft!==null&&(!draft.exists||draft.content!==draft.originalContent);
  const newline=draft?newlineStyle(draft.originalContent):'lf';
  const editable=draft?.writable===true&&newline!=='mixed';
  const perform=async(operation:'save'|'move'|'delete',destination?:string,confirmedCreate=false):Promise<void>=>{
    if(!draft||pending.current||ownerPending)return;
    if(protectedDraft?.pendingMutation||(recoveryBlocked&&!(operation==='save'&&confirmedCreate&&!draft.exists&&recovery?.kind==='missing'))){setError('请先核对原操作或恢复草稿的磁盘基线。');return;}
    pending.current=true;setBusy(true);setError(null);setNotice(null);
    const captured=draft;
    try {
      if(operation==='save'){
        const result=await services.documents.save(workspaceId,path,captured.version,captured.content);
        const next=services.documents.draft(workspaceId,path)??{...captured,version:result.version,originalContent:captured.content,exists:true};
        if(mounted.current&&current.current===owner){setDraft(next);setNotice('已保存。');onChanged();}
      }else if(operation==='move'){
        if(!captured.version||!destination)throw new Error('文件尚未保存，不能移动。');
        const result=await services.documents.move(workspaceId,path,captured.version,destination);
        if(mounted.current&&current.current===owner){onMoved(result.destination);onChanged();}
      }else{
        if(!captured.version)throw new Error('文件尚未保存。');
        await services.documents.delete(workspaceId,path,captured.version);
        if(mounted.current&&current.current===owner){onClose();onChanged();}
      }
    }catch(error){if(mounted.current&&current.current===owner)setError(message(error));}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  };
  const discardAndClose=async():Promise<void>=>{try{await services.documents.discardDraft(workspaceId,path);onClose();}catch(error){setError(message(error));}};
  const requestClose=():void=>{if(dirty)setConfirm('close');else void discardAndClose();};
  const acceptConfirm=():void=>{
    const intent=confirm;setConfirm(null);
    if(intent==='reload')void read();
    else if(intent==='close')void discardAndClose();
    else if(intent==='delete')void perform('delete');
    else if(intent==='create')void perform('save',undefined,true);
  };
  return <section className="workspace-document-editor" aria-label="工作区文本编辑器" aria-busy={working||loading}>
    <header><strong title={path}>{path}</strong><small>{dirty?'有未保存修改':draft?.exists?'文本文件':'新文件'}</small></header>
    <div className="workspace-document-actions">
      <button type="button" disabled={!draft||!editable||working||loading||recoveryBlocked||Boolean(protectedDraft?.pendingMutation)||(!dirty&&draft.exists)} onClick={()=>void perform('save')}>保存文件</button>
      <button type="button" disabled={working||loading||Boolean(protectedDraft?.pendingMutation)} onClick={()=>dirty?setConfirm('reload'):void read()}>重新读取</button>
      <button type="button" disabled={!draft?.exists||!draft.writable||working||loading||recoveryBlocked||Boolean(protectedDraft?.pendingMutation)} onClick={()=>setRename(true)}>重命名或移动</button>
      <button type="button" disabled={!draft?.exists||!draft.writable||working||loading||recoveryBlocked||Boolean(protectedDraft?.pendingMutation)} onClick={()=>setConfirm('delete')}>删除文件</button>
      <button type="button" disabled={working} onClick={requestClose}>关闭文件</button>
      <button type="button" disabled={!draft} onClick={()=>{const content=services.documents.draft(workspaceId,path)?.content??draft?.content;if(content!==undefined)void services.clipboard.writeText({text:content}).then(()=>setNotice('草稿已复制；磁盘文件未改变。')).catch(error=>setError(message(error)));}}>复制草稿</button>
    </div>
    {loading&&<p role="status">正在读取文件…</p>}
    {error&&<p role="alert">{error} {protectedDraft?.pendingMutation?'请使用“核对原操作”，保留原命令身份。':'请核对磁盘版本；未保存内容仍保留在草稿中。'}</p>}
    {notice&&<p role="status">{notice}</p>}
    {recovered&&<div className="file-draft-recovery" role="status"><strong>已恢复受保护草稿</strong>
      <p>{!recovery?'正在核对磁盘版本…':recovery.kind==='matched'?'磁盘版本与原稿一致，恢复的修改尚未写入文件。':recovery.kind==='changed'?'磁盘已改变。请比较原稿、草稿和当前磁盘；保留草稿或明确重新读取。':recovery.kind==='missing'?'源文件已不存在。恢复副本仍保留，可复制草稿；不会自动重建文件。':'当前工作区或文件不可用。恢复副本仍保留，可复制草稿。'}</p>
      {recovery?.kind==='changed'&&<div className="file-draft-comparison"><details><summary>原稿</summary><pre>{draft?.originalContent}</pre></details><details><summary>恢复草稿</summary><pre>{draft?.content}</pre></details><details><summary>当前磁盘</summary><pre>{recovery.disk.content}</pre></details></div>}
      {recovery&&(recovery.kind==='missing'||recovery.kind==='unavailable')&&<small>{recovery.error}</small>}
      {recovery?.kind==='missing'&&draft&&!draft.exists&&<button type="button" disabled={working||loading||!editable||Boolean(protectedDraft?.pendingMutation)} onClick={()=>setConfirm('create')}>创建此草稿文件</button>}
      <button type="button" disabled={working||loading} onClick={()=>void services.documents.inspectRecovery(workspaceId,path)}>重新核对磁盘</button>
    </div>}
    {protection.error&&<p role="alert">草稿尚未受到持久保护：{protection.error}。请保留当前窗口中的内容。</p>}
    {protectedDraft&&<small>{services.documents.protectedRevision(protectedDraft.draftId)===protectedDraft.revision?'当前修订已保护':dirty?'当前修订尚未确认保护':'磁盘内容未修改'}{protection.protectedAt?` · 最近保护 ${new Date(protection.protectedAt).toLocaleTimeString()}`:''}</small>}
    {protectedDraft?.pendingMutation&&<p role="alert">原文件操作尚未核对；草稿和原命令身份仍已保留。<button type="button" disabled={working||loading} onClick={()=>{
      setBusy(true);void services.documents.reconcileMutation(workspaceId,path).then(result=>{
        if(!mounted.current||current.current!==owner)return;
        if(result.kind==='workspace.document.moved')onMoved(result.destination);
        else if(result.kind==='workspace.document.deleted')onClose();
        setNotice('原操作已确认。');onChanged();
      }).catch(error=>{if(mounted.current&&current.current===owner)setError(message(error));}).finally(()=>{if(mounted.current)setBusy(false);});
    }}>核对原操作</button></p>}
    {draft&&!draft.writable&&<p>此工作区为只读。</p>}
    {newline==='mixed'&&<p>此文件混用换行格式，当前以只读方式打开，以保留原始换行。</p>}
    {draft&&<textarea aria-label="文件正文" spellCheck={false} maxLength={WORKSPACE_DOCUMENT_MAX_BYTES} value={draft.content.replace(/\r\n/gu,'\n')}
      readOnly={!editable||loading||(working&&protectedDraft?.pendingMutation?.command.kind!=='workspace.document.save')} onChange={event=>{
        if(!editable||loading||((pending.current||services.documents.isPending(workspaceId,path))&&services.documents.draft(workspaceId,path)?.pendingMutation?.command.kind!=='workspace.document.save'))return;
        const content=newline==='crlf'?event.target.value.replace(/\n/gu,'\r\n'):event.target.value;
        try{apply({...draft,content});}catch(error){setError(message(error));}
      }} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(editable&&!working&&!loading&&!recoveryBlocked&&!protectedDraft?.pendingMutation&&(dirty||!draft.exists))void perform('save');}}}/>}
    <small>仅支持最多 256 KiB 的 UTF-8 文本。按原磁盘版本保存；只有确认保护的修订可在重启后恢复，恢复草稿不会自动写入文件。</small>
    <ConfirmDialog open={confirm!==null} title={confirm==='delete'?'删除文件':confirm==='reload'?'重新读取文件':confirm==='create'?'创建恢复文件':'关闭未保存文件'}
      description={confirm==='delete'?'将永久删除磁盘文件，并丢弃此文件未保存的修改。':confirm==='reload'?'重新读取将丢弃当前未保存修改；读取失败时仍保留草稿。':confirm==='create'?'在当前工作区创建这个尚未保存的新文件。如果路径已经存在，将拒绝创建并保留草稿。':'关闭后会丢弃此文件未保存的修改。'}
      confirmLabel={confirm==='delete'?'确认删除':confirm==='reload'?'确认重新读取':confirm==='create'?'确认创建':'丢弃并关闭'} danger={confirm==='delete'} onConfirm={acceptConfirm} onClose={()=>setConfirm(null)}/>
    <TextPromptDialog open={rename} title="重命名或移动文件" description="输入工作区内的目标路径。目标文件已经存在时不会覆盖。未保存修改会随文件保留在编辑器中。"
      fieldLabel="文件路径" maxLength={1024} initialValue={path} confirmLabel="确认移动" onClose={()=>setRename(false)} onConfirm={destination=>{
        setRename(false);
        if(!workspaceDocumentPathSchema.safeParse(destination).success||destination===path){setError('请输入不同的有效工作区相对文件路径。');return;}
        void perform('move',destination);
      }}/>
  </section>;
}
function newlineStyle(content:string):'lf'|'crlf'|'mixed' {
  const withoutPairs=content.replace(/\r\n/gu,'');
  if(withoutPairs.includes('\r')||(content.includes('\r\n')&&withoutPairs.includes('\n')))return 'mixed';
  return content.includes('\r\n')?'crlf':'lf';
}
function message(error:unknown):string{
  if(error instanceof Error&&error.message.includes('file_draft_'))return fileDraftProtectionMessage(error);
  return error instanceof Error?error.message:'文件操作未完成。';
}
