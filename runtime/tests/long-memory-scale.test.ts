import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {describe,it,expect,vi} from 'vitest';
import {SqliteLongMemoryStore} from '../src/adapters/persistence/SqliteLongMemoryStore.js';
import {MEMORY_INDEX_RELATIVE_PATH} from '../src/adapters/persistence/SqliteLongMemoryIndexStore.js';
import {LocalGgufEmbeddingProvider} from '../src/adapters/embedding/LocalMemoryEmbedding.js';
import {ProductionLongMemoryService} from '../src/composition/ProductionLongMemoryService.js';
import {createShutdownContext} from '../src/ingress/ShutdownContext.js';

const scope={workspaceId:'scale-workspace',sessionId:'scale-session'};
const now=new Date('2026-10-06T00:00:00Z');
const signal=()=>new AbortController().signal;
const measurements:unknown[]=[];
describe('bounded memory search scale using deterministic vectors, not neural quality',()=>{
  for(const count of [0,100,1000,10000])it('measures '+count+' actual persisted memories and adversarial bucket collisions',async()=>{
    const root=mkdtempSync(path.join(tmpdir(),'ariadne-memory-scale-'));
    const store=new SqliteLongMemoryStore(root);let service:ProductionLongMemoryService|null=null;
    try{
      const setupStart=performance.now();
      for(let index=0;index<count;index++)await store.execute('create-'+index,{kind:'memory.put',contractVersion:'5.0',...scope,
        memoryId:'memory-'+String(index).padStart(5,'0'),expectedVersion:null,scope:'workspace',memoryType:'preference',
        title:'Reviewed benchmark '+index,content:'Shared SQLite instruction '+index,importance:0.8,confidence:1,sensitivity:'workspace',retentionUntil:null},now);
      const setupMs=performance.now()-setupStart;
      const modelPath=path.join(root,'deterministic-fixture.gguf'),bytes=Buffer.from('scale fixture, not real model');writeFileSync(modelPath,bytes);
      const policy={provider:'local-gguf',modelId:'scale-fixture',modelPath,sha256:createHash('sha256').update(bytes).digest('hex'),dimension:2,gpuLayers:0} as const;
      let documentsEmbedded=0,queriesEmbedded=0;
      const embedding=new LocalGgufEmbeddingProvider({...policy,runtimeFactory:async()=>({dimension:2,
        async embed(text:string){if(text.startsWith('Reviewed benchmark'))documentsEmbedded++;else queriesEmbedded++;return [1,0];},async dispose(){}})});
      const bodyReads=vi.spyOn(store,'get'),workerReads=vi.spyOn(store,'indexSource'),lexical=vi.spyOn(store,'lexicalSearch');
      service=new ProductionLongMemoryService(store,embedding,policy,()=>now);
      const coldStart=performance.now(),cold=await service.recall(scope,'SQLite',20,signal()),coldMs=performance.now()-coldStart;
      expect(cold).toMatchObject({complete:false,embedding:{reason:'index_rebuild_required'}});
      expect(documentsEmbedded).toBe(0);expect(workerReads).not.toHaveBeenCalled();expect(bodyReads.mock.calls.length).toBeLessThanOrEqual(80);
      const buildStart=performance.now();
      await expect.poll(()=>{
        const database=new DatabaseSync(path.join(root,MEMORY_INDEX_RELATIVE_PATH),{readOnly:true});
        try{return database.prepare("SELECT (SELECT count(*) FROM memory_index_vectors) AS vectors,(SELECT count(*) FROM memory_index_jobs WHERE kind='index') AS pending,(SELECT scanning FROM memory_index_state WHERE singleton=1) AS scanning").get();}
        finally{database.close();}
      },{timeout:110000,interval:50}).toMatchObject({vectors:count,pending:0,scanning:0});
      const buildMs=performance.now()-buildStart;expect(documentsEmbedded).toBe(count);
      const instructionsStart=performance.now(),instructions=await service.instructionMemories(scope,signal()),instructionsMs=performance.now()-instructionsStart;
      expect(instructions).toHaveLength(Math.min(8,count));expect(instructions.every(memory=>memory.status==='active'&&memory.reviewedAt!==null)).toBe(true);
      bodyReads.mockClear();workerReads.mockClear();lexical.mockClear();const beforeQueries=queriesEmbedded;
      const warmStart=performance.now(),warm=await service.recall(scope,'SQLite',20,signal()),warmMs=performance.now()-warmStart;
      expect(warm.hits).toHaveLength(Math.min(count,20));expect(warm.complete).toBe(count<=128);
      if(count>128)expect(warm.embedding).toMatchObject({degraded:true,reason:null});
      expect(queriesEmbedded-beforeQueries).toBe(1);expect(documentsEmbedded).toBe(count);
      expect(bodyReads.mock.calls.length).toBeLessThanOrEqual(336);expect(workerReads.mock.calls.length).toBeLessThanOrEqual(1);
      expect(warm.hits.every(hit=>hit.memory.scopeId===scope.workspaceId&&hit.memory.version===1)).toBe(true);
      expect(warm.hits.map(hit=>hit.score)).toEqual([...warm.hits.map(hit=>hit.score)].sort((a,b)=>b-a));
      const rows=await lexical.mock.results[0]!.value;
      measurements.push({count,dimension:2,fixture:'all-identical-vectors-worst-bucket-collision',setupMs,coldMs,buildMs,instructionsMs,warmMs,
        coldComplete:cold.complete,warmComplete:warm.complete,lexicalBodies:rows.length,foregroundSourceReads:bodyReads.mock.calls.length,
        backgroundSourceReadsDuringQuery:workerReads.mock.calls.length,documentsEmbedded,queryEmbeddings:queriesEmbedded-beforeQueries,
        candidatesBudget:128,coordinateBudget:131072,scopeVerified:true,sorted:true});
      writeFileSync(path.resolve('../artifacts/todo-remediation/t08-memory-scale-measurements.json'),JSON.stringify({passed:measurements.length===4,
        evidence:'actual SQLite source/index, deterministic adapter vectors; not live neural quality',measurements},null,2)+'\n');
    }finally{
      const shutdown=createShutdownContext(Date.now()+5000);
      try{if(service)await service.close(shutdown);else await store.close(shutdown);}finally{shutdown.dispose();rmSync(root,{recursive:true,force:true});}
    }
  },120000);
});
