import { useState } from 'react';
import { createPortal } from 'react-dom';
import { runtimeCommandSchema,runtimeResultSchema,type RuntimeCommand,type RuntimeResult } from '@ariadne/protocol/public';
import type { ModuleServices } from '../src/renderer/src/core/modules/module-contract';
import { WorkspaceDocumentFeatureStore } from '../src/renderer/src/core/runtime/features/workspace-document-feature-store';
import { WorkspaceDocumentEditor } from '../src/renderer/src/modules/file-explorer/WorkspaceDocumentEditor';
import { memoryFileDraftApi } from './support/file-draft-api';
import { PublicResultError } from '../src/renderer/src/core/runtime/public-result';
const requests:Array<{command:RuntimeCommand;commandId:string|undefined;resolve(result:RuntimeResult):void;reject(error:Error):void}>=[];
const api=memoryFileDraftApi(),copied:string[]=[];
const createOwner=()=>{const owner=new WorkspaceDocumentFeatureStore({execute:(command,commandId)=>new Promise((resolve,reject)=>{requests.push({command:runtimeCommandSchema.parse(command),commandId,resolve,reject});})});owner.configureProtection(api);return owner;};
let documents=createOwner();void documents.initialize();
const services={get documents(){return documents;},clipboard:{writeText:async({text}:{text:string})=>{copied.push(text);}}} as unknown as ModuleServices;
const version=(index:number)=>`workspace-file-v1:${'a'.repeat(63)}${(index%16).toString(16)}`;
export function DocumentsFixture({page}:{page:string}):React.JSX.Element|null {
  const [selection,setSelection]=useState<{workspaceId:string;path:string;create:boolean}|null>({workspaceId:'workspace-a',path:'first.txt',create:false});
  const [generation,setGeneration]=useState(0);
  const [secondView,setSecondView]=useState<Window|null>(null);
  Object.assign(window,{__documentsFixture:{count:()=>requests.length,commands:()=>requests.map(item=>item.command),
    select:(path:string,workspaceId='workspace-a',create=false)=>setSelection({workspaceId,path,create}),
    commandIds:()=>requests.map(item=>item.commandId),
    reject:(index:number)=>{const entry=requests[index]!;entry.reject(new PublicResultError({code:'workspace_file_stale_version',message:'【UI 夹具】文件版本冲突',retryable:false,correlationId:entry.commandId??crypto.randomUUID()}));},
    rejectUnknown:(index:number)=>requests[index]!.reject(new Error('【UI 夹具】响应丢失')),
    rejectMissing:(index:number)=>requests[index]!.reject(new PublicResultError({code:'workspace_file_not_found',message:'【UI 夹具】文件已不存在',retryable:false,correlationId:requests[index]!.commandId??crypto.randomUUID()})),
    restore:async(path:string)=>{await documents.flush();documents.dispose();documents=createOwner();await documents.initialize();setSelection({workspaceId:'workspace-a',path,create:false});setGeneration(value=>value+1);},
    copied:()=>copied,
    get secondView(){return secondView;},
    openSecondView:()=>{
      const child=window.open('/popout.html','file-draft-second-view');if(!child)throw new Error('fixture_second_view_blocked');
      child.addEventListener('load',()=>{const css=child.document.createElement('link');css.rel='stylesheet';css.href=document.querySelector<HTMLLinkElement>('link[rel=stylesheet]')!.href;child.document.head.append(css);setSecondView(child);},{once:true});
    },
    closeSecondView:()=>{setSecondView(null);secondView?.close();},
    resolveRead:(index:number,content:string,writable=true,observedVersion=version(index))=>{
      const entry=requests[index]!;const command=entry.command;if(command.kind!=='workspace.document.read')throw new Error('fixture_wrong_read');
      entry.resolve(runtimeResultSchema.parse({kind:'workspace.document.read_result',workspaceId:command.workspaceId,path:command.path,content,
        byteLength:new TextEncoder().encode(content).length,version:observedVersion,writable}));
    },
    resolveMutation:(index:number)=>{
      const entry=requests[index]!;const command=entry.command;if(!('workspaceId' in command)||!('path' in command))throw new Error('fixture_wrong_mutation');
      const metadata={workspaceId:command.workspaceId,path:command.path,byteLength:3};
      switch(command.kind){
        case 'workspace.document.save':entry.resolve(runtimeResultSchema.parse({...metadata,kind:'workspace.document.saved',operation:command.expectedVersion===null?'created':'replaced',version:version(index)}));break;
        case 'workspace.document.move':entry.resolve(runtimeResultSchema.parse({...metadata,kind:'workspace.document.moved',destination:command.destination,version:version(index)}));break;
        case 'workspace.document.delete':entry.resolve(runtimeResultSchema.parse({...metadata,kind:'workspace.document.deleted'}));break;
        default:throw new Error('fixture_wrong_mutation');
      }
    },draft:(workspaceId:string,path:string)=>documents.draft(workspaceId,path)}});
  return page==='documents'?<div className="file-explorer has-document"><header>【UI 夹具】文本文件；没有连接磁盘</header><div className="file-explorer-body">【UI 夹具】文件列表</div>
    {selection&&<WorkspaceDocumentEditor key={generation} {...selection} services={services} onClose={()=>setSelection(null)} onMoved={path=>setSelection(current=>current?{...current,path,create:false}:null)} onChanged={()=>{}}/>}
    {selection&&secondView&&createPortal(<div className="file-explorer has-document"><div className="file-explorer-body">【UI 夹具】同一编辑所有者的另一个窗口</div><WorkspaceDocumentEditor {...selection} services={services} onClose={()=>{setSelection(null);}} onMoved={path=>setSelection(current=>current?{...current,path,create:false}:null)} onChanged={()=>{}}/></div>,secondView.document.body)}
  </div>:null;
}
