import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeCommand, RuntimeResult } from '@ariadne/protocol/public';
import { WorkspaceDocumentFeatureStore } from '../src/renderer/src/core/runtime/features/workspace-document-feature-store';
import { memoryFileDraftApi } from './support/file-draft-api';
import { PublicResultError } from '../src/renderer/src/core/runtime/public-result';
const version=`workspace-file-v1:${'a'.repeat(64)}`,fresh=`workspace-file-v1:${'b'.repeat(64)}`;
const stores:WorkspaceDocumentFeatureStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.dispose();});
async function fixture(execute:(command:RuntimeCommand,commandId?:string)=>Promise<RuntimeResult>){
  const api=memoryFileDraftApi(),store=new WorkspaceDocumentFeatureStore({execute});stores.push(store);
  store.configureProtection(api);await store.initialize();
  store.rememberDraft('workspace-a','notes.txt',{content:'A',originalContent:'old',version,writable:true,exists:true});
  return {api,store};
}
const saved:RuntimeResult={kind:'workspace.document.saved',workspaceId:'workspace-a',path:'notes.txt',byteLength:1,operation:'replaced',version:fresh};
describe('file draft and original mutation durability',()=>{
  it('shares not-yet-created aliases while keeping observed case-sensitive identities separate',async()=>{
    const f=await fixture(async()=>saved);
    f.api.resolvePath=async({workspaceId,path})=>({workspaceId,path,exists:path.startsWith('Sensitive/'),comparisonPath:path.startsWith('Sensitive/')?path:path.toLowerCase()});
    expect(await f.store.resolvePath('workspace-a','New.txt')).toBe('New.txt');
    f.store.rememberDraft('workspace-a','New.txt',{content:'new',originalContent:'',version:null,writable:true,exists:false});
    expect(await f.store.resolvePath('workspace-a','NEW.TXT')).toBe('New.txt');
    for(const path of ['Sensitive/Notes.txt','Sensitive/notes.txt']){const resolved=await f.store.resolvePath('workspace-a',path);f.store.rememberDraft('workspace-a',resolved,{content:path,originalContent:'old',version,writable:true,exists:true});}
    expect(f.store.draft('workspace-a','Sensitive/Notes.txt')!.draftId).not.toBe(f.store.draft('workspace-a','Sensitive/notes.txt')!.draftId);
  });
  it('protects the captured original command before sending it and retains B on late success',async()=>{
    let release!:(result:RuntimeResult)=>void;
    const f=await fixture(async(command,id)=>{
      const persisted=await f.api.list();
      expect(persisted.records[0]!.pendingMutation).toMatchObject({commandId:id,command,state:'staged'});
      return new Promise(resolve=>{release=resolve;});
    });
    const saving=f.store.save('workspace-a','notes.txt',version,'A');
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    f.store.rememberDraft('workspace-a','notes.txt',{content:'B',originalContent:'incorrect stale callback',version,writable:true,exists:true});
    expect(f.store.draft('workspace-a','notes.txt')!.originalContent).toBe('old');
    release(saved);await saving;
    expect(f.store.draft('workspace-a','notes.txt')).toMatchObject({content:'B',originalContent:'A',version:fresh,pendingMutation:null});
    expect((await f.api.list()).records[0]).toMatchObject({content:'B',originalContent:'A',pendingMutation:null});
  });
  it('keeps an uncertain original envelope through restore and reconciles the same ID without rebuilding from B',async()=>{
    const sent:Array<{command:RuntimeCommand;id:string|undefined}>=[];
    const f=await fixture(async(command,id)=>{sent.push({command,id});throw new Error('lost response fixture');});
    await expect(f.store.save('workspace-a','notes.txt',version,'A')).rejects.toThrow('lost response');
    f.store.rememberDraft('workspace-a','notes.txt',{content:'B',originalContent:'old',version,writable:true,exists:true});await f.store.flush();
    const restored=new WorkspaceDocumentFeatureStore({execute:async(command,id)=>{sent.push({command,id});return saved;}});stores.push(restored);
    restored.configureProtection(f.api);await restored.initialize();
    await expect(restored.save('workspace-a','notes.txt',version,'B')).rejects.toThrow('尚未确认');
    await restored.reconcileMutation('workspace-a','notes.txt');
    expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);
    expect(restored.draft('workspace-a','notes.txt')).toMatchObject({content:'B',originalContent:'A',pendingMutation:null});
  });
  it('definitive correlated rejection preserves the baseline and newer editable content',async()=>{
    const f=await fixture(async(_command,id)=>{throw new PublicResultError({code:'workspace_file_stale_version',message:'disk changed fixture',retryable:false,correlationId:id!});});
    await expect(f.store.save('workspace-a','notes.txt',version,'A')).rejects.toThrow('disk changed');
    expect(f.store.draft('workspace-a','notes.txt')).toMatchObject({content:'A',originalContent:'old',version,pendingMutation:null});
  });
  it('a protection failure before dispatch never sends a workspace mutation',async()=>{
    const execute=vi.fn(async()=>saved),f=await fixture(execute);
    f.api.replace=async()=>{throw new Error('private disk fixture failure');};
    await expect(f.store.save('workspace-a','notes.txt',version,'A')).rejects.toThrow('private disk fixture failure');
    expect(execute).not.toHaveBeenCalled();expect(f.store.draft('workspace-a','notes.txt')!.pendingMutation).not.toBeNull();
  });
  it('save outcome protection failure retains the original envelope and B in memory',async()=>{
    const f=await fixture(async()=>{f.store.rememberDraft('workspace-a','notes.txt',{content:'B',originalContent:'old',version,writable:true,exists:true});return saved;}),replace=f.api.replace;let calls=0;
    f.api.replace=async request=>{if(++calls===2)throw new Error('outcome disk fixture failure');return replace(request);};
    await expect(f.store.save('workspace-a','notes.txt',version,'A')).rejects.toThrow('outcome disk fixture failure');
    expect(f.store.draft('workspace-a','notes.txt')).toMatchObject({content:'B',originalContent:'A',pendingMutation:{command:{content:'A'}}});
    expect((await f.api.list()).records[0]!.pendingMutation).not.toBeNull();
  });
  it('cancelled quit stops the remaining save batch and resumes editing',async()=>{
    const sent:RuntimeCommand[]=[];let release!:(result:RuntimeResult)=>void;
    const f=await fixture(async command=>{sent.push(command);return new Promise(resolve=>{release=resolve;});});
    f.store.rememberDraft('workspace-a','second.txt',{content:'second',originalContent:'old',version,writable:true,exists:true});
    const quitting=f.store.prepareQuit('save');const stopped=expect(quitting).rejects.toThrow('已取消');
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    f.store.resumeAfterCancelledQuit();release(saved);await stopped;
    expect(sent).toHaveLength(1);expect(f.store.draft('workspace-a','second.txt')!.content).toBe('second');
    expect(()=>f.store.rememberDraft('workspace-a','second.txt',{content:'after cancel',originalContent:'old',version,writable:true,exists:true})).not.toThrow();
  });
  it('leases a discarded draft until its private removal is acknowledged',async()=>{
    const f=await fixture(async()=>saved);await f.store.flush();
    const replace=f.api.replace;let release!:()=>void;
    f.api.replace=async request=>{await new Promise<void>(resolve=>{release=resolve;});return replace(request);};
    const discarding=f.store.discardDraft('workspace-a','notes.txt');
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    expect(f.store.draft('workspace-a','notes.txt')!.content).toBe('A');
    expect(()=>f.store.rememberDraft('workspace-a','notes.txt',{content:'B',originalContent:'old',version,writable:true,exists:true})).toThrow('丢弃');
    await expect(f.store.read('workspace-a','notes.txt')).rejects.toThrow('尚未结束');
    release();await discarding;expect(f.store.draft('workspace-a','notes.txt')).toBeUndefined();
    expect((await f.api.list()).records).toEqual([]);
  });
  it.each(['changed','missing','unavailable'] as const)('recovery inspection %s retains all text and performs no mutation',async kind=>{
    const f=await fixture(async()=>saved);await f.store.flush();
    const execute=vi.fn(async(command:RuntimeCommand):Promise<RuntimeResult>=>{
      expect(command.kind).toBe('workspace.document.read');
      if(kind==='changed')return {kind:'workspace.document.read_result',workspaceId:'workspace-a',path:'notes.txt',content:'external',byteLength:8,version:fresh,writable:true};
      throw new PublicResultError({code:kind==='missing'?'workspace_file_not_found':'workspace_not_found',message:'fixture unavailable',retryable:false,correlationId:crypto.randomUUID()});
    });
    const restored=new WorkspaceDocumentFeatureStore({execute});stores.push(restored);restored.configureProtection(f.api);await restored.initialize();
    await restored.inspectRecovery('workspace-a','notes.txt');
    expect(restored.recoveryState('workspace-a','notes.txt')?.kind).toBe(kind);
    expect(restored.draft('workspace-a','notes.txt')).toMatchObject({content:'A',originalContent:'old',version});
    await expect(restored.save('workspace-a','notes.txt',version,'A')).rejects.toThrow('磁盘基线');
    expect(execute.mock.calls.every(([command])=>command.kind==='workspace.document.read')).toBe(true);
    expect((await f.api.list()).records[0]).toMatchObject({content:'A',originalContent:'old',version,pendingMutation:null});
  });
  it('a recovered matching baseline permits only an explicit save and clears the recovery marker after settlement',async()=>{
    const f=await fixture(async()=>saved);await f.store.flush();const sent:RuntimeCommand[]=[];
    const restored=new WorkspaceDocumentFeatureStore({execute:async command=>{
      sent.push(command);return command.kind==='workspace.document.read'?{kind:'workspace.document.read_result',workspaceId:'workspace-a',path:'notes.txt',content:'old',byteLength:3,version,writable:true}:saved;
    }});stores.push(restored);restored.configureProtection(f.api);await restored.initialize();
    expect(sent).toEqual([]);await restored.inspectRecovery('workspace-a','notes.txt');expect(sent.map(c=>c.kind)).toEqual(['workspace.document.read']);
    await restored.save('workspace-a','notes.txt',version,'A');expect(sent.at(-1)?.kind).toBe('workspace.document.save');
    expect(restored.isRecovered('workspace-a','notes.txt')).toBe(false);expect((await f.api.list()).records).toEqual([]);
  });
});
