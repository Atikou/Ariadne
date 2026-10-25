import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeMemoryIndexSchema } from './LongMemoryIndexSchema.js';
import { memoryIndexMetadataSchema,type MemoryIndexMetadata,type MemoryIndexCursor } from './LongMemoryIndexRecords.js';
import { acquireSqliteOwnerLease,closeOwnedSqliteDatabase,type SqliteOwnerLease } from './SqliteOwnerLease.js';
import { memoryVectorBuckets,memoryQueryBuckets,memoryCandidateLimit } from './LongMemoryCandidateBuckets.js';
import { memoryOwnerPredicate,memoryOwnerParameters,type MemoryOwnerScope } from './LongMemoryQueries.js';

export const MEMORY_INDEX_RELATIVE_PATH='data/long-memory/search-index.db';
export class MemoryIndexUnavailable extends Error {
  constructor(cause?:unknown){super('long_memory_index_unavailable',{cause});this.name='MemoryIndexUnavailable';}
}
export interface MemorySearchIndexState {
  readonly spaceId:string;readonly dimension:number;readonly scanTag:string;readonly scanAfter:string|null;
  readonly scanning:boolean;readonly bootstrap:MemoryIndexCursor;readonly cursor:MemoryIndexCursor;
}
export interface MemoryIndexJob {
  readonly memoryId:string;readonly version:number;readonly spaceId:string;readonly kind:'index'|'expire';readonly attempts:number;
}
export interface MemoryVectorCandidate { readonly memoryId:string;readonly version:number;readonly vector:readonly number[]; }

/** Only reconstructible metadata/vectors/jobs. Opening failure is separate from
 * authoritative memory health and preserves unknown existing files. Methods
 * and transactions are synchronous, so this owner never yields with BEGIN open. */
export class SqliteLongMemoryIndexStore {
  private database:DatabaseSync|null=null;
  private lease:SqliteOwnerLease|null=null;
  public get available():boolean{return this.database!==null;}
  constructor(dataRoot:string){
    const file=path.resolve(dataRoot,MEMORY_INDEX_RELATIVE_PATH);
    let database:DatabaseSync|null=null,lease:SqliteOwnerLease|null=null;
    try{
      mkdirSync(path.dirname(file),{recursive:true});
      lease=acquireSqliteOwnerLease(file,'long-memory-search-index');database=new DatabaseSync(file);
      initializeMemoryIndexSchema(database);database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
      this.database=database;this.lease=lease;
    }catch{
      if(database&&lease){try{closeOwnedSqliteDatabase(database,lease);}catch{/* uncertain resource remains fenced by shared closer */}}
      else lease?.close();
    }
  }
  state():MemorySearchIndexState|null{
    return this.read(database=>{
      const row=database.prepare('SELECT * FROM memory_index_state WHERE singleton=1').get();if(!row)return null;
      const result:MemorySearchIndexState={spaceId:String(row.space_id),dimension:Number(row.dimension),scanTag:String(row.scan_tag),
        scanAfter:row.scan_after===null?null:String(row.scan_after),scanning:row.scanning===1,
        bootstrap:{sequence:Number(row.bootstrap_sequence),commandId:row.bootstrap_command_id===null?null:String(row.bootstrap_command_id)},
        cursor:{sequence:Number(row.cursor_sequence),commandId:row.cursor_command_id===null?null:String(row.cursor_command_id)}};
      this.validateSpace(result.spaceId,result.dimension);this.validateCursor(result.bootstrap);this.validateCursor(result.cursor);
      if(!result.scanTag||![0,1].includes(Number(row.scanning)))throw new MemoryIndexUnavailable();
      return result;
    });
  }
  beginBootstrap(spaceId:string,dimension:number,head:MemoryIndexCursor,wallNow=Date.now()):MemorySearchIndexState{
    this.validateSpace(spaceId,dimension);this.validateCursor(head);
    const tag=randomUUID();
    this.transaction(database=>{
      database.prepare('DELETE FROM memory_index_jobs WHERE space_id<>?').run(spaceId);
      database.prepare('UPDATE memory_index_jobs SET leased=0,available_at=MAX(available_at,?) WHERE leased=1').run(wallNow+1000);
      database.prepare('INSERT INTO memory_index_state VALUES (1,?,?,?,NULL,1,?,?,0,NULL) ON CONFLICT(singleton) DO UPDATE SET space_id=excluded.space_id,dimension=excluded.dimension,scan_tag=excluded.scan_tag,scan_after=NULL,scanning=1,bootstrap_sequence=excluded.bootstrap_sequence,bootstrap_command_id=excluded.bootstrap_command_id,cursor_sequence=0,cursor_command_id=NULL')
        .run(spaceId,dimension,tag,head.sequence,head.commandId);
    });
    return this.state()!;
  }
  applyMetadataPage(records:readonly MemoryIndexMetadata[],tag:string,after:string|null,domainNow:number,wallNow=Date.now()):void{
    if(records.length>256)throw new MemoryIndexUnavailable();
    this.transaction(database=>{
      const state=this.state();if(!state||!state.scanning||state.scanTag!==tag)throw new MemoryIndexUnavailable();
      for(const record of records)this.upsertMetadata(database,memoryIndexMetadataSchema.parse(record),state,domainNow,wallNow);
      database.prepare('UPDATE memory_index_state SET scan_after=? WHERE singleton=1 AND scan_tag=?').run(after,tag);
    });
  }
  finishBootstrap(tag:string):void{
    this.transaction(database=>{
      const state=this.state();if(!state||!state.scanning||state.scanTag!==tag)throw new MemoryIndexUnavailable();
      database.prepare('DELETE FROM memory_index_metadata WHERE scan_tag<>?').run(tag);
      database.prepare('UPDATE memory_index_state SET scanning=0,cursor_sequence=bootstrap_sequence,cursor_command_id=bootstrap_command_id WHERE singleton=1').run();
    });
  }
  applyChanges(records:readonly MemoryIndexMetadata[],cursor:MemoryIndexCursor,domainNow:number,wallNow=Date.now()):void{
    if(records.length>256)throw new MemoryIndexUnavailable();this.validateCursor(cursor);
    this.transaction(database=>{
      const state=this.state();if(!state||state.scanning||cursor.sequence<state.cursor.sequence)throw new MemoryIndexUnavailable();
      for(const record of records)this.upsertMetadata(database,memoryIndexMetadataSchema.parse(record),state,domainNow,wallNow);
      database.prepare('UPDATE memory_index_state SET cursor_sequence=?,cursor_command_id=? WHERE singleton=1').run(cursor.sequence,cursor.commandId);
    });
  }
  claimJob(wallNow=Date.now()):MemoryIndexJob|null{
    return this.transaction(database=>{
      const state=this.state();if(!state||state.scanning)return null;
      const row=database.prepare('SELECT * FROM memory_index_jobs WHERE leased=0 AND available_at<=? AND space_id=? ORDER BY available_at,memory_id LIMIT 1').get(wallNow,state.spaceId);
      if(!row)return null;
      const job:MemoryIndexJob={memoryId:String(row.memory_id),version:Number(row.version),spaceId:String(row.space_id),kind:row.kind==='expire'?'expire':'index',attempts:Number(row.attempts)};
      if(!Number.isSafeInteger(job.version)||job.version<1||!Number.isSafeInteger(job.attempts)||job.attempts<0||!['index','expire'].includes(String(row.kind)))throw new MemoryIndexUnavailable();
      database.prepare('UPDATE memory_index_jobs SET leased=1 WHERE memory_id=? AND version=? AND space_id=?').run(job.memoryId,job.version,job.spaceId);
      return job;
    });
  }
  retryJob(job:MemoryIndexJob,wallNow=Date.now()):void{
    this.transaction(database=>database.prepare('UPDATE memory_index_jobs SET leased=0,attempts=attempts+1,available_at=? WHERE memory_id=? AND version=? AND space_id=? AND kind=? AND leased=1')
      .run(wallNow+Math.min(30000,1000*2**Math.min(job.attempts,5)),job.memoryId,job.version,job.spaceId,job.kind));
  }
  releaseJob(job:MemoryIndexJob,delay=100,wallNow=Date.now()):void{
    this.transaction(database=>database.prepare('UPDATE memory_index_jobs SET leased=0,available_at=? WHERE memory_id=? AND version=? AND space_id=? AND kind=? AND leased=1')
      .run(wallNow+delay,job.memoryId,job.version,job.spaceId,job.kind));
  }
  /** Rebuild only this validated, reconstructible schema; unknown formats never reach here. */
  reset():void{
    this.transaction(database=>database.exec('DELETE FROM memory_index_jobs; DELETE FROM memory_index_vectors; DELETE FROM memory_index_metadata; DELETE FROM memory_index_state;'));
  }
  pruneOldSpaces(limit=128):number{
    if(!Number.isSafeInteger(limit)||limit<1||limit>256)throw new MemoryIndexUnavailable();
    return this.transaction(database=>{
      const state=this.state();if(!state||state.scanning)return 0;
      const result=database.prepare('DELETE FROM memory_index_vectors WHERE rowid IN (SELECT rowid FROM memory_index_vectors WHERE space_id<>? LIMIT ?)').run(state.spaceId,limit);
      return Number(result.changes);
    });
  }
  hasFailedIndexJobs(domainNow:number):boolean{
    return this.read(database=>{
      const state=this.state();if(!state)return false;
      return Boolean(database.prepare("SELECT 1 FROM memory_index_jobs j JOIN memory_index_metadata m ON m.memory_id=j.memory_id AND m.version=j.version WHERE j.space_id=? AND j.kind='index' AND j.attempts>0 AND m.status='active' AND m.reviewed_at IS NOT NULL AND (m.expires_at IS NULL OR m.expires_at>?) LIMIT 1")
        .get(state.spaceId,domainNow));
    });
  }
  dropJob(job:MemoryIndexJob):void{
    this.transaction(database=>database.prepare('DELETE FROM memory_index_jobs WHERE memory_id=? AND version=? AND space_id=?').run(job.memoryId,job.version,job.spaceId));
  }
  publishVector(job:MemoryIndexJob,vector:readonly number[],domainNow:number,wallNow=Date.now()):boolean{
    return this.transaction(database=>{
      const state=this.state();if(!state||state.scanning||state.spaceId!==job.spaceId||job.kind!=='index')return false;
      const current=database.prepare("SELECT 1 FROM memory_index_jobs j JOIN memory_index_metadata m ON m.memory_id=j.memory_id WHERE j.memory_id=? AND j.version=? AND j.space_id=? AND j.kind='index' AND j.leased=1 AND m.version=j.version AND m.status='active' AND m.reviewed_at IS NOT NULL AND (m.expires_at IS NULL OR m.expires_at>?)")
        .get(job.memoryId,job.version,job.spaceId,domainNow);
      if(!current)return false;
      if(vector.length!==state.dimension||!vector.every(value=>Number.isFinite(value)&&Math.abs(value)<=1.000001))throw new MemoryIndexUnavailable();
      const buckets=memoryVectorBuckets(vector);
      database.prepare('INSERT INTO memory_index_vectors VALUES (?,?,?,?,?,?) ON CONFLICT(memory_id,version,space_id) DO UPDATE SET dimension=excluded.dimension,vector_json=excluded.vector_json,published_at=excluded.published_at')
        .run(job.memoryId,job.version,job.spaceId,vector.length,JSON.stringify(vector),wallNow);
      database.prepare('DELETE FROM memory_index_buckets WHERE memory_id=? AND version=? AND space_id=?').run(job.memoryId,job.version,job.spaceId);
      const insert=database.prepare('INSERT INTO memory_index_buckets VALUES (?,?,?,?,?)');
      for(const [table,bucket] of buckets.entries())insert.run(job.memoryId,job.version,job.spaceId,table,bucket);
      const expiry=database.prepare('SELECT expires_at FROM memory_index_metadata WHERE memory_id=?').get(job.memoryId)?.expires_at;
      if(expiry===null)database.prepare('DELETE FROM memory_index_jobs WHERE memory_id=? AND version=? AND space_id=?').run(job.memoryId,job.version,job.spaceId);
      else database.prepare("UPDATE memory_index_jobs SET kind='expire',leased=0,attempts=0,available_at=? WHERE memory_id=? AND version=? AND space_id=?")
        .run(wallNow+Math.max(0,Number(expiry)-domainNow),job.memoryId,job.version,job.spaceId);
      return true;
    });
  }
  removeObsoleteJob(job:MemoryIndexJob):void{
    this.transaction(database=>{
      database.prepare('DELETE FROM memory_index_vectors WHERE memory_id=? AND version=? AND space_id=?').run(job.memoryId,job.version,job.spaceId);
      database.prepare('DELETE FROM memory_index_jobs WHERE memory_id=? AND version=? AND space_id=? AND kind=?').run(job.memoryId,job.version,job.spaceId,job.kind);
    });
  }
  vectorCandidates(spaceId:string,scope:MemoryOwnerScope,queryVector:readonly number[],requested:number,domainNow:number):{
    readonly candidates:readonly MemoryVectorCandidate[];readonly complete:boolean;readonly limited?:true
  }{
    return this.read(database=>{
      const state=this.state();if(!state||state.scanning||state.spaceId!==spaceId)return {candidates:[],complete:false};
      if(queryVector.length!==state.dimension)throw new MemoryIndexUnavailable();
      const limit=memoryCandidateLimit(state.dimension,requested),probes=memoryQueryBuckets(queryVector);
      const placeholders=probes.map(()=>'(?,?,?)').join(',');
      // Group/sort only candidate identities and scalar metadata. Vector JSON
      // is loaded after LIMIT, never for an unbounded bucket collision group.
      const rows=database.prepare('WITH wanted(table_id,bucket,distance) AS (VALUES '+placeholders+') '
        +'SELECT b.memory_id,b.version,MIN(w.distance) AS distance FROM wanted w JOIN memory_index_buckets b ON b.table_id=w.table_id AND b.bucket=w.bucket '
        +'JOIN memory_index_metadata m ON m.memory_id=b.memory_id AND m.version=b.version '
        +"WHERE b.space_id=? AND "+memoryOwnerPredicate+" AND m.status='active' AND m.reviewed_at IS NOT NULL AND (m.expires_at IS NULL OR m.expires_at>?) "
        +'GROUP BY b.memory_id,b.version ORDER BY distance,m.importance DESC,m.updated_at DESC,b.memory_id LIMIT ?')
        .all(...probes.flatMap(probe=>[probe.table,probe.bucket,probe.distance]),spaceId,...memoryOwnerParameters(scope),domainNow,limit+1);
      const candidates:MemoryVectorCandidate[]=[],readVector=database.prepare('SELECT dimension,vector_json FROM memory_index_vectors WHERE memory_id=? AND version=? AND space_id=?');
      const readBuckets=database.prepare('SELECT table_id,bucket FROM memory_index_buckets WHERE memory_id=? AND version=? AND space_id=? ORDER BY table_id');
      for(const row of rows.slice(0,limit)){
        const id=String(row.memory_id),version=Number(row.version),stored=readVector.get(id,version,spaceId);
        if(!stored||stored.dimension!==state.dimension||typeof stored.vector_json!=='string')throw new MemoryIndexUnavailable();
        const vector:unknown=JSON.parse(stored.vector_json);
        if(!Array.isArray(vector)||vector.length!==state.dimension||!vector.every(value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1.000001))throw new MemoryIndexUnavailable();
        const buckets=memoryVectorBuckets(vector as number[]),actual=readBuckets.all(id,version,spaceId);
        if(actual.length!==buckets.length||actual.some((bucket,index)=>bucket.table_id!==index||bucket.bucket!==buckets[index]))throw new MemoryIndexUnavailable();
        candidates.push({memoryId:id,version,vector:vector as number[]});
      }
      const pending=database.prepare("SELECT 1 FROM memory_index_jobs j JOIN memory_index_metadata m ON m.memory_id=j.memory_id AND m.version=j.version WHERE j.space_id=? AND j.kind='index' AND "
        +memoryOwnerPredicate+" AND m.status='active' AND m.reviewed_at IS NOT NULL AND (m.expires_at IS NULL OR m.expires_at>?) LIMIT 1")
        .get(spaceId,...memoryOwnerParameters(scope),domainNow);
      return {candidates,complete:rows.length<=limit&&!pending,...(rows.length>limit?{limited:true as const}:{})};
    });
  }
  instructionCandidates(scope:MemoryOwnerScope,domainNow:number,limit=8):readonly {memoryId:string;version:number}[]{
    if(!Number.isSafeInteger(limit)||limit<1||limit>32)throw new MemoryIndexUnavailable();
    return this.read(database=>{
      const state=this.state();if(!state||state.scanning)return [];
      const rows:Array<{memory_id:string;version:number;importance:number;updated_at:string}>=[];
      for(const [ownerScope,ownerId,workspace] of [['global','global',null],['workspace',scope.workspaceId,null],['session',scope.sessionId,scope.workspaceId]] as const){
        const selected=database.prepare("SELECT memory_id,version,importance,updated_at FROM memory_index_metadata WHERE scope=? AND scope_id=? AND (? IS NULL OR workspace_id=?) AND status='active' AND reviewed_at IS NOT NULL AND (expires_at IS NULL OR expires_at>?) AND (importance>=0.7 OR memory_type IN ('preference','habit')) ORDER BY importance DESC,updated_at DESC,memory_id LIMIT ?")
          .all(ownerScope,ownerId,workspace,workspace,domainNow,limit) as unknown as typeof rows;
        rows.push(...selected);
      }
      rows.sort((a,b)=>b.importance-a.importance||b.updated_at.localeCompare(a.updated_at)||a.memory_id.localeCompare(b.memory_id));
      return rows.slice(0,limit).map(row=>({memoryId:row.memory_id,version:row.version}));
    });
  }
  close():void{
    if(!this.database||!this.lease)return;const database=this.database,lease=this.lease;
    this.database=null;this.lease=null;closeOwnedSqliteDatabase(database,lease);
  }
  private upsertMetadata(database:DatabaseSync,row:MemoryIndexMetadata,state:MemorySearchIndexState,domainNow:number,wallNow:number):void{
    const expires=row.retentionUntil===null?null:Date.parse(row.retentionUntil);
    const previous=database.prepare('SELECT version FROM memory_index_metadata WHERE memory_id=?').get(row.memoryId);
    if(previous&&previous.version!==row.version)database.prepare('DELETE FROM memory_index_vectors WHERE memory_id=?').run(row.memoryId);
    database.prepare('INSERT INTO memory_index_metadata VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET version=excluded.version,scope=excluded.scope,scope_id=excluded.scope_id,workspace_id=excluded.workspace_id,session_id=excluded.session_id,status=excluded.status,reviewed_at=excluded.reviewed_at,updated_at=excluded.updated_at,expires_at=excluded.expires_at,memory_type=excluded.memory_type,importance=excluded.importance,confidence=excluded.confidence,scan_tag=excluded.scan_tag')
      .run(row.memoryId,row.version,row.scope,row.scopeId,row.workspaceId,row.sessionId,row.status,row.reviewedAt,row.updatedAt,expires,row.memoryType,row.importance,row.confidence,state.scanTag);
    if(row.status!=='active'||row.reviewedAt===null||(expires!==null&&expires<=domainNow)){
      database.prepare('DELETE FROM memory_index_vectors WHERE memory_id=?').run(row.memoryId);
      database.prepare('DELETE FROM memory_index_jobs WHERE memory_id=?').run(row.memoryId);return;
    }
    const cached=database.prepare('SELECT 1 FROM memory_index_vectors WHERE memory_id=? AND version=? AND space_id=? AND dimension=?').get(row.memoryId,row.version,state.spaceId,state.dimension);
    if(cached&&expires===null){database.prepare('DELETE FROM memory_index_jobs WHERE memory_id=?').run(row.memoryId);return;}
    const kind=cached?'expire':'index',available=cached?wallNow+Math.max(0,expires!-domainNow):wallNow;
    database.prepare('INSERT INTO memory_index_jobs VALUES (?,?,?,?,?,0,0) ON CONFLICT(memory_id) DO UPDATE SET version=excluded.version,space_id=excluded.space_id,kind=excluded.kind,available_at=CASE WHEN memory_index_jobs.version=excluded.version AND memory_index_jobs.space_id=excluded.space_id AND memory_index_jobs.kind=excluded.kind THEN memory_index_jobs.available_at ELSE excluded.available_at END,attempts=CASE WHEN memory_index_jobs.version=excluded.version AND memory_index_jobs.space_id=excluded.space_id AND memory_index_jobs.kind=excluded.kind THEN memory_index_jobs.attempts ELSE 0 END,leased=CASE WHEN memory_index_jobs.version=excluded.version AND memory_index_jobs.space_id=excluded.space_id AND memory_index_jobs.kind=excluded.kind THEN memory_index_jobs.leased ELSE 0 END')
      .run(row.memoryId,row.version,state.spaceId,kind,available);
  }
  private read<T>(execute:(database:DatabaseSync)=>T):T{
    if(!this.database)throw new MemoryIndexUnavailable();
    try{return execute(this.database);}catch(error){if(error instanceof MemoryIndexUnavailable)throw error;throw new MemoryIndexUnavailable(error);}
  }
  private transaction<T>(execute:(database:DatabaseSync)=>T):T{
    return this.read(database=>{
      database.exec('BEGIN IMMEDIATE;');
      try{const result=execute(database);database.exec('COMMIT;');return result;}
      catch(error){if(database.isTransaction)database.exec('ROLLBACK;');throw error;}
    });
  }
  private validateSpace(spaceId:string,dimension:number):void{
    if(!/^sha256:[a-f0-9]{64}$/u.test(spaceId)||!Number.isSafeInteger(dimension)||dimension<1||dimension>65_536)throw new MemoryIndexUnavailable();
  }
  private validateCursor(cursor:MemoryIndexCursor):void{
    if(!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0||(cursor.sequence===0?cursor.commandId!==null:!cursor.commandId))throw new MemoryIndexUnavailable();
  }
}
