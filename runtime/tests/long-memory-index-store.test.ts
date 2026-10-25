import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach,describe,expect,it } from 'vitest';
import { SqliteLongMemoryIndexStore,MEMORY_INDEX_RELATIVE_PATH } from '../src/adapters/persistence/SqliteLongMemoryIndexStore.js';
import type { MemoryIndexMetadata } from '../src/adapters/persistence/LongMemoryIndexRecords.js';
import { readOwnedAuthorityFault } from '../src/adapters/persistence/SqliteAuthorityHealth.js';

const roots:string[]=[],owners:SqliteLongMemoryIndexStore[]=[];
const space='sha256:'+'a'.repeat(64),otherSpace='sha256:'+'b'.repeat(64),domainNow=Date.parse('2026-10-06T00:00:00Z');
function fixture(){
  const root=mkdtempSync(path.join(tmpdir(),'ariadne-memory-index-store-'));roots.push(root);
  const store=new SqliteLongMemoryIndexStore(root);owners.push(store);return {root,store};
}
const metadata=(id='memory-a'):MemoryIndexMetadata=>({memoryId:id,version:1,scope:'workspace',scopeId:'workspace-a',
  workspaceId:'workspace-a',sessionId:'session-a',status:'active',reviewedAt:new Date(domainNow).toISOString(),
  updatedAt:new Date(domainNow).toISOString(),retentionUntil:null,memoryType:'fact',importance:0.8,confidence:1});
afterEach(()=>{for(const owner of owners.splice(0))owner.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('independent durable memory indexing queue',()=>{
  it('enforces the coordinate budget with actual stored 65536-dimensional vectors',()=>{
    const {store}=fixture(),state=store.beginBootstrap(space,65536,{sequence:3,commandId:'original-three'},1000);
    store.applyMetadataPage([metadata('a'),metadata('b'),metadata('c')],state.scanTag,'c',domainNow,1000);store.finishBootstrap(state.scanTag);
    const vector=Array.from({length:65536},(_,index)=>index===0?1:0);
    let job;while((job=store.claimJob(1000)))expect(store.publishVector(job,vector,domainNow,1000)).toBe(true);
    const result=store.vectorCandidates(space,{workspaceId:'workspace-a',sessionId:'session-a'},vector,128,domainNow);
    expect(result.candidates).toHaveLength(2);expect(result.complete).toBe(false);
    expect(result.candidates.reduce((total,candidate)=>total+candidate.vector.length,0)).toBe(131072);
  });
  it('publishes only the leased current version, bounds a collision group and filters owner, status, expiry and model space',()=>{
    const {store}=fixture(),state=store.beginBootstrap(space,2,{sequence:6,commandId:'original-six'},1000);
    const records=[metadata('memory-a'),{...metadata('memory-b'),importance:0.9},metadata('memory-c'),
      {...metadata('foreign'),scopeId:'workspace-b',workspaceId:'workspace-b'},
      {...metadata('wrong-session'),scope:'session' as const,scopeId:'session-a',workspaceId:'workspace-b'},
      {...metadata('inactive'),status:'inactive' as const}];
    store.applyMetadataPage(records,state.scanTag,'wrong-session',domainNow,1000);store.finishBootstrap(state.scanTag);
    let job;while((job=store.claimJob(1000)))expect(store.publishVector(job,[1,0],domainNow,1000)).toBe(true);
    const scope={workspaceId:'workspace-a',sessionId:'session-a'};
    const bounded=store.vectorCandidates(space,scope,[1,0],2,domainNow);
    expect(bounded.candidates).toHaveLength(2);expect(bounded.complete).toBe(false);
    expect(bounded.candidates[0]?.memoryId).toBe('memory-b');
    expect(store.vectorCandidates(space,scope,[1,0],20,domainNow).candidates.map(row=>row.memoryId)).toEqual(['memory-b','memory-a','memory-c']);
    expect(store.vectorCandidates(otherSpace,scope,[1,0],20,domainNow)).toEqual({candidates:[],complete:false});
    expect(store.instructionCandidates(scope,domainNow,2).map(row=>row.memoryId)).toEqual(['memory-b','memory-a']);
    store.applyChanges([{...metadata('memory-b'),version:2,status:'inactive'}],{sequence:7,commandId:'original-seven'},domainNow,1000);
    expect(store.vectorCandidates(space,scope,[1,0],20,domainNow).candidates.map(row=>row.memoryId)).toEqual(['memory-a','memory-c']);
  });
  it('rejects an old computed vector after a metadata update and attributes cache corruption to the derived owner',()=>{
    const {store,root}=fixture(),state=store.beginBootstrap(space,2,{sequence:1,commandId:'original'},1000);
    store.applyMetadataPage([metadata()],state.scanTag,'memory-a',domainNow,1000);store.finishBootstrap(state.scanTag);
    const old=store.claimJob(1000)!;
    store.applyChanges([{...metadata(),version:2}],{sequence:2,commandId:'updated'},domainNow,1000);
    expect(store.publishVector(old,[1,0],domainNow,1000)).toBe(false);
    expect(store.publishVector(store.claimJob(1000)!,[1,0],domainNow,1000)).toBe(true);
    const database=new DatabaseSync(path.join(root,MEMORY_INDEX_RELATIVE_PATH));
    try{database.prepare("UPDATE memory_index_vectors SET vector_json='[null,null]' WHERE memory_id='memory-a'").run();}finally{database.close();}
    let failure;try{store.vectorCandidates(space,{workspaceId:'workspace-a',sessionId:'session-a'},[1,0],20,domainNow);}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(Error);expect(readOwnedAuthorityFault(failure)).toBeNull();
    expect((failure as Error).message).toBe('long_memory_index_unavailable');
  });
  it('coalesces source versions with its cursor, excludes inactive/expired records and retires old-space work',()=>{
    const {store}=fixture();expect(store.available).toBe(true);
    const state=store.beginBootstrap(space,2,{sequence:2,commandId:'original-two'},1000);
    store.applyMetadataPage([metadata(),{...metadata('inactive'),status:'inactive'},
      {...metadata('expired'),retentionUntil:new Date(domainNow-1).toISOString()}],state.scanTag,'memory-a',domainNow,1000);
    expect(store.claimJob(1000)).toBeNull();store.finishBootstrap(state.scanTag);
    expect(store.state()?.cursor).toEqual({sequence:2,commandId:'original-two'});
    const old=store.claimJob(1000)!;expect(old).toMatchObject({memoryId:'memory-a',version:1,spaceId:space});
    store.applyChanges([{...metadata(),version:2}],{sequence:3,commandId:'original-three'},domainNow,1000);
    store.dropJob(old);expect(store.claimJob(1000)).toMatchObject({memoryId:'memory-a',version:2});
    store.applyChanges([{...metadata(),version:3,status:'inactive'}],{sequence:4,commandId:'original-four'},domainNow,1000);
    expect(store.claimJob(1000)).toBeNull();
    const changed=store.beginBootstrap(otherSpace,2,{sequence:4,commandId:'original-four'},1000);
    store.applyMetadataPage([metadata('new-space-memory')],changed.scanTag,'new-space-memory',domainNow,1000);
    store.finishBootstrap(changed.scanTag);expect(store.claimJob(1000)?.spaceId).toBe(otherSpace);
  });
  it('persists backoff across reopen/rescan and recovers a lease abandoned by a prior owner',()=>{
    const {store,root}=fixture();let state=store.beginBootstrap(space,2,{sequence:1,commandId:'original'},1000);
    store.applyMetadataPage([metadata()],state.scanTag,'memory-a',domainNow,1000);store.finishBootstrap(state.scanTag);
    store.retryJob(store.claimJob(1000)!,1000);store.close();
    const reopened=new SqliteLongMemoryIndexStore(root);owners.push(reopened);
    state=reopened.beginBootstrap(space,2,{sequence:1,commandId:'original'},1100);
    reopened.applyMetadataPage([metadata()],state.scanTag,'memory-a',domainNow,1100);reopened.finishBootstrap(state.scanTag);
    expect(reopened.claimJob(1999)).toBeNull();const leased=reopened.claimJob(2000)!;expect(leased.attempts).toBe(1);reopened.close();
    const afterCrash=new SqliteLongMemoryIndexStore(root);owners.push(afterCrash);
    state=afterCrash.beginBootstrap(space,2,{sequence:1,commandId:'original'},2100);
    afterCrash.applyMetadataPage([metadata()],state.scanTag,'memory-a',domainNow,2100);afterCrash.finishBootstrap(state.scanTag);
    expect(afterCrash.claimJob(3099)).toBeNull();expect(afterCrash.claimJob(3100)).toMatchObject({memoryId:'memory-a',attempts:1});
  });
  it('fences another index owner and preserves future-format data while optional index opening fails',()=>{
    const {store,root}=fixture();const second=new SqliteLongMemoryIndexStore(root);owners.push(second);expect(second.available).toBe(false);
    store.close();const file=path.join(root,MEMORY_INDEX_RELATIVE_PATH),database=new DatabaseSync(file);
    try{database.exec('PRAGMA user_version=2; PRAGMA wal_checkpoint(TRUNCATE);');}finally{database.close();}
    const before=readFileSync(file),future=new SqliteLongMemoryIndexStore(root);owners.push(future);
    expect(future.available).toBe(false);expect(readFileSync(file)).toEqual(before);
    expect(()=>future.state()).toThrow('long_memory_index_unavailable');
  });
});
