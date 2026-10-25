import { describe,expect,it,vi } from 'vitest';
import { runtimeCommandSchema,type RuntimeCommand,type RuntimeResult } from '@ariadne/protocol/public';
import { WorkspaceDocumentFeatureStore } from '../src/renderer/src/core/runtime/features/workspace-document-feature-store';
import { memoryFileDraftApi } from './support/file-draft-api';
const version=`workspace-file-v1:${'a'.repeat(64)}`;
async function protect(store:WorkspaceDocumentFeatureStore){store.configureProtection(memoryFileDraftApi());await store.initialize();return store;}
describe('workspace document feature boundary',()=>{
  it('sends exact owner, path and freshness for every operation',async()=>{
    const commands:RuntimeCommand[]=[];
    const store=new WorkspaceDocumentFeatureStore({execute:async command=>{
      const parsed=runtimeCommandSchema.parse(command);commands.push(parsed);
      if(!('path' in parsed)||!('workspaceId' in parsed))throw new Error('fixture');
      const metadata={workspaceId:parsed.workspaceId,path:parsed.path,byteLength:3};
      switch(parsed.kind){
        case 'workspace.document.read':return {...metadata,kind:'workspace.document.read_result',content:'abc',version,writable:true};
        case 'workspace.document.save':return {...metadata,kind:'workspace.document.saved',operation:'replaced',version};
        case 'workspace.document.move':return {...metadata,kind:'workspace.document.moved',destination:parsed.destination,version};
        case 'workspace.document.delete':return {...metadata,kind:'workspace.document.deleted'};
        default:throw new Error('fixture');
      }
    }});
    await protect(store);const read=await store.read('workspace-a','notes.txt');
    store.rememberDraft('workspace-a','notes.txt',{content:read.content,originalContent:read.content,version:read.version,writable:read.writable,exists:true});
    await store.save('workspace-a','notes.txt',version,'abc');
    await store.move('workspace-a','notes.txt',version,'folder/new.txt');await store.delete('workspace-a','folder/new.txt',version);
    expect(commands).toHaveLength(4);expect(commands[1]).toMatchObject({expectedVersion:version,content:'abc'});
  });
  it('rejects foreign owners, paths and move destinations',async()=>{
    for(const result of [
      {kind:'workspace.document.read_result',workspaceId:'other',path:'notes.txt',byteLength:0,content:'',version,writable:true},
      {kind:'workspace.document.read_result',workspaceId:'workspace-a',path:'other.txt',byteLength:0,content:'',version,writable:true}
    ] as RuntimeResult[])await expect(new WorkspaceDocumentFeatureStore({execute:async()=>result}).read('workspace-a','notes.txt')).rejects.toThrow('identity_invalid');
    const store=await protect(new WorkspaceDocumentFeatureStore({execute:async()=>({kind:'workspace.document.moved',workspaceId:'workspace-a',path:'notes.txt',destination:'wrong.txt',byteLength:0,version})}));
    store.rememberDraft('workspace-a','notes.txt',{content:'abc',originalContent:'abc',version,writable:true,exists:true});
    await expect(store.move('workspace-a','notes.txt',version,'new.txt')).rejects.toThrow('identity_invalid');
  });
  it('keeps drafts isolated by workspace and never evicts dirty buffers at the bound',async()=>{
    const execute=vi.fn(async():Promise<RuntimeResult>=>{throw new Error('No command expected');});const store=new WorkspaceDocumentFeatureStore({execute});
    await protect(store);
    for(let index=0;index<32;index++)store.rememberDraft('workspace-a',`${index}.txt`,{content:'dirty',originalContent:'old',version,writable:true,exists:true});
    expect(store.draft('workspace-b','0.txt')).toBeUndefined();
    expect(()=>store.rememberDraft('workspace-b','extra.txt',{content:'new',originalContent:'',version:null,writable:true,exists:false})).toThrow('32');
    expect(store.draft('workspace-a','0.txt')?.content).toBe('dirty');await store.discardDraft('workspace-a','0.txt');
    store.rememberDraft('workspace-b','extra.txt',{content:'new',originalContent:'',version:null,writable:true,exists:false});expect(execute).not.toHaveBeenCalled();
  });
  it('joins owner pending state, preserves newer drafts and fences a read started before a save',async()=>{
    const requests:Array<{command:RuntimeCommand;resolve(result:RuntimeResult):void}>=[];
    const store=new WorkspaceDocumentFeatureStore({execute:command=>new Promise(resolve=>requests.push({command,resolve}))});
    await protect(store);
    store.rememberDraft('workspace-a','notes.txt',{content:'one',originalContent:'old',version,writable:true,exists:true});
    const read=store.read('workspace-a','notes.txt');const rejected=expect(read).rejects.toThrow('状态已变化');
    const save=store.save('workspace-a','notes.txt',version,'one');expect(store.isPending('workspace-a','notes.txt')).toBe(true);
    await expect(store.save('workspace-a','notes.txt',version,'duplicate')).rejects.toThrow('进行中');
    await expect(store.read('workspace-a','notes.txt')).rejects.toThrow('尚未结束');await vi.waitFor(()=>expect(requests).toHaveLength(2));
    store.rememberDraft('workspace-a','notes.txt',{content:'newer draft',originalContent:'old',version,writable:true,exists:true});
    const fresh=`workspace-file-v1:${'b'.repeat(64)}`;
    requests[1]!.resolve({kind:'workspace.document.saved',workspaceId:'workspace-a',path:'notes.txt',byteLength:3,operation:'replaced',version:fresh});await save;
    expect(store.draft('workspace-a','notes.txt')).toMatchObject({content:'newer draft',originalContent:'one',version:fresh});
    expect(store.isPending('workspace-a','notes.txt')).toBe(false);
    requests[0]!.resolve({kind:'workspace.document.read_result',workspaceId:'workspace-a',path:'notes.txt',byteLength:3,content:'old',version,writable:true});await rejected;
    expect(store.draft('workspace-a','notes.txt')?.content).toBe('newer draft');
  });
  it('transfers one of 32 dirty drafts atomically without losing it or overwriting a dirty destination',async()=>{
    const gateway={execute:vi.fn(async():Promise<RuntimeResult>=>({kind:'workspace.document.moved',workspaceId:'workspace-a',path:'0.txt',destination:'moved.txt',byteLength:3,version}))};
    const store=new WorkspaceDocumentFeatureStore(gateway);
    await protect(store);
    for(let index=0;index<32;index++)store.rememberDraft('workspace-a',`${index}.txt`,{content:'dirty',originalContent:'old',version,writable:true,exists:true});
    await expect(store.move('workspace-a','0.txt',version,'1.txt')).rejects.toThrow('目标路径');expect(gateway.execute).not.toHaveBeenCalled();
    const states:number[]=[];const unsubscribe=store.subscribe(()=>states.push(Number(Boolean(store.draft('workspace-a','0.txt')))+Number(Boolean(store.draft('workspace-a','moved.txt')))));
    await store.move('workspace-a','0.txt',version,'moved.txt');unsubscribe();
    expect(states.every(count=>count===1)).toBe(true);expect(store.draft('workspace-a','moved.txt')?.content).toBe('dirty');
  });
});
