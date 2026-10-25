import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {SqliteLongMemoryStore} from '../adapters/persistence/SqliteLongMemoryStore.js';
import {MEMORY_INDEX_RELATIVE_PATH} from '../adapters/persistence/SqliteLongMemoryIndexStore.js';
import {LocalGgufEmbeddingProvider} from '../adapters/embedding/LocalMemoryEmbedding.js';
import {ProductionLongMemoryService} from '../composition/ProductionLongMemoryService.js';
import {createShutdownContext} from '../ingress/ShutdownContext.js';

const modelPath=path.resolve(process.argv[2]??''),output=path.resolve(process.argv[3]??'');
if(!process.argv[2]||!process.argv[3])throw new Error('accept_memory_index_requires_model_and_output');
const expected='d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac';
const digest=createHash('sha256').update(await readFile(modelPath)).digest('hex');
if(digest!==expected)throw new Error('accept_memory_model_digest_mismatch');
const root=mkdtempSync(path.join(tmpdir(),'ariadne-live-memory-index-'));
const scope={workspaceId:'live-memory-fixture',sessionId:'live-session'};
let service:ProductionLongMemoryService|null=null;
const result:{passed:boolean;[key:string]:unknown}={passed:false,evidence:'actual native node-llama-cpp/official pinned Nomic GGUF; isolated synthetic memory source',
  modelSha256:digest,dimension:768,officialSource:'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/blob/18d1044f4866e224159fce8c6fc5c4f3920176e7/nomic-embed-text-v1.5.Q4_K_M.gguf',
  scope:'small English wiring sample with model-required task prefixes; not general or Chinese retrieval quality'};
try{
  const policy={provider:'local-gguf',modelId:'nomic-embed-text-v1.5-Q4_K_M-acceptance',modelPath,sha256:digest,dimension:768,gpuLayers:0} as const;
  const source=new SqliteLongMemoryStore(root);
  service=new ProductionLongMemoryService(source,new LocalGgufEmbeddingProvider(policy),policy);
  for(const [memoryId,title,content] of [
    ['storage','Application storage','Use SQLite database transactions to store project records durably on local disk.'],
    ['music','Musical instruments','A piano has black and white keys and produces music when its strings are struck.'],
    ['garden','Garden planting','Water tomato plants regularly and give them enough sunshine.']
  ])await service.execute('create-'+memoryId,{kind:'memory.put',contractVersion:'5.0',...scope,memoryId:memoryId!,expectedVersion:null,
    scope:'workspace',memoryType:'fact',title:'search_document: '+title,content:content!,importance:0.5,confidence:1,sensitivity:'workspace',retentionUntil:null},new AbortController().signal);
  const buildStart=performance.now(),deadline=Date.now()+90000;
  let indexed=false;
  while(Date.now()<deadline){
    const db=new DatabaseSync(path.join(root,MEMORY_INDEX_RELATIVE_PATH),{readOnly:true});
    try{indexed=Number(db.prepare('SELECT count(*) AS count FROM memory_index_vectors').get()?.count)===3;}finally{db.close();}
    if(indexed)break;await new Promise(resolve=>setTimeout(resolve,100));
  }
  result.buildMs=performance.now()-buildStart;if(!indexed)throw new Error('accept_memory_background_index_timeout');
  const queryStart=performance.now(),recall=await service.recall(scope,'search_query: persist relational data transactionally',3,new AbortController().signal);
  result.queryMs=performance.now()-queryStart;result.complete=recall.complete;result.embedding=recall.embedding;
  result.hits=recall.hits.map(hit=>({memoryId:hit.memory.memoryId,version:hit.memory.version,score:hit.score,reason:hit.reason}));
  if(recall.embedding.degraded||recall.hits[0]?.memory.memoryId!=='storage'||recall.hits[0]?.reason!=='semantic')throw new Error('accept_memory_live_semantic_recall_failed');
  await service.execute('delete-storage',{kind:'memory.delete',contractVersion:'5.0',...scope,memoryId:'storage',expectedVersion:1},new AbortController().signal);
  const deleted=await service.recall(scope,'search_query: persist relational data transactionally',3,new AbortController().signal);
  if(deleted.hits.some(hit=>hit.memory.memoryId==='storage'))throw new Error('accept_memory_deleted_source_returned');
  result.deletedImmediatelyInvisible=true;result.passed=true;
}catch(error){result.failure=error instanceof Error?error.message:'accept_memory_unknown_failure';process.exitCode=1;}
finally{
  if(service){const shutdown=createShutdownContext(Date.now()+10000);try{await service.close(shutdown);}finally{shutdown.dispose();}}
  writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  const relative=path.relative(tmpdir(),root);
  if(relative.startsWith('..')||path.isAbsolute(relative)||!relative.startsWith('ariadne-live-memory-index-'))throw new Error('accept_memory_cleanup_scope_invalid');
  rmSync(root,{recursive:true,force:true});
}
console.log(JSON.stringify({passed:result.passed,failure:result.failure??null}));
