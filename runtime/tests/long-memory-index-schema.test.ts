import { DatabaseSync } from 'node:sqlite';
import { describe,expect,it } from 'vitest';
import { initializeMemoryIndexSchema,memoryIndexLayoutDigest,MEMORY_INDEX_LAYOUT_DIGEST } from '../src/adapters/persistence/LongMemoryIndexSchema.js';

describe('independent memory search index Schema 1',()=>{
  it('looks up only failed jobs rather than repeatedly scanning the entire pending queue',()=>{
    const database=new DatabaseSync(':memory:');
    try{
      initializeMemoryIndexSchema(database);
      const plan=database.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM memory_index_jobs j JOIN memory_index_metadata m ON m.memory_id=j.memory_id AND m.version=j.version WHERE j.space_id=? AND j.kind='index' AND j.attempts>0 AND m.status='active' AND m.reviewed_at IS NOT NULL AND (m.expires_at IS NULL OR m.expires_at>?) LIMIT 1").all('space',0);
      expect(plan.some(row=>String(row.detail).includes('SEARCH j USING INDEX memory_index_job_failed'))).toBe(true);
      expect(plan.some(row=>String(row.detail).includes('SCAN j'))).toBe(false);
    }finally{database.close();}
  });
  it('creates one strict derived layout and accepts its reopening without changing authoritative tables',()=>{
    const database=new DatabaseSync(':memory:');
    try{
      initializeMemoryIndexSchema(database);expect(memoryIndexLayoutDigest(database)).toBe(MEMORY_INDEX_LAYOUT_DIGEST);
      initializeMemoryIndexSchema(database);
      expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('long_memories','long_memory_commands')").all()).toEqual([]);
    }finally{database.close();}
  });
  it('preserves unknown unversioned files, future schemas and layout drift instead of silently creating an empty index',()=>{
    for(const scenario of ['unversioned','future','drift']){
      const database=new DatabaseSync(':memory:');
      try{
        if(scenario==='unversioned')database.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('retained');");
        else{initializeMemoryIndexSchema(database);if(scenario==='future')database.exec('PRAGMA user_version=2;');
          else database.exec('DROP INDEX memory_index_job_due;');}
        const before=database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
        expect(()=>initializeMemoryIndexSchema(database)).toThrow('long_memory_index_');
        expect(database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(before);
        if(scenario==='unversioned')expect(database.prepare('SELECT value FROM unrelated').get()?.value).toBe('retained');
      }finally{database.close();}
    }
  });
});
