import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {SqliteLongMemoryStore} from '../../src/adapters/persistence/SqliteLongMemoryStore.js';
import {MEMORY_INDEX_RELATIVE_PATH} from '../../src/adapters/persistence/SqliteLongMemoryIndexStore.js';
import {LocalGgufEmbeddingProvider} from '../../src/adapters/embedding/LocalMemoryEmbedding.js';
import {ProductionLongMemoryService} from '../../src/composition/ProductionLongMemoryService.js';
import {createShutdownContext} from '../../src/ingress/ShutdownContext.js';

const phase=process.argv[2],root=path.resolve(process.argv[3]??''),relative=path.relative(tmpdir(),root);
if(!['prepare','verify'].includes(phase??'')||relative.startsWith('..')||path.isAbsolute(relative)||!relative.startsWith('ariadne-index-kill-'))throw new Error('index_kill_fixture_scope_invalid');
const scope={workspaceId:'workspace',sessionId:'session'},now=new Date('2026-10-06T00:00:00Z');
const store=new SqliteLongMemoryStore(root);
if(phase==='prepare')for(let index=0;index<3;index++)await store.execute('original-'+index,{kind:'memory.put',contractVersion:'5.0',...scope,
  memoryId:'memory-'+index,expectedVersion:null,scope:'workspace',memoryType:'fact',title:'Fixture '+index,content:'Owned source SQLite '+index,
  importance:0.8,confidence:1,sensitivity:'workspace',retentionUntil:null},now);
const modelPath=path.join(root,'fixture.gguf'),bytes=Buffer.from('crash adapter fixture, not real model');writeFileSync(modelPath,bytes);
const policy={provider:'local-gguf',modelId:'crash-fixture',modelPath,sha256:createHash('sha256').update(bytes).digest('hex'),dimension:2,gpuLayers:0} as const;
let computations=0;
const keepalive=setInterval(()=>{},1000);
const embedding=new LocalGgufEmbeddingProvider({...policy,runtimeFactory:async()=>({dimension:2,async embed(){
  computations++;
  if(phase==='prepare'){
    const db=new DatabaseSync(path.join(root,MEMORY_INDEX_RELATIVE_PATH),{readOnly:true});
    let leased=0;try{leased=Number(db.prepare('SELECT count(*) AS n FROM memory_index_jobs WHERE leased=1').get()?.n);}finally{db.close();}
    if(leased!==1)throw new Error('index_kill_expected_one_durable_lease');
    process.send?.({kind:'leased',leased,computations});return new Promise<number[]>(()=>{});
  }
  return [1,0];
},async dispose(){}})});
const service=new ProductionLongMemoryService(store,embedding,policy,()=>now);
if(phase==='verify'){
  try{
    const deadline=Date.now()+10000;
    let ready=false;
    while(Date.now()<deadline){
      const db=new DatabaseSync(path.join(root,MEMORY_INDEX_RELATIVE_PATH),{readOnly:true});
      try{ready=Number(db.prepare('SELECT count(*) AS n FROM memory_index_vectors').get()?.n)===3;}finally{db.close();}
      if(ready)break;await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(!ready||computations!==3)throw new Error('index_kill_recovery_vectors_invalid');
    const db=new DatabaseSync(path.join(root,'data/long-memory/long-memory.db'),{readOnly:true});
    try{
      const receipts=Number(db.prepare('SELECT count(*) AS n FROM long_memory_commands').get()?.n);
      const versions=db.prepare('SELECT memory_id,version FROM long_memories ORDER BY memory_id').all();
      if(receipts!==3||versions.length!==3||versions.some(row=>row.version!==1))throw new Error('index_kill_original_commands_replayed');
      process.send?.({kind:'verified',passed:true,receipts,versions,computations});
    }finally{db.close();}
  }finally{
    clearInterval(keepalive);const shutdown=createShutdownContext(Date.now()+5000);
    try{await service.close(shutdown);}finally{shutdown.dispose();process.disconnect?.();}
  }
}
