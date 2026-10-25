import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { SqliteLongMemoryStore } from '../src/adapters/persistence/SqliteLongMemoryStore.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots:string[]=[],stores:SqliteLongMemoryStore[]=[];
const clock=new Date('2026-10-06T00:00:00Z'),scope={workspaceId:'workspace-a',sessionId:'session-a'};
function fixture(){
  const root=mkdtempSync(path.join(tmpdir(),'ariadne-memory-index-source-'));roots.push(root);
  const store=new SqliteLongMemoryStore(root);stores.push(store);return {root,store};
}
const put=(memoryId:string,expectedVersion:number|null=null)=>({kind:'memory.put',contractVersion:'5.0',...scope,
  memoryId,expectedVersion,scope:'workspace',memoryType:'fact',title:'fixture',content:'PRIVATE_BODY_NOT_INDEX_METADATA',
  importance:0.8,confidence:1,sensitivity:'workspace',retentionUntil:null} as const);
afterEach(async()=>{for(const store of stores.splice(0)){const context=createShutdownContext(Date.now()+5000);store.prepareShutdown(context);await store.close(context);context.dispose();}
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});
describe('released memory authority as recoverable index change source',()=>{
  it('uses committed original receipts once, returns bounded metadata without bodies and fences obsolete versions',async()=>{
    const {store}=fixture();const command=put('memory-a');
    await store.execute('original-create',command,clock);await store.execute('original-create',command,clock);
    await store.execute('another-create',put('memory-b'),clock);
    const first=await store.indexChanges({sequence:0,commandId:null},1);
    expect(first.changes).toEqual([{sequence:1,commandId:'original-create',memoryId:'memory-a',version:1}]);
    expect(first.head).toEqual({sequence:2,commandId:'another-create'});
    const second=await store.indexChanges({sequence:1,commandId:'original-create'},1);
    expect(second.changes).toEqual([{sequence:2,commandId:'another-create',memoryId:'memory-b',version:1}]);
    const metadata=await store.indexMetadataPage(null,1);
    expect(metadata).toHaveLength(1);expect(metadata[0]).toMatchObject({memoryId:'memory-a',version:1,importance:0.8});
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE_BODY');expect(JSON.stringify(metadata)).not.toContain('content');
    expect((await store.indexMetadataPage('memory-a',1))[0]?.memoryId).toBe('memory-b');
    await store.execute('new-version',put('memory-a',1),clock);expect(await store.indexSource('memory-a',1,clock)).toBeNull();
    const obsoletePublication=vi.fn(()=>true);
    expect(await store.publishIndexIfCurrent('memory-a',1,clock,obsoletePublication)).toBe(false);expect(obsoletePublication).not.toHaveBeenCalled();
    expect(await store.publishIndexIfCurrent('memory-a',2,clock,()=>true)).toBe(true);
    expect((await store.indexSource('memory-a',2,clock))?.content).toBe(command.content);
    await store.execute('deactivate',{kind:'memory.transition',contractVersion:'5.0',...scope,memoryId:'memory-a',expectedVersion:2,action:'deactivate'},clock);
    expect(await store.indexSource('memory-a',3,clock)).toBeNull();
    const inactivePublication=vi.fn(()=>true);
    expect(await store.publishIndexIfCurrent('memory-a',3,clock,inactivePublication)).toBe(false);expect(inactivePublication).not.toHaveBeenCalled();
    await store.execute('delete',{kind:'memory.delete',contractVersion:'5.0',...scope,memoryId:'memory-b',expectedVersion:1},clock);
    expect((await store.indexMetadataPage(null)).find(row=>row.memoryId==='memory-b')).toMatchObject({status:'deleted',memoryType:null,importance:null});
    expect(await store.indexSource('memory-b',2,clock)).toBeNull();
  });
  it('a moved receipt position forces metadata reconstruction without repeating the original mutation or changing Schema 1',async()=>{
    const {store,root}=fixture();await store.execute('original-create',put('memory-a'),clock);
    const context=createShutdownContext(Date.now()+5000);store.prepareShutdown(context);await store.close(context);context.dispose();stores.splice(stores.indexOf(store),1);
    const database=new DatabaseSync(path.join(root,'data/long-memory/long-memory.db'));
    try{database.exec("UPDATE long_memory_commands SET rowid=99 WHERE command_id='original-create';");}finally{database.close();}
    const reopened=new SqliteLongMemoryStore(root);stores.push(reopened);
    expect(await reopened.indexChanges({sequence:1,commandId:'original-create'})).toMatchObject({resetRequired:true,changes:[],head:{sequence:99,commandId:'original-create'}});
    expect((await reopened.get('memory-a',scope,clock))?.version).toBe(1);await expect(reopened.indexMetadataPage(null)).resolves.toHaveLength(1);
    expect((await reopened.execute('original-create',put('memory-a'),clock)).version).toBe(1);
  });
});
